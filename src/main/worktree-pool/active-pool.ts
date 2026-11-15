import type { WorktreePoolService } from './worktree-pool-service'

/**
 * The worktree pool this process leases agent worktrees from, if it has one.
 *
 * The process that runs the Studio core keeps it, as the core installs it
 * (server/core/studio-worktree-pool.ts): the desktop's main in process, the
 * desktop's server out of process, a WSL or SSH machine's server. Its records
 * live in that data directory, and two processes driving the same slots would
 * race, so the desktop's shell keeps none when its server runs apart. A process
 * with none here creates a fresh worktree from the same default branch.
 */
let active: WorktreePoolService | null = null

export function installWorktreePool(pool: WorktreePoolService | null): void {
  active = pool
}

export function activeWorktreePool(): WorktreePoolService | null {
  return active
}
