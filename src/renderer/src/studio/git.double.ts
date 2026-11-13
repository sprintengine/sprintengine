import type * as Git from './git'

// A stand-in for the window's git (`git.ts`), for tests of what calls it.
// Every suite gets it (`tests/setup.ts` mocks the module with this one); the
// module's own suite asks for the real one.
//
// A call goes, as it is made, to the member of the same name a suite set on
// `window.api` (the names the window's IPC once had, which suites have always
// stubbed), else to `gitDouble`'s, which a suite may set too. Unset, a follow
// hears nothing and anything else rejects, as an unstubbed IPC member did.

type Api = Git.GitApi

function notStubbed(name: string): Promise<never> {
  return Promise.reject(new Error(`git.${name} is not stubbed in this test`))
}

function blank(): Api {
  return {
    watchGitCheckout: () => () => undefined,
    getGitRepoRoot: () => notStubbed('getGitRepoRoot'),
    getGitStatus: () => notStubbed('getGitStatus'),
    checkIgnored: () => notStubbed('checkIgnored'),
    getWorkspaceChangeSummary: () => notStubbed('getWorkspaceChangeSummary'),
    getBranchSteps: () => notStubbed('getBranchSteps'),
    getBranchStepDiff: () => notStubbed('getBranchStepDiff'),
    getGitFileAtRev: () => notStubbed('getGitFileAtRev'),
    getGitFileBase: () => notStubbed('getGitFileBase'),
    getGitFileAtStage: () => notStubbed('getGitFileAtStage'),
    getGitBranches: () => notStubbed('getGitBranches'),
    getGitRepositoryIdentity: () => notStubbed('getGitRepositoryIdentity'),
    getModuleWorkspaceGitInfo: () => notStubbed('getModuleWorkspaceGitInfo'),
    getGitCommitGraph: () => notStubbed('getGitCommitGraph'),
    getGitConflictFile: () => notStubbed('getGitConflictFile'),
    resolveGitConflict: () => notStubbed('resolveGitConflict'),
    getGitFileHunks: () => notStubbed('getGitFileHunks'),
    stageGitHunk: () => notStubbed('stageGitHunk'),
    unstageGitHunk: () => notStubbed('unstageGitHunk'),
    stageGitPaths: () => notStubbed('stageGitPaths'),
    unstageGitPaths: () => notStubbed('unstageGitPaths'),
    revertGitPaths: () => notStubbed('revertGitPaths'),
    commitGitChanges: () => notStubbed('commitGitChanges'),
    pushGitBranch: () => notStubbed('pushGitBranch'),
    fetchGitRemotes: () => notStubbed('fetchGitRemotes'),
    pullGitBranchWithStash: () => notStubbed('pullGitBranchWithStash'),
    switchGitBranch: () => notStubbed('switchGitBranch'),
    mergeGitRef: () => notStubbed('mergeGitRef'),
    rebaseGitBranch: () => notStubbed('rebaseGitBranch'),
    cherryPickGitCommit: () => notStubbed('cherryPickGitCommit'),
    revertGitCommit: () => notStubbed('revertGitCommit'),
    resetGitBranchToCommit: () => notStubbed('resetGitBranchToCommit'),
    deleteGitBranch: () => notStubbed('deleteGitBranch'),
    renameGitBranch: () => notStubbed('renameGitBranch'),
    continueGitOperation: () => notStubbed('continueGitOperation'),
    abortGitOperation: () => notStubbed('abortGitOperation'),
    listGitStashes: () => notStubbed('listGitStashes'),
    pushGitStash: () => notStubbed('pushGitStash'),
    applyGitStash: () => notStubbed('applyGitStash'),
    dropGitStash: () => notStubbed('dropGitStash'),
    checkoutGitCommit: () => notStubbed('checkoutGitCommit'),
    checkoutGitCommitAsBranch: () => notStubbed('checkoutGitCommitAsBranch'),
    createGitTagFromCommit: () => notStubbed('createGitTagFromCommit'),
    listGitWorktrees: () => notStubbed('listGitWorktrees'),
    pruneGitWorktrees: () => notStubbed('pruneGitWorktrees'),
    unlockAgentGitWorktree: () => notStubbed('unlockAgentGitWorktree'),
    getGitChangelists: () => notStubbed('getGitChangelists'),
    setActiveGitChangelist: () => notStubbed('setActiveGitChangelist'),
    createGitChangelist: () => notStubbed('createGitChangelist'),
    renameGitChangelist: () => notStubbed('renameGitChangelist'),
    deleteGitChangelist: () => notStubbed('deleteGitChangelist'),
    moveGitChangelistPaths: () => notStubbed('moveGitChangelistPaths'),
    onGitChangelistsChanged: () => () => undefined,
    createGitPatch: () => notStubbed('createGitPatch'),
    getGitHubTokenStatus: () => notStubbed('getGitHubTokenStatus'),
    setGitHubToken: () => notStubbed('setGitHubToken'),
    clearGitHubToken: () => notStubbed('clearGitHubToken'),
    listGitHubRepos: () => notStubbed('listGitHubRepos'),
    cloneRepository: () => notStubbed('cloneRepository'),
    cancelRepositoryClone: () => notStubbed('cancelRepositoryClone'),
    createNewProject: () => notStubbed('createNewProject'),
    listGitHubOwners: () => notStubbed('listGitHubOwners'),
    onRepositoryCloneProgress: () => () => undefined,
    probeVersionControlProviders: () => notStubbed('probeVersionControlProviders'),
    probeHostGh: () => notStubbed('probeHostGh'),
  } as Api
}

/** What each call answers when no suite stubbed `window.api` for it: set a member to change it. */
export const gitDouble: Api = blank()

/** Put every member back as it was. */
export function resetGitDouble(): void {
  Object.assign(gitDouble, blank())
}

export { windowHasStudio } from './windowStudioClient'

function stubbed(name: keyof Api): ((...args: unknown[]) => unknown) | null {
  const api = (globalThis as { window?: { api?: Record<string, unknown> } }).window?.api
  const member = api?.[name]
  return typeof member === 'function' ? (member as (...args: unknown[]) => unknown) : null
}

export const gitApi: Api = Object.fromEntries(
  (Object.keys(blank()) as Array<keyof Api>).map((name) => [
    name,
    (...args: unknown[]) => (stubbed(name) ?? (gitDouble[name] as (...args: unknown[]) => unknown))(...args),
  ]),
) as Api
