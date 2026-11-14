import {
  STUDIO_WORKTREES_CAPABILITY,
  type AgentWorktreeCleanupInput,
  type AgentWorktreeCleanupReport,
  type GitCommandResult,
  type GitWorktreeCreated,
  type GitWorktreeCreateInput,
  type GitWorktreeOperationResult,
  type GitWorktreeRemoveInput,
  type GitWorktreeRestoreInput,
  type GitWorktreeRestoreResult,
  type SettledChatDeletionOutcome,
  type SettledChatDeletionPlan,
  type StudioMethod,
  type StudioMethodParams,
  type StudioMethodResult,
  type WorktreeDependencyInstallView,
  type WorktreeInventory,
  type WorktreeInventoryInput,
  type WorktreePoolActionInput,
  type WorktreePoolActionResult,
  type WorktreePoolSettings,
  type WorktreePoolSnapshot,
} from '../../../../packages/studio-protocol/src/public'
import { followWindowStudioPush, rereadOnReopen } from './windowStudioPush'
import { windowStudioClient } from './windowStudioClient'

// The window's way to the worktrees its Studio's agents run in: the Studio
// protocol's `worktrees.*` and `settledChats.*` and their streams, over the
// window's own connection, as every other client reaches them. Settings ▸
// Worktrees, the Worktree manager, a new chat's worktree, a chat's worktree
// brought back, the agents' worktree cleanup, the install toasts and rows,
// and Delete on a settled chat call these. The members keep the names the
// window has always called them by, so a caller changes only where it
// imports them from.

export type WorktreesApi = {
  /** A repository's worktree pool, or null when it has none. */
  getWorktreePoolSnapshot(repoRoot: string): Promise<WorktreePoolSnapshot | null>
  /** Hear every pool's snapshot as it moves; filter on the repository. Returns the unsubscriber. */
  onWorktreePoolChanged(cb: (snapshot: WorktreePoolSnapshot) => void): () => void
  /** A person's decision on a held pool worktree, the removal or clearing of an idle one, a lease given back or caught up. */
  worktreePoolAction(input: WorktreePoolActionInput): Promise<WorktreePoolActionResult>
  /** Remove a worktree the pool does not own, checked as a pool eviction is. */
  removeOtherWorktree(input: { repoRoot: string; path: string }): Promise<WorktreePoolActionResult>
  getWorktreePoolSettings(): Promise<WorktreePoolSettings>
  setWorktreePoolSettings(patch: Partial<WorktreePoolSettings>): Promise<WorktreePoolSettings>
  /** Every worktree of these projects and of every pool, for Settings ▸ Worktrees. */
  getWorktreeInventory(input: WorktreeInventoryInput): Promise<WorktreeInventory>
  /** The dependency installs leased worktrees are running now. */
  listWorktreeInstalls(): Promise<WorktreeDependencyInstallView[]>
  /** A leased worktree's dependency install started, moved on, or ended. Returns the unsubscriber. */
  onWorktreeInstallChanged(cb: (view: WorktreeDependencyInstallView) => void): () => void
  cancelWorktreeInstall(id: string): Promise<boolean>
  createGitWorktree(input: GitWorktreeCreateInput): Promise<GitWorktreeOperationResult<GitWorktreeCreated>>
  /** Recreate a chat's worktree the cleanup gave back, at its old path, from the branch it kept. */
  restoreGitWorktree(input: GitWorktreeRestoreInput): Promise<GitWorktreeRestoreResult>
  removeGitWorktree(input: GitWorktreeRemoveInput): Promise<GitWorktreeOperationResult<GitCommandResult>>
  /** Remove agent worktrees that are clean and merged; report (and keep) the rest. */
  cleanupAgentWorktrees(input: AgentWorktreeCleanupInput): Promise<AgentWorktreeCleanupReport>
  /** What deleting each of these settled chats would do: its worktree's fate, or why it cannot be deleted now. */
  planSettledChatDeletion(workspaceIds: string[]): Promise<SettledChatDeletionPlan[]>
  /** Delete these settled chats: history, record, and the worktree each owns (given back to the pool, or removed). */
  deleteSettledChats(workspaceIds: string[]): Promise<SettledChatDeletionOutcome[]>
}

const UNSERVED = 'This Studio does not serve its worktrees to this window.'

function randomId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

async function call<M extends StudioMethod>(method: M, params: StudioMethodParams<M>): Promise<StudioMethodResult<M>> {
  const client = await windowStudioClient()
  if (!client.supports(STUDIO_WORKTREES_CAPABILITY)) throw new Error(UNSERVED)
  return client.request(method, params)
}

/** A write, under a command id of its own. */
function act<M extends StudioMethod>(
  method: M,
  params: Omit<StudioMethodParams<M>, 'commandId'>,
): Promise<StudioMethodResult<M>> {
  return call(method, { ...params, commandId: randomId() } as StudioMethodParams<M>)
}

export const worktreesApi: WorktreesApi = {
  getWorktreePoolSnapshot: async (repoRoot) => (await call('worktrees.poolSnapshot', { repoRoot })).snapshot,
  onWorktreePoolChanged: (cb) =>
    followWindowStudioPush({
      topic: 'worktrees.poolChanged',
      params: {},
      capability: STUDIO_WORKTREES_CAPABILITY,
      onPayload: cb,
    }),
  worktreePoolAction: (action) => act('worktrees.poolAction', { action }),
  removeOtherWorktree: (input) => act('worktrees.removeOther', input),
  getWorktreePoolSettings: () => call('worktrees.poolSettings', {}),
  setWorktreePoolSettings: (patch) => act('worktrees.setPoolSettings', { patch }),
  getWorktreeInventory: (input) =>
    call('worktrees.inventory', { repoRoots: input.repoRoots, ...(input.measure ? { measure: true } : {}) }),
  listWorktreeInstalls: async () => (await call('worktrees.installs', {})).installs,
  onWorktreeInstallChanged: (cb) =>
    followWindowStudioPush({
      topic: 'worktrees.installChanged',
      params: {},
      capability: STUDIO_WORKTREES_CAPABILITY,
      onPayload: cb,
      // The installs running now, each as its own change.
      reread: rereadOnReopen(
        async () => (await call('worktrees.installs', {})).installs,
        (installs) => installs.forEach(cb),
      ),
    }),
  cancelWorktreeInstall: async (id) => (await act('worktrees.cancelInstall', { id })).cancelled,
  createGitWorktree: (input) => act('worktrees.create', { input }),
  restoreGitWorktree: (input) => act('worktrees.restore', { input }),
  removeGitWorktree: (input) => act('worktrees.remove', { input }),
  cleanupAgentWorktrees: (input) => act('worktrees.cleanupAgents', { input }),
  planSettledChatDeletion: async (workspaceIds) => (await call('settledChats.planDelete', { workspaceIds })).plans,
  deleteSettledChats: async (workspaceIds) => (await act('settledChats.delete', { workspaceIds })).outcomes,
}
