import {
  STUDIO_FILES_CAPABILITY,
  STUDIO_GIT_CAPABILITY,
  type BranchStepDiff,
  type BranchStepSelection,
  type BranchStepsSnapshot,
  type Changelist,
  type CloneProgress,
  type GitBranchSnapshot,
  type GitCheckoutChange,
  type GitCommandResult,
  type GitConflictFileContent,
  type GitFileBaseResult,
  type GitFileHunksResult,
  type GitFileStage,
  type GitFileStageResult,
  type GitGraphOptions,
  type GitGraphSnapshot,
  type GitHubOwnerListResult,
  type GitHubRepoListResult,
  type GitHubTokenStatus,
  type GitHunkRef,
  type GitHunkScope,
  type GitPatchResult,
  type GitRepoOperation,
  type GitResetMode,
  type GitStashListSnapshot,
  type GitStatusSnapshot,
  type GitWorktreeListSnapshot,
  type GitWorktreeOperationResult,
  type HostGhStatus,
  type ModuleWorkspaceGitInfoResult,
  type NewProjectInput,
  type NewProjectResult,
  type RepositoryCloneInput,
  type RepositoryCloneResult,
  type RepositoryIdentityRead,
  type RevFileResult,
  type StudioCapability,
  type StudioMethod,
  type StudioMethodParams,
  type StudioMethodResult,
  type VersionControlProviderProbe,
  type WorkspaceChangeSummary,
} from '../../../../packages/studio-protocol/src/public'
import { followWindowStudioPush } from './windowStudioPush'
import { windowStudioClient } from './windowStudioClient'

// The window's way to git on its Studio's machine: the Studio protocol's
// `git.*`, `github.*` and `versionControl.*` and their streams, over the
// window's own connection, as every other client reaches them. The Git pane,
// the diff view, the editor's gutter, the commit window, the sidebar, the
// clone and new-project dialogs and Settings › Version control call these.
// The members keep the names the window has always called them by, so a
// caller changes only where it imports them from.
//
// Saving a patch through the system's save dialog stays the shell's
// (`window.api.saveGitPatch`), as do the worktree pool's steps.

type CheckoutChangeListener = (change: GitCheckoutChange) => void

/** A checkout's key, spelled as the server's watch spells it (git-repo-watch.ts `checkoutKey`). */
function gitCheckoutKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/u, '')
}

export type GitApi = {
  /** Hear a checkout's changes; one stream per checkout however many views follow it. Returns the unsubscriber. */
  watchGitCheckout(checkoutPath: string, cb: CheckoutChangeListener): () => void
  getGitRepoRoot(folderPath: string, hostId?: string): Promise<string | null>
  getGitStatus(repoRoot: string): Promise<GitStatusSnapshot>
  checkIgnored(repoRoot: string, relativePaths: string[]): Promise<string[]>
  getWorkspaceChangeSummary(checkoutPath: string): Promise<WorkspaceChangeSummary>
  getBranchSteps(checkoutPath: string): Promise<BranchStepsSnapshot>
  getBranchStepDiff(checkoutPath: string, selection: BranchStepSelection): Promise<BranchStepDiff>
  getGitFileAtRev(repoRoot: string, rev: string, filePath: string): Promise<RevFileResult>
  getGitFileBase(repoRoot: string, filePath: string): Promise<GitFileBaseResult>
  getGitFileAtStage(repoRoot: string, filePath: string, stage: GitFileStage): Promise<GitFileStageResult>
  getGitBranches(repoRoot: string): Promise<GitBranchSnapshot>
  getGitRepositoryIdentity(folderPath: string): Promise<RepositoryIdentityRead>
  getModuleWorkspaceGitInfo(folderPath: string): Promise<ModuleWorkspaceGitInfoResult>
  getGitCommitGraph(repoRoot: string, options?: GitGraphOptions): Promise<GitGraphSnapshot>
  getGitConflictFile(repoRoot: string, filePath: string): Promise<GitConflictFileContent | null>
  resolveGitConflict(repoRoot: string, filePath: string, content: string): Promise<GitCommandResult>
  getGitFileHunks(repoRoot: string, filePath: string, scope: GitHunkScope): Promise<GitFileHunksResult>
  stageGitHunk(ref: GitHunkRef): Promise<GitCommandResult>
  unstageGitHunk(ref: GitHunkRef): Promise<GitCommandResult>
  stageGitPaths(repoRoot: string, paths: string[]): Promise<GitCommandResult>
  unstageGitPaths(repoRoot: string, paths: string[]): Promise<GitCommandResult>
  revertGitPaths(repoRoot: string, paths: string[]): Promise<GitCommandResult>
  commitGitChanges(repoRoot: string, message: string): Promise<GitCommandResult>
  pushGitBranch(repoRoot: string): Promise<GitCommandResult>
  fetchGitRemotes(repoRoot: string): Promise<GitCommandResult>
  pullGitBranchWithStash(repoRoot: string): Promise<GitCommandResult>
  switchGitBranch(repoRoot: string, branchName: string): Promise<GitCommandResult>
  mergeGitRef(repoRoot: string, ref: string): Promise<GitCommandResult>
  rebaseGitBranch(repoRoot: string, ontoRef: string): Promise<GitCommandResult>
  cherryPickGitCommit(repoRoot: string, commitHash: string): Promise<GitCommandResult>
  revertGitCommit(repoRoot: string, commitHash: string): Promise<GitCommandResult>
  resetGitBranchToCommit(repoRoot: string, commitHash: string, mode: GitResetMode): Promise<GitCommandResult>
  deleteGitBranch(repoRoot: string, branchName: string, force?: boolean): Promise<GitCommandResult>
  renameGitBranch(repoRoot: string, branchName: string, newName: string): Promise<GitCommandResult>
  continueGitOperation(repoRoot: string, operation: GitRepoOperation): Promise<GitCommandResult>
  abortGitOperation(repoRoot: string, operation: GitRepoOperation): Promise<GitCommandResult>
  listGitStashes(repoRoot: string): Promise<GitStashListSnapshot>
  pushGitStash(repoRoot: string, message: string, includeUntracked?: boolean): Promise<GitCommandResult>
  applyGitStash(repoRoot: string, index: number, expectedHash: string, pop?: boolean): Promise<GitCommandResult>
  dropGitStash(repoRoot: string, index: number, expectedHash: string): Promise<GitCommandResult>
  checkoutGitCommit(repoRoot: string, commitHash: string): Promise<GitCommandResult>
  checkoutGitCommitAsBranch(repoRoot: string, branchName: string, commitHash: string): Promise<GitCommandResult>
  createGitTagFromCommit(repoRoot: string, tagName: string, commitHash: string): Promise<GitCommandResult>
  listGitWorktrees(repoRoot: string): Promise<GitWorktreeOperationResult<GitWorktreeListSnapshot>>
  pruneGitWorktrees(repoRoot: string): Promise<GitWorktreeOperationResult<GitCommandResult>>
  unlockAgentGitWorktree(repoRoot: string, worktreePath: string): Promise<GitWorktreeOperationResult<GitCommandResult>>
  getGitChangelists(repoRoot: string): Promise<Changelist[]>
  setActiveGitChangelist(repoRoot: string, id: string): Promise<Changelist[]>
  createGitChangelist(
    repoRoot: string,
    input: { name: string; comment?: string; activate?: boolean; paths?: string[] },
  ): Promise<Changelist[]>
  renameGitChangelist(repoRoot: string, id: string, input: { name: string; comment?: string }): Promise<Changelist[]>
  deleteGitChangelist(repoRoot: string, id: string): Promise<Changelist[]>
  moveGitChangelistPaths(repoRoot: string, id: string, paths: string[]): Promise<Changelist[]>
  onGitChangelistsChanged(cb: (event: { repoRoot: string }) => void): () => void
  createGitPatch(repoRoot: string, paths: string[], cached?: boolean): Promise<GitPatchResult>
  getGitHubTokenStatus(): Promise<GitHubTokenStatus>
  setGitHubToken(token: string): Promise<GitHubTokenStatus>
  clearGitHubToken(): Promise<GitHubTokenStatus>
  listGitHubRepos(): Promise<GitHubRepoListResult>
  cloneRepository(input: RepositoryCloneInput): Promise<RepositoryCloneResult>
  cancelRepositoryClone(cloneId: string): Promise<void>
  createNewProject(input: NewProjectInput): Promise<NewProjectResult>
  listGitHubOwners(): Promise<GitHubOwnerListResult>
  onRepositoryCloneProgress(cb: (progress: CloneProgress) => void): () => void
  probeVersionControlProviders(): Promise<VersionControlProviderProbe[]>
  probeHostGh(hostId: string): Promise<HostGhStatus | null>
}

const UNSERVED = 'This Studio does not serve git to this window.'

function randomId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

async function call<M extends StudioMethod>(
  method: M,
  params: StudioMethodParams<M>,
  capability: StudioCapability = STUDIO_GIT_CAPABILITY,
): Promise<StudioMethodResult<M>> {
  const client = await windowStudioClient()
  if (!client.supports(capability)) throw new Error(UNSERVED)
  return client.request(method, params)
}

/** A write, under a command id of its own. */
function act<M extends StudioMethod>(
  method: M,
  params: Omit<StudioMethodParams<M>, 'commandId'>,
): Promise<StudioMethodResult<M>> {
  return call(method, { ...params, commandId: randomId() } as StudioMethodParams<M>)
}

// One stream per checkout for the whole window, however many views follow it.
const checkoutFollows = new Map<string, { listeners: Set<CheckoutChangeListener>; stop: () => void }>()

export { windowHasStudio } from './windowStudioClient'

export const gitApi: GitApi = {
  watchGitCheckout(checkoutPath, cb) {
    const key = gitCheckoutKey(checkoutPath)
    let follow = checkoutFollows.get(key)
    if (!follow) {
      const listeners = new Set<CheckoutChangeListener>()
      const stop = followWindowStudioPush({
        topic: 'git.checkoutChanged',
        params: { checkoutPath: key },
        capability: STUDIO_GIT_CAPABILITY,
        onPayload: (change) => {
          for (const listener of [...listeners]) {
            try {
              listener(change)
            } catch (error) {
              console.warn('[git] checkout change listener threw', error)
            }
          }
        },
      })
      follow = { listeners, stop }
      checkoutFollows.set(key, follow)
    }
    follow.listeners.add(cb)
    let active = true
    return () => {
      if (!active) return
      active = false
      const current = checkoutFollows.get(key)
      if (!current) return
      current.listeners.delete(cb)
      if (current.listeners.size === 0) {
        checkoutFollows.delete(key)
        current.stop()
      }
    }
  },
  getGitRepoRoot: async (folderPath, hostId) =>
    (await call('files.repoRoot', { folderPath, ...(hostId === undefined ? {} : { hostId }) }, STUDIO_FILES_CAPABILITY))
      .repoRoot,
  getGitStatus: (repoRoot) => call('git.status', { repoRoot }),
  checkIgnored: async (repoRoot, paths) => (await call('git.checkIgnored', { repoRoot, paths })).paths,
  getWorkspaceChangeSummary: (checkoutPath) => call('git.changeSummary', { checkoutPath }),
  getBranchSteps: (checkoutPath) => call('git.branchSteps', { checkoutPath }),
  getBranchStepDiff: (checkoutPath, selection) => call('git.branchStepDiff', { checkoutPath, selection }),
  getGitFileAtRev: (repoRoot, rev, path) => call('git.fileAtRev', { repoRoot, rev, path }),
  getGitFileBase: (repoRoot, path) => call('git.fileBase', { repoRoot, path }),
  getGitFileAtStage: (repoRoot, path, stage) => call('git.fileAtStage', { repoRoot, path, stage }),
  getGitBranches: (repoRoot) => call('git.branches', { repoRoot }),
  getGitRepositoryIdentity: (folderPath) => call('git.repositoryIdentity', { folderPath }),
  getModuleWorkspaceGitInfo: (folderPath) => call('git.moduleWorkspaceInfo', { folderPath }),
  getGitCommitGraph: (repoRoot, options = {}) =>
    call('git.commitGraph', {
      repoRoot,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.skip === undefined ? {} : { skip: options.skip }),
    }),
  getGitConflictFile: async (repoRoot, path) => (await call('git.conflictFile', { repoRoot, path })).file,
  resolveGitConflict: (repoRoot, path, content) => act('git.resolveConflict', { repoRoot, path, content }),
  getGitFileHunks: (repoRoot, path, scope) => call('git.fileHunks', { repoRoot, path, scope }),
  stageGitHunk: (ref) => act('git.stageHunk', { ref }),
  unstageGitHunk: (ref) => act('git.unstageHunk', { ref }),
  stageGitPaths: (repoRoot, paths) => act('git.stage', { repoRoot, paths }),
  unstageGitPaths: (repoRoot, paths) => act('git.unstage', { repoRoot, paths }),
  revertGitPaths: (repoRoot, paths) => act('git.revertPaths', { repoRoot, paths }),
  commitGitChanges: (repoRoot, message) => act('git.commit', { repoRoot, message }),
  pushGitBranch: (repoRoot) => act('git.push', { repoRoot }),
  fetchGitRemotes: (repoRoot) => act('git.fetch', { repoRoot }),
  pullGitBranchWithStash: (repoRoot) => act('git.pullWithStash', { repoRoot }),
  switchGitBranch: (repoRoot, branch) => act('git.switchBranch', { repoRoot, branch }),
  mergeGitRef: (repoRoot, ref) => act('git.mergeRef', { repoRoot, ref }),
  rebaseGitBranch: (repoRoot, onto) => act('git.rebase', { repoRoot, onto }),
  cherryPickGitCommit: (repoRoot, commit) => act('git.cherryPick', { repoRoot, commit }),
  revertGitCommit: (repoRoot, commit) => act('git.revertCommit', { repoRoot, commit }),
  resetGitBranchToCommit: (repoRoot, commit, mode) => act('git.resetToCommit', { repoRoot, commit, mode }),
  deleteGitBranch: (repoRoot, branch, force) =>
    act('git.deleteBranch', { repoRoot, branch, ...(force === undefined ? {} : { force }) }),
  renameGitBranch: (repoRoot, branch, newName) => act('git.renameBranch', { repoRoot, branch, newName }),
  continueGitOperation: (repoRoot, operation) => act('git.continueOperation', { repoRoot, operation }),
  abortGitOperation: (repoRoot, operation) => act('git.abortOperation', { repoRoot, operation }),
  listGitStashes: (repoRoot) => call('git.stashList', { repoRoot }),
  pushGitStash: (repoRoot, message, includeUntracked) =>
    act('git.stashPush', { repoRoot, message, ...(includeUntracked === undefined ? {} : { includeUntracked }) }),
  applyGitStash: (repoRoot, index, expectedHash, pop) =>
    act('git.stashApply', { repoRoot, index, expectedHash, ...(pop === undefined ? {} : { pop }) }),
  dropGitStash: (repoRoot, index, expectedHash) => act('git.stashDrop', { repoRoot, index, expectedHash }),
  checkoutGitCommit: (repoRoot, commit) => act('git.checkoutCommit', { repoRoot, commit }),
  checkoutGitCommitAsBranch: (repoRoot, branch, commit) =>
    act('git.checkoutCommitAsBranch', { repoRoot, branch, commit }),
  createGitTagFromCommit: (repoRoot, tag, commit) => act('git.tagCommit', { repoRoot, tag, commit }),
  listGitWorktrees: (repoRoot) => call('git.worktrees', { repoRoot }),
  pruneGitWorktrees: (repoRoot) => act('git.pruneWorktrees', { repoRoot }),
  unlockAgentGitWorktree: (repoRoot, worktreePath) => act('git.unlockAgentWorktree', { repoRoot, worktreePath }),
  getGitChangelists: async (repoRoot) => (await call('git.changelists', { repoRoot })).changelists,
  setActiveGitChangelist: async (repoRoot, id) => (await act('git.setActiveChangelist', { repoRoot, id })).changelists,
  createGitChangelist: async (repoRoot, input) =>
    (await act('git.createChangelist', { repoRoot, ...input })).changelists,
  renameGitChangelist: async (repoRoot, id, input) =>
    (await act('git.renameChangelist', { repoRoot, id, ...input })).changelists,
  deleteGitChangelist: async (repoRoot, id) => (await act('git.deleteChangelist', { repoRoot, id })).changelists,
  moveGitChangelistPaths: async (repoRoot, id, paths) =>
    (await act('git.moveChangelistPaths', { repoRoot, id, paths })).changelists,
  onGitChangelistsChanged: (cb) =>
    followWindowStudioPush({
      topic: 'git.changelistsChanged',
      params: {},
      capability: STUDIO_GIT_CAPABILITY,
      onPayload: cb,
    }),
  createGitPatch: (repoRoot, paths, cached) =>
    call('git.createPatch', { repoRoot, paths, ...(cached === undefined ? {} : { cached }) }),
  getGitHubTokenStatus: () => call('github.tokenStatus', {}),
  setGitHubToken: (token) => act('github.setToken', { token }),
  clearGitHubToken: () => act('github.clearToken', {}),
  listGitHubRepos: () => call('github.listRepos', {}),
  cloneRepository: (input) => act('github.clone', { input }),
  cancelRepositoryClone: async (cloneId) => {
    await act('github.cancelClone', { cloneId })
  },
  createNewProject: (input) => act('github.newProject', { input }),
  listGitHubOwners: () => call('github.listOwners', {}),
  onRepositoryCloneProgress: (cb) =>
    followWindowStudioPush({
      topic: 'github.cloneProgress',
      params: {},
      capability: STUDIO_GIT_CAPABILITY,
      onPayload: cb,
    }),
  probeVersionControlProviders: async () => (await call('versionControl.probeProviders', {})).providers,
  probeHostGh: async (hostId) => (await call('versionControl.probeHostGh', { hostId })).status,
}
