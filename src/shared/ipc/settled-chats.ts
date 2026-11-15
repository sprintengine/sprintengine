// Deleting settled chats, from Settings ▸ Settled chats and from a settled
// chat's row menu: the Studio protocol's `settledChats.*`, whose shapes are
// defined in `packages/studio-protocol/src/worktree-types.ts` and re-exported
// here under the same names. ../electron-api.ts re-exports everything here.
//
// The Studio core does the deleting (src/main/settled-chat-deletion.ts): it
// holds the chat's record, its transcripts and the worktree pool.

export type {
  SettledChatDeletionOutcome,
  SettledChatDeletionPlan,
  SettledChatWorktreeKeptBecause,
  SettledChatWorktreeOutcome,
  SettledChatWorktreePlan,
} from '../../../packages/studio-protocol/src/public'
