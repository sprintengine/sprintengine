import type {
  StudioMethodParams,
  StudioMethodResult,
  StudioWorktreesMethod,
  WorktreeDependencyInstallView,
  WorktreePoolSnapshot,
} from '../../../packages/studio-protocol/src/public'

// The core's worktree service as the router, the RPC server and the window's
// connections see it (`studio-worktrees.ts` builds it). Kept apart from the
// service, which runs git and reaches Node's own modules, so what only names
// the type never loads them.

type Params<M extends StudioWorktreesMethod> = Omit<StudioMethodParams<M>, 'commandId'>

/** Who asked: an owner's own connection, or a client held to its grant (a paired device). */
export type StudioWorktreesAsker = { owner: boolean }

export type StudioWorktreesRun = {
  [M in StudioWorktreesMethod]: (params: Params<M>, asker: StudioWorktreesAsker) => Promise<StudioMethodResult<M>>
}

export type StudioWorktrees = {
  run: StudioWorktreesRun
  onPoolChanged(listener: (snapshot: WorktreePoolSnapshot) => void): () => void
  onInstallChanged(listener: (view: WorktreeDependencyInstallView) => void): () => void
}
