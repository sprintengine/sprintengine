import {
  studioNoParams,
  studioParams,
  studioParamsRefused as refuse,
  type StudioMethodTable,
  type StudioParsed,
  type StudioTopicTable,
} from './contract.js'
import { STUDIO_GIT_CAPABILITY } from './handshake.js'
import { isStudioPath } from './key.js'
import type { StudioScope } from './scopes.js'
import type {
  BranchStepDiff,
  BranchStepSelection,
  BranchStepsSnapshot,
  Changelist,
  CloneProgress,
  GitBranchSnapshot,
  GitCheckoutChange,
  GitCommandResult,
  GitConflictFileContent,
  GitFileBaseResult,
  GitFileHunksResult,
  GitFileStage,
  GitFileStageResult,
  GitGraphSnapshot,
  GitHubOwnerListResult,
  GitHubRepoListResult,
  GitHubTokenStatus,
  GitHunkRef,
  GitHunkScope,
  GitPatchResult,
  GitRepoOperation,
  GitResetMode,
  GitStashListSnapshot,
  GitStatusSnapshot,
  GitWorktreeListSnapshot,
  GitWorktreeOperationResult,
  HostGhStatus,
  ModuleWorkspaceGitInfoResult,
  NewProjectInput,
  NewProjectResult,
  RepositoryCloneInput,
  RepositoryCloneResult,
  RepositoryIdentityRead,
  RevFileResult,
  VersionControlProviderProbe,
  WorkspaceChangeSummary,
} from './git-types.js'

// Git on a Studio's machine, by the repository's folder: what the Git pane,
// the diff view, the editor's gutter, the commit window, the sidebar's
// grouping and Settings › Version control read and run. Offered as `git` by
// every Studio's core, so each machine's server answers for its own
// checkouts. The repository root a file's diff is read from is `files.repoRoot`.
//
// Grants.
// - Reading a repository is `files:read`.
// - What changes the index or records work (staging, a commit, a stash, a
//   resolved conflict, the app's changelists) is `files:write`.
// - Anything that moves a branch, rewrites history, discards work, talks to
//   a remote with this machine's credentials, or removes the worktrees agents
//   run in is an owner's as well, each with its reason below.
// - The GitHub account Studio holds (its token, its repositories, cloning
//   with it) is an owner's.
// - What the machine's version-control CLIs are is `providers:read`.
//
// A client that is not an owner names a repository only inside the folders
// the Studio knows. A ref, a branch or a commit never starts with `-`, so
// nothing a client sends reaches git as an option.

type Repo = { repoRoot: string }
type Commanded<P> = P & { commandId: string }
type Unknown = 'not_found'
type Read<P, R> = { params: P; result: R; errors: Unknown }
type Write<P, R> = { params: Commanded<P>; result: R; errors: Unknown }

export type StudioGitMethodMap = {
  'git.status': Read<Repo, GitStatusSnapshot>
  /** Which of these repository-relative paths git ignores. */
  'git.checkIgnored': Read<Repo & { paths: string[] }, { paths: string[] }>
  'git.changeSummary': Read<{ checkoutPath: string }, WorkspaceChangeSummary>
  'git.branchSteps': Read<{ checkoutPath: string }, BranchStepsSnapshot>
  'git.branchStepDiff': Read<{ checkoutPath: string; selection: BranchStepSelection }, BranchStepDiff>
  'git.fileAtRev': Read<Repo & { rev: string; path: string }, RevFileResult>
  'git.fileBase': Read<Repo & { path: string }, GitFileBaseResult>
  'git.fileAtStage': Read<Repo & { path: string; stage: GitFileStage }, GitFileStageResult>
  'git.branches': Read<Repo, GitBranchSnapshot>
  /** Which repository a folder is a clone of, and whether that could be told. */
  'git.repositoryIdentity': Read<{ folderPath: string }, RepositoryIdentityRead>
  /** A folder's branch and remotes, as a module's host asks for them. */
  'git.moduleWorkspaceInfo': Read<{ folderPath: string }, ModuleWorkspaceGitInfoResult>
  'git.commitGraph': Read<Repo & { limit?: number; skip?: number }, GitGraphSnapshot>
  'git.conflictFile': Read<Repo & { path: string }, { file: GitConflictFileContent | null }>
  'git.fileHunks': Read<Repo & { path: string; scope: GitHunkScope }, GitFileHunksResult>
  'git.stashList': Read<Repo, GitStashListSnapshot>
  'git.worktrees': Read<Repo, GitWorktreeOperationResult<GitWorktreeListSnapshot>>
  'git.changelists': Read<Repo, { changelists: Changelist[] }>
  /** `git diff` of these paths as text, staged with `cached`. */
  'git.createPatch': Read<Repo & { paths: string[]; cached?: boolean }, GitPatchResult>

  'git.stage': Write<Repo & { paths: string[] }, GitCommandResult>
  'git.unstage': Write<Repo & { paths: string[] }, GitCommandResult>
  'git.stageHunk': Write<{ ref: GitHunkRef }, GitCommandResult>
  'git.unstageHunk': Write<{ ref: GitHunkRef }, GitCommandResult>
  'git.commit': Write<Repo & { message: string }, GitCommandResult>
  'git.resolveConflict': Write<Repo & { path: string; content: string }, GitCommandResult>
  'git.stashPush': Write<Repo & { message: string; includeUntracked?: boolean }, GitCommandResult>
  'git.setActiveChangelist': Write<Repo & { id: string }, { changelists: Changelist[] }>
  'git.createChangelist': Write<
    Repo & { name: string; comment?: string; activate?: boolean; paths?: string[] },
    { changelists: Changelist[] }
  >
  'git.renameChangelist': Write<Repo & { id: string; name: string; comment?: string }, { changelists: Changelist[] }>
  'git.deleteChangelist': Write<Repo & { id: string }, { changelists: Changelist[] }>
  'git.moveChangelistPaths': Write<Repo & { id: string; paths: string[] }, { changelists: Changelist[] }>

  /** Throws away these paths' changes in the working tree. */
  'git.revertPaths': Write<Repo & { paths: string[] }, GitCommandResult>
  'git.push': Write<Repo, GitCommandResult>
  'git.fetch': Write<Repo, GitCommandResult>
  'git.pullWithStash': Write<Repo, GitCommandResult>
  'git.switchBranch': Write<Repo & { branch: string }, GitCommandResult>
  'git.mergeRef': Write<Repo & { ref: string }, GitCommandResult>
  'git.rebase': Write<Repo & { onto: string }, GitCommandResult>
  'git.cherryPick': Write<Repo & { commit: string }, GitCommandResult>
  'git.revertCommit': Write<Repo & { commit: string }, GitCommandResult>
  'git.resetToCommit': Write<Repo & { commit: string; mode: GitResetMode }, GitCommandResult>
  'git.deleteBranch': Write<Repo & { branch: string; force?: boolean }, GitCommandResult>
  'git.renameBranch': Write<Repo & { branch: string; newName: string }, GitCommandResult>
  'git.continueOperation': Write<Repo & { operation: GitRepoOperation }, GitCommandResult>
  'git.abortOperation': Write<Repo & { operation: GitRepoOperation }, GitCommandResult>
  'git.stashApply': Write<Repo & { index: number; expectedHash: string; pop?: boolean }, GitCommandResult>
  'git.stashDrop': Write<Repo & { index: number; expectedHash: string }, GitCommandResult>
  'git.checkoutCommit': Write<Repo & { commit: string }, GitCommandResult>
  'git.checkoutCommitAsBranch': Write<Repo & { branch: string; commit: string }, GitCommandResult>
  'git.tagCommit': Write<Repo & { tag: string; commit: string }, GitCommandResult>
  'git.pruneWorktrees': Write<Repo, GitWorktreeOperationResult<GitCommandResult>>
  'git.unlockAgentWorktree': Write<Repo & { worktreePath: string }, GitWorktreeOperationResult<GitCommandResult>>

  'github.tokenStatus': { params: Record<string, never>; result: GitHubTokenStatus }
  'github.setToken': { params: Commanded<{ token: string }>; result: GitHubTokenStatus }
  'github.clearToken': { params: Commanded<Record<never, never>>; result: GitHubTokenStatus }
  'github.listRepos': { params: Record<string, never>; result: GitHubRepoListResult }
  'github.listOwners': { params: Record<string, never>; result: GitHubOwnerListResult }
  /** Clone into a folder here; `cloneId` names it for `github.cloneProgress` and `github.cancelClone`. */
  'github.clone': Write<{ input: RepositoryCloneInput }, RepositoryCloneResult>
  'github.cancelClone': { params: Commanded<{ cloneId: string }>; result: Record<string, never> }
  'github.newProject': Write<{ input: NewProjectInput }, NewProjectResult>

  /** The machine's git, gh, glab and tea, and the login each forge CLI holds. */
  'versionControl.probeProviders': {
    params: Record<string, never>
    result: { providers: VersionControlProviderProbe[] }
  }
  /** `gh` on one of this desktop's other machines (a WSL distribution, an SSH machine). */
  'versionControl.probeHostGh': { params: { hostId: string }; result: { status: HostGhStatus | null } }
}

export type StudioGitMethod = keyof StudioGitMethodMap

export type StudioGitTopicMap = {
  /** A checkout's working tree or refs moved; a client re-reads what it shows. */
  'git.checkoutChanged': { params: { checkoutPath: string }; payload: GitCheckoutChange; stream: 'push' }
  /** A repository's changelists changed; a client re-reads them. */
  'git.changelistsChanged': { params: Record<string, never>; payload: { repoRoot: string }; stream: 'push' }
  /** How each clone in progress is going. */
  'github.cloneProgress': { params: Record<string, never>; payload: CloneProgress; stream: 'push' }
}

// ── Validation ──────────────────────────────────────────────────────────────

const MAX_TEXT = 4 * 1024 * 1024
const MAX_PATHS = 10_000

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}
function text(value: unknown, max = MAX_TEXT): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0')
}
/** A ref, branch, tag or commit: never empty, never read by git as an option. */
function ref(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1000 &&
    !value.startsWith('-') &&
    !/[\0\n\r]/u.test(value)
  )
}
function relative(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
}
function paths(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_PATHS && value.every(relative)
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000
}
function optional<T>(value: unknown, check: (value: unknown) => value is T): boolean {
  return value === undefined || check(value)
}
function bool(value: unknown): value is boolean {
  return typeof value === 'boolean'
}
function oneOf<T extends string>(values: readonly T[]) {
  return (value: unknown): value is T => typeof value === 'string' && (values as readonly string[]).includes(value)
}

type Check = (value: unknown) => boolean
type Shape = Record<string, readonly [Check, string] | readonly [Check, string, 'optional']>

/** Read params member by member: each checked, an optional one dropped when absent, anything else dropped. */
function shaped<P>(shape: Shape): (value: Record<string, unknown>) => StudioParsed<P> {
  return (value) => {
    const out: Record<string, unknown> = {}
    for (const [key, [check, words, optionalMember]] of Object.entries(shape)) {
      if (value[key] === undefined && optionalMember) continue
      if (!check(value[key])) return refuse(words)
      out[key] = Array.isArray(value[key]) ? [...(value[key] as unknown[])] : value[key]
    }
    return studioParams(out as P)
  }
}

function commanded<P>(read: (value: Record<string, unknown>) => StudioParsed<P>) {
  return (value: Record<string, unknown>): StudioParsed<Commanded<P>> => {
    if (!id(value.commandId)) return refuse('"commandId" must be a string of 1 to 200 characters.')
    const parsed = read(value)
    return parsed.ok ? studioParams({ ...parsed.params, commandId: value.commandId }) : parsed
  }
}

const REPO = [isStudioPath, '"repoRoot" is the repository’s folder.'] as const
const CHECKOUT = [isStudioPath, '"checkoutPath" is the checkout’s folder.'] as const
const FOLDER = [isStudioPath, '"folderPath" is a folder on the Studio’s machine.'] as const
const PATH = [relative, '"path" names a file in the repository.'] as const
const PATHS = [paths, '"paths" lists files in the repository.'] as const
const COMMIT = [ref, '"commit" is a commit, never starting with "-".'] as const
const BRANCH = [ref, '"branch" is a branch name, never starting with "-".'] as const
const MESSAGE = [text, '"message" is text.'] as const
const LIST_ID = [id, '"id" names a changelist.'] as const
const OPERATION = [
  oneOf(['merge', 'rebase', 'cherry-pick', 'revert'] as const),
  '"operation" is merge, rebase, cherry-pick or revert.',
] as const
const STASH = [count, '"index" is the stash’s place in the list.'] as const
const HASH = [ref, '"expectedHash" is the stash’s commit as listed.'] as const

function selection(value: unknown): value is BranchStepSelection {
  if (value === null || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  if (kind === 'span' || kind === 'uncommitted') return true
  return kind === 'commit' && ref((value as { hash?: unknown }).hash)
}

function hunkRef(value: unknown): value is GitHunkRef {
  if (value === null || typeof value !== 'object') return false
  const at = value as Record<string, unknown>
  return (
    isStudioPath(at.repoRoot) &&
    relative(at.filePath) &&
    (at.scope === 'staged' || at.scope === 'unstaged') &&
    count(at.index) &&
    text(at.fingerprint, 200)
  )
}

function cloneInput(value: unknown): value is RepositoryCloneInput {
  if (value === null || typeof value !== 'object') return false
  const input = value as Record<string, unknown>
  return (
    text(input.url, 2000) &&
    !input.url.startsWith('-') &&
    isStudioPath(input.parentDir) &&
    relative(input.folderName) &&
    (input.branch === undefined || input.branch === null || ref(input.branch)) &&
    optional(input.cloneId, id)
  )
}

function newProjectInput(value: unknown): value is NewProjectInput {
  if (value === null || typeof value !== 'object') return false
  const input = value as Record<string, unknown>
  if (!isStudioPath(input.parentDir) || !relative(input.name)) return false
  const publish = input.publish
  if (publish === undefined || publish === null) return true
  if (typeof publish !== 'object') return false
  const at = publish as Record<string, unknown>
  return (
    (at.owner === null || id(at.owner)) &&
    (at.visibility === 'private' || at.visibility === 'public') &&
    bool(at.confirmed)
  )
}

const MOVES_WORK =
  'It moves a branch, rewrites history or discards work in a checkout, which only Studio’s own connections may.'
const USES_REMOTE = 'It reaches the repository’s remote with this machine’s git credentials.'
/** Why removing or unlocking the agents' worktrees is an owner's; `worktrees.ts` gives the same reason. */
export const STUDIO_AGENT_WORKTREES_OWNER = 'It removes or unlocks the worktrees Studio’s agents run in.'
const AGENT_WORKTREES = STUDIO_AGENT_WORKTREES_OWNER
const GITHUB_ACCOUNT = 'It is this Studio’s GitHub account: its token, and what that account can see and create.'

const held = (scope: StudioScope, mutation: boolean) =>
  ({ scope, mutation, capability: STUDIO_GIT_CAPABILITY }) as const
const reading = held('files:read', false)
const writing = held('files:write', true)
const owners = (reason: string, scope: StudioScope = 'files:write', mutation = true) =>
  ({ ...held(scope, mutation), owner: reason }) as const

const repo = shaped<Repo>({ repoRoot: REPO })

export const STUDIO_GIT_METHODS: StudioMethodTable<StudioGitMethodMap> = {
  'git.status': { ...reading, params: repo },
  'git.checkIgnored': { ...reading, params: shaped({ repoRoot: REPO, paths: PATHS }) },
  'git.changeSummary': { ...reading, params: shaped({ checkoutPath: CHECKOUT }) },
  'git.branchSteps': { ...reading, params: shaped({ checkoutPath: CHECKOUT }) },
  'git.branchStepDiff': {
    ...reading,
    params: shaped({
      checkoutPath: CHECKOUT,
      selection: [selection, '"selection" is a span, the uncommitted work, or a commit.'],
    }),
  },
  'git.fileAtRev': { ...reading, params: shaped({ repoRoot: REPO, rev: [ref, '"rev" is a revision.'], path: PATH }) },
  'git.fileBase': { ...reading, params: shaped({ repoRoot: REPO, path: PATH }) },
  'git.fileAtStage': {
    ...reading,
    params: shaped({
      repoRoot: REPO,
      path: PATH,
      stage: [oneOf(['head', 'index'] as const), '"stage" is head or index.'],
    }),
  },
  'git.branches': { ...reading, params: repo },
  'git.repositoryIdentity': { ...reading, params: shaped({ folderPath: FOLDER }) },
  'git.moduleWorkspaceInfo': { ...reading, params: shaped({ folderPath: FOLDER }) },
  'git.commitGraph': {
    ...reading,
    params: shaped({
      repoRoot: REPO,
      limit: [count, '"limit" is a count.', 'optional'],
      skip: [count, '"skip" is a count.', 'optional'],
    }),
  },
  'git.conflictFile': { ...reading, params: shaped({ repoRoot: REPO, path: PATH }) },
  'git.fileHunks': {
    ...reading,
    params: shaped({
      repoRoot: REPO,
      path: PATH,
      scope: [oneOf(['staged', 'unstaged'] as const), '"scope" is staged or unstaged.'],
    }),
  },
  'git.stashList': { ...reading, params: repo },
  'git.worktrees': { ...reading, params: repo },
  'git.changelists': { ...reading, params: repo },
  'git.createPatch': {
    ...reading,
    params: shaped({ repoRoot: REPO, paths: PATHS, cached: [bool, '"cached" is true or false.', 'optional'] }),
  },

  'git.stage': { ...writing, params: commanded(shaped({ repoRoot: REPO, paths: PATHS })) },
  'git.unstage': { ...writing, params: commanded(shaped({ repoRoot: REPO, paths: PATHS })) },
  'git.stageHunk': { ...writing, params: commanded(shaped({ ref: [hunkRef, '"ref" names one hunk of a file.'] })) },
  'git.unstageHunk': { ...writing, params: commanded(shaped({ ref: [hunkRef, '"ref" names one hunk of a file.'] })) },
  'git.commit': { ...writing, params: commanded(shaped({ repoRoot: REPO, message: MESSAGE })) },
  'git.resolveConflict': {
    ...writing,
    params: commanded(shaped({ repoRoot: REPO, path: PATH, content: [text, '"content" is the resolved file.'] })),
  },
  'git.stashPush': {
    ...writing,
    params: commanded(
      shaped({
        repoRoot: REPO,
        message: MESSAGE,
        includeUntracked: [bool, '"includeUntracked" is true or false.', 'optional'],
      }),
    ),
  },
  'git.setActiveChangelist': { ...writing, params: commanded(shaped({ repoRoot: REPO, id: LIST_ID })) },
  'git.createChangelist': {
    ...writing,
    params: commanded(
      shaped({
        repoRoot: REPO,
        name: [(value: unknown) => text(value, 200), '"name" is the list’s name.'],
        comment: [(value: unknown) => text(value, 10_000), '"comment" is text.', 'optional'],
        activate: [bool, '"activate" is true or false.', 'optional'],
        paths: [paths, '"paths" lists files in the repository.', 'optional'],
      }),
    ),
  },
  'git.renameChangelist': {
    ...writing,
    params: commanded(
      shaped({
        repoRoot: REPO,
        id: LIST_ID,
        name: [(value: unknown) => text(value, 200), '"name" is the list’s name.'],
        comment: [(value: unknown) => text(value, 10_000), '"comment" is text.', 'optional'],
      }),
    ),
  },
  'git.deleteChangelist': { ...writing, params: commanded(shaped({ repoRoot: REPO, id: LIST_ID })) },
  'git.moveChangelistPaths': { ...writing, params: commanded(shaped({ repoRoot: REPO, id: LIST_ID, paths: PATHS })) },

  'git.revertPaths': { ...owners(MOVES_WORK), params: commanded(shaped({ repoRoot: REPO, paths: PATHS })) },
  'git.push': { ...owners(USES_REMOTE), params: commanded(repo) },
  'git.fetch': { ...owners(USES_REMOTE), params: commanded(repo) },
  'git.pullWithStash': { ...owners(USES_REMOTE), params: commanded(repo) },
  'git.switchBranch': { ...owners(MOVES_WORK), params: commanded(shaped({ repoRoot: REPO, branch: BRANCH })) },
  'git.mergeRef': {
    ...owners(MOVES_WORK),
    params: commanded(shaped({ repoRoot: REPO, ref: [ref, '"ref" is a ref.'] })),
  },
  'git.rebase': {
    ...owners(MOVES_WORK),
    params: commanded(shaped({ repoRoot: REPO, onto: [ref, '"onto" is a ref.'] })),
  },
  'git.cherryPick': { ...owners(MOVES_WORK), params: commanded(shaped({ repoRoot: REPO, commit: COMMIT })) },
  'git.revertCommit': { ...owners(MOVES_WORK), params: commanded(shaped({ repoRoot: REPO, commit: COMMIT })) },
  'git.resetToCommit': {
    ...owners(MOVES_WORK),
    params: commanded(
      shaped({
        repoRoot: REPO,
        commit: COMMIT,
        mode: [oneOf(['soft', 'mixed', 'hard'] as const), '"mode" is soft, mixed or hard.'],
      }),
    ),
  },
  'git.deleteBranch': {
    ...owners(MOVES_WORK),
    params: commanded(
      shaped({ repoRoot: REPO, branch: BRANCH, force: [bool, '"force" is true or false.', 'optional'] }),
    ),
  },
  'git.renameBranch': {
    ...owners(MOVES_WORK),
    params: commanded(shaped({ repoRoot: REPO, branch: BRANCH, newName: [ref, '"newName" is a branch name.'] })),
  },
  'git.continueOperation': {
    ...owners(MOVES_WORK),
    params: commanded(shaped({ repoRoot: REPO, operation: OPERATION })),
  },
  'git.abortOperation': { ...owners(MOVES_WORK), params: commanded(shaped({ repoRoot: REPO, operation: OPERATION })) },
  'git.stashApply': {
    ...owners(MOVES_WORK),
    params: commanded(
      shaped({ repoRoot: REPO, index: STASH, expectedHash: HASH, pop: [bool, '"pop" is true or false.', 'optional'] }),
    ),
  },
  'git.stashDrop': {
    ...owners(MOVES_WORK),
    params: commanded(shaped({ repoRoot: REPO, index: STASH, expectedHash: HASH })),
  },
  'git.checkoutCommit': { ...owners(MOVES_WORK), params: commanded(shaped({ repoRoot: REPO, commit: COMMIT })) },
  'git.checkoutCommitAsBranch': {
    ...owners(MOVES_WORK),
    params: commanded(shaped({ repoRoot: REPO, branch: BRANCH, commit: COMMIT })),
  },
  'git.tagCommit': {
    ...owners(MOVES_WORK),
    params: commanded(shaped({ repoRoot: REPO, tag: [ref, '"tag" is a tag name.'], commit: COMMIT })),
  },
  'git.pruneWorktrees': { ...owners(AGENT_WORKTREES), params: commanded(repo) },
  'git.unlockAgentWorktree': {
    ...owners(AGENT_WORKTREES),
    params: commanded(
      shaped({ repoRoot: REPO, worktreePath: [isStudioPath, '"worktreePath" is the worktree’s folder.'] }),
    ),
  },

  'github.tokenStatus': { ...owners(GITHUB_ACCOUNT, 'settings:write', false), params: studioNoParams },
  'github.setToken': {
    ...owners(GITHUB_ACCOUNT, 'settings:write'),
    params: commanded(shaped({ token: [(value: unknown) => text(value, 1000), '"token" is the GitHub token.'] })),
  },
  'github.clearToken': { ...owners(GITHUB_ACCOUNT, 'settings:write'), params: commanded(shaped({})) },
  'github.listRepos': { ...owners(GITHUB_ACCOUNT, 'workspaces:read', false), params: studioNoParams },
  'github.listOwners': { ...owners(GITHUB_ACCOUNT, 'workspaces:read', false), params: studioNoParams },
  'github.clone': {
    ...owners(GITHUB_ACCOUNT),
    params: commanded(shaped({ input: [cloneInput, '"input" is { url, parentDir, folderName, branch?, cloneId? }.'] })),
  },
  'github.cancelClone': {
    ...owners(GITHUB_ACCOUNT),
    params: commanded(shaped({ cloneId: [id, '"cloneId" names the clone.'] })),
  },
  'github.newProject': {
    ...owners(GITHUB_ACCOUNT),
    params: commanded(shaped({ input: [newProjectInput, '"input" is { parentDir, name, publish? }.'] })),
  },

  'versionControl.probeProviders': { ...held('providers:read', false), params: studioNoParams },
  'versionControl.probeHostGh': {
    ...held('providers:read', false),
    params: shaped({ hostId: [id, '"hostId" names the machine.'] }),
  },
}

export const STUDIO_GIT_TOPICS: StudioTopicTable<StudioGitTopicMap> = {
  'git.checkoutChanged': {
    scope: 'files:read',
    capability: STUDIO_GIT_CAPABILITY,
    push: true,
    params: shaped({ checkoutPath: CHECKOUT }),
  },
  'git.changelistsChanged': {
    scope: 'files:read',
    capability: STUDIO_GIT_CAPABILITY,
    push: true,
    params: studioNoParams,
  },
  'github.cloneProgress': {
    scope: 'files:write',
    capability: STUDIO_GIT_CAPABILITY,
    push: true,
    owner: GITHUB_ACCOUNT,
    params: studioNoParams,
  },
}
