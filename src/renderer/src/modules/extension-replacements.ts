import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import {
  EXTENSION_COMMAND_ACTIONS,
  EXTENSION_REPLACEABLE_ACTIONS,
  type ExtensionReplaceableAction,
} from '../../../../packages/extension-sdk/src/extension-manifest'
import type { ExtensionCommandContext } from '../../../../packages/extension-sdk/src/index'
import type { ExtensionManifestView } from '../../../shared/modules/manifest'
import { runAppCommand } from '../commands/appCommandRunner'
import { getCommandDefinition } from '../commands/commandRegistry'
import type { InternalRendererHost } from './renderer-host'

// A worker command that declares `replaces` runs in place of one of Studio's
// own actions when the person fires that action from its shortcut, the
// palette or a menu. The window keeps them here: the extension contributions
// register one per such command, and the window's command paths ask
// `runReplaceable` before running the built-in.
//
// Studio's own action is the floor. The extension has 2 s to answer; if it
// refuses, throws, or is still thinking, Studio runs its own, once, and never
// a second time around a worker that runs the action itself (`runCommandForWorker`). Only the
// person's own gestures are taken over: a declarative command's `action`, a
// surface handing on to a shell command and a worker's `studio.runCommand` go
// through `runAppCommand`, which is always the built-in.

/** How long an extension has to answer before Studio runs its own action. */
export const REPLACEMENT_TIME_LIMIT_MS = 2000

export type ExtensionReplacement = {
  /** The extension's install key. */
  key: string
  commandId: string
  title: string
  action: ExtensionReplaceableAction
  /** When it was installed; the earliest of two that replace one action does. Absent reads as the latest. */
  installedAt?: number
  host: Pick<InternalRendererHost, 'methods' | 'getActiveWorkspaceId'>
  /** Whether the extension is switched on and served now: asked again each time the action fires. */
  live: () => boolean
}

const registered = new Map<string, ExtensionReplacement[]>()

/** Register a replacement for the extension `replacement.key`; returns the unregister. */
export function registerExtensionReplacement(replacement: ExtensionReplacement): () => void {
  registered.set(replacement.key, [...(registered.get(replacement.key) ?? []), replacement])
  return () => {
    const kept = (registered.get(replacement.key) ?? []).filter((entry) => entry !== replacement)
    if (kept.length > 0) registered.set(replacement.key, kept)
    else registered.delete(replacement.key)
  }
}

/** Drop every replacement an extension registered: it is being registered again, or is gone. */
export function forgetExtensionReplacements(key: string): void {
  registered.delete(key)
}

export function isReplaceableAction(action: string): action is ExtensionReplaceableAction {
  return (EXTENSION_REPLACEABLE_ACTIONS as readonly string[]).includes(action)
}

// ── The switch on the extension's page ──────────────────────────────────────
// Kept in this window's storage, sparse (only the ones switched off), so an
// extension is let take over until the person says otherwise. Studio has no
// per-extension window preference on its server, and a replacement only ever
// takes over this window's own actions, so this window's storage is where the
// choice lives; the dispatch reads it without React.

type ReplacementSwitches = {
  off: Record<string, true>
  setTakesOver: (key: string, on: boolean) => void
}

export const useExtensionReplacementSwitches = create<ReplacementSwitches>()(
  persist(
    (set) => ({
      off: {},
      setTakesOver: (key, on) =>
        set((state) => {
          const off = { ...state.off }
          if (on) delete off[key]
          else off[key] = true
          return { off }
        }),
    }),
    { name: 'sprintengine-extension-replacements', version: 1 },
  ),
)

/** An uninstalled extension's switch is forgotten: installed again, it starts on, as a new one does. */
export function forgetExtensionReplacementSwitch(key: string): void {
  if (useExtensionReplacementSwitches.getState().off[key] === true)
    useExtensionReplacementSwitches.getState().setTakesOver(key, true)
}

/** Whether the person lets this extension take over Studio's actions (on unless switched off). */
export function extensionTakesOver(key: string): boolean {
  return useExtensionReplacementSwitches.getState().off[key] !== true
}

// ── Which one runs ──────────────────────────────────────────────────────────

/**
 * The replacement that runs for `action` now: from an extension that is live
 * and let take over, the one installed first (ties by key). Null when Studio's
 * own runs.
 */
export function replacementFor(action: string): ExtensionReplacement | null {
  const candidates = [...registered.values()]
    .flat()
    .filter((entry) => entry.action === action && entry.live() && extensionTakesOver(entry.key))
  candidates.sort(
    (a, b) =>
      (a.installedAt ?? Number.POSITIVE_INFINITY) - (b.installedAt ?? Number.POSITIVE_INFINITY) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )
  return candidates[0] ?? null
}

type ReplacementLog = (key: string, line: string) => void

// The extension's log proper is written by its Studio (it records there when
// the worker answers late or refuses one of these calls); the window says
// the same in its console for whoever is looking at it.
let logLine: ReplacementLog = (key, line) => console.warn(`[extensions] ${key}: ${line}`)

/** Where the window's lines about a replacement go; for tests. Returns the restore. */
export function setReplacementLog(next: ReplacementLog): () => void {
  const previous = logLine
  logLine = next
  return () => {
    logLine = previous
  }
}

/**
 * Run `actionId` as the person fired it: the replacement that takes it over,
 * when there is one, else Studio's own (`runBuiltIn`). Whether the gesture was
 * taken: with a replacement it always is, at once, whatever the worker answers.
 */
export function runReplaceable(actionId: string, runBuiltIn: () => boolean): boolean {
  const replacement = isReplaceableAction(actionId) ? replacementFor(actionId) : null
  if (!replacement) return runBuiltIn()
  void runReplacement(replacement, runBuiltIn)
  return true
}

// ── Studio's own action runs once ───────────────────────────────────────────
// A replacement that wraps Studio's action (`await studio.runCommand(action)`)
// races the 2 s floor: Studio may run its own and then hear the worker ask
// for the same, or the worker may run it and then fail. Each call this window
// has made and not heard the end of is kept here under a token of its own,
// which rides the call (`replacementCall`) and comes back on the worker's
// `runCommand` (`extension.commandRuns`' `call`). So the action runs once per
// call, however calls overlap: after Studio ran its own for a call, that
// call's ask is dropped; after a call's worker ran it, Studio does not run it
// again for that call. Another call, older or newer, is never claimed.

type ReplacementCall = {
  key: string
  action: string
  /** Studio ran its own in the worker's place. */
  fellBack: boolean
  /** The worker ran the action itself (`studio.runCommand`), during the call. */
  workerRan: boolean
}

/** Calls whose answer has not come; one the worker never answers is let go of after this long. */
const REPLACEMENT_CALL_FORGET_MS = 60_000
const inFlight = new Map<string, ReplacementCall>()

/**
 * A worker's `studio.runCommand(action)`, heard by this window
 * (`extension.commandRuns`): Studio's own action, never a replacement
 * (`runBuiltInAction`), unless it came from a replacement call of this
 * window's (`call`) for that very action, and Studio already ran its own in
 * that call's place. Whether anything ran.
 */
export function runCommandForWorker(run: { moduleId: string; action: string; call?: string }): boolean {
  const call = run.call === undefined ? undefined : inFlight.get(run.call)
  if (call && call.key === run.moduleId && call.action === run.action) {
    if (call.fellBack) {
      logLine(
        run.moduleId,
        `asked to run Studio's "${run.action}" after Studio had already run it in its place; it was not run again.`,
      )
      return false
    }
    call.workerRan = true
  }
  return runBuiltInAction(run.action)
}

let callSequence = 0
/** A token for one replacement call: unique in this window, and nothing a worker could guess its way into. */
function newCallToken(): string {
  callSequence += 1
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  return `${callSequence}-${random}`
}

async function runReplacement(replacement: ExtensionReplacement, runBuiltIn: () => boolean): Promise<void> {
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const call: ReplacementCall = { key: replacement.key, action: replacement.action, fellBack: false, workerRan: false }
  const token = newCallToken()
  inFlight.set(token, call)
  const forget = setTimeout(() => inFlight.delete(token), REPLACEMENT_CALL_FORGET_MS)
  const builtIn = (why: string) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    const reason = why.replace(/[.\s]+$/u, '')
    // The worker ran the action itself: its failure, or its silence, does not run it twice.
    if (call.workerRan) {
      logLine(
        replacement.key,
        `"${replacement.commandId}" ${reason}, after running Studio's "${replacement.action}" itself; Studio did not run it again.`,
      )
      return
    }
    call.fellBack = true
    logLine(replacement.key, `Studio ran its own "${replacement.action}": "${replacement.commandId}" ${reason}.`)
    runBuiltIn()
  }
  timer = setTimeout(
    () => builtIn(`had not answered within ${REPLACEMENT_TIME_LIMIT_MS / 1000} s`),
    REPLACEMENT_TIME_LIMIT_MS,
  )
  // The token rides the call; Studio takes it off before the extension sees the context.
  const context: ExtensionCommandContext & { replacementCall: string } = {
    where: 'replaces',
    replaces: replacement.action,
    workspaceId: replacement.host.getActiveWorkspaceId(),
    replacementCall: token,
  }
  try {
    const answer = await replacement.host.methods().operate(replacement.commandId, context)
    if (answer.ok) {
      settled = true
      clearTimeout(timer)
    } else builtIn(`did not run: ${answer.message}`)
  } catch (error) {
    builtIn(`failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(forget)
    inFlight.delete(token)
  }
}

/**
 * Run one of Studio's own actions for a worker's `studio.runCommand`: always the
 * built-in, never an extension's replacement of it, so a worker cannot reach
 * another extension through Studio's name for an action, nor call itself back.
 * Only the actions an extension may name; whether anything ran it.
 */
export function runBuiltInAction(action: string): boolean {
  if (!(EXTENSION_COMMAND_ACTIONS as readonly string[]).includes(action)) return false
  return runAppCommand(action)
}

// ── What the person is shown ────────────────────────────────────────────────

export type ExtensionReplacementLine = {
  commandId: string
  title: string
  action: string
  /** The built-in command's title as Studio's palette shows it. */
  builtInTitle: string
}

/** Each of an extension's commands that takes over one of Studio's actions, with both titles. */
export function extensionReplacementLines(
  extension: Pick<ExtensionManifestView, 'contributes'>,
): ExtensionReplacementLine[] {
  return (extension.contributes.commands ?? []).flatMap((command) =>
    command.replaces === undefined
      ? []
      : [
          {
            commandId: command.id,
            title: command.title,
            action: command.replaces,
            builtInTitle: getCommandDefinition(command.replaces)?.title ?? command.replaces,
          },
        ],
  )
}
