import type {
  StudioFileViewsMethod,
  StudioFileViewsMethodMap,
  StudioGrant,
  StudioHandlerOf,
} from '../../../packages/studio-protocol/src/public'
import type { FileViews } from '../file-views/file-views'

// The router's answers to `file-views`: a file a chat's agent showed
// (`file.view`), read and saved for the person through that chat
// (server/file-views/file-views.ts holds who may save what). A save is
// carried out once per command id, so a retry after a dropped connection is
// answered with the first save's answer and does not save twice.

type Asking = { grant: StudioGrant }

export type StudioFileViewsHandlers<A extends Asking = Asking> = {
  readonly [M in StudioFileViewsMethod]: StudioHandlerOf<StudioFileViewsMethodMap[M], A>
}

type Refusal = { ok: false; error: { code: 'not_found' | 'too_large' | 'unavailable'; message: string } }

export type StudioFileViewsHandlerOptions<A extends Asking = Asking> = {
  /** The views; without them both methods are answered `unavailable`. */
  views?: Pick<FileViews, 'read' | 'write'>
  /** The first answer to a command id, for every retry of it; new work otherwise. */
  kept<R>(
    method: StudioFileViewsMethod,
    asking: A,
    commandId: string,
    work: () => Promise<{ ok: true; result: R } | Refusal>,
  ): Promise<{ ok: true; result: R } | Refusal>
}

const unserved = (method: StudioFileViewsMethod): Refusal => ({
  ok: false,
  error: { code: 'unavailable', message: `This Studio does not serve ${method}.` },
})

export function createStudioFileViewsHandlers<A extends Asking>(
  options: StudioFileViewsHandlerOptions<A>,
): StudioFileViewsHandlers<A> {
  const { views } = options
  return {
    'fileViews.read': async ({ key, path }) => {
      if (!views) return unserved('fileViews.read')
      const read = await views.read({ workspaceId: key.workspaceId, agentId: key.agentId }, path)
      return read.ok
        ? { ok: true, result: read.read }
        : { ok: false, error: { code: read.code, message: read.message } }
    },
    'fileViews.write': ({ key, path, text, ifMatch, commandId }, asking) => {
      if (!views) return unserved('fileViews.write')
      return options.kept('fileViews.write', asking, commandId, async () => {
        const written = await views.write({ workspaceId: key.workspaceId, agentId: key.agentId }, path, text, ifMatch)
        return written.ok
          ? { ok: true, result: written.written }
          : { ok: false, error: { code: written.code, message: written.message } }
      })
    },
  }
}
