import type { ControlRpc } from '../server/bootstrap/control-rpc'
import { SERVER_EVENTS, SERVER_METHODS } from '../server/desktop/server-methods'
import type { AgentLaunchRequest, AgentLaunchResult } from '../shared/agent-launch'
import type { TerminalSessionSnapshot } from '../shared/electron-api'
import type { ConversationPromptHookAs } from '../shared/conversation-runtime'

// What the desktop's shell reads of the terminals and asks of them, which are
// the Studio server's (src/server/core/studio-agent-terminals.ts): its tours
// (a question typed at the author, a new author launched), keep-awake, the
// tray and a quit's count of working agents. The server sends its sessions whole on every change and
// answers the rest on the control channel.

export type ShellTerminals = {
  /** The sessions, as the server last said. */
  list(): TerminalSessionSnapshot[]
  /** Type into a session. */
  write(sessionId: string, data: string): void
  /**
   * A prompt Studio is about to type to a terminal agent that nobody typed (a
   * tour's), through the extensions' prompt hooks where the session runs.
   */
  hookPrompt(
    sessionId: string,
    text: string,
    hookAs: Omit<ConversationPromptHookAs, 'starter'>,
  ): Promise<{ ok: true; text: string } | { ok: false; message: string }>
  launch(request: AgentLaunchRequest): Promise<AgentLaunchResult>
}

/** A launch may cut a worktree and wait on its install first; past this the shell stops waiting. */
const LAUNCH_TIMEOUT_MS = 120_000

/** The server's terminals: the list it pushes, and requests for the rest. */
export function remoteShellTerminals(rpc: Pick<ControlRpc, 'on' | 'call'>): ShellTerminals {
  let sessions: TerminalSessionSnapshot[] = []
  rpc.on(SERVER_EVENTS.terminalSessions, (payload) => {
    if (Array.isArray(payload)) sessions = payload as TerminalSessionSnapshot[]
  })
  const unanswered = (error: unknown): string =>
    `The Studio server did not answer: ${error instanceof Error ? error.message : String(error)}`
  return {
    list: () => sessions,
    write: (sessionId, data) => {
      void rpc.call(SERVER_METHODS.terminalWrite, { sessionId, data }).catch(() => undefined)
    },
    // A server that cannot be asked types nothing: the hooks are its to run.
    hookPrompt: (sessionId, text, hookAs) =>
      rpc
        .call<{ ok: true; text: string } | { ok: false; message: string }>(SERVER_METHODS.terminalHookPrompt, {
          sessionId,
          text,
          hookAs,
        })
        .catch((error: unknown) => ({ ok: false as const, message: unanswered(error) })),
    launch: (request) =>
      rpc
        .call<AgentLaunchResult>(SERVER_METHODS.agentLaunch, request, { timeoutMs: LAUNCH_TIMEOUT_MS })
        .catch((error: unknown): AgentLaunchResult => ({
          ok: false,
          code: 'server_unavailable',
          message: unanswered(error),
        })),
  }
}
