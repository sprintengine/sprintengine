import type { ControlRpc } from '../server/bootstrap/control-rpc'
import { compactDeps, type StudioAgentTerminals } from '../server/core/studio-agent-terminals'
import { SERVER_EVENTS, SERVER_METHODS } from '../server/desktop/server-methods'
import type { AgentLaunchRequest, AgentLaunchResult } from '../shared/agent-launch'
import type { TerminalSessionSnapshot } from '../shared/electron-api'
import type { ConversationPeekSessionState } from './conversation-peek/service'
import { compactTerminalAgent, type AgentCompactResult } from './ipc/agent-compact-ipc'

// What the desktop's shell reads of the terminals and asks of them, which are
// the Studio server's (src/server/core/studio-agent-terminals.ts): its tours
// (a question typed at the author, a new author launched), keep-awake, the
// tray, a quit's count of working agents, Compact on an agent tab and the
// peek card. In process the core is in this process, and each read is the
// runtime's own; out of process the server sends its sessions whole on every
// change and answers the rest on the control channel.

export type ShellTerminals = {
  /** The sessions, as the server last said. */
  list(): TerminalSessionSnapshot[]
  /** Type into a session. */
  write(sessionId: string, data: string): void
  launch(request: AgentLaunchRequest): Promise<AgentLaunchResult>
  /** Compact on an agent tab (agent-compact-ipc.ts), checked and typed where the session runs. */
  compact(sessionId: unknown): Promise<AgentCompactResult>
  peekState(sessionId: string): Promise<ConversationPeekSessionState | null>
}

const NO_TERMINALS = 'Terminals cannot start on this machine: its terminal module did not load.'
/** A launch may cut a worktree and wait on its install first; past this the shell stops waiting. */
const LAUNCH_TIMEOUT_MS = 120_000

/** The core's terminals, in this process; null where none can start. */
export function localShellTerminals(terminals: StudioAgentTerminals | null): ShellTerminals {
  return {
    list: () => terminals?.runtime.sessions.listTerminals() ?? [],
    write: (sessionId, data) => terminals?.runtime.sessions.writeTerminal(sessionId, data),
    launch: (request) =>
      terminals
        ? terminals.launchService.launch(request)
        : Promise.resolve({ ok: false, code: 'terminals_unavailable', message: NO_TERMINALS }),
    compact: (sessionId) =>
      terminals
        ? compactTerminalAgent(compactDeps(terminals), sessionId)
        : Promise.resolve({ ok: false, message: NO_TERMINALS }),
    peekState: async (sessionId) => (terminals ? terminals.runtime.readConversationPeekSessionState(sessionId) : null),
  }
}

/** The server's terminals, from a process of its own: the list it pushes, and requests for the rest. */
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
    launch: (request) =>
      rpc
        .call<AgentLaunchResult>(SERVER_METHODS.agentLaunch, request, { timeoutMs: LAUNCH_TIMEOUT_MS })
        .catch((error: unknown): AgentLaunchResult => ({
          ok: false,
          code: 'server_unavailable',
          message: unanswered(error),
        })),
    compact: (sessionId) =>
      rpc
        .call<AgentCompactResult>(SERVER_METHODS.agentCompact, { sessionId })
        .catch((error: unknown): AgentCompactResult => ({ ok: false, message: unanswered(error) })),
    peekState: (sessionId) =>
      rpc
        .call<ConversationPeekSessionState | null>(SERVER_METHODS.terminalPeekState, { sessionId })
        .catch(() => null),
  }
}
