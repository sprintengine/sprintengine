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
import { machineRouteOfPath } from '../../../shared/machine-spelling'
import { askStudioAtPath, askStudioOfPaths } from './paneStudio'
import { followWindowStudioPush, rereadOnReopen } from './windowStudioPush'
import { windowStudioClient } from './windowStudioClient'

// The window's way to the worktrees its chats run in: the Studio protocol's
// `worktrees.*` and `settledChats.*` and their streams, as every other client
// reaches them. Settings ▸ Worktrees, the Worktree manager, a new chat's
// worktree, a chat's worktree brought back, the agents' worktree cleanup, the
// install toasts and rows, and Delete on a settled chat call these. The
// members keep the names the window has always called them by, so a caller
// changes only where it imports them from.
//
// A worktree is made, listed, given back and removed by the Studio on the
// machine its project is on, from that machine's own pool: the window's own
// Studio for a folder on this computer, an SSH machine's or a WSL
// distribution's for one there (`paneStudio.ts`, as the Files and Git panes
// ask). Each step goes where the folders it names are; a pool lease, which
// names none, goes to the machine of the worktree it was handed out for, and
// a machine's pool settings to the machine named. The installs and the
// streams are the window's own Studio's.

export type WorktreesApi = {
  /** A repository's worktree pool, or null when it has none. */
  getWorktreePoolSnapshot(repoRoot: string): Promise<WorktreePoolSnapshot | null>
  /** Hear every pool's snapshot as it moves; filter on the repository. Returns the unsubscriber. */
  onWorktreePoolChanged(cb: (snapshot: WorktreePoolSnapshot) => void): () => void
  /**
   * A person's decision on a held pool worktree, the removal or clearing of an
   * idle one, a lease given back or caught up. A lease names no folder: `at` is
   * the worktree it was handed out for, whose machine's pool holds it.
   */
  worktreePoolAction(input: WorktreePoolActionInput, at?: string): Promise<WorktreePoolActionResult>
  /** Remove a worktree the pool does not own, checked as a pool eviction is. */
  removeOtherWorktree(input: { repoRoot: string; path: string }): Promise<WorktreePoolActionResult>
  /** The pool's settings: this computer's Studio's, or with `at`, those of the Studio on `at`'s machine. */
  getWorktreePoolSettings(at?: string): Promise<WorktreePoolSettings>
  setWorktreePoolSettings(patch: Partial<WorktreePoolSettings>, at?: string): Promise<WorktreePoolSettings>
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

/** Ask the Studio on the machine the folders in `params` are on, or at `at`'s machine when given. */
function call<M extends StudioMethod>(
  method: M,
  params: StudioMethodParams<M>,
  at?: string,
): Promise<StudioMethodResult<M>> {
  return at === undefined
    ? askStudioOfPaths(method, params, STUDIO_WORKTREES_CAPABILITY, UNSERVED)
    : askStudioAtPath(at, method, params, STUDIO_WORKTREES_CAPABILITY, UNSERVED)
}

/** A write, under a command id of its own. */
function act<M extends StudioMethod>(
  method: M,
  params: Omit<StudioMethodParams<M>, 'commandId'>,
  at?: string,
): Promise<StudioMethodResult<M>> {
  return call(method, { ...params, commandId: randomId() } as StudioMethodParams<M>, at)
}

/** What only the window's own Studio keeps: the pool's settings, the installs. */
async function callOwn<M extends StudioMethod>(
  method: M,
  params: StudioMethodParams<M>,
): Promise<StudioMethodResult<M>> {
  const client = await windowStudioClient()
  if (!client.supports(STUDIO_WORKTREES_CAPABILITY)) throw new Error(UNSERVED)
  return client.request(method, params)
}

/** The machine a path is on, by its route; '' for this computer's. */
function machineKeyOf(path: string): string {
  return machineRouteOfPath(path) ?? ''
}

/**
 * Every project's worktrees, each asked of its own machine's Studio: this
 * computer's together, and each machine's together. A machine that cannot be
 * asked lists its projects with why, as a project git could not read is.
 */
async function inventoryAcrossMachines(input: WorktreeInventoryInput): Promise<WorktreeInventory> {
  const byMachine = new Map<string, string[]>([['', []]])
  for (const root of input.repoRoots) {
    const key = machineKeyOf(root)
    byMachine.set(key, [...(byMachine.get(key) ?? []), root])
  }
  const measure = input.measure ? { measure: true as const } : {}
  const answers = await Promise.all(
    [...byMachine].map(async ([key, repoRoots]): Promise<WorktreeInventory> => {
      if (key === '') return callOwn('worktrees.inventory', { repoRoots, ...measure })
      try {
        return await call('worktrees.inventory', { repoRoots, ...measure }, repoRoots[0])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          projects: repoRoots.map((repoRoot) => ({
            repoRoot,
            defaultRef: null,
            pool: null,
            worktrees: [],
            error: message,
          })),
          measuredAt: null,
        }
      }
    }),
  )
  const [own, ...machines] = answers
  return {
    projects: answers.flatMap((answer) => answer.projects),
    measuredAt: own?.measuredAt ?? machines.find((answer) => answer.measuredAt !== null)?.measuredAt ?? null,
  }
}

/**
 * An agent worktree cleanup of one repository, asked of its machine: what the
 * window's records keep there is sent, and a path on another machine, which
 * cannot be in that repository, is not.
 */
function cleanupOnItsMachine(input: AgentWorktreeCleanupInput): Promise<AgentWorktreeCleanupReport> {
  const machine = machineKeyOf(input.repoRoot)
  const protectedPaths = input.protectedPaths.filter((path) => machineKeyOf(path) === machine)
  return act('worktrees.cleanupAgents', { input: { ...input, protectedPaths } })
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
  worktreePoolAction: (action, at) => act('worktrees.poolAction', { action }, at),
  removeOtherWorktree: (input) => act('worktrees.removeOther', input),
  getWorktreePoolSettings: (at) =>
    at === undefined ? callOwn('worktrees.poolSettings', {}) : call('worktrees.poolSettings', {}, at),
  setWorktreePoolSettings: (patch, at) =>
    at === undefined
      ? callOwn('worktrees.setPoolSettings', { patch, commandId: randomId() })
      : act('worktrees.setPoolSettings', { patch }, at),
  getWorktreeInventory: inventoryAcrossMachines,
  listWorktreeInstalls: async () => (await callOwn('worktrees.installs', {})).installs,
  onWorktreeInstallChanged: (cb) =>
    followWindowStudioPush({
      topic: 'worktrees.installChanged',
      params: {},
      capability: STUDIO_WORKTREES_CAPABILITY,
      onPayload: cb,
      // The installs running now, each as its own change.
      reread: rereadOnReopen(
        async () => (await callOwn('worktrees.installs', {})).installs,
        (installs) => installs.forEach(cb),
      ),
    }),
  cancelWorktreeInstall: async (id) =>
    (await callOwn('worktrees.cancelInstall', { id, commandId: randomId() })).cancelled,
  createGitWorktree: (input) => act('worktrees.create', { input }),
  restoreGitWorktree: (input) => act('worktrees.restore', { input }),
  removeGitWorktree: (input) => act('worktrees.remove', { input }),
  cleanupAgentWorktrees: cleanupOnItsMachine,
  // A settled chat is a record of the window's own Studio, which deletes it.
  planSettledChatDeletion: async (workspaceIds) => (await callOwn('settledChats.planDelete', { workspaceIds })).plans,
  deleteSettledChats: async (workspaceIds) =>
    (await callOwn('settledChats.delete', { workspaceIds, commandId: randomId() })).outcomes,
}
