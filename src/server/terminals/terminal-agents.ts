import type { ConversationPeek } from '../../../packages/studio-protocol/src/public'

/**
 * What a window asks of a session beside its pty (`terminal.peek`,
 * `terminal.refreshPullRequests`), served where the session runs: the
 * server's peek service over a terminal agent's state and a chat's
 * transcript, and its terminal agents' pull request marks.
 */
export type StudioTerminalAgents = {
  peek(sessionId: string): Promise<ConversationPeek>
  refreshPullRequests(sessionId: string): Promise<boolean>
}
