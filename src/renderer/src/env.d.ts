/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Which client this renderer was built for (renderer.vite.config.ts): a desktop window or a web tab. */
  readonly STUDIO_CLIENT: 'desktop' | 'web'
}

import type {
  AgentCli as SharedAgentCli,
  AppUpdateState as SharedAppUpdateState,
  ElectronApi,
  GitBranchSnapshot as SharedGitBranchSnapshot,
  GitCommandResult as SharedGitCommandResult,
  GitConflictFileContent as SharedGitConflictFileContent,
  GitFileStatus as SharedGitFileStatus,
  GitGraphCommit as SharedGitGraphCommit,
  GitRepoOperation as SharedGitRepoOperation,
  GitResetMode as SharedGitResetMode,
  GitStashEntry as SharedGitStashEntry,
  GitStatusEntry as SharedGitStatusEntry,
  GitStatusSnapshot as SharedGitStatusSnapshot,
  GitWorktreeEntry as SharedGitWorktreeEntry,
  GitWorktreeOperationResult as SharedGitWorktreeOperationResult,
  KnowledgeRootStatus as SharedKnowledgeRootStatus,
  SprintEngineAuthState as SharedSprintEngineAuthState,
  SessionActivity as SharedSessionActivity,
  AgentPhase as SharedAgentPhase,
  AgentStateSource as SharedAgentStateSource,
  TerminalKind as SharedTerminalKind,
  TerminalPathStyle as SharedTerminalPathStyle,
  TerminalSessionSnapshot as SharedTerminalSessionSnapshot,
  WindowState as SharedWindowState,
  WorkspaceFolderCheckResult as SharedWorkspaceFolderCheckResult,
} from '../../shared/electron-api'

declare global {
  type KnowledgeRootStatus = SharedKnowledgeRootStatus
  type AgentCli = SharedAgentCli
  type AppUpdateState = SharedAppUpdateState
  type SessionActivity = SharedSessionActivity
  type AgentPhase = SharedAgentPhase
  type AgentStateSource = SharedAgentStateSource
  type TerminalKind = SharedTerminalKind
  type TerminalPathStyle = SharedTerminalPathStyle
  type TerminalSessionSnapshot = SharedTerminalSessionSnapshot
  type GitFileStatus = SharedGitFileStatus
  type GitRepoOperation = SharedGitRepoOperation
  type GitResetMode = SharedGitResetMode
  type GitStashEntry = SharedGitStashEntry
  type GitStatusEntry = SharedGitStatusEntry
  type GitStatusSnapshot = SharedGitStatusSnapshot
  type GitBranchSnapshot = SharedGitBranchSnapshot
  type GitGraphCommit = SharedGitGraphCommit
  type GitCommandResult = SharedGitCommandResult
  type GitConflictFileContent = SharedGitConflictFileContent
  type GitWorktreeEntry = SharedGitWorktreeEntry
  type GitWorktreeOperationResult<T> = SharedGitWorktreeOperationResult<T>
  type WorkspaceFolderCheckResult = SharedWorkspaceFolderCheckResult
  type WindowState = SharedWindowState
  type SprintEngineAuthState = SharedSprintEngineAuthState

  interface Window {
    api: ElectronApi
  }
}

export {}
