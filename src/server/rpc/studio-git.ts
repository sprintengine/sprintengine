import {
  STUDIO_METHODS,
  type GitCheckoutChange,
  type StudioErrorBody,
  type StudioGitMethod,
  type StudioGitMethodMap,
  type StudioGrant,
  type StudioHandlerOf,
} from '../../../packages/studio-protocol/src/public'
import { spelledResult } from '../../main/environments/ssh/machine-ipc'
import { notOnMachineYet } from '../../shared/machine-channels'
import type { StudioFileSystem } from '../files/studio-file-system'
import type { StudioGit } from '../git/studio-git-types'
import { isAbsolute, join } from 'node:path'

import {
  namesAnyPath,
  placePath,
  UNKNOWN_PATH,
  type StudioFileSystemAsking,
  type StudioMachineCall,
} from './studio-file-system'
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
// An owner's repository on an SSH machine (`ssh://…`) is answered there for
// the reads and stages that machine's server answers (`machine-channels.ts`),
// and refused in words for the rest, until those machines' panes reach their
// own servers.

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
  machine?: StudioMachineCall
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

/**
 * What an SSH machine's server answers, as the window's IPC sent it there
 * (`machine-channels.ts`): its channel and arguments, with the folder made
 * plain, and how its answer reads as this method's result.
 */
const ON_MACHINE: Partial<
  Record<
    StudioGitMethod,
    { channel: string; args(p: Record<string, unknown>): unknown[]; result?(value: unknown): unknown }
  >
> = {
  'git.status': { channel: 'git:get-status', args: (p) => [p.repoRoot] },
  'git.checkIgnored': {
    channel: 'git:check-ignored',
    args: (p) => [p.repoRoot, p.paths],
    result: (value) => ({ paths: value }),
  },
  'git.fileBase': { channel: 'git:get-file-base', args: (p) => [p.repoRoot, p.path] },
  'git.fileAtStage': { channel: 'git:get-file-at-stage', args: (p) => [p.repoRoot, p.path, p.stage] },
  'git.fileAtRev': { channel: 'git:get-file-at-rev', args: (p) => [p.repoRoot, p.rev, p.path] },
  'git.fileHunks': { channel: 'git:get-file-hunks', args: (p) => [p.repoRoot, p.path, p.scope] },
  'git.changeSummary': { channel: 'git:get-workspace-change-summary', args: (p) => [p.checkoutPath] },
  'git.branchSteps': { channel: 'git:get-branch-steps', args: (p) => [p.checkoutPath] },
  'git.branchStepDiff': { channel: 'git:get-branch-step-diff', args: (p) => [p.checkoutPath, p.selection] },
  'git.branches': { channel: 'git:get-branches', args: (p) => [p.repoRoot] },
  'git.commitGraph': {
    channel: 'git:get-commit-graph',
    args: (p) => [
      p.repoRoot,
      { ...(p.limit === undefined ? {} : { limit: p.limit }), ...(p.skip === undefined ? {} : { skip: p.skip }) },
    ],
  },
  'git.repositoryIdentity': { channel: 'git:get-repository-identity', args: (p) => [p.folderPath] },
  'git.stage': { channel: 'git:stage', args: (p) => [p.repoRoot, p.paths] },
  'git.unstage': { channel: 'git:unstage', args: (p) => [p.repoRoot, p.paths] },
  'git.stageHunk': { channel: 'git:stage-hunk', args: (p) => [p.ref] },
  'git.unstageHunk': { channel: 'git:unstage-hunk', args: (p) => [p.ref] },
  'git.commit': { channel: 'git:commit', args: (p) => [p.repoRoot, p.message] },
}

const ok = <T>(result: T): { ok: true; result: T } => ({ ok: true, result })
const refuse = <C extends string>(code: C, message: string): Refused<C> => ({ ok: false, error: { code, message } })

export function createStudioGitHandlers(options: StudioGitHandlerOptions) {
  const { git } = options

  async function answer(method: StudioGitMethod, raw: Record<string, unknown>, asking: Asking) {
    if (!git) return refuse('unavailable', `This Studio does not serve ${method}.`)
    if (method.startsWith('github.') && method !== 'github.clone' && method !== 'github.listOwners' && !git.hasGitHub)
      return refuse('unavailable', 'This Studio holds no GitHub account.')
    const { commandId: _commandId, ...unplaced } = raw
    let params: Record<string, unknown> = unplaced
    let machine: { id: string } | null = null
    const purpose = STUDIO_METHODS[method].mutation ? 'write' : 'read'
    for (const field of foldersOf(method)) {
      if (!options.fileSystem) return refuse('unavailable', `This Studio does not serve ${method}.`)
      const at = await placePath(options.fileSystem, read(params, field), asking, purpose)
      if (!at.ok) return refuse('not_found', UNKNOWN_PATH)
      if (at.machine) {
        if (machine && machine.id !== at.machine.id) return refuse('not_found', UNKNOWN_PATH)
        machine = { id: at.machine.id }
        params = write(params, field, at.machine.path)
      } else {
        if (machine) return refuse('not_found', UNKNOWN_PATH)
        params = write(params, field, at.path)
      }
    }
    // A resolved conflict is written to its file before git adds it: for a
    // client held to known folders that file is held as any write is, by
    // where it really is, so a link in the repository cannot carry it out.
    if (method === 'git.resolveConflict' && !machine && !namesAnyPath(asking) && options.fileSystem) {
      const file = String(params.path)
      const at = await placePath(
        options.fileSystem,
        isAbsolute(file) ? file : join(String(params.repoRoot), file),
        asking,
        'write',
      )
      if (!at.ok || at.machine) return refuse('not_found', UNKNOWN_PATH)
      params = { ...params, path: at.path }
    }
    if (machine) {
      const route = ON_MACHINE[method]
      if (!route || !options.machine) return refuse('unavailable', notOnMachineYet(method))
      const value = await options.machine(machine.id, route.channel, route.args(params))
      const spelled = spelledResult(machine.id, route.channel, value)
      return ok(route.result ? route.result(spelled) : spelled)
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
    if (!at.ok) return { ok: false, code: 'not_found', message: UNKNOWN_PATH }
    // A checkout on an SSH machine is not watched here: its views refresh by asking again.
    if (at.machine) return { ok: false, code: 'unavailable', message: notOnMachineYet('git.checkoutChanged') }
    return { ok: true, dispose: git.followCheckout(at.path, listener) }
  }

  return { handlers, followCheckout }
}
