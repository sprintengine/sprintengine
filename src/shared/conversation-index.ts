import type { ConversationKey } from './conversation-runtime'

// A workspace's history, read off its transcripts: the contract's shapes,
// under the names app code has always used.
export type {
  ConversationHistoryThread as ConversationThread,
  ConversationSearchHit,
  ConversationSearchResult,
  ConversationThreadsResult,
} from '../../packages/conversation-protocol/src/public'

export type ConversationWorkspaceKey = Pick<ConversationKey, 'workspaceRoot' | 'workspaceId'>
export type ConversationSearchInput = ConversationWorkspaceKey & { query: string; requestId?: string }
export type ConversationRenameInput = ConversationKey & { title: string }
