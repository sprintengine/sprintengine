import type {
  StudioCanvasMethod,
  StudioCanvasMethodMap,
  StudioGrant,
  StudioHandlerOf,
} from '../../../packages/studio-protocol/src/public'
import type { StudioRequestContext } from './studio-rpc-types'
import type { StudioCanvasAnswer, StudioCanvasDomain, StudioCanvasRefusal } from '../canvas/canvas-domain'

// The router's answers to `canvas.*`: each method's call on the machine's
// boards, once the router has held the grant to the method's scope. A commit
// is carried out once per command id, so one retried after a dropped
// connection merges once and is answered as it was the first time. Staging
// and the pen belong to the connection that asks.

type Asking = { grant: StudioGrant; context: StudioRequestContext }

export type StudioCanvasHandlers<A extends Asking = Asking> = {
  readonly [M in StudioCanvasMethod]: StudioHandlerOf<StudioCanvasMethodMap[M], A>
}

type Code = StudioCanvasRefusal['code']
type Answer<R> = { ok: true; result: R } | { ok: false; error: { code: Code; message: string } }

export type StudioCanvasHandlerOptions<A extends Asking = Asking> = {
  /** The boards; without them every method is answered `unavailable`. */
  canvas?: StudioCanvasDomain
  /** The first answer to a method's command id, for every retry of it; new work otherwise. */
  kept<R>(
    method: StudioCanvasMethod,
    asking: A,
    commandId: string,
    work: () => Promise<Answer<R>>,
  ): Promise<Answer<R> | { ok: false; error: { code: 'unavailable'; message: string } }>
}

const unserved = (method: StudioCanvasMethod) =>
  ({ ok: false, error: { code: 'unavailable', message: `This Studio does not serve ${method}.` } }) as const

function answer<T>(outcome: StudioCanvasAnswer<T>): Answer<T> {
  return outcome.ok
    ? { ok: true, result: outcome.value }
    : { ok: false, error: { code: outcome.code, message: outcome.message } }
}

export function createStudioCanvasHandlers<A extends Asking>(
  options: StudioCanvasHandlerOptions<A>,
): StudioCanvasHandlers<A> {
  const { canvas } = options
  return {
    'canvas.list': async ({ workspaceId }) =>
      canvas ? answer(await canvas.list(workspaceId)) : unserved('canvas.list'),
    'canvas.picture': async (params) => (canvas ? answer(await canvas.picture(params)) : unserved('canvas.picture')),
    'canvas.read': async (ref) => (canvas ? answer(await canvas.read(ref)) : unserved('canvas.read')),
    'canvas.files': async ({ ids, ...ref }) =>
      canvas ? answer(await canvas.files(ref, ids)) : unserved('canvas.files'),
    'canvas.stage': async (params, asking) => {
      if (!canvas) return unserved('canvas.stage')
      const staged = await canvas.stage(asking.context.connectionId, params)
      if (staged.ok) return { ok: true, result: staged.value }
      // What a stage refuses is its size, its parts, or a board this client may
      // not reach; the method names no board that could be missing, so that is
      // `invalid_params` too, in the domain's words.
      const code = staged.code === 'too_large' || staged.code === 'unavailable' ? staged.code : 'invalid_params'
      return { ok: false, error: { code, message: staged.message } }
    },
    'canvas.commit': ({ commandId, ...params }, asking) =>
      canvas
        ? options.kept('canvas.commit', asking, commandId, async () =>
            answer(await canvas.commit(asking.context.connectionId, params)),
          )
        : unserved('canvas.commit'),
    'canvas.takePen': async (ref, asking) => {
      if (!canvas) return unserved('canvas.takePen')
      canvas.takePen(asking.context.connectionId, ref)
      return { ok: true, result: { taken: true } }
    },
  }
}
