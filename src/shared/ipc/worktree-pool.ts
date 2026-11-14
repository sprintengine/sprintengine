// The pool of reusable agent worktrees: its settings' bounds and defaults, and
// the shapes a client reads, which the Studio protocol defines
// (`packages/studio-protocol/src/worktree-types.ts`) and this file re-exports
// under the same names. ../electron-api.ts re-exports everything here.
//
// The Studio core owns every pool (server/core/studio-worktree-pool.ts). A
// window reaches it through the protocol's `worktrees.*` methods
// (renderer/src/studio/worktrees.ts); it never runs a git command against a
// slot itself. Leases are not asked for here: an agent worktree created with
// `fromPool` (GitWorktreeCreateInput) comes from the pool.

import type {
  WorktreeDependencyInstallSetting,
  WorktreePoolSettings,
} from '../../../packages/studio-protocol/src/public'
import { comparablePath } from '../host-paths'

export type {
  WorktreeDependencyInstallReason,
  WorktreeDependencyInstallSetting,
  WorktreeDependencyInstallState,
  WorktreeDependencyInstallView,
  WorktreeDiskUsage,
  WorktreeInventory,
  WorktreeInventoryEntry,
  WorktreeInventoryInput,
  WorktreeInventoryProject,
  WorktreePoolActionInput,
  WorktreePoolActionResult,
  WorktreePoolHeldAction,
  WorktreePoolHeldReason,
  WorktreePoolSettings,
  WorktreePoolSlotState,
  WorktreePoolSlotView,
  WorktreePoolSnapshot,
} from '../../../packages/studio-protocol/src/public'

/** The longest install command kept; anything longer is a paste gone wrong. */
export const WORKTREE_INSTALL_COMMAND_MAX = 1_000

export const WORKTREE_POOL_KEEP_IDLE_MAX = 6
export const WORKTREE_POOL_MAX_SLOTS_MIN = 2
/** The hard ceiling `maxSlots` is clamped to. */
export const WORKTREE_POOL_MAX_SLOTS_CEILING = 32
export const WORKTREE_POOL_DISK_LIMIT_CHOICES_GB = [10, 20, 30, 50, 100, 200] as const
/** What Settings ▸ Worktrees offers for `idleReturnMinutes`. */
export const WORKTREE_POOL_IDLE_RETURN_CHOICES_MIN = [30, 60, 120, 240, 480, 1440] as const
/**
 * The bounds `idleReturnMinutes` is clamped to. Below a quarter of an hour a
 * person reading a reply in another chat would come back to a worktree being
 * checked out again; past a week the pool is as full as it never gave any back.
 */
export const WORKTREE_POOL_IDLE_RETURN_MIN_MINUTES = 15
export const WORKTREE_POOL_IDLE_RETURN_MAX_MINUTES = 7 * 24 * 60
export const DEFAULT_WORKTREE_POOL_SETTINGS: WorktreePoolSettings = {
  enabled: true,
  keepIdle: 3,
  maxSlots: 12,
  diskLimitGb: null,
  idleReturnMinutes: 120,
  dependencyInstall: {},
}

/** The entry `settings.dependencyInstall` holds for a project, however its path is spelled. */
export function dependencyInstallSettingFor(
  settings: Pick<WorktreePoolSettings, 'dependencyInstall'>,
  repoRoot: string,
): WorktreeDependencyInstallSetting | null {
  const wanted = comparablePath(repoRoot)
  for (const [root, setting] of Object.entries(settings.dependencyInstall ?? {})) {
    if (comparablePath(root) === wanted) return setting
  }
  return null
}

/**
 * An agent as a pool lease names it: its chat and its id together. Agent ids
 * are unique only within a chat (older chats each have an `agent-1`), so a
 * bare id says nothing about whose lease a slot is.
 */
export function agentLeaseKey(workspaceId: string, agentId: string): string {
  return `${workspaceId}\u0000${agentId}`
}
