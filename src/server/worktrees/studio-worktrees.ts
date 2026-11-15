import { cleanupAgentWorktreesOnce } from '../../main/agent-worktree-cleanup'
import { createGitWorktree, removeGitWorktree, restoreGitWorktree } from '../../main/git'
import { scopedHost } from '../../main/git-repo-root'
import { withGitHost } from '../../main/git-run'
import { worktreeLeases } from '../../main/worktree-leases'
import { createWorktreeInventory } from '../../main/worktree-pool/worktree-inventory'
import { catchUpResult } from '../../main/worktree-pool/worktree-pool-service'
import { dependencyInstallSettingFor } from '../../shared/ipc/worktree-pool'
import type { StudioWorktreePool } from '../core/studio-worktree-pool'
import type { StudioWorktrees } from './studio-worktrees-types'

// The protocol's `worktrees.*` and `settledChats.*`, answered from the pool
// the Studio core keeps (core/studio-worktree-pool.ts): Settings ▸ Worktrees,
// the Worktree manager, a new chat's worktree, a chat's worktree brought
// back, the agents' worktree cleanup and deleting settled chats. Each step
// takes the pool or a path hold (worktree-leases.ts), which are this
// process's, as are the turns that start in those folders. The params come
// here checked by the method table (`worktrees.ts`).

export function createStudioWorktrees(worktrees: StudioWorktreePool): StudioWorktrees {
  const { pool, installer } = worktrees
  const inventory = createWorktreeInventory({
    pool,
    livePaths: worktrees.liveWorkPaths,
    knownWorkspaceIds: worktrees.knownWorkspaceIds,
    removeWorktree: removeGitWorktree,
  })
  // Built on first use, one per actor: the record of a delete says whose it was.
  const deletions = new Map<'ui' | 'mobile', ReturnType<StudioWorktreePool['settledChatDeletion']>>()
  const deletion = (owner: boolean) => {
    const actor = owner ? 'ui' : 'mobile'
    let made = deletions.get(actor)
    if (!made) {
      made = worktrees.settledChatDeletion(actor)
      deletions.set(actor, made)
    }
    return made
  }

  return {
    onPoolChanged: worktrees.onPoolChanged,
    onInstallChanged: worktrees.onInstallChanged,
    run: {
      'worktrees.poolSnapshot': async ({ repoRoot }) => ({ snapshot: await pool.snapshot(repoRoot) }),
      'worktrees.poolSettings': () => pool.getSettings(),
      // Every project's install choice at once, as the page holds them;
      // checked entry by entry where it is stored (normalizePoolSettings).
      'worktrees.setPoolSettings': ({ patch }) => pool.updateSettings(patch),
      'worktrees.inventory': ({ repoRoots, measure }) => inventory.read({ repoRoots, measure: measure === true }),
      'worktrees.poolAction': async ({ action }) => {
        if (action.kind === 'release') return pool.action(action)
        if (action.kind === 'catch-up') {
          const outcome = await pool.catchUp(action.leaseId)
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
        return pool.action(action)
      },
      // Remove or Free up space on a worktree the pool does not own: checked
      // as an eviction is (live work, hidden edits, ignored files that may be work).
      'worktrees.removeOther': (input) => inventory.removeOther(input),
      'worktrees.installs': async () => ({ installs: installer?.list() ?? [] }),
      'worktrees.cancelInstall': async ({ id }) => ({ cancelled: installer?.cancel(id) ?? false }),
      // A window's launch always waits for the worktree's dependency install:
      // the agent it starts next would otherwise run in a half-installed checkout.
      'worktrees.create': ({ input }) =>
        withGitHost(scopedHost(input.hostId), () => createGitWorktree({ ...input, dependencyInstall: 'wait' })),
      // A window bringing a chat's worktree back is a start like a turn's:
      // held shared, so a return or removal of the path waits its turn rather
      // than running under it. A turn's own restore runs under the turn's
      // hold (chat-folder-guard.ts), not through here.
      'worktrees.restore': async ({ input }) => {
        const hold = await worktreeLeases.acquireShared(input.path, { reason: 'its chat is bringing it back' })
        if ('busy' in hold) return { ok: false, message: hold.busy }
        try {
          return await withGitHost(scopedHost(input.hostId), () => restoreGitWorktree(input))
        } finally {
          hold.release()
        }
      },
      'worktrees.remove': ({ input }) => removeGitWorktree(input),
      // The client names the paths and agents its records still use; the live
      // terminals' and chats' folders are added here, and the pool takes back
      // its own slots.
      'worktrees.cleanupAgents': ({ input }) =>
        cleanupAgentWorktreesOnce(input, {
          livePaths: worktrees.liveWorkPaths,
          pool,
          knownWorkspaceIds: worktrees.knownWorkspaceIds,
        }),
      'settledChats.planDelete': async ({ workspaceIds }, asker) => ({
        plans: await deletion(asker.owner).plan(workspaceIds),
      }),
      'settledChats.delete': async ({ workspaceIds }, asker) => ({
        outcomes: await deletion(asker.owner).delete(workspaceIds),
      }),
    },
  }
}
