// The person's terminals, as an extension's worker reaches them
// (`getTerminalService`, packages/extension-sdk/src/terminals.ts).
//
// The host's gate has already held each call to the extension's approval
// (`terminals:send` or `terminals:read`) and to whoever set it off: the
// person alone, so a paired device, the phone or another app never reaches a
// terminal through an extension (services.ts). Here, the rest:
//
// - An agent that asks before it runs commands (an invoker with a ceiling
//   short of the loosest preset) cannot have an extension type into a
//   terminal or run a command for it: typing into a shell runs whatever is
//   typed, unasked.
// - `send` types only into a terminal the extension opened, or one in a
//   workspace a window on this machine shows now (read at each call, and again
//   right before the write): never into a terminal in a workspace nobody is
//   looking at, where it could answer an agent's prompt with no one watching.
// - What an extension types goes through the control plane's write, so the
//   extensions' `terminal.write.before` hooks see it as an extension's write.
// - `close` reaches only a terminal the extension opened. It keeps those until
//   it is switched off or its approval lapses (`forget`: the terminals stay,
//   the person's now), or it is uninstalled or killed (`closeAll`: they close).
// - Work that waits (a shell starting, which can wait on a workspace's lease;
//   a write queued behind others or behind the write hooks) is the
//   extension's until it is carried out: `forget` and `closeAll` cancel it,
//   abandoning a shell's launch where it waits, and the gate is asked again
//   after each of the runtime's waits, right before the shell's process is
//   spawned, and right before each write goes to the terminal. A `create`
//   cancelled before then starts no process at all.
//
// A terminal's id is its session id: what `create` answers, and what the
// events carry.

import { randomUUID } from 'node:crypto'

import { extensionHostService } from '../../../packages/extension-sdk/src/services'

import {
  EXTENSION_TERMINAL_LIST_MAX,
  EXTENSION_TERMINAL_OPENED_LIMIT,
  EXTENSION_TERMINAL_READ_DEFAULT_LINES,
  EXTENSION_TERMINAL_READ_MAX_LINES,
  EXTENSION_TERMINAL_TEXT_MAX_CHARS,
  EXTENSION_TERMINAL_TITLE_MAX_CHARS,
  type ExtensionTerminalErrorCode,
  type ExtensionTerminalRegistry,
} from '../../../packages/extension-sdk/src/terminals'
import type { TerminalSessionSnapshot, TerminalSpawnResult } from '../../../packages/studio-protocol/src/terminals'
import { isMostPermissiveCliPermissionPreset, type CliPermissionPreset } from '../../shared/cli-permission-preset'
import { terminalPlainText } from '../automation/terminal-plain-text'
import { gateExtensionHostCall } from './extension-host-gate'
import { currentInvoker, invokerCeiling, type ExtensionInvoker } from './extension-invocation'

/** How many characters of raw output a read looks back over, and the most text it answers. */
const READ_RAW_BYTES = 256 * 1024
const READ_MAX_CHARS = 64 * 1024

/** What the registry needs of the machine's terminals; null where this Studio runs none. */
export type ExtensionTerminalHost = {
  list(): readonly TerminalSessionSnapshot[]
  /**
   * Open a shell no pane shows yet: its output buffers until one does.
   * `mayStart` is asked after every wait the launch makes and right before
   * the process is spawned: a reason abandons it with nothing started. `kill`
   * of the session id abandons a launch still waiting (the workspace's lease).
   */
  spawnShell(input: {
    sessionId: string
    terminalId: string
    workspaceId: string
    cwd: string
    mayStart: () => string | null
  }): Promise<TerminalSpawnResult>
  /**
   * Write through the control plane, so the extensions' write hooks run.
   * `stillMay` is asked right before the bytes reach the terminal, after the
   * hooks and the queue: a reason refuses the write (`withdrawn`).
   */
  write(
    sessionId: string,
    data: string,
    stillMay?: () => string | null,
  ): Promise<{ ok: true } | { ok: false; reason: string; message: string }>
  /** The newest raw output, or undefined for no such session. */
  readTail(sessionId: string, maxBytes: number): { text: string; truncated: boolean } | undefined
  kill(sessionId: string): void
}

export type ExtensionTerminalDeps = {
  terminals(): ExtensionTerminalHost | null
  /** A workspace this Studio holds, as a terminal opens in it; null for one it does not. */
  workspace(workspaceId: string): { folderPath: string | null; remote: boolean } | null
  /** The workspaces a window on this machine shows now; absent (tests), none. */
  shownWorkspaces?: () => ReadonlySet<string>
  /** An agent's name, as the sidebar shows it, for a terminal it runs in; null when Studio has none. */
  agentTitle?: (workspaceId: string | undefined, agentId: string) => string | null
  /** The ceiling of whoever set off the call running now (tests pass their own). */
  ceiling?: () => CliPermissionPreset | null
}

export type ExtensionTerminals = ExtensionTerminalRegistry & {
  /** The terminals each extension opened, with their titles: the id and title, newest last. */
  opened(moduleId: string): Array<{ id: string; title: string | null }>
  /** The title an extension gave a terminal it opened, by its id, or null. */
  titleOf(terminalId: string): string | null
  /** It was switched off or lost its approval: it no longer holds its terminals, which stay open. */
  forget(moduleId: string): void
  /** It was uninstalled or killed: the terminals it opened close. */
  closeAll(moduleId: string): void
  /**
   * Where an extension's approval is read as it stands now (the workers), so
   * work that waited is held to it again before it is carried out; null (as
   * at first) holds it to its cancellation alone.
   */
  bindGrants(grantOf: ((moduleId: string) => readonly string[] | null) | null): void
}

/**
 * One piece of an extension's terminal work on its way: cancelled when it lets
 * go of its terminals. A shell starting keeps its session id, so cancelling
 * also abandons its launch.
 */
type Pending = { cancelled: boolean; launching?: string }

const TERMINALS_SERVICE = extensionHostService('terminals.module-service')!

class TerminalRefusal extends Error {
  constructor(
    readonly code: ExtensionTerminalErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ExtensionTerminalRefusal'
  }
}

const refuse = (code: ExtensionTerminalErrorCode, message: string): never => {
  throw new TerminalRefusal(code, message)
}

function record(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    refuse('invalid_params', 'A terminal call takes its input as an object.')
  return input as Record<string, unknown>
}

function idOf(input: Record<string, unknown>, name: string): string {
  const value = input[name]
  if (typeof value !== 'string' || value.length === 0 || value.length > 256)
    refuse('invalid_params', `"${name}" is an id.`)
  return value as string
}

function textOf(input: Record<string, unknown>, name: string, max: number, optional: true): string | undefined
function textOf(input: Record<string, unknown>, name: string, max: number, optional?: false): string
function textOf(input: Record<string, unknown>, name: string, max: number, optional = false): string | undefined {
  const value = input[name]
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string') return refuse('invalid_params', `"${name}" is text.`)
  if (value.length > max) refuse('invalid_params', `"${name}" holds at most ${max} characters.`)
  return value
}

export function createExtensionTerminals(deps: ExtensionTerminalDeps): ExtensionTerminals {
  // By extension: the terminals it opened, oldest first, with their titles.
  const openedBy = new Map<string, Map<string, string | null>>()
  // By extension: the work it has on its way (a shell starting, a write queued).
  const pendingBy = new Map<string, Set<Pending>>()
  const ceiling = deps.ceiling ?? invokerCeiling
  let grantOf: ((moduleId: string) => readonly string[] | null) | null = null

  function begin(moduleId: string): Pending {
    const pending: Pending = { cancelled: false }
    let set = pendingBy.get(moduleId)
    if (!set) pendingBy.set(moduleId, (set = new Set()))
    set.add(pending)
    return pending
  }

  function finish(moduleId: string, pending: Pending): void {
    const set = pendingBy.get(moduleId)
    set?.delete(pending)
    if (set?.size === 0) pendingBy.delete(moduleId)
  }

  function cancel(moduleId: string): void {
    const terminals = deps.terminals()
    for (const pending of pendingBy.get(moduleId) ?? []) {
      pending.cancelled = true
      // A shell still starting is abandoned where it waits (the runtime's kill
      // of a pending launch); one past its waits meets `mayStart`.
      if (pending.launching) terminals?.kill(pending.launching)
    }
    pendingBy.delete(moduleId)
  }

  /**
   * Why work on its way may no longer be carried out, or null: cancelled (the
   * extension was switched off, lost its approval, was uninstalled or killed),
   * or the gate, asked again as it stands now, refuses it.
   */
  function withdrawn(
    moduleId: string,
    method: 'send' | 'create',
    pending: Pending,
    invoker: ExtensionInvoker,
  ): string | null {
    if (pending.cancelled)
      return `Extension "${moduleId}" was switched off, lost its approval or was removed before its terminal work was carried out.`
    if (!grantOf) return null
    const decision = gateExtensionHostCall({
      extensionId: moduleId,
      method: `${TERMINALS_SERVICE.key}.${method}`,
      requirement: TERMINALS_SERVICE.methods[method],
      grant: grantOf(moduleId),
      invoker,
    })
    return decision.ok ? null : decision.message
  }

  function titleOfTerminal(terminalId: string): string | null {
    for (const opened of openedBy.values()) if (opened.has(terminalId)) return opened.get(terminalId) ?? null
    return null
  }

  function host(): ExtensionTerminalHost {
    return deps.terminals() ?? refuse('unavailable', 'This Studio runs no terminals on its machine.')
  }

  function live(terminals: ExtensionTerminalHost, terminalId: string): TerminalSessionSnapshot {
    return (
      terminals.list().find((session) => session.sessionId === terminalId) ??
      refuse('unknown_terminal', `There is no terminal "${terminalId}" on this Studio.`)
    )
  }

  /** Typing into a shell runs what is typed: only for whoever may run commands unasked. */
  function mayType(what: string): void {
    const cap = ceiling()
    if (cap !== null && !isMostPermissiveCliPermissionPreset(cap))
      refuse(
        'not_permitted',
        `${what} runs commands without asking, and the agent that set this off asks before it runs one (it runs on "${cap}").`,
      )
  }

  /** Why `send` may not type into `session` now, or null: its own, or in a workspace a window shows. */
  function outOfReach(moduleId: string, session: TerminalSessionSnapshot): string | null {
    if (openedBy.get(moduleId)?.has(session.sessionId)) return null
    if (session.workspaceId !== undefined && deps.shownWorkspaces?.().has(session.workspaceId)) return null
    return `An extension types only into a terminal it opened, or one in a workspace a window shows now; terminal "${session.sessionId}" is neither.`
  }

  function remember(moduleId: string, terminalId: string, title: string | null): void {
    const opened = openedBy.get(moduleId) ?? new Map<string, string | null>()
    opened.set(terminalId, title)
    openedBy.set(moduleId, opened)
  }

  /**
   * Room for one more terminal of the extension's, counting those still
   * starting. A terminal it opened is never forgotten while it runs, so its
   * removal closes every one: the ones that exited are let go first, and at
   * the limit `create` is refused.
   */
  function makeRoom(moduleId: string, terminals: ExtensionTerminalHost): void {
    const opened = openedBy.get(moduleId)
    if (opened && opened.size + (pendingBy.get(moduleId)?.size ?? 0) >= EXTENSION_TERMINAL_OPENED_LIMIT) {
      const running = new Set(
        terminals
          .list()
          .filter((session) => session.processAlive)
          .map((session) => session.sessionId),
      )
      for (const terminalId of [...opened.keys()]) if (!running.has(terminalId)) opened.delete(terminalId)
    }
    if ((opened?.size ?? 0) + (pendingBy.get(moduleId)?.size ?? 0) >= EXTENSION_TERMINAL_OPENED_LIMIT)
      refuse(
        'limit_reached',
        `Extension "${moduleId}" already has ${EXTENSION_TERMINAL_OPENED_LIMIT} terminals open, the most it may: close one first.`,
      )
  }

  async function write(
    terminals: ExtensionTerminalHost,
    terminalId: string,
    data: string,
    stillMay: () => string | null,
  ): Promise<boolean> {
    const written = await terminals.write(terminalId, data, stillMay)
    if (written.ok) return true
    if (written.reason === 'refused') refuse('refused_by_extension', written.message)
    if (written.reason === 'withdrawn') refuse('not_permitted', written.message)
    // Gone, or its process exited: not accepted, which is an answer, not a failure.
    if (written.reason === 'not_alive' || written.reason === 'not_found') return false
    return refuse('action_failed', written.message)
  }

  return {
    async send(moduleId, input) {
      const params = record(input)
      const terminalId = idOf(params, 'terminalId')
      const text = textOf(params, 'text', EXTENSION_TERMINAL_TEXT_MAX_CHARS)
      const enter = params.enter
      if (enter !== undefined && typeof enter !== 'boolean') refuse('invalid_params', '"enter" is true or false.')
      mayType('Typing into a terminal')
      const terminals = host()
      const session = live(terminals, terminalId)
      const away = outOfReach(moduleId, session)
      if (away) refuse('not_yours', away)
      if (!session.processAlive) return { accepted: false }
      const invoker = currentInvoker()
      const pending = begin(moduleId)
      try {
        // Asked again right before the bytes go out: the window may have moved on meanwhile.
        let movedAway = false
        const stillMay = () => {
          const why = withdrawn(moduleId, 'send', pending, invoker)
          if (why) return why
          const now = terminals.list().find((candidate) => candidate.sessionId === terminalId)
          const away = now ? outOfReach(moduleId, now) : null
          movedAway = away !== null
          return away
        }
        try {
          return { accepted: await write(terminals, terminalId, enter === true ? `${text}\r` : text, stillMay) }
        } catch (error) {
          if (movedAway && error instanceof TerminalRefusal) refuse('not_yours', error.message)
          throw error
        }
      } finally {
        finish(moduleId, pending)
      }
    },

    async create(moduleId, input) {
      const params = record(input)
      const workspaceId = idOf(params, 'workspaceId')
      const title = textOf(params, 'title', EXTENSION_TERMINAL_TITLE_MAX_CHARS, true)
      const command = textOf(params, 'command', EXTENSION_TERMINAL_TEXT_MAX_CHARS, true)
      if (command !== undefined) mayType('Running a command in a terminal')
      const terminals = host()
      const workspace =
        deps.workspace(workspaceId) ??
        refuse('unknown_workspace', `There is no workspace "${workspaceId}" on this Studio.`)
      if (workspace.remote)
        refuse('unavailable', `Workspace "${workspaceId}" runs on another machine, which keeps its own terminals.`)
      if (!workspace.folderPath)
        refuse('unavailable', `Workspace "${workspaceId}" has no folder to open a terminal in.`)
      makeRoom(moduleId, terminals)
      const terminalId = `ext-${randomUUID()}`
      const sessionId = `terminal-${terminalId}`
      const invoker = currentInvoker()
      // Tracked before anything is awaited, so letting go of its terminals cancels it.
      const pending = begin(moduleId)
      pending.launching = sessionId
      try {
        const stillMay = () => withdrawn(moduleId, 'create', pending, invoker)
        const before = stillMay()
        if (before) refuse('not_permitted', before)
        // Asked again by the runtime after its waits and right before the
        // shell's process is spawned: cancelled or refused by then, no shell
        // starts, so none of its startup scripts run.
        const spawned = await terminals.spawnShell({
          sessionId,
          terminalId,
          workspaceId,
          cwd: workspace.folderPath!,
          mayStart: stillMay,
        })
        pending.launching = undefined
        const after = stillMay()
        if (after) {
          // Withdrawn after it started (between the spawn and here): it is no one's, so it closes.
          if (terminals.list().some((session) => session.sessionId === sessionId)) terminals.kill(sessionId)
          refuse('not_permitted', after)
        }
        if (!spawned.ok) refuse('action_failed', `The terminal did not start: ${spawned.message}`)
        remember(moduleId, sessionId, title?.trim() ? title.trim() : null)
        if (command !== undefined && command.length > 0) await write(terminals, sessionId, `${command}\r`, stillMay)
        return { terminalId: sessionId }
      } finally {
        finish(moduleId, pending)
      }
    },

    async read(_moduleId, input) {
      const params = record(input)
      const terminalId = idOf(params, 'terminalId')
      const asked = params.maxLines
      if (asked !== undefined && (typeof asked !== 'number' || !Number.isInteger(asked) || asked < 1))
        refuse('invalid_params', '"maxLines" is a whole number of at least 1.')
      const maxLines = Math.min(
        (asked as number | undefined) ?? EXTENSION_TERMINAL_READ_DEFAULT_LINES,
        EXTENSION_TERMINAL_READ_MAX_LINES,
      )
      const terminals = host()
      live(terminals, terminalId)
      const tail =
        terminals.readTail(terminalId, READ_RAW_BYTES) ??
        refuse('unknown_terminal', `There is no terminal "${terminalId}" on this Studio.`)
      const plain = terminalPlainText(tail.text, { maxLines, maxChars: READ_MAX_CHARS })
      return {
        lines: plain.text.length > 0 ? plain.text.split('\n') : [],
        truncated: tail.truncated || plain.truncated,
      }
    },

    async close(moduleId, input) {
      const params = record(input)
      const terminalId = idOf(params, 'terminalId')
      const opened = openedBy.get(moduleId)
      if (!opened?.has(terminalId)) refuse('not_yours', 'An extension closes only the terminals it opened (`create`).')
      const terminals = host()
      if (terminals.list().some((session) => session.sessionId === terminalId)) terminals.kill(terminalId)
      opened!.delete(terminalId)
      return { closed: true as const }
    },

    async list(moduleId, input) {
      const params = input === undefined ? {} : record(input)
      const workspaceId = params.workspaceId === undefined ? undefined : idOf(params, 'workspaceId')
      const terminals = host()
      const own = openedBy.get(moduleId)
      const live = terminals
        .list()
        .filter((session) => session.processAlive && (workspaceId === undefined || session.workspaceId === workspaceId))
      return {
        terminals: live.slice(0, EXTENSION_TERMINAL_LIST_MAX).map((session) => ({
          terminalId: session.sessionId,
          workspaceId: session.workspaceId ?? null,
          title:
            (session.agentId ? deps.agentTitle?.(session.workspaceId, session.agentId) : null) ??
            session.agentName ??
            titleOfTerminal(session.sessionId),
          opened: own?.has(session.sessionId) ?? false,
        })),
        truncated: live.length > EXTENSION_TERMINAL_LIST_MAX,
      }
    },

    opened: (moduleId) => [...(openedBy.get(moduleId) ?? [])].map(([id, title]) => ({ id, title })),

    titleOf: titleOfTerminal,

    forget(moduleId) {
      cancel(moduleId)
      openedBy.delete(moduleId)
    },

    closeAll(moduleId) {
      cancel(moduleId)
      const opened = openedBy.get(moduleId)
      openedBy.delete(moduleId)
      const terminals = deps.terminals()
      if (!opened || !terminals) return
      const running = new Set(terminals.list().map((session) => session.sessionId))
      for (const terminalId of opened.keys()) if (running.has(terminalId)) terminals.kill(terminalId)
    },

    bindGrants(next) {
      grantOf = next
    },
  }
}
