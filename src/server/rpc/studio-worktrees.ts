import {
  STUDIO_METHODS,
  type StudioErrorBody,
  type StudioGrant,
  type StudioHandlerOf,
  type StudioWorktreesMethod,
  type StudioWorktreesMethodMap,
} from '../../../packages/studio-protocol/src/public'
import { isMachinePath } from '../../shared/machine-paths'
import { notOnMachineYet } from '../../shared/machine-channels'
import type { StudioWorktrees } from '../worktrees/studio-worktrees-types'

// The router's answers to `worktrees.*` and `settledChats.*`. The method
// table holds who may run what: the pool and the agents' worktrees are an
// owner's, each with its reason; a settled chat's delete is a chat's, as a
// paired device's Delete on a chat here is. Every write runs once per
// command id. An agent worktree step that names a folder on an SSH machine is
// refused in words, as the window's IPC refused it: that machine's worktrees
// are its own server's. The inventory leaves such a project out; a pool read
// for one finds no pool here.

/** The steps that run git on the folders they name. */
const STEPS: ReadonlySet<StudioWorktreesMethod> = new Set([
  'worktrees.create',
  'worktrees.restore',
  'worktrees.remove',
  'worktrees.removeOther',
  'worktrees.cleanupAgents',
])

type Asking = { grant: StudioGrant; voice: unknown }

export type StudioWorktreesHandlers = {
  readonly [M in StudioWorktreesMethod]: StudioHandlerOf<StudioWorktreesMethodMap[M], Asking>
}

type Refused<C extends string> = { ok: false; error: StudioErrorBody & { code: C } }
type Kept = <A extends { ok: boolean; error?: StudioErrorBody }>(
  id: string,
  work: () => Promise<A>,
  voice: unknown,
  method: string,
) => Promise<A | Refused<'unavailable'>>

export type StudioWorktreesHandlerOptions = {
  worktrees?: StudioWorktrees
  once: Kept
  runtimeId(grant: StudioGrant, commandId: string): string
}

/** Whether anything in these params names a folder on an SSH machine: a member, or an entry of a list. */
function namesMachine(params: Record<string, unknown>, depth = 0): boolean {
  for (const value of Object.values(params)) {
    if (isMachinePath(value)) return true
    if (Array.isArray(value) && value.some(isMachinePath)) return true
    if (depth === 0 && value !== null && typeof value === 'object' && !Array.isArray(value))
      if (namesMachine(value as Record<string, unknown>, depth + 1)) return true
  }
  return false
}

const ok = <T>(result: T): { ok: true; result: T } => ({ ok: true, result })
const refuse = <C extends string>(code: C, message: string): Refused<C> => ({ ok: false, error: { code, message } })

export function createStudioWorktreesHandlers(options: StudioWorktreesHandlerOptions): StudioWorktreesHandlers {
  const { worktrees } = options

  async function answer(method: StudioWorktreesMethod, raw: Record<string, unknown>, asking: Asking) {
    if (!worktrees) return refuse('unavailable', `This Studio does not serve ${method}.`)
    const { commandId: _commandId, ...asked } = raw
    let params: Record<string, unknown> = asked
    if (STEPS.has(method) && namesMachine(params)) return refuse('unavailable', notOnMachineYet(method))
    if (method === 'worktrees.inventory')
      params = { ...params, repoRoots: (params.repoRoots as string[]).filter((root) => !isMachinePath(root)) }
    const run = worktrees.run[method] as (
      params: Record<string, unknown>,
      asker: { owner: boolean },
    ) => Promise<unknown>
    return ok(await run(params, { owner: asking.grant.owner }))
  }

  return Object.fromEntries(
    (Object.keys(STUDIO_METHODS) as StudioWorktreesMethod[])
      .filter((method) => /^(worktrees|settledChats)\./u.test(method))
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
  ) as unknown as StudioWorktreesHandlers
}
