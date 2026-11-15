import {
  STUDIO_METHODS,
  type GitCheckoutChange,
  type StudioErrorBody,
  type StudioGitMethod,
  type StudioGitMethodMap,
  type StudioGrant,
  type StudioHandlerOf,
} from '../../../packages/studio-protocol/src/public'
import type { StudioFileSystem } from '../files/studio-file-system'
import type { StudioGit } from '../git/studio-git-types'
import { isAbsolute, join } from 'node:path'

import { namesAnyPath, placePath, unplaced, UNKNOWN_PATH, type StudioFileSystemAsking } from './studio-file-system'
import type { StudioRequestContext } from './studio-rpc-types'

// The router's answers to `git.*`, `github.*` and `versionControl.*`. The
// method table holds who may run what (a scope, and an owner's reason for
// what moves branches, rewrites history, discards work, reaches a remote or
// holds the GitHub account). The rule of their own is the folders: every
// folder a method names (its repository, checkout, folder, worktree, or where
// a clone goes) is placed as the files by path are (`studio-file-system.ts`):
// as written for an owner's own connection, else only where it really is
// inside the folders Studio knows, the work done on that real path. Writes
// are held to the workspaces' own folders.
//
// A repository on an SSH machine (`ssh://…`) is that machine's own Studio's:
// the window asks it there (design-wsl-ssh-direct PR 2), and here it is
// refused as any path on another machine is.

type Asking = StudioFileSystemAsking

export type StudioGitHandlers = {
  readonly [M in StudioGitMethod]: StudioHandlerOf<StudioGitMethodMap[M], Asking>
}

type Refused<C extends string> = { ok: false; error: StudioErrorBody & { code: C } }
type Kept = <A extends { ok: boolean; error?: StudioErrorBody }>(
  id: string,
  work: () => Promise<A>,
  voice: Asking['voice'],
  method: string,
) => Promise<A | Refused<'unavailable'>>

export type StudioGitHandlerOptions = {
  git?: StudioGit
  /** Where the known folders come from: the files by path. */
  fileSystem?: StudioFileSystem
  once: Kept
  runtimeId(grant: StudioGrant, commandId: string): string
}

/** Which members of each method's params name a folder on this machine. */
type FolderField = 'repoRoot' | 'checkoutPath' | 'folderPath' | 'worktreePath' | 'ref.repoRoot' | 'input.parentDir'

function foldersOf(method: StudioGitMethod): FolderField[] {
  if (method === 'git.stageHunk' || method === 'git.unstageHunk') return ['ref.repoRoot']
  if (method === 'github.clone' || method === 'github.newProject') return ['input.parentDir']
  if (method === 'git.changeSummary' || method === 'git.branchSteps' || method === 'git.branchStepDiff')
    return ['checkoutPath']
  if (method === 'git.repositoryIdentity' || method === 'git.moduleWorkspaceInfo') return ['folderPath']
  if (method === 'git.unlockAgentWorktree') return ['repoRoot', 'worktreePath']
  if (method.startsWith('git.')) return ['repoRoot']
  return []
}

function read(params: Record<string, unknown>, field: FolderField): string {
  const [outer, inner] = field.split('.') as [string, string | undefined]
  const value = inner ? (params[outer] as Record<string, unknown>)[inner] : params[outer]
  return value as string
}

function write(params: Record<string, unknown>, field: FolderField, value: string): Record<string, unknown> {
  const [outer, inner] = field.split('.') as [string, string | undefined]
  return inner
    ? { ...params, [outer]: { ...(params[outer] as Record<string, unknown>), [inner]: value } }
    : { ...params, [outer]: value }
}

/** The methods that read or write a repository's file on disk themselves, not through git. */
const WORKING_FILE: Partial<Record<StudioGitMethod, 'read' | 'write'>> = {
  'git.conflictFile': 'read',
  'git.resolveConflict': 'write',
}

const ok = <T>(result: T): { ok: true; result: T } => ({ ok: true, result })
const refuse = <C extends string>(code: C, message: string): Refused<C> => ({ ok: false, error: { code, message } })

export function createStudioGitHandlers(options: StudioGitHandlerOptions) {
  const { git } = options

  async function answer(method: StudioGitMethod, raw: Record<string, unknown>, asking: Asking) {
    if (!git) return refuse('unavailable', `This Studio does not serve ${method}.`)
    if (method.startsWith('github.') && method !== 'github.clone' && method !== 'github.listOwners' && !git.hasGitHub)
      return refuse('unavailable', 'This Studio holds no GitHub account.')
    const { commandId: _commandId, ...asked } = raw
    let params: Record<string, unknown> = asked
    const purpose = STUDIO_METHODS[method].mutation ? 'write' : 'read'
    for (const field of foldersOf(method)) {
      if (!options.fileSystem) return refuse('unavailable', `This Studio does not serve ${method}.`)
      const at = await placePath(options.fileSystem, read(params, field), asking, purpose)
      if (!at.ok) return unplaced(at)
      params = write(params, field, at.path)
    }
    // A conflicted file is read from the working tree (`git.conflictFile`),
    // and a resolved one written there before git adds it: not through git,
    // which would take a link as a link. For a client held to known folders
    // that file is held as any read or write by path is, by where it really
    // is, so a link in the repository cannot carry either out of it.
    const workingFile = WORKING_FILE[method]
    if (workingFile && !namesAnyPath(asking) && options.fileSystem) {
      const file = String(params.path)
      const at = await placePath(
        options.fileSystem,
        isAbsolute(file) ? file : join(String(params.repoRoot), file),
        asking,
        workingFile,
      )
      if (!at.ok) return refuse('not_found', UNKNOWN_PATH)
      params = { ...params, path: at.path }
    }
    const run = git.run[method] as (params: Record<string, unknown>) => Promise<unknown>
    return ok(await run(params))
  }

  const handlers = Object.fromEntries(
    (Object.keys(STUDIO_METHODS) as StudioGitMethod[])
      .filter((method) => /^(git|github|versionControl)\./u.test(method))
      .map((method) => [
        method,
        (params: Record<string, unknown>, asking: Asking) =>
          STUDIO_METHODS[method].mutation
            ? options.once(
                `${method}:${options.runtimeId(asking.grant, params.commandId as string)}`,
                () => answer(method, params, asking),
                asking.voice,
                method,
              )
            : answer(method, params, asking),
      ]),
  ) as unknown as StudioGitHandlers

  /** Follow a checkout for `git.checkoutChanged`, held to what the asker may name. */
  async function followCheckout(
    checkoutPath: string,
    asking: { grant: StudioGrant; context: StudioRequestContext },
    listener: (change: GitCheckoutChange) => void,
  ): Promise<{ ok: true; dispose(): void } | { ok: false; code: 'not_found' | 'unavailable'; message: string }> {
    if (!git || !options.fileSystem)
      return { ok: false, code: 'unavailable', message: 'This Studio does not serve git.checkoutChanged.' }
    const at = await placePath(options.fileSystem, checkoutPath, asking, 'read')
    if (!at.ok) return { ok: false, ...unplaced(at).error }
    return { ok: true, dispose: git.followCheckout(at.path, listener) }
  }

  return { handlers, followCheckout }
}
