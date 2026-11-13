// Part of the IPC contract: Git status, history, worktrees and the GitHub surfaces.
// ../electron-api.ts re-exports everything here.

import type { WorktreeDependencyInstallView } from './worktree-pool'

// Per-hunk staging (git-commit-window T7). The shapes live beside the parser
// that produces them; they are re-exported here because they are part of this
// IPC contract like everything else in this file.
export type {
  GitFileHunks,
  GitFileHunksResult,
  GitHunkRef,
  GitHunkScope,
  GitHunkUnsupported,
  GitHunkView,
  HunkInclusionSummary,
} from '../git/hunks'
export type {
  GitStatusEntry,
  GitRepoOperation,
  GitResetMode,
  GitStatusSnapshot,
  GitRowSummary,
  ChangedFileCounts,
  WorkspaceChangeSummary,
  BranchStep,
  BranchStepsSnapshot,
  BranchStepSelection,
  BranchStepFile,
  RevFileResult,
  BranchStepDiff,
  GitStashEntry,
  GitStashListSnapshot,
  GitFileBaseResult,
  GitFileStage,
  GitPatchResult,
  GitFileStageResult,
  GitBranch,
  GitBranchSnapshot,
  GitCommit,
  GitRef,
  GitGraphCommit,
  GitGraphSnapshot,
  GitGraphOptions,
  GitCommandResult,
  GitWorktreeEntry,
  GitWorktreeListSnapshot,
  GitWorktreeOperationResult,
  GitCheckoutChangeKind,
  GitCheckoutChange,
  GitHubTokenStatus,
  GitHubRepoSummary,
  GitHubRepoListResult,
  RepositoryCloneInput,
  RepositoryCloneResult,
  NewProjectInput,
  NewProjectResult,
  GitHubOwnerListResult,
  CloneProgressStage,
  CloneProgress,
  GitConflictFileContent,
} from '../../../packages/studio-protocol/src/public'
import type { GitWorktreeEntry, GitWorktreeOperationResult } from '../../../packages/studio-protocol/src/public'

// Changelists (git-commit-window T6): the app's own named sets of paths, one
// file per repository under the user-data dir. Re-exported here because they
// cross this boundary, like the hunk shapes above.
export type { Changelist } from '../git/changelists'

/** Where a patch was written, or `null` when the person dismissed the dialog —
 *  a cancel is not a failure, so `ok` stays true. */
export type GitPatchSaveResult = { ok: boolean; path: string | null; message: string | null }

export type GitWorktreeCreateInput = {
  repoRoot: string
  containerPath: string
  destinationPath: string
  branchName: string
  baseRef: string
  copyIncludedFiles?: boolean
  /**
   * Lock the new worktree as in use by an agent, naming this owner: the
   * agent's id, or the branch when the agent does not exist yet. The agent
   * worktree cleanup never removes a worktree another profile has locked, and
   * this profile releases its own lock once its records no longer use it.
   */
  agentLockOwner?: string
  /**
   * An agent's worktree, forked from the default branch: leased from the
   * worktree pool (its path is then a pool slot's, not `destinationPath`), or
   * created fresh from `origin/<default>` when there is no pool to lease from.
   * `baseRef` is used only when the repository has no default branch at all.
   */
  fromPool?: boolean
  /** The machine whose git makes it (a WSL machine's); absent resolves from the folder. */
  hostId?: string
  /**
   * The caller shows the dependency install itself: New chat's worktree,
   * whose install is folded into its chat's working line. The install is
   * marked `quiet`, and no window toasts it unless it fails.
   */
  quietInstall?: boolean
}

/** A created worktree, and what it was forked from. */
export type GitWorktreeCreated = GitWorktreeEntry & {
  /** The ref it was forked from, as the caller should record it (`origin/main`, `HEAD`). */
  baseRef: string
  /** Set when the worktree is a pool slot. */
  leaseId: string | null
  /** The dependency install the lease ran before handing the slot out, when it ran one. */
  dependencyInstall?: WorktreeDependencyInstallView | null
}

/**
 * Check a chat's worktree out again at the path it had, on the branch it kept,
 * after the agent worktree cleanup gave it back.
 */
export type GitWorktreeRestoreInput = {
  repoRoot: string
  path: string
  branchName: string
  copyIncludedFiles?: boolean
  /** Lock it again as in use, naming this owner, as creation does. */
  agentLockOwner?: string
  /** The machine whose git makes it (a WSL machine's); absent resolves from the folder. */
  hostId?: string
}

/**
 * A restore's answer. A refusal marked `definitive` is one no retry changes
 * (the branch was deleted, the path is not one of the app's worktrees); any
 * other may succeed next time (the volume is back, the branch was freed).
 */
export type GitWorktreeRestoreResult =
  GitWorktreeOperationResult<GitWorktreeEntry> | { ok: false; message: string; definitive: true }

export type GitWorktreeRemoveInput = {
  repoRoot: string
  path: string
  force?: boolean
}

/**
 * Why the cleanup kept an agent worktree, or that it removed it. `recent`: git
 * touched it within the last hour; `ignored-files`: ignored files that are not
 * rebuildable output or unchanged copies; `hidden-edits`: tracked files hidden
 * from `git status` by `--assume-unchanged` or `--skip-worktree`;
 * `not-owned`: an unattended sweep met a worktree this profile never locked.
 */
export type AgentWorktreeCleanupVerdict =
  | 'removed'
  /** A worktree pool slot nobody uses any more, detached and given back to the pool (its branch kept). */
  | 'returned'
  /** A worktree pool slot nobody uses that still holds work; held in the pool for a person to decide. */
  | 'held'
  | 'dirty'
  | 'unmerged'
  | 'in-use'
  | 'locked'
  | 'missing'
  | 'recent'
  | 'ignored-files'
  | 'hidden-edits'
  | 'not-owned'
  | 'no-default-branch'
  | 'error'

export type AgentWorktreeCleanupEntry = {
  path: string
  branch: string | null
  verdict: AgentWorktreeCleanupVerdict
  /** For `unmerged`: commits on the branch that the default branch does not have. */
  uniqueCommits?: number
  /** For `dirty`, `ignored-files` and `hidden-edits`: how many paths kept it. */
  changedPaths?: number
  detail?: string
}

export type AgentWorktreeCleanupInput = {
  repoRoot: string
  /** Paths the app still uses (a workspace's folder, a live agent's worktree). Never removed. */
  protectedPaths: string[]
  /** Report what would happen without removing anything. */
  dryRun?: boolean
  /**
   * Take only worktrees this profile locked and has since released. The
   * unattended sweep sets it; a person's cleanup from the Worktree manager,
   * whose report they read, does not.
   */
  ownedOnly?: boolean
  /**
   * Every agent the app's records hold. A pool slot an agent leased for itself
   * (MCP `worktree.lease`) is in use while its agent exists, wherever the
   * agent's terminal sits. Left out: unknown, and every such slot is kept.
   */
  agentIds?: string[]
  /**
   * The same agents, each with its chat (`agentLeaseKey`): what a lease that
   * records its agent's chat is matched against, since an agent id is unique
   * only within its chat. Left out: unknown, and every such slot is kept.
   */
  agentKeys?: string[]
  /**
   * Branches the app's records still name (a chat's `worktree.branch`, a
   * worktree entry's): never deleted, merged or not, because a chat whose
   * worktree was given back is restored from its branch. Left out: unknown,
   * and no branch is deleted.
   */
  keepBranches?: string[]
}

export type AgentWorktreeCleanupReport = {
  repoRoot: string
  /** The ref "merged" was measured against, e.g. `origin/main`. Null when none could be found. */
  defaultRef: string | null
  entries: AgentWorktreeCleanupEntry[]
  /**
   * Studio's branches (under the person's branch prefix or `agent/`) no
   * worktree has checked out whose work is on the default branch: deleted
   * (or, on a dry run, the ones that would be).
   */
  deletedBranches?: string[]
  dryRun: boolean
}

export type DiagnosticLevel = 'info' | 'warning' | 'error'
