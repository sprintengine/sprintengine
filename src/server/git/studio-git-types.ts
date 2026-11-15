import type {
  CloneProgress,
  GitCheckoutChange,
  GitHubTokenStatus,
  StudioGitMethod,
  StudioMethodParams,
  StudioMethodResult,
} from '../../../packages/studio-protocol/src/public'

// The core's git service as the router, the RPC server and the window's
// connections see it (`studio-git.ts` builds it). Kept apart from the
// service, which runs git and reaches Node's own modules, so what only names
// the type never loads them.

/** The GitHub token store a Studio keeps (`main/github-token-store.ts`), as git uses it. */
export type GitHubTokens = {
  getStatus(): Promise<GitHubTokenStatus>
  resolveToken(explicit?: string | null): Promise<string>
  writeToken(token: string): Promise<GitHubTokenStatus>
  clearToken(): Promise<GitHubTokenStatus>
}

type Params<M extends StudioGitMethod> = Omit<StudioMethodParams<M>, 'commandId'>
export type StudioGitRun = { [M in StudioGitMethod]: (params: Params<M>) => Promise<StudioMethodResult<M>> }

export type StudioGitOptions = {
  /** Where the changelist store writes: the Studio's data directory. */
  dataDir(): string
  /** The GitHub token this Studio keeps; without it, `github.*` but cloning is answered without an account. */
  githubTokens?: GitHubTokens
}

export type StudioGit = {
  run: StudioGitRun
  /** Hear a checkout's changes for as long as the caller wants; it stays watched until the last caller stops. */
  followCheckout(checkoutPath: string, listener: (change: GitCheckoutChange) => void): () => void
  onChangelistsChanged(listener: (payload: { repoRoot: string }) => void): () => void
  onCloneProgress(listener: (progress: CloneProgress) => void): () => void
  /** Whether this Studio holds a GitHub account's token store. */
  readonly hasGitHub: boolean
}
