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
// - What an extension types goes through the control plane's write, so the
//   extensions' `terminal.write.before` hooks see it as an extension's write.
// - `close` reaches only a terminal the extension opened. It keeps those until
//   it is switched off or its approval lapses (`forget`: the terminals stay,
//   the person's now), or it is uninstalled or killed (`closeAll`: they close).
//
// A terminal's id is its session id: what `create` answers, and what the
// events carry.

import { randomUUID } from 'node:crypto'

import {
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
import { invokerCeiling } from './extension-invocation'

/** How many characters of raw output a read looks back over, and the most text it answers. */
const READ_RAW_BYTES = 256 * 1024
const READ_MAX_CHARS = 64 * 1024

/** What the registry needs of the machine's terminals; null where this Studio runs none. */
export type ExtensionTerminalHost = {
  list(): readonly TerminalSessionSnapshot[]
  /** Open a shell no pane shows yet: its output buffers until one does. */
  spawnShell(input: {
    sessionId: string
    terminalId: string
    workspaceId: string
    cwd: string
  }): Promise<TerminalSpawnResult>
  /** Write through the control plane, so the extensions' write hooks run. */
  write(sessionId: string, data: string): Promise<{ ok: true } | { ok: false; reason: string; message: string }>
  /** The newest raw output, or undefined for no such session. */
  readTail(sessionId: string, maxBytes: number): { text: string; truncated: boolean } | undefined
  kill(sessionId: string): void
}

export type ExtensionTerminalDeps = {
  terminals(): ExtensionTerminalHost | null
  /** A workspace this Studio holds, as a terminal opens in it; null for one it does not. */
  workspace(workspaceId: string): { folderPath: string | null; remote: boolean } | null
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
}

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
  const ceiling = deps.ceiling ?? invokerCeiling

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

  function remember(moduleId: string, terminalId: string, title: string | null): void {
    const opened = openedBy.get(moduleId) ?? new Map<string, string | null>()
    opened.delete(terminalId)
    opened.set(terminalId, title)
    // Past the limit the oldest is forgotten, not closed: it is the person's now.
    while (opened.size > EXTENSION_TERMINAL_OPENED_LIMIT) opened.delete(opened.keys().next().value as string)
    openedBy.set(moduleId, opened)
  }

  async function write(terminals: ExtensionTerminalHost, terminalId: string, data: string): Promise<boolean> {
    const written = await terminals.write(terminalId, data)
    if (written.ok) return true
    if (written.reason === 'refused') refuse('refused_by_extension', written.message)
    // Gone, or its process exited: not accepted, which is an answer, not a failure.
    if (written.reason === 'not_alive' || written.reason === 'not_found') return false
    return refuse('action_failed', written.message)
  }

  return {
    async send(_moduleId, input) {
      const params = record(input)
      const terminalId = idOf(params, 'terminalId')
      const text = textOf(params, 'text', EXTENSION_TERMINAL_TEXT_MAX_CHARS)
      const enter = params.enter
      if (enter !== undefined && typeof enter !== 'boolean') refuse('invalid_params', '"enter" is true or false.')
      mayType('Typing into a terminal')
      const terminals = host()
      const session = live(terminals, terminalId)
      if (!session.processAlive) return { accepted: false }
      return { accepted: await write(terminals, terminalId, enter === true ? `${text}\r` : text) }
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
      const terminalId = `ext-${randomUUID()}`
      const sessionId = `terminal-${terminalId}`
      const spawned = await terminals.spawnShell({ sessionId, terminalId, workspaceId, cwd: workspace.folderPath! })
      if (!spawned.ok) refuse('action_failed', `The terminal did not start: ${spawned.message}`)
      remember(moduleId, sessionId, title?.trim() ? title.trim() : null)
      if (command !== undefined && command.length > 0) await write(terminals, sessionId, `${command}\r`)
      return { terminalId: sessionId }
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

    opened: (moduleId) => [...(openedBy.get(moduleId) ?? [])].map(([id, title]) => ({ id, title })),

    titleOf(terminalId) {
      for (const opened of openedBy.values()) if (opened.has(terminalId)) return opened.get(terminalId) ?? null
      return null
    },

    forget(moduleId) {
      openedBy.delete(moduleId)
    },

    closeAll(moduleId) {
      const opened = openedBy.get(moduleId)
      openedBy.delete(moduleId)
      const terminals = deps.terminals()
      if (!opened || !terminals) return
      const running = new Set(terminals.list().map((session) => session.sessionId))
      for (const terminalId of opened.keys()) if (running.has(terminalId)) terminals.kill(terminalId)
    },
  }
}
