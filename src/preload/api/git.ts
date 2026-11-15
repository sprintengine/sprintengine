import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi, GitPatchSaveResult } from '../../shared/electron-api'

// Saving a patch through the system's dialog. The rest of git is the Studio
// protocol's (renderer/src/studio/git.ts), as are the agents' worktrees
// (renderer/src/studio/worktrees.ts).
export const gitApi = {
  // Changelists and patches (git-commit-window T6). Every changelist call
  // answers with the whole reconciled set, so the panel re-renders from one
  // value instead of patching its own copy.
  // Main's own writes to a repository's lists (an agent launching, editing or
  // exiting). One channel for every repository, filtered in the renderer on the
  // root, exactly as `terminal.sessions` is one channel for every
  // session: a per-repository channel would need a subscription per open
  // checkout and a teardown nobody would get right.
  saveGitPatch: (repoRoot: string, patch: string, defaultFileName?: string): Promise<GitPatchSaveResult> =>
    ipcRenderer.invoke('git:save-patch', repoRoot, patch, defaultFileName),
  // One channel for every clone, filtered on the id by the caller, as
  // `git:changelists-changed` is one channel for every repository.
} satisfies Pick<ElectronApi, 'saveGitPatch'>
