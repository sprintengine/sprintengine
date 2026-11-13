// The shapes the git family (`git.ts`) carries: a repository's status,
// branches, history, stashes, hunks, changelists and patches; the checkout
// changes a client follows; what a provider's CLI and a GitHub account say.
// `src/shared` re-exports each under the name the app has always used.

export const VERSION_CONTROL_PROVIDER_IDS = ['git', 'gh', 'glab', 'tea'] as const

export type GitFileStatus = 'new' | 'modified' | 'deleted' | 'renamed' | 'conflicted'

/** One `@@ … @@` block of a `-U0` diff. */
export type DiffHunk = {
  /** First line of the range on the OLD side (1-based; 0 for an empty range). */
  oldStart: number
  oldLines: number
  /** First line of the range on the NEW side (1-based; 0 for an empty range). */
  newStart: number
  newLines: number
  /**
   * The hunk's body exactly as git wrote it: `+` and `-` lines, any
   * `\ No newline at end of file` markers, and — with `-U0` there are none, but
   * the parser accepts them — context lines. Never re-wrapped, never trimmed.
   */
  lines: string[]
}

/**
 * Which diff the viewer is showing, and therefore which TEXT is under the
 * boxes: `staged` is HEAD↔index, `unstaged` is index↔worktree.
 *
 * It is no longer which hunks are drawn. A hunk's scope IS its include state —
 * a hunk of the staged diff is in the index, a hunk of the unstaged diff is not
 * — so drawing only the scope's own hunks made the box vanish the moment it was
 * ticked, and a hunk you had just included could never be taken back out from
 * this window. The boxes are the UNION of both diffs (`readFileHunks`); the
 * scope only chooses which of the two texts Monaco is showing.
 */
export type GitHunkScope = 'staged' | 'unstaged'

/** One hunk as the renderer sees it: where to draw the box, and what to say. */
export type GitHunkView = {
  /** Position in ITS OWN diff, as read. A hint for `locateHunk`, not an id —
   *  the union interleaves two diffs, so two hunks can share an index. */
  index: number
  /** The diff this hunk came from, which is the diff a toggle must name. */
  scope: GitHunkScope
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** `hunkFingerprint` of the hunk — what actually names it across a re-read. */
  fingerprint: string
  /** Whether this hunk is in the index. Follows its own scope, always. */
  included: boolean
}

/** Why a file has no per-hunk boxes, when it has none. */
export type GitHunkUnsupported = 'binary' | 'untracked'

export type GitFileHunks = {
  ok: true
  /** Which of the two texts Monaco is showing. Not a filter on `hunks`. */
  scope: GitHunkScope
  /**
   * EVERY hunk of the file, both sides of the index, ordered by their new-side
   * line so the boxes read down the gutter in file order. The staged ones carry
   * `included: true` and the unstaged ones `included: false`, which is the
   * whole of what a box shows and the whole of what a click has to decide.
   */
  hunks: GitHunkView[]
  /**
   * The whole file's counter. Null when the file's differences could not be
   * counted honestly (binary, untracked) — the caller then says the shorter
   * true thing rather than a confident zero.
   */
  summary: HunkInclusionSummary | null
  unsupported: GitHunkUnsupported | null
}

export type GitFileHunksResult = GitFileHunks | { ok: false; message: string }

/**
 * Which hunk to stage or unstage. Carries no patch and no content — main reads
 * the diff again and builds the patch itself.
 */
export type GitHunkRef = {
  repoRoot: string
  /** Absolute or repo-relative; main normalises it. */
  filePath: string
  scope: GitHunkScope
  index: number
  fingerprint: string
}

/** "N differences, M included" — the mockup's sentence, as two numbers. */
export type HunkInclusionSummary = { total: number; included: number }

/**
 * A run of NEW-side lines, in git's own hunk convention: `start` is 1-based and
 * `lines` may be 0 for a pure deletion anchored AFTER line `start` (git writes
 * `+4,0` for "deleted after new line 4", and `+0,0` when the deletion was at
 * the head of the file — which is the one case `start` is 0).
 *
 * A zero-length span is a point between two lines, not a line, so it neither
 * overlaps nor widens a run: it is kept as its own entry and dropped only when
 * the line it is anchored after is itself owned by the same list.
 */
export type OwnedSpan = { start: number; lines: number }

/** The agent a list was made for. `exited` is a flag the store sets when the
 *  agent's session ends; reconcile then deletes the list if it is also empty. */
export type ChangelistOwner = {
  kind: 'agent'
  agentId: string
  name: string
  workspaceId?: string
  exited?: boolean
}

/** One minimal changed region of a single tool call, in git hunk convention:
 *  `old*` in the file's coordinates BEFORE the call, `new*` after it. Not the
 *  hunk bounds of a context diff — the changed lines only. */
export type Edit = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
}

/** The new-side half of a git hunk — the only half ownership is expressed in.
 *  `DiffHunk` (`./hunks`) is assignable to it. */
export type HunkRange = { newStart: number; newLines: number }

/** The one shape, on disk and on the wire. `paths` are repo-relative and posix
 *  ('src/main/git.ts'), because that is the spelling git reports and the only
 *  one that survives a repository moving between machines. */
export type Changelist = {
  id: string
  name: string
  /** The list's comment — the composer offers it as the commit message's
   *  placeholder when the list is active. Absent, never empty. */
  comment?: string
  /** WHOLE-file membership: the file's home list. Exclusive across lists. */
  paths: string[]
  /** Repo-relative path -> the spans this list owns in a file whose home is a
   *  DIFFERENT list. Absent, never `{}`; no entry is ever empty. */
  spans?: Record<string, OwnedSpan[]>
  active: boolean
  /** Present on lists made for an agent (`changelistOwnerId`). */
  owner?: ChangelistOwner
}

export type RepositoryIdentity = {
  /** `host/owner/name` (or the normalised URL when it has no such path): equal for every clone of one repository. */
  canonicalKey: string
  /** The remote URL as `git remote` reported it, for display and diagnosis. */
  remoteUrl: string
  /**
   * The repository's last path segment as the remote spells it — `SprintEngine`
   * for `git@github.com:Acme/SprintEngine.git` — for display. Compare keys, not names.
   */
  name: string
}

/**
 * What a read of a folder's identity actually answered.
 *
 * `settled` is the difference between "asked, and this folder has no remote"
 * and "could not ask" — a read that timed out on a spun-down volume, or that
 * threw. Both used to arrive as a bare `null`, which made a folder on a sleeping
 * disk indistinguishable from a folder with no remote. That is fine for
 * GROUPING, where either way the folder groups by its path, and wrong for
 * anything that writes the answer down: one-colour-per-project (2026-09-09)
 * would spend a hue on the folder's PATH key and then a second on its
 * repository key the next time the volume was awake, so one project would end
 * up wearing two of the six colours. A caller that persists anything derived
 * from an identity must wait for `settled`.
 */
export type RepositoryIdentityRead = {
  identity: RepositoryIdentity | null
  /** The read completed and this IS the answer — including "no remote". */
  settled: boolean
}

export type VersionControlProviderId = (typeof VERSION_CONTROL_PROVIDER_IDS)[number]

// Why a provider carries no version. `not_installed` is a definitive verdict
// the settings row can pair with an install path; `probe_failed` means no
// verdict was reached at all (the probe timed out, could not be spawned, or
// produced output with no version in it) and must not be rendered as either
// installed or missing.
export type VersionControlProbeFailure = 'not_installed' | 'probe_failed'

/**
 * The machine a probe ran on, when it is not this one. On Windows each WSL
 * machine runs its own git (a WSL workspace's git is the distribution's), so
 * the Git row is one row per machine; a probe without this is this machine's.
 */
export type VersionControlProbeMachine = { hostId: string; label: string }

export type VersionControlProviderProbe = (
  | {
      id: VersionControlProviderId
      resolved: true
      // The binary's own `--version` line, verbatim.
      version: string
      // Only for a provider that carries its own auth (the forge CLIs), and
      // only when that auth resolves to a login. Never any token material.
      auth?: { login: string }
    }
  | { id: VersionControlProviderId; resolved: false; reason: VersionControlProbeFailure }
) & { machine?: VersionControlProbeMachine }

/** What one machine's `gh` is, as far as a read-only check can tell. */
export type HostGhStatus = {
  /** False when `gh` is not on the machine's login PATH. */
  installed: boolean
  /** `gh --version`'s number, when it said one. */
  version: string | null
  /**
   * Whether `gh` holds a token for github.com (`gh auth token` succeeds; the
   * token itself is never read back). Null when it could not be told.
   */
  signedIn: boolean | null
}

/** The kind of machine a `gh` row is for: its install and sign-in commands differ. */
export type HostGhMachine = { kind: 'wsl' } | { kind: 'ssh'; os: string | null }

/** A git remote of a workspace's repository, as `git remote -v` names it (fetch URL). */
export type ModuleWorkspaceGitRemote = {
  name: string
  /** The fetch URL, with any credentials in it removed. */
  url: string
  /** `owner/repo` when the remote is a GitHub repository, SSH host aliases resolved. */
  github?: string
}

export type ModuleWorkspaceGitInfoErrorCode =
  'permission_missing' | 'unknown_workspace' | 'no_folder' | 'not_a_repository' | 'unavailable' | 'git_failed'

/**
 * A workspace's checked-out branch (null on a detached HEAD) and its remotes,
 * read by git from the workspace's own folder — so a worktree reports its own
 * branch and a submodule its own repository.
 */
export type ModuleWorkspaceGitInfoResult =
  | { ok: true; branch: string | null; remotes: ModuleWorkspaceGitRemote[] }
  | { ok: false; code: ModuleWorkspaceGitInfoErrorCode; message: string }

export type GitStatusEntry = {
  path: string
  relativePath: string
  status: GitFileStatus
  staged: boolean
  unstaged: boolean
}

/** A multi-step operation parked in the repo, awaiting continue or abort. */
export type GitRepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

export type GitResetMode = 'soft' | 'mixed' | 'hard'

export type GitStatusSnapshot = {
  repoRoot: string
  files: Record<string, GitStatusEntry>
  operation: GitRepoOperation | null
  updatedAt: number
}

/**
 * The sidebar row's one-line git story (remote-sessions-ux /
 * two-line-session-rows): branch + working-tree ±lines against HEAD. Quiet on
 * anything unreadable — a row simply shows no git facts.
 */
export type GitRowSummary = {
  branch: string | null
  additions: number
  deletions: number
}

/**
 * How many FILES a reading covers, by what happened to each one — the numbers
 * the sidebar line and the header chip draw (`+added+updated` / `−removed`).
 * Lines are shown only where a single file is in view.
 *
 * A rename counts once, as `updated` (it is one file that moved, never a removed
 * plus an added); so does a type change and a conflicted file mid-merge. An
 * untracked file counts as `added`. The three always sum to the reading's own
 * `changedFiles`, which is what lets a caller draw either number without
 * re-deriving the other.
 */
export type ChangedFileCounts = { added: number; updated: number; removed: number }

/**
 * What a workspace's row reports as changed
 * (the-diff-an-agent-made / branch-scoped-row-diff).
 *
 * The numbers are the span `merge-base(HEAD, <default branch>) → working tree`
 * taken in the checkout the workspace's agents actually work in, so a pull, a
 * merge or a commit landing under the agent cannot inflate them.
 *
 * `scope` is load-bearing, not diagnostic — it says how much the UI is entitled
 * to claim, and the row's tooltip and spoken label are derived from it:
 * `worktree` (a linked worktree, exclusive to this chat), `branch` (a shared
 * checkout ahead of the default branch — the BRANCH's work, which may include a
 * person's commits), and `folder` (a shared checkout level with the default
 * branch, so only its uncommitted state can be reported).
 */
export type WorkspaceChangeSummary = {
  branch: string | null
  additions: number
  deletions: number
  changedFiles: number
  scope: 'worktree' | 'branch' | 'folder'
  /** The same changed files, split by what happened to them: `added + updated + removed === changedFiles`.
   *  Absent only when the per-status reading could not be taken; a caller must then draw nothing
   *  rather than a zero, exactly as for `uncommitted`. */
  files?: ChangedFileCounts
  /** The checkout's UNCOMMITTED changes alone — index + worktree vs HEAD, untracked files counted as additions.
   *  What the line shows once its branch has landed by squash (decision 2). Absent when unreadable. */
  uncommitted?: {
    additions: number
    deletions: number
    changedFiles: number
    /** Split by status, untracked files counted as `added`: sums to this reading's `changedFiles`. */
    files?: ChangedFileCounts
  }
}

/**
 * One step in a branch's timeline: a commit
 * (the-diff-an-agent-made / changed-files-and-commit-steps).
 *
 * A step is a commit rather than a captured turn, so the timeline is the repo's
 * own history — it survives a restart, a re-clone and a machine change, and a
 * pull cannot invent one.
 */
export type BranchStep = {
  hash: string
  shortHash: string
  /** The commit subject. May be empty; never trusted to be one line. */
  subject: string
  /** Author date, epoch ms. Zero when git gave something unparseable. */
  authoredAt: number
  /**
   * More than one parent. A merge step still carries a diff — what it brought
   * into the branch — so the strip labels it rather than hiding it.
   */
  isMerge: boolean
}

export type BranchStepsSnapshot = {
  branch: string | null
  /** The merge-base the span measures from, or null when none resolves. */
  baseOid: string | null
  /** Same contract as WorkspaceChangeSummary['scope'] — how much may be claimed. */
  scope: 'worktree' | 'branch' | 'folder'
  /** Oldest first: the order the work happened in. */
  steps: BranchStep[]
  /** Whether the working tree carries anything at all, tracked or untracked. */
  hasUncommitted: boolean
}

/** Which slice of the branch a viewer is showing. */
export type BranchStepSelection = { kind: 'span' } | { kind: 'uncommitted' } | { kind: 'commit'; hash: string }

export type BranchStepFile = {
  path: string
  status: 'new' | 'modified' | 'deleted' | 'renamed'
  additions: number
  deletions: number
  /** Where a rename came from. Absent for every other status. */
  oldPath?: string
}

/** One side of a step's diff, read at a revision. */
export type RevFileResult = { kind: 'content'; content: string } | { kind: 'absent' } | { kind: 'too-large' }

export type BranchStepDiff = {
  files: BranchStepFile[]
  additions: number
  deletions: number
}

export type GitStashEntry = {
  /** Git's selector for the entry, e.g. `stash@{0}`. */
  ref: string
  /** The stash commit hash — the entry's stable identity; selectors renumber. */
  hash: string
  index: number
  branch: string | null
  message: string
  createdAt: number
}

export type GitStashListSnapshot = {
  repoRoot: string
  stashes: GitStashEntry[]
  updatedAt: number
}

export type GitFileBaseResult = { ok: true; content: string } | { ok: false; message: string }

// Which stored version of a file the diff viewer reads. `head` is the committed
// version (`git show HEAD:<p>`); `index` is the staged version (`git show :0:<p>`).
export type GitFileStage = 'head' | 'index'

/** `git diff` of a selection, as text. `patch` is empty when there was nothing
 *  to diff, and `message` says which of the two sides was empty. */
export type GitPatchResult = { ok: boolean; patch: string; message: string | null }

export type GitFileStageResult =
  { ok: true; exists: boolean; content: string; binary: boolean; tooLarge: boolean } | { ok: false; message: string }

export type GitBranch = {
  name: string
  current: boolean
  upstream: string | null
}

export type GitBranchSnapshot = {
  current: string | null
  branches: GitBranch[]
  ahead: number
  behind: number
}

export type GitCommit = {
  hash: string
  shortHash: string
  author: string
  date: string
  refs: string[]
  subject: string
  commitWebUrl: string | null
}

export type GitRef = {
  name: string
  hash: string
  type: 'head' | 'remote' | 'tag' | 'other'
}

export type GitGraphCommit = GitCommit & {
  parents: string[]
}

export type GitGraphSnapshot = {
  commits: GitGraphCommit[]
  refs: GitRef[]
  headHash: string | null
  detached: boolean
  totalCount: number
  hasMore: boolean
  updatedAt: number
}

export type GitGraphOptions = {
  limit?: number
  skip?: number
}

export type GitCommandResult = {
  ok: boolean
  stdout: string
  stderr: string
  message: string | null
  pushedCommitCount?: number
}

export type GitWorktreeEntry = {
  path: string
  head: string | null
  branch: string | null
  branchRef: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  lockedReason: string | null
  /**
   * Set when the lock is the in-use mark the app places on an agent worktree:
   * this profile's, which it releases itself, or another Studio profile's,
   * which it never touches.
   */
  agentLock?: 'this-profile' | 'other-profile'
  prunable: boolean
  prunableReason: string | null
}

export type GitWorktreeListSnapshot = {
  repoRoot: string
  worktrees: GitWorktreeEntry[]
  updatedAt: number
}

export type GitWorktreeOperationResult<T> =
  | { ok: true; data: T; message: string | null; stdout?: string; stderr?: string }
  | { ok: false; message: string; stdout?: string; stderr?: string }

/**
 * Which readings of a checkout went stale (main's git-repo-watch.ts):
 * `worktree` — status and the row's diff; `refs` — the graph, branches,
 * stashes and worktree list, which every checkout of a repository shares.
 */
export type GitCheckoutChangeKind = 'worktree' | 'refs'

export type GitCheckoutChange = {
  checkoutKey: string
  kinds: GitCheckoutChangeKind[]
  /** `gitdir`: a git file moved; `activity`: an agent's turn ended there; `fallback`: the slow sweep. */
  reason: 'gitdir' | 'activity' | 'fallback'
}

export type GitHubTokenStatus = {
  configured: boolean
  source: 'settings' | 'environment' | 'none'
  encryptionAvailable: boolean
}

export type GitHubRepoSummary = {
  fullName: string
  name: string
  owner: string
  isPrivate: boolean
  description: string | null
  cloneUrl: string
  defaultBranch: string | null
  pushedAt: string | null
}

export type GitHubRepoListResult =
  | { ok: true; repos: GitHubRepoSummary[] }
  | { ok: false; reason: 'no_token' | 'unauthorized' | 'network'; message: string }

export type RepositoryCloneInput = {
  url: string
  parentDir: string
  folderName: string
  /** The branch to check out; absent or null clones the remote's default. */
  branch?: string | null
  /** Names this clone for its progress events and for `cancelRepositoryClone`. */
  cloneId?: string
}

export type RepositoryCloneResult =
  | { ok: true; path: string }
  | {
      ok: false
      message: string
      /**
       * `exists`: the folder is taken — and when it is already a clone of this
       * repository, `existingPath` is where, so it can be opened instead.
       */
      reason?: 'invalid' | 'exists' | 'cancelled' | 'failed'
      existingPath?: string
    }

/** A project made from nothing: a folder with a first commit, and optionally a GitHub repository. */
export type NewProjectInput = {
  parentDir: string
  /** The folder's name, and the repository's when it is published. */
  name: string
  /**
   * Publish it to GitHub. `confirmed` is the person's yes to the confirmation
   * the form shows; a request without it is not published. Absent or null
   * makes a local repository only.
   */
  publish?: { owner: string | null; visibility: 'private' | 'public'; confirmed: boolean } | null
}

export type NewProjectResult =
  | {
      ok: true
      path: string
      /** The GitHub repository it was published to, or null for a local project. */
      repository: { fullName: string; htmlUrl: string; isPrivate: boolean } | null
      /** A step after the folder was made that did not happen, said plainly. */
      warning: string | null
    }
  | { ok: false; reason: 'invalid' | 'exists' | 'failed'; message: string }

/** Who a new repository can belong to: the signed-in account, or one of its organisations. */
export type GitHubOwnerListResult =
  | { ok: true; login: string; orgs: string[] }
  | { ok: false; reason: 'no_token' | 'unauthorized' | 'network'; message: string }

export type CloneProgressStage = 'connecting' | 'counting' | 'receiving' | 'resolving' | 'checkout'

/** One step of a running clone, as `git clone --progress` reports it. */
export type CloneProgress = {
  cloneId: string
  stage: CloneProgressStage
  /** Through the stage, 0–100; null while git has not said. */
  percent: number | null
  /**
   * git's transfer detail beside the count, e.g. `12.30 MiB | 5.00 MiB/s`; once
   * git has gone quiet, `12.30 MiB | Stalled` (or `Stalled` alone) until it speaks.
   */
  detail: string | null
}

export type GitConflictFileContent = {
  path: string
  relativePath: string
  base: string | null
  ours: string | null
  theirs: string | null
  result: string
}
