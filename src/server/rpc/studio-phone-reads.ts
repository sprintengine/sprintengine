import type {
  StudioBacklogMethodMap,
  StudioGrant,
  StudioHandlerOf,
  StudioPullRequestReadsMethodMap,
  StudioSharesMethodMap,
} from '../../../packages/studio-protocol/src/public'
import type { StudioPhoneReads } from '../backlog/backlog-domain'

// The router's answers to `backlog.*`, `shares.list` and the pull request
// reads, once the router has held the grant to each method's scope. An update
// is carried out once per command id: a retry after a dropped connection is
// answered with the first answer.

type Asking = { grant: StudioGrant }
type Map = StudioBacklogMethodMap & StudioSharesMethodMap & StudioPullRequestReadsMethodMap

export type StudioPhoneReadsHandlers<A extends Asking = Asking> = {
  readonly [M in keyof Map]: StudioHandlerOf<Map[M], A>
}

type Code = 'not_found' | 'invalid_params' | 'unavailable'
type Answer<R, C extends Code = Code> = { ok: true; result: R } | { ok: false; error: { code: C; message: string } }

export type StudioPhoneReadsHandlerOptions<A extends Asking = Asking> = {
  /** The reads; without them every method is answered `unavailable`. */
  reads?: StudioPhoneReads
  /** The first answer to a method's command id, for every retry of it; new work otherwise. */
  kept<R, C extends Code>(
    method: keyof Map,
    asking: A,
    commandId: string,
    work: () => Promise<Answer<R, C>>,
  ): Promise<Answer<R, C | 'unavailable'>>
}

const unserved = (method: keyof Map) =>
  ({ ok: false, error: { code: 'unavailable', message: `This Studio does not serve ${method}.` } }) as const

function answer<T>(outcome: { ok: true; value: T } | { ok: false; code: Code; message: string }): Answer<T> {
  return outcome.ok
    ? { ok: true, result: outcome.value }
    : { ok: false, error: { code: outcome.code, message: outcome.message } }
}

/** A read of a pull request names no record of this Studio's: one it could not find is one it could not read. */
function read<T>(
  outcome: { ok: true; value: T } | { ok: false; code: Code; message: string },
): Answer<T, 'invalid_params' | 'unavailable'> {
  if (outcome.ok) return { ok: true, result: outcome.value }
  return {
    ok: false,
    error: { code: outcome.code === 'invalid_params' ? 'invalid_params' : 'unavailable', message: outcome.message },
  }
}

export function createStudioPhoneReadsHandlers<A extends Asking>(
  options: StudioPhoneReadsHandlerOptions<A>,
): StudioPhoneReadsHandlers<A> {
  const { reads } = options
  return {
    'backlog.list': async () =>
      reads ? { ok: true, result: { workspaces: await reads.backlog.list() } } : unserved('backlog.list'),
    'backlog.update': ({ commandId, ...update }, asking) =>
      reads
        ? options.kept('backlog.update', asking, commandId, async () => answer(await reads.backlog.update(update)))
        : unserved('backlog.update'),
    'shares.list': async () =>
      reads ? { ok: true, result: { shares: await reads.shares() } } : unserved('shares.list'),
    'pullRequests.detail': async ({ url }) =>
      reads ? read(await reads.pullRequest(url)) : unserved('pullRequests.detail'),
    'pullRequests.diff': async ({ url, path, offset }) =>
      reads ? read(await reads.pullRequestDiff(url, path, offset ?? 0)) : unserved('pullRequests.diff'),
  }
}
