import type { AgentLaunchRecord, TerminalOpenParams } from '../../packages/studio-protocol/src/public'
import type { AgentStarter } from '../shared/agent-state'
import type { ConversationPromptHookAs } from '../shared/conversation-runtime'

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
  // Set only by the AgentLaunchService, and never by a client's open: who
  // asked for the agent, which its launch hooks run as before its record is
  // registered, and what its `initialPrompt` is when nobody typed it, which
  // the prompt hooks then check before it is handed over.
  startedBy?: AgentStarter
  initialPromptHookAs?: Omit<ConversationPromptHookAs, 'starter'>
  // The payload is flat. In-process callers must flatten any metadata
  // themselves. Typed `never` so handing over a still-nested set of spawn
  // arguments fails to compile instead of silently dropping every field in it.
  metadata?: never
}
