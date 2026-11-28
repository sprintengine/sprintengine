import { getGitRepoRoot } from '../../main/git'
import { readBranchName, resolveTrunk } from '../../main/git-branch-span'
import { getGitBranches } from '../../main/git-read-models'
import { listGitWorktrees } from '../../main/git-worktree-list'
import type { WorkspaceExtensions } from '../../shared/workspace-extensions'
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync'
import { isThisMachinesChat } from './studio-workspace-list'

// What a client reads of one of this Studio's projects before it starts a
// chat there: the project's checkout (`workspaces.checkout` on the protocol,
// the gateway's `workspace.checkout` tool on MCP) and what a chat in it can
// use (`workspaces.extensions`, `workspace.extensions`). Read where the
// project's folder is, by the Studio that holds it: every Studio serves them,
// with or without a desktop shell around it, an SSH machine's and a WSL
// distribution's included. One implementation, so a device, a desktop
// starting a chat on another machine and an agent read the same facts.

/** Where a folder stands in git; `git: false` for a folder that is not a repository. */
export type FolderCheckout = {
  git: boolean
  branch: string | null
  defaultBranch: string | null
  branches: Array<{ name: string; current: boolean }>
  worktrees: Array<{ path: string; branch: string | null; isMain: boolean }>
}

/** Why a project's read has no answer: the workspace is not this Studio's, or has no folder to read. */
export type StudioWorkspaceReadRefusal = {
  ok: false
  code: 'unknown_workspace' | 'workspace_without_folder'
  message: string
}

export type StudioWorkspaceReads = {
  /**
   * A project's checkout. `ownOnly` refuses what another environment holds
   * (this desktop's copies of an SSH machine's or a WSL distribution's chats):
   * whoever asks from outside reads those on that machine, not through here.
   */
  checkout(
    workspaceId: string,
    options: { ownOnly: boolean },
  ): Promise<{ ok: true; checkout: { workspaceId: string } & FolderCheckout } | StudioWorkspaceReadRefusal>
  /** What a chat in a project can use; with `cli`, that CLI's MCP servers there too. */
  extensions(
    workspaceId: string,
    cli: string | null,
    options: { ownOnly: boolean },
  ): Promise<{ ok: true; extensions: { workspaceId: string } & WorkspaceExtensions } | StudioWorkspaceReadRefusal>
}

export type StudioWorkspaceReadsDeps = {
  snapshot(): WorkspaceSyncSnapshot
  /** A folder's checkout; never throws for a non-repo (that is the `git: false` answer). */
  readCheckout?(folder: string): Promise<FolderCheckout>
  /** The skills and, for a CLI, the MCP servers a chat in a folder can use. */
  readExtensions(folder: string, cli: string | null): Promise<WorkspaceExtensions>
}

/**
 * A folder's checkout facts, from the same readers the sidebar rows and the
 * Worktree manager use, so a remote picker lists exactly what this machine's
 * Git view would. Not a repo is an answer, not an error.
 */
async function readFolderCheckout(folder: string): Promise<FolderCheckout> {
  const empty: FolderCheckout = { git: false, branch: null, defaultBranch: null, branches: [], worktrees: [] }
  const repoRoot = await getGitRepoRoot(folder).catch(() => null)
  if (!repoRoot) return empty
  const [branch, snapshot, worktrees] = await Promise.all([
    readBranchName(repoRoot),
    getGitBranches(repoRoot).catch(() => null),
    listGitWorktrees(repoRoot).catch(() => null),
  ])
  const trunk = await resolveTrunk(repoRoot, branch).catch(() => null)
  return {
    git: true,
    branch,
    defaultBranch: trunk?.name ?? null,
    // `git branch` prints a detached HEAD as a pseudo-entry, "(HEAD detached
    // at abc)", marked current; it is not a ref anyone can fork from and is
    // dropped.
    branches: (snapshot?.branches ?? [])
      .filter((entry) => !entry.name.startsWith('('))
      .map((entry) => ({ name: entry.name, current: entry.current })),
    worktrees: worktrees?.ok
      ? worktrees.data.worktrees
          .filter((entry) => !entry.bare)
          // `git worktree list` names the main worktree first, always.
          .map((entry, index) => ({ path: entry.path, branch: entry.branch, isMain: index === 0 }))
      : [],
  }
}

export function createStudioWorkspaceReads(deps: StudioWorkspaceReadsDeps): StudioWorkspaceReads {
  const readCheckout = deps.readCheckout ?? readFolderCheckout

  function folderOf(workspaceId: string, ownOnly: boolean): { folder: string } | StudioWorkspaceReadRefusal {
    const workspace = deps.snapshot().state.workspaces.find((candidate) => candidate.id === workspaceId)
    if (!workspace || (ownOnly && !isThisMachinesChat(workspace)))
      return {
        ok: false,
        code: 'unknown_workspace',
        message: `Workspace "${workspaceId}" is not known to the running app.`,
      }
    if (!workspace.folderPath)
      return {
        ok: false,
        code: 'workspace_without_folder',
        message: `Workspace "${workspaceId}" has no usable folder path in this app session; open it in the app first.`,
      }
    return { folder: workspace.folderPath }
  }

  return {
    async checkout(workspaceId, { ownOnly }) {
      const found = folderOf(workspaceId, ownOnly)
      if (!('folder' in found)) return found
      return { ok: true, checkout: { workspaceId, ...(await readCheckout(found.folder)) } }
    },
    async extensions(workspaceId, cli, { ownOnly }) {
      const found = folderOf(workspaceId, ownOnly)
      if (!('folder' in found)) return found
      return { ok: true, extensions: { workspaceId, ...(await deps.readExtensions(found.folder, cli)) } }
    },
  }
}
