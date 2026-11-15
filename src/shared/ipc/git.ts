// Part of the IPC contract: Git status, history, worktrees and the GitHub surfaces.
// ../electron-api.ts re-exports everything here.

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

// Changelists (git-commit-window T6): the app's own named sets of paths, one
// file per repository under the user-data dir. Re-exported here because they
// cross this boundary, like the hunk shapes above.
export type { Changelist } from '../git/changelists'

/** Where a patch was written, or `null` when the person dismissed the dialog —
 *  a cancel is not a failure, so `ok` stays true. */
export type GitPatchSaveResult = { ok: boolean; path: string | null; message: string | null }

// The agents' worktrees: the Studio protocol's (`worktree-types.ts`).
export type {
  AgentWorktreeCleanupEntry,
  AgentWorktreeCleanupInput,
  AgentWorktreeCleanupReport,
  AgentWorktreeCleanupVerdict,
  GitWorktreeCreated,
  GitWorktreeCreateInput,
  GitWorktreeRemoveInput,
  GitWorktreeRestoreInput,
  GitWorktreeRestoreResult,
} from '../../../packages/studio-protocol/src/public'

export type DiagnosticLevel = 'info' | 'warning' | 'error'
