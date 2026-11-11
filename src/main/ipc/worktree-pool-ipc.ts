import type { IpcMain } from 'electron'
import { isAbsolute } from 'path'
import type { AgentWorktreeCleanupInput } from '../../shared/electron-api'
import type {
  WorktreeDependencyInstallView,
  WorktreeInventory,
  WorktreeInventoryInput,
  WorktreePoolActionInput,
  WorktreePoolActionResult,
  WorktreePoolSettings,
  WorktreePoolSnapshot,
} from '../../shared/ipc/worktree-pool'
import { dependencyInstallSettingFor } from '../../shared/ipc/worktree-pool'
import { cleanupAgentWorktreesOnce } from '../agent-worktree-cleanup'
import { machineAwareIpc } from '../environments/ssh/machine-ipc'
import { createGitWorktree, removeGitWorktree, restoreGitWorktree } from '../git'
import { scopedHost } from '../git-repo-root'
import { withGitHost } from '../git-run'
import { worktreeLeases } from '../worktree-leases'
import { createWorktreeInventory } from '../worktree-pool/worktree-inventory'
import type { DependencyInstaller } from '../worktree-pool/dependency-install'
import { catchUpResult, type WorktreePoolService } from '../worktree-pool/worktree-pool-service'

/**
 * The windows' side of the worktree pool, served by the Studio core that owns
 * it (server/core/studio-worktree-pool.ts): registered by
 * `registerServerDomainIpc`, on main's `ipcMain` in process and on the
 * server's tunnel out of process, so a window reaches the one pool the agents'
 * turns, schedules and tools use.
 *
 * A snapshot of a repository's pool, a person's action on a held or idle
 * slot, the pool's settings, the inventory of every worktree Settings ▸
 * Worktrees draws, the dependency installs leased worktrees run (listed, and
 * cancelled), and the agent worktree steps that lease, bring back, remove or
 * return a worktree (`git:worktree:create|restore|remove|cleanup-agents`):
 * each takes the pool or a path hold (worktree-leases.ts), which have to be
 * the same process's as the turns that start in those folders. A window is
 * sent `worktree-pool:changed` with a pool's snapshot whenever one moves.
 */

const HELD_ACTIONS = new Set(['commit', 'stash', 'discard', 'keep'])

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isRepoRoot(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && isAbsolute(value)
}

/** What the channels below are served from: the core's pool composition. */
export type WorktreePoolIpcDeps = {
  pool: WorktreePoolService
  installer: DependencyInstaller | null
  /** Working directories of the live terminal sessions and chat sessions; nothing here recycles one. */
  liveWorkPaths: () => Promise<string[]>
  /** Every chat id on record, or null when unknown; a worktree holding one's history is kept. */
  knownWorkspaceIds: () => Iterable<string> | null
}

export function registerWorktreePoolIpc(ipcMain: IpcMain, deps: WorktreePoolIpcDeps): void {
  const { pool, installer } = deps
  ipcMain.handle(
    'worktree-pool:action',
    async (_, input: WorktreePoolActionInput): Promise<WorktreePoolActionResult> => {
      if (input?.kind === 'release') {
        return isString(input.leaseId)
          ? pool.action({ kind: 'release', leaseId: input.leaseId })
          : { ok: false, message: 'No lease named.' }
      }
      if (input?.kind === 'catch-up') {
        if (!isString(input.leaseId)) return { ok: false, message: 'No lease named.' }
        const outcome = await pool.catchUp(input.leaseId)
        // A move that changed the lockfile installs again, as a lease does,
        // before the chat that waits on the catch-up starts in it.
        if (outcome.kind === 'moved' && installer) {
          await installer.prepare({
            repoRoot: outcome.repoRoot,
            path: outcome.path,
            branch: outcome.branch,
            setting: dependencyInstallSettingFor(await pool.getSettings(), outcome.repoRoot),
            quiet: true,
          })
        }
        return catchUpResult(outcome)
      }
      if (!input || !isString(input.repoRoot) || !isString(input.slotId)) {
        return { ok: false, message: 'No worktree named.' }
      }
      if (input.kind === 'evict' || input.kind === 'clear-ignored') {
        return pool.action({ kind: input.kind, repoRoot: input.repoRoot, slotId: input.slotId })
      }
      if (input.kind !== 'held' || !HELD_ACTIONS.has(input.action)) return { ok: false, message: 'Unknown action.' }
      return pool.action({
        kind: 'held',
        repoRoot: input.repoRoot,
        slotId: input.slotId,
        action: input.action,
        message: typeof input.message === 'string' ? input.message.slice(0, 2_000) : undefined,
      })
    },
  )

  ipcMain.handle('worktree-pool:snapshot', async (_, repoRoot: unknown): Promise<WorktreePoolSnapshot | null> => {
    if (!isString(repoRoot)) return null
    return pool.snapshot(repoRoot)
  })

  ipcMain.handle('worktree-pool:settings-get', async (): Promise<WorktreePoolSettings> => pool.getSettings())

  ipcMain.handle(
    'worktree-pool:settings-set',
    async (_, patch: Partial<WorktreePoolSettings> | null): Promise<WorktreePoolSettings> => {
      if (!patch || typeof patch !== 'object') return pool.getSettings()
      const clean: Partial<WorktreePoolSettings> = {}
      if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled
      if (typeof patch.keepIdle === 'number') clean.keepIdle = patch.keepIdle
      if (typeof patch.maxSlots === 'number') clean.maxSlots = patch.maxSlots
      if (patch.diskLimitGb === null || typeof patch.diskLimitGb === 'number') clean.diskLimitGb = patch.diskLimitGb
      if (typeof patch.idleReturnMinutes === 'number') clean.idleReturnMinutes = patch.idleReturnMinutes
      // Every project's choice at once, as the page holds them; checked entry
      // by entry where it is stored (normalizePoolSettings).
      if (patch.dependencyInstall && typeof patch.dependencyInstall === 'object') {
        clean.dependencyInstall = patch.dependencyInstall
      }
      return pool.updateSettings(clean)
    },
  )

  // The installs running now (a window opening while one runs), and Cancel on one.
  ipcMain.handle('worktree-install:list', async (): Promise<WorktreeDependencyInstallView[]> => installer?.list() ?? [])
  ipcMain.handle('worktree-install:cancel', async (_, id: unknown): Promise<boolean> =>
    isString(id) ? (installer?.cancel(id) ?? false) : false,
  )

  const inventory = createWorktreeInventory({
    pool,
    livePaths: deps.liveWorkPaths,
    knownWorkspaceIds: deps.knownWorkspaceIds,
    removeWorktree: removeGitWorktree,
  })
  // Remove or Free up space on a worktree the pool does not own: checked as
  // an eviction is (live work, hidden edits, ignored files that may be work).
  ipcMain.handle(
    'worktree-pool:remove-other',
    async (_, input: { repoRoot?: unknown; path?: unknown } | null): Promise<WorktreePoolActionResult> => {
      if (!input || !isString(input.repoRoot) || !isString(input.path)) {
        return { ok: false, message: 'No worktree named.' }
      }
      return inventory.removeOther({ repoRoot: input.repoRoot, path: input.path })
    },
  )
  ipcMain.handle(
    'worktree-pool:inventory',
    async (_, input: WorktreeInventoryInput | null): Promise<WorktreeInventory> =>
      inventory.read({
        repoRoots: Array.isArray(input?.repoRoots) ? input.repoRoots.filter(isString).slice(0, 200) : [],
        measure: input?.measure === true,
      }),
  )

  registerAgentWorktreeIpc(ipcMain, deps)
}

/**
 * The git panel's agent worktree steps that go through the pool or a path
 * hold. A path spelled `ssh://` is refused in words, as main's machine-aware
 * git channels refuse what an SSH machine does not answer.
 */
function registerAgentWorktreeIpc(registry: IpcMain, deps: WorktreePoolIpcDeps): void {
  const ipc = machineAwareIpc(registry, null)
  // A window's launch always waits for the worktree's dependency install: the
  // agent it starts next would otherwise run in a half-installed checkout.
  ipc.handle('git:worktree:create', async (_, input) => {
    return withGitHost(scopedHost(input?.hostId), () => createGitWorktree({ ...input, dependencyInstall: 'wait' }))
  })

  // A window bringing a chat's worktree back is a start like a turn's: held
  // shared, so a return or removal of the path waits its turn rather than
  // running under it (worktree-leases.ts). A turn's own restore runs under the
  // turn's hold (chat-folder-guard.ts), not through here.
  ipc.handle('git:worktree:restore', async (_, input) => {
    const hold =
      typeof input?.path === 'string'
        ? await worktreeLeases.acquireShared(input.path, { reason: 'its chat is bringing it back' })
        : null
    if (hold && 'busy' in hold) return { ok: false, message: hold.busy }
    try {
      return await withGitHost(scopedHost(input?.hostId), () => restoreGitWorktree(input))
    } finally {
      hold?.release()
    }
  })

  ipc.handle('git:worktree:remove', async (_, input) => {
    return removeGitWorktree(input)
  })

  // Agent worktree cleanup (agent-worktree-cleanup.ts): the renderer names the
  // paths and agents its records still use; the live terminals' and chats'
  // folders are added here, and the pool takes back its own slots.
  ipc.handle('git:worktree:cleanup-agents', async (_, input: AgentWorktreeCleanupInput) => {
    if (!input || typeof input.repoRoot !== 'string' || !isRepoRoot(input.repoRoot)) {
      return { repoRoot: String(input?.repoRoot ?? ''), defaultRef: null, entries: [], dryRun: true }
    }
    const strings = (value: unknown): string[] | undefined =>
      Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        : undefined
    const agentIds = strings(input.agentIds)
    const agentKeys = strings(input.agentKeys)
    const keepBranches = strings(input.keepBranches)
    return cleanupAgentWorktreesOnce(
      {
        repoRoot: input.repoRoot,
        protectedPaths: strings(input.protectedPaths) ?? [],
        dryRun: input.dryRun === true,
        ownedOnly: input.ownedOnly === true,
        ...(agentIds ? { agentIds } : {}),
        ...(agentKeys ? { agentKeys } : {}),
        ...(keepBranches ? { keepBranches } : {}),
      },
      { livePaths: deps.liveWorkPaths, pool: deps.pool, knownWorkspaceIds: deps.knownWorkspaceIds },
    )
  })
}
