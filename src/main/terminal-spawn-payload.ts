import type {
  AgentLaunchRecord,
  TerminalOpenParams,
  TerminalSpawnResult,
} from '../../packages/studio-protocol/src/public'

/**
 * What the terminal runtime starts a session from: a client's `terminal.open`
 * (or `terminal.resume`), or a launch the Studio itself makes.
 *
 * `cliSessionId` is the agent's session id within its CLI, used as the resume
 * token (`claude --resume <id>` / `codex resume <id>`), distinct from
 * `sessionId`, the terminal's own key. For Claude it equals the minted id; for
 * Codex it is the harness id learned from the hook, persisted and passed on
 * resume.
 */
export type TerminalSpawnPayload = TerminalOpenParams & {
  // Set only by the AgentLaunchService: the launch decisions it made, retained
  // on the session and surfaced on its snapshot so a window can project an
  // agent record for an agent it never composed. Never set by a client's open:
  // a window that launched an agent already HAS its record, and projecting
  // over it would fight the store.
  agentRecord?: AgentLaunchRecord
  // The payload is flat. In-process callers must flatten any metadata
  // themselves. Typed `never` so handing over a still-nested set of spawn
  // arguments fails to compile instead of silently dropping every field in it.
  metadata?: never
}

/**
 * Why a terminal cannot start while the Studio server runs in a process of its
 * own: windows reach terminals only over the Studio protocol, and that server
 * does not serve them until it holds the terminal runtime. Every launch the
 * shell would make (`agent.launch`, `backlog.work`, a schedule, Resume in
 * terminal, a tour) is refused in these words rather than started where no
 * window could show or end it.
 */
export const TERMINALS_NOT_SERVED_OUT_OF_PROCESS =
  'Terminal agents cannot start while the Studio server runs in its own process (a preview setting): its windows cannot show terminals yet. Turn off "Run Studio server in its own process" in Settings to use them, or start a chat instead.'

/** The answer to a terminal launch while the Studio server runs out of process. */
export function refuseTerminalSpawnOutOfProcess(payload: { sessionId: string }): TerminalSpawnResult {
  return { ok: false, sessionId: payload.sessionId, message: TERMINALS_NOT_SERVED_OUT_OF_PROCESS, exitCode: 1 }
}
