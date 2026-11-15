import type {
  StudioGrant,
  StudioHandlerOf,
  StudioSchedulesMethod,
  StudioSchedulesMethodMap,
} from '../../../packages/studio-protocol/src/public'
import type {
  StudioSchedulesAnswer,
  StudioSchedulesDomain,
  StudioSchedulesRefusal,
} from '../schedules/schedules-domain'
import type { StudioRequestContext } from './studio-rpc-types'

// The router's answers to `schedules.*`: each method's call on the Studio's
// scheduled agents, once the router has held the grant to the method's scope.
// A change is carried out once per command id: a retry after a dropped
// connection is answered with the first answer, so a retried Run now starts
// one chat, not two. The preset a schedule may run on is held to the asking
// grant's ceiling, and what starts a schedule (Resume, Run now, Resume all)
// to the folders the asker may name: a paired device starts none in a folder
// Studio does not know, and Resume all, which starts every schedule not
// paused on its own, is refused when one of them is beyond either.

type Asking = { grant: StudioGrant; context: StudioRequestContext }

export type StudioSchedulesHandlers<A extends Asking = Asking> = {
  readonly [M in StudioSchedulesMethod]: StudioHandlerOf<StudioSchedulesMethodMap[M], A>
}

type Code = StudioSchedulesRefusal['code']
type Answer<R, C extends Code = Code> = { ok: true; result: R } | { ok: false; error: { code: C; message: string } }

export type StudioSchedulesHandlerOptions<A extends Asking = Asking> = {
  /** The schedules; without them every method is answered `unavailable`. */
  schedules?: StudioSchedulesDomain
  /** The first answer to a method's command id, for every retry of it; new work otherwise. */
  kept<R, C extends Code>(
    method: StudioSchedulesMethod,
    asking: A,
    commandId: string,
    work: () => Promise<Answer<R, C>>,
  ): Promise<Answer<R, C | 'unavailable'>>
  /** Whether the asker may name this folder: any, for an owner's own connection; otherwise one Studio knows. */
  mayName(folder: string, asking: A): Promise<boolean>
}

const unserved = (method: StudioSchedulesMethod) =>
  ({ ok: false, error: { code: 'unavailable', message: `This Studio does not serve ${method}.` } }) as const

function answer<T, R, C extends Code>(outcome: StudioSchedulesAnswer<T, C>, shape: (value: T) => R): Answer<R, C> {
  return outcome.ok
    ? { ok: true, result: shape(outcome.value) }
    : { ok: false, error: { code: outcome.code, message: outcome.message } }
}

export function createStudioSchedulesHandlers<A extends Asking>(
  options: StudioSchedulesHandlerOptions<A>,
): StudioSchedulesHandlers<A> {
  const { schedules } = options
  const schedule = <T>(value: T) => ({ schedule: value })
  // The first of these schedules in a folder the asker may not name, as a refusal; null when there is none.
  const beyondReach = async (ids: readonly string[] | 'running', asking: A) => {
    const all = schedules?.list().schedules ?? []
    const starting =
      ids === 'running'
        ? all.filter((agent) => agent.pausedAt === undefined)
        : all.filter((agent) => ids.includes(agent.id))
    for (const agent of starting)
      if (!(await options.mayName(agent.folderPath, asking)))
        return {
          ok: false as const,
          error: {
            code: 'invalid_params' as const,
            message: `${agent.name || agent.id} runs in a folder this connection cannot name, so it is started from the machine it runs on.`,
          },
        }
    return null
  }
  return {
    'schedules.list': () => (schedules ? { ok: true, result: schedules.list() } : unserved('schedules.list')),
    'schedules.create': ({ commandId, ...draft }, asking) =>
      schedules
        ? options.kept('schedules.create', asking, commandId, async () =>
            answer(await schedules.create(draft, asking.grant.ceiling), schedule),
          )
        : unserved('schedules.create'),
    'schedules.update': ({ commandId, ...change }, asking) =>
      schedules
        ? options.kept('schedules.update', asking, commandId, async () =>
            answer(await schedules.update(change, asking.grant.ceiling), schedule),
          )
        : unserved('schedules.update'),
    'schedules.pause': ({ commandId, id }, asking) =>
      schedules
        ? options.kept('schedules.pause', asking, commandId, async () => answer(await schedules.pause(id), schedule))
        : unserved('schedules.pause'),
    'schedules.resume': ({ commandId, id }, asking) =>
      schedules
        ? options.kept(
            'schedules.resume',
            asking,
            commandId,
            async () =>
              (await beyondReach([id], asking)) ?? answer(await schedules.resume(id, asking.grant.ceiling), schedule),
          )
        : unserved('schedules.resume'),
    'schedules.runNow': ({ commandId, id }, asking) =>
      schedules
        ? options.kept(
            'schedules.runNow',
            asking,
            commandId,
            async () =>
              (await beyondReach([id], asking)) ??
              answer(await schedules.runNow(id, asking.grant.ceiling), (ran) => ran),
          )
        : unserved('schedules.runNow'),
    'schedules.delete': ({ commandId, id }, asking) =>
      schedules
        ? options.kept('schedules.delete', asking, commandId, async () =>
            answer(await schedules.remove(id), (gone) => gone),
          )
        : unserved('schedules.delete'),
    'schedules.markSeen': ({ commandId, id }, asking) =>
      schedules
        ? options.kept('schedules.markSeen', asking, commandId, async () =>
            answer(await schedules.markSeen(id), schedule),
          )
        : unserved('schedules.markSeen'),
    'schedules.pauseAll': ({ commandId, until }, asking) =>
      schedules
        ? options.kept('schedules.pauseAll', asking, commandId, async () =>
            answer(await schedules.pauseAll(until), (paused) => paused),
          )
        : unserved('schedules.pauseAll'),
    'schedules.resumeAll': ({ commandId }, asking) =>
      schedules
        ? options.kept(
            'schedules.resumeAll',
            asking,
            commandId,
            async () =>
              (await beyondReach('running', asking)) ??
              answer(await schedules.resumeAll(asking.grant.ceiling), (resumed) => resumed),
          )
        : unserved('schedules.resumeAll'),
  }
}
