// The person's terminals, for a worker: type into one (`terminals:send`), open
// one in a workspace and close the ones it opened (`terminals:send`), and read
// what one shows (`terminals:read`). Worker tier only: a surface's frame has
// no way to a terminal, so extension.json refuses either permission below the
// worker tier rather than ask the person for something it could never use.
//
// Terminals belong to the person at this machine. Whoever set a call off must
// be that person (or an agent of theirs on this machine, or the extension's
// own work, which runs as the person who approved it): a paired device, the
// phone and another app never reach a terminal through an extension, as they
// never reach one through Studio. An agent that asks before it runs commands
// cannot have an extension type or run a command for it either.
//
// A terminal is named by its id: the one `create` answers, one `list` answers
// (`terminals:read`), or one an event carries (`workspace.changed`'s
// `terminals`, `agent.status.changed`'s `terminalId`). What the extension types passes the extensions' own
// `terminal.write.before` hooks first, as any write Studio makes for someone
// other than the person at the keyboard does.

import type { MainHost, ServiceToken } from './index.js'

/** The most lines `read` answers, and what it answers when `maxLines` is not given. */
export const EXTENSION_TERMINAL_READ_MAX_LINES = 2000
export const EXTENSION_TERMINAL_READ_DEFAULT_LINES = 200
/** The most characters one `send` may type, and one `create`'s `command` and `title` may hold. */
export const EXTENSION_TERMINAL_TEXT_MAX_CHARS = 64 * 1024
export const EXTENSION_TERMINAL_TITLE_MAX_CHARS = 200
/** The most terminals Studio remembers an extension opened; the oldest is forgotten (not closed) past it. */
export const EXTENSION_TERMINAL_OPENED_LIMIT = 128
/** The most terminals one `list` answers. */
export const EXTENSION_TERMINAL_LIST_MAX = 50

/** A live terminal, as `list` answers it. */
export type ExtensionTerminalSummary = {
  /** Its id, which the other methods take. */
  terminalId: string
  workspaceId: string | null
  /**
   * The agent's name for an agent's terminal, or the title your extension gave
   * one it opened; null for a shell the person opened (Studio does not know
   * the name its tab shows).
   */
  title: string | null
  /** Whether your extension opened it (`create`), so `close` reaches it. */
  opened: boolean
}

/**
 * Why a terminal call was refused, as the rejected error's `code`:
 * `not_permitted` and `approval_required` are the host's gate's;
 * `unknown_terminal` (no terminal by that id), `unknown_workspace`,
 * `not_yours` (`close` of a terminal it did not open), `unavailable` (this
 * Studio runs no terminals), `invalid_params`, `refused_by_extension` (an
 * extension's `terminal.write.before` hook refused the write) and
 * `action_failed`.
 */
export type ExtensionTerminalErrorCode =
  | 'not_permitted'
  | 'approval_required'
  | 'unknown_terminal'
  | 'unknown_workspace'
  | 'not_yours'
  | 'unavailable'
  | 'invalid_params'
  | 'refused_by_extension'
  | 'action_failed'

export type ExtensionTerminalService = {
  /**
   * Type `text` into the terminal `terminalId`, pressing Enter after it when
   * `enter` is true. `accepted` is false when the terminal is gone or its
   * process has exited.
   */
  send(input: { terminalId: string; text: string; enter?: boolean }): Promise<{ accepted: boolean }>
  /**
   * Open a shell in a workspace's folder, in the background: no window
   * switches to it, and the person finds it among the workspace's terminals.
   * With `command`, the shell runs it (typed, then Enter). The extension may
   * close it later; it keeps it until it is switched off or removed, and
   * uninstalling it, or Studio's kill list removing it, closes it.
   */
  create(input: { workspaceId: string; title?: string; command?: string }): Promise<{ terminalId: string }>
  /**
   * The terminal's newest output as plain text, one line a string, colours
   * and cursor moves taken out: at most `maxLines` (default 200, at most
   * 2000). `truncated` says older output was left out.
   */
  read(input: { terminalId: string; maxLines?: number }): Promise<{ lines: string[]; truncated: boolean }>
  /**
   * Close a terminal the extension opened, stopping what runs in it. Any other
   * terminal is refused with `not_yours`.
   */
  close(input: { terminalId: string }): Promise<{ closed: true }>
  /**
   * The live terminals on this Studio's machine, in one workspace when
   * `workspaceId` is given: at most 50, `truncated` saying more were left out.
   * Needs `terminals:read`.
   */
  list(input?: { workspaceId?: string }): Promise<{ terminals: ExtensionTerminalSummary[]; truncated: boolean }>
}

/** The host's side: each method takes the calling extension's id first. */
export type ExtensionTerminalRegistry = {
  [K in keyof ExtensionTerminalService]: (
    moduleId: string,
    ...args: Parameters<ExtensionTerminalService[K]>
  ) => ReturnType<ExtensionTerminalService[K]>
}

const terminalServiceToken: ServiceToken<ExtensionTerminalRegistry> = { key: 'terminals.module-service' }

/**
 * The terminal service for `host`'s extension. `host.supports('terminals')`
 * says this Studio has it; on a machine where Studio runs no terminals, every
 * call rejects with `unavailable`.
 */
export function getTerminalService(host: MainHost): ExtensionTerminalService {
  const registry = host.requireService(terminalServiceToken)
  const moduleId = host.moduleId
  return {
    send: (input) => registry.send(moduleId, input),
    create: (input) => registry.create(moduleId, input),
    read: (input) => registry.read(moduleId, input),
    close: (input) => registry.close(moduleId, input),
    list: (input) => registry.list(moduleId, input),
  }
}
