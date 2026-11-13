import type {
  ConversationHighlightColor,
  StudioChatDeleted,
  StudioChatDeletePlan,
  StudioChatSearchAnswer,
} from '../../../packages/studio-protocol/src/public'
import type { ConversationLifecycle, ConversationLifecycleFailure } from '../../main/automation/conversation-lifecycle'
import { deepRedactLocalPaths } from '../../main/mobile/control/path-safety'
import type { WorkspaceRegistryActor } from '../../shared/workspace-registry'
import type {
  SettledChatDeletionOutcome,
  SettledChatDeletionPlan,
  SettledChatWorktreePlan,
} from '../../shared/ipc/settled-chats'

// A chat's record beyond its rest, as the protocol serves it
// (`chat-lifecycle`): its marks, name and Auto compact written by the core's
// own lifecycle (conversation-lifecycle.ts), the record every device lists;
// its deletion by the same deletion a window's Delete makes; and a search of
// what was said in the chats the sidebar lists. Every server's core gives
// these, so a phone or another desktop reaches the chats of whichever Studio
// it asks.
//
// Who may ask is the router's grant check, made first. `byOwner` says whose
// write the registry records: an owner's connection's as the gateway's, a
// paired client's as a paired device's, as settle and visit record theirs.

export type StudioChatLifecycleRefusal = {
  ok: false
  code: 'not_found' | 'conflict' | 'invalid_params' | 'unavailable'
  message: string
}

type Code = StudioChatLifecycleRefusal['code']
/** An answer, or a refusal in one of the codes its method declares. */
export type StudioChatLifecycleAnswer<T, C extends Code = Code> =
  { ok: true; value: T } | (StudioChatLifecycleRefusal & { code: C })
type Answer<T, C extends Code> = Promise<StudioChatLifecycleAnswer<T, C>>
type Writing = 'not_found' | 'invalid_params' | 'unavailable'

export type StudioChatLifecycleDomain = {
  markUnread(workspaceId: string, byOwner: boolean): Answer<{ lastVisitedAt: number }, Writing | 'conflict'>
  snooze(
    workspaceId: string,
    until: number | null,
    byOwner: boolean,
  ): Answer<{ snoozedUntil: number | null }, Writing | 'conflict'>
  highlight(
    workspaceId: string,
    change: { starred?: boolean; color?: ConversationHighlightColor | null },
    byOwner: boolean,
  ): Answer<{ starred: boolean; color: ConversationHighlightColor | null }, Writing>
  setAutoSettle(workspaceId: string, enabled: boolean, byOwner: boolean): Answer<{ enabled: boolean }, Writing>
  setAutoCompact(workspaceId: string, enabled: boolean, byOwner: boolean): Answer<{ enabled: boolean }, Writing>
  rename(workspaceId: string, name: string, byOwner: boolean): Answer<{ name: string }, Writing>
  deletePlan(workspaceId: string): Answer<StudioChatDeletePlan, 'unavailable'>
  delete(workspaceId: string, byOwner: boolean): Answer<StudioChatDeleted, 'conflict' | 'unavailable'>
  searchChats(query: string): Promise<StudioChatSearchAnswer>
}

/** Deleting settled chats, as a window's Delete does (settled-chat-deletion-app.ts). */
export type StudioChatDeletion = {
  plan(workspaceIds: readonly string[]): Promise<SettledChatDeletionPlan[]>
  delete(workspaceIds: readonly string[]): Promise<SettledChatDeletionOutcome[]>
}

export type StudioChatLifecycleDeps = {
  lifecycle: Pick<
    ConversationLifecycle,
    'markUnread' | 'snooze' | 'highlight' | 'setAutoSettle' | 'setAutoCompact' | 'rename'
  >
  /** The deletion that records its removal as `actor`'s; made on first ask. */
  deletion: (actor: 'ui' | 'mobile') => StudioChatDeletion
  /** Whether this Studio has a record of the chat at all. */
  hasChat(workspaceId: string): boolean
  searchChats(query: string): Promise<StudioChatSearchAnswer>
}

/** A lifecycle refusal in the protocol's words: a chat at work, settled or with nothing finished is a conflict. */
/**
 * A refusal as it crosses to another device: a message from the filesystem
 * (a record or history that could not be written or removed) names the path it
 * failed on, so its paths are redacted.
 */
function refused<C extends Code>(code: C, message: string): StudioChatLifecycleRefusal & { code: C } {
  return { ok: false, code, message: deepRedactLocalPaths(message) }
}

function refusal(failure: ConversationLifecycleFailure): StudioChatLifecycleRefusal {
  switch (failure.code) {
    case 'unknown_workspace':
      return refused('not_found', failure.message)
    case 'working':
    case 'settled':
    case 'nothing_finished':
    case 'stale':
    case 'not_applicable':
      return refused('conflict', failure.message)
    case 'invalid_arguments':
      return refused('invalid_params', failure.message)
    case 'write_failed':
      return refused('unavailable', failure.message)
  }
}

/** A worktree as a delete's plan tells it: never its path. */
function plannedWorktree(worktree: SettledChatWorktreePlan): StudioChatDeletePlan['worktrees'][number] {
  return {
    name: worktree.name,
    branch: worktree.branch,
    pooled: worktree.pooled,
    changedPaths: worktree.changedPaths,
    unpushedCommits: worktree.unpushedCommits,
    fate: worktree.fate,
    ...(worktree.keptBecause ? { keptBecause: worktree.keptBecause } : {}),
  }
}

export function createStudioChatLifecycleDomain(deps: StudioChatLifecycleDeps): StudioChatLifecycleDomain {
  const actor = (byOwner: boolean): WorkspaceRegistryActor => (byOwner ? 'gateway' : 'mobile')
  const deletions = new Map<'ui' | 'mobile', StudioChatDeletion>()
  const deletion = (byOwner: boolean) => {
    const who = byOwner ? 'ui' : 'mobile'
    let made = deletions.get(who)
    if (!made) deletions.set(who, (made = deps.deletion(who)))
    return made
  }
  // Every write but mark unread is answered at once; each is shaped the same way.
  function answered<R extends { ok: true }, T>(
    done: R | ConversationLifecycleFailure,
    shape: (done: R) => T,
  ): StudioChatLifecycleAnswer<T, Code> {
    return done.ok ? { ok: true, value: shape(done) } : refusal(done)
  }
  return {
    markUnread: async (workspaceId, byOwner) =>
      answered(await deps.lifecycle.markUnread(workspaceId, actor(byOwner)), (done) => ({
        lastVisitedAt: done.lastVisitedAt,
      })) as StudioChatLifecycleAnswer<{ lastVisitedAt: number }, Writing | 'conflict'>,
    snooze: async (workspaceId, until, byOwner) =>
      answered(deps.lifecycle.snooze(workspaceId, until, actor(byOwner)), (done) => ({
        snoozedUntil: done.snoozedUntil,
      })) as StudioChatLifecycleAnswer<{ snoozedUntil: number | null }, Writing | 'conflict'>,
    highlight: async (workspaceId, change, byOwner) =>
      answered(deps.lifecycle.highlight(workspaceId, change, actor(byOwner)), (done) => ({
        starred: done.starred,
        color: done.color,
      })) as StudioChatLifecycleAnswer<{ starred: boolean; color: ConversationHighlightColor | null }, Writing>,
    setAutoSettle: async (workspaceId, enabled, byOwner) =>
      answered(deps.lifecycle.setAutoSettle(workspaceId, enabled, actor(byOwner)), (done) => ({
        enabled: done.autoSettle,
      })) as StudioChatLifecycleAnswer<{ enabled: boolean }, Writing>,
    setAutoCompact: async (workspaceId, enabled, byOwner) =>
      answered(deps.lifecycle.setAutoCompact(workspaceId, enabled, actor(byOwner)), (done) => ({
        enabled: done.autoCompact,
      })) as StudioChatLifecycleAnswer<{ enabled: boolean }, Writing>,
    rename: async (workspaceId, name, byOwner) =>
      answered(deps.lifecycle.rename(workspaceId, name, actor(byOwner)), (done) => ({
        name: done.name,
      })) as StudioChatLifecycleAnswer<{ name: string }, Writing>,
    async deletePlan(workspaceId) {
      if (!deps.hasChat(workspaceId)) return { ok: true, value: { gone: true, worktrees: [] } }
      try {
        const [plan] = await deletion(false).plan([workspaceId])
        return {
          ok: true,
          value: {
            worktrees: (plan?.worktrees ?? []).map(plannedWorktree),
            ...(plan?.refused ? { refused: deepRedactLocalPaths(plan.refused) } : {}),
          },
        }
      } catch (error) {
        return refused('unavailable', error instanceof Error ? error.message : String(error))
      }
    },
    async delete(workspaceId, byOwner) {
      // Asked again once it went through: it is gone, as was asked.
      if (!deps.hasChat(workspaceId)) return { ok: true, value: { gone: true, worktrees: [] } }
      let outcome: SettledChatDeletionOutcome | undefined
      try {
        ;[outcome] = await deletion(byOwner).delete([workspaceId])
      } catch (error) {
        return refused('unavailable', error instanceof Error ? error.message : String(error))
      }
      if (!outcome?.ok) return refused('conflict', outcome?.message ?? 'The chat was not deleted.')
      return {
        ok: true,
        value: { worktrees: outcome.worktrees.map(({ path: _path, ...told }) => told) },
      }
    },
    searchChats: (query) => deps.searchChats(query),
  }
}
