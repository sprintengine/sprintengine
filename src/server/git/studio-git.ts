import type { Changelist, CloneProgress } from '../../../packages/studio-protocol/src/public'
import { setAgentWorktreeLockProfile } from '../../main/agent-worktree-lock'
import { diffBranchSelection, listBranchSteps, readFileAtRev } from '../../main/branch-steps'
import {
  abortGitOperation,
  applyGitStash,
  checkoutGitCommit,
  checkoutGitCommitAsBranch,
  cherryPickGitCommit,
  commitGitChanges,
  continueGitOperation,
  createGitTagFromCommit,
  deleteGitBranch,
  dropGitStash,
  fetchGitRemotes,
  getGitBranches,
  getGitCommitGraph,
  getGitConflictFile,
  getGitFileAtStage,
  getGitFileBase,
  getGitStatus,
  listGitStashes,
  listGitWorktrees,
  mergeGitRef,
  pruneGitWorktrees,
  pullGitBranchWithStash,
  pushGitBranch,
  pushGitStash,
  rebaseGitBranch,
  renameGitBranch,
  resetGitBranchToCommit,
  resolveGitConflict,
  revertGitCommit,
  revertGitPaths,
  stageGitPaths,
  switchGitBranch,
  unlockAgentGitWorktree,
  unstageGitPaths,
} from '../../main/git'
import {
  createGitChangelist,
  deleteGitChangelist,
  getGitChangelists,
  moveGitChangelistPaths,
  renameGitChangelist,
  setActiveGitChangelist,
} from '../../main/git-changelists'
import { cloneRepository } from '../../main/git-clone'
import { readFileHunks, stageGitHunk, unstageGitHunk } from '../../main/git-hunks'
import { checkIgnoredPaths } from '../../main/git-ignore'
import { createGitPatch } from '../../main/git-patch'
import { sharedGhRunner } from '../../main/github/gh'
import { createGhHostTokenResolver, type GhHostTokenResolver } from '../../main/github/host-token'
import { listGitHubRepos } from '../../main/github-repos'
import { createNewProject, listGitHubOwners, realNewProjectDeps } from '../../main/new-project'
import { readRepositoryIdentityRead } from '../../main/repository-identity'
import { getWorkspaceChangeSummary } from '../../main/workspace-change-summary'
import { readFolderGitInfo } from '../../main/workspace-git-info'
import { announceChangelistsChanged, onChangelistsChanged } from './changelist-events'
import { getGitRepoWatch, onCheckoutChanges } from './checkout-watch'
import { createVersionControl } from './version-control'

// Git on this Studio's machine: what the protocol's `git.*`, `github.*` and
// `versionControl.*` methods run here, and their three streams. The core
// builds one for every server, so each machine answers for its own
// checkouts. It holds no rule about who asks: the router's handlers
// (`rpc/studio-git.ts`) hold the repository a client names before any call
// here, and the method table holds who may run what.
//
// Each method takes its protocol params without the command id, with its
// paths already resolved.

import type { StudioGit, StudioGitOptions } from './studio-git-types'

export type { StudioGit, StudioGitOptions } from './studio-git-types'

type Run = StudioGit['run']

export function createStudioGit(options: StudioGitOptions): StudioGit {
  const store = () => options.dataDir()
  // An agent's worktree is locked under this Studio's profile, as git's own lock reason says.
  setAgentWorktreeLockProfile(options.dataDir())
  const tokens = options.githubTokens
  const versionControl = createVersionControl()
  const cloneListeners = new Set<(progress: CloneProgress) => void>()
  const clones = new Map<string, AbortController>()
  let hostTokens: GhHostTokenResolver | null = null
  const newProjectDeps = realNewProjectDeps(async () => (tokens ? tokens.resolveToken() : null))
  const noAccount = (): never => {
    throw new Error('This Studio holds no GitHub account.')
  }
  /** A changelist write answers with the reconciled set and tells every client to re-read. */
  const changed = async (repoRoot: string, write: Promise<Changelist[]>) => {
    const changelists = await write
    announceChangelistsChanged(repoRoot)
    return { changelists }
  }

  const run: Run = {
    'git.status': ({ repoRoot }) => getGitStatus(repoRoot),
    'git.checkIgnored': async ({ repoRoot, paths }) => ({
      paths: Array.from(await checkIgnoredPaths(repoRoot, paths)),
    }),
    'git.changeSummary': ({ checkoutPath }) => getWorkspaceChangeSummary({ checkoutPath }),
    'git.branchSteps': ({ checkoutPath }) => listBranchSteps(checkoutPath),
    'git.branchStepDiff': ({ checkoutPath, selection }) => diffBranchSelection(checkoutPath, selection),
    'git.fileAtRev': ({ repoRoot, rev, path }) => readFileAtRev(repoRoot, rev, path),
    'git.fileBase': ({ repoRoot, path }) => getGitFileBase(repoRoot, path),
    'git.fileAtStage': ({ repoRoot, path, stage }) => getGitFileAtStage(repoRoot, path, stage),
    'git.branches': ({ repoRoot }) => getGitBranches(repoRoot),
    'git.repositoryIdentity': ({ folderPath }) => readRepositoryIdentityRead(folderPath),
    'git.moduleWorkspaceInfo': ({ folderPath }) => readFolderGitInfo(folderPath),
    'git.commitGraph': ({ repoRoot, limit, skip }) =>
      getGitCommitGraph(repoRoot, {
        ...(limit === undefined ? {} : { limit }),
        ...(skip === undefined ? {} : { skip }),
      }),
    'git.conflictFile': async ({ repoRoot, path }) => ({ file: await getGitConflictFile(repoRoot, path) }),
    'git.fileHunks': ({ repoRoot, path, scope }) => readFileHunks(repoRoot, path, scope),
    'git.stashList': ({ repoRoot }) => listGitStashes(repoRoot),
    'git.worktrees': ({ repoRoot }) => listGitWorktrees(repoRoot),
    'git.changelists': async ({ repoRoot }) => ({ changelists: await getGitChangelists(store(), repoRoot) }),
    'git.createPatch': ({ repoRoot, paths, cached }) => createGitPatch(repoRoot, paths, { cached: cached === true }),

    'git.stage': ({ repoRoot, paths }) => stageGitPaths(repoRoot, paths),
    'git.unstage': ({ repoRoot, paths }) => unstageGitPaths(repoRoot, paths),
    'git.stageHunk': ({ ref }) => stageGitHunk(ref),
    'git.unstageHunk': ({ ref }) => unstageGitHunk(ref),
    'git.commit': ({ repoRoot, message }) => commitGitChanges(repoRoot, message),
    'git.resolveConflict': ({ repoRoot, path, content }) => resolveGitConflict(repoRoot, path, content),
    'git.stashPush': ({ repoRoot, message, includeUntracked }) => pushGitStash(repoRoot, message, includeUntracked),
    'git.setActiveChangelist': ({ repoRoot, id }) => changed(repoRoot, setActiveGitChangelist(store(), repoRoot, id)),
    'git.createChangelist': ({ repoRoot, ...input }) =>
      changed(repoRoot, createGitChangelist(store(), repoRoot, input)),
    'git.renameChangelist': ({ repoRoot, id, ...input }) =>
      changed(repoRoot, renameGitChangelist(store(), repoRoot, id, input)),
    'git.deleteChangelist': ({ repoRoot, id }) => changed(repoRoot, deleteGitChangelist(store(), repoRoot, id)),
    'git.moveChangelistPaths': ({ repoRoot, id, paths }) =>
      changed(repoRoot, moveGitChangelistPaths(store(), repoRoot, id, paths)),

    'git.revertPaths': ({ repoRoot, paths }) => revertGitPaths(repoRoot, paths),
    'git.push': ({ repoRoot }) => pushGitBranch(repoRoot),
    'git.fetch': ({ repoRoot }) => fetchGitRemotes(repoRoot),
    'git.pullWithStash': ({ repoRoot }) => pullGitBranchWithStash(repoRoot),
    'git.switchBranch': ({ repoRoot, branch }) => switchGitBranch(repoRoot, branch),
    'git.mergeRef': ({ repoRoot, ref }) => mergeGitRef(repoRoot, ref),
    'git.rebase': ({ repoRoot, onto }) => rebaseGitBranch(repoRoot, onto),
    'git.cherryPick': ({ repoRoot, commit }) => cherryPickGitCommit(repoRoot, commit),
    'git.revertCommit': ({ repoRoot, commit }) => revertGitCommit(repoRoot, commit),
    'git.resetToCommit': ({ repoRoot, commit, mode }) => resetGitBranchToCommit(repoRoot, commit, mode),
    'git.deleteBranch': ({ repoRoot, branch, force }) => deleteGitBranch(repoRoot, branch, force),
    'git.renameBranch': ({ repoRoot, branch, newName }) => renameGitBranch(repoRoot, branch, newName),
    'git.continueOperation': ({ repoRoot, operation }) => continueGitOperation(repoRoot, operation),
    'git.abortOperation': ({ repoRoot, operation }) => abortGitOperation(repoRoot, operation),
    'git.stashApply': ({ repoRoot, index, expectedHash, pop }) => applyGitStash(repoRoot, index, expectedHash, pop),
    'git.stashDrop': ({ repoRoot, index, expectedHash }) => dropGitStash(repoRoot, index, expectedHash),
    'git.checkoutCommit': ({ repoRoot, commit }) => checkoutGitCommit(repoRoot, commit),
    'git.checkoutCommitAsBranch': ({ repoRoot, branch, commit }) => checkoutGitCommitAsBranch(repoRoot, branch, commit),
    'git.tagCommit': ({ repoRoot, tag, commit }) => createGitTagFromCommit(repoRoot, tag, commit),
    'git.pruneWorktrees': ({ repoRoot }) => pruneGitWorktrees(repoRoot),
    'git.unlockAgentWorktree': ({ repoRoot, worktreePath }) => unlockAgentGitWorktree(repoRoot, worktreePath),

    'github.tokenStatus': () => (tokens ? tokens.getStatus() : noAccount()),
    'github.setToken': ({ token }) => (tokens ? tokens.writeToken(token) : noAccount()),
    'github.clearToken': () => (tokens ? tokens.clearToken() : noAccount()),
    'github.listRepos': () => (tokens ? listGitHubRepos(tokens) : noAccount()),
    'github.listOwners': () => listGitHubOwners(newProjectDeps),
    'github.clone': async ({ input }) => {
      const { cloneId } = input
      const controller = new AbortController()
      if (cloneId) clones.set(cloneId, controller)
      try {
        return await cloneRepository(
          { url: input.url, parentDir: input.parentDir, folderName: input.folderName, branch: input.branch ?? null },
          {
            token: tokens ? await tokens.resolveToken() : null,
            resolveHostToken: (host) => (hostTokens ??= createGhHostTokenResolver(sharedGhRunner()))(host),
            signal: controller.signal,
            ...(cloneId
              ? {
                  onProgress: (progress: Omit<CloneProgress, 'cloneId'>) => {
                    for (const listener of [...cloneListeners]) listener({ cloneId, ...progress } as CloneProgress)
                  },
                }
              : {}),
          },
        )
      } finally {
        if (cloneId && clones.get(cloneId) === controller) clones.delete(cloneId)
      }
    },
    'github.cancelClone': async ({ cloneId }) => {
      clones.get(cloneId)?.abort()
      return {}
    },
    'github.newProject': ({ input }) =>
      createNewProject(
        { parentDir: input.parentDir, name: input.name, publish: input.publish ?? null },
        newProjectDeps,
      ),

    'versionControl.probeProviders': async () => ({ providers: await versionControl.probeProviders() }),
    'versionControl.probeHostGh': async ({ hostId }) => ({ status: await versionControl.probeHostGh(hostId) }),
  }

  return {
    run,
    followCheckout(checkoutPath, listener) {
      const watch = getGitRepoWatch()
      let key: string | null = null
      let stopped = false
      const stop = onCheckoutChanges((changes) => {
        if (key === null) return
        for (const change of changes) if (change.checkoutKey === key) listener(change)
      })
      void watch.retain(checkoutPath).then((retained) => {
        if (stopped) watch.release(checkoutPath)
        else key = retained
      })
      return () => {
        if (stopped) return
        stopped = true
        stop()
        if (key !== null) watch.release(checkoutPath)
      }
    },
    onChangelistsChanged: (listener) => onChangelistsChanged((repoRoot) => listener({ repoRoot })),
    onCloneProgress(listener) {
      cloneListeners.add(listener)
      return () => void cloneListeners.delete(listener)
    },
    hasGitHub: tokens !== undefined,
  }
}
