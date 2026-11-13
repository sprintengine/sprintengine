import type {
  StudioChatLifecycleMethod,
  StudioChatLifecycleMethodMap,
  StudioGrant,
  StudioHandlerOf,
} from '../../../packages/studio-protocol/src/public'
import type {
  StudioChatLifecycleAnswer,
  StudioChatLifecycleDomain,
  StudioChatLifecycleRefusal,
} from '../chat-lifecycle/chat-lifecycle-domain'

// The router's answers to `chat-lifecycle`: each method's call on the chat's
// record, by its workspace, once the router has held the grant to the
// method's scope. A chat the Studio has no record of is `not_found`. A change is carried out once per command id: a retry
// after a dropped connection is answered with the first answer, so a mark
// retried after another device changed the chat does not undo that change.

type Asking = { grant: StudioGrant }

export type StudioChatLifecycleHandlers<A extends Asking = Asking> = {
  readonly [M in StudioChatLifecycleMethod]: StudioHandlerOf<StudioChatLifecycleMethodMap[M], A>
}

type Code = StudioChatLifecycleRefusal['code']
type Answer<R, C extends Code = Code> = { ok: true; result: R } | { ok: false; error: { code: C; message: string } }

export type StudioChatLifecycleHandlerOptions<A extends Asking = Asking> = {
  /** The chats' records; without them every method is answered `unavailable`. */
  lifecycle?: StudioChatLifecycleDomain
  /** The first answer to a method's command id, for every retry of it; new work otherwise. */
  kept<R, C extends Code>(
    method: StudioChatLifecycleMethod,
    asking: A,
    commandId: string,
    work: () => Promise<Answer<R, C>>,
  ): Promise<Answer<R, C | 'unavailable'>>
}

const unserved = (method: StudioChatLifecycleMethod) =>
  ({ ok: false, error: { code: 'unavailable', message: `This Studio does not serve ${method}.` } }) as const

function answer<T, C extends Code>(outcome: StudioChatLifecycleAnswer<T, C>): Answer<T, C> {
  return outcome.ok
    ? { ok: true, result: outcome.value }
    : { ok: false, error: { code: outcome.code, message: outcome.message } }
}

export function createStudioChatLifecycleHandlers<A extends Asking>(
  options: StudioChatLifecycleHandlerOptions<A>,
): StudioChatLifecycleHandlers<A> {
  const { lifecycle } = options

  /** A change to one chat, carried out once per command id. */
  function change<M extends StudioChatLifecycleMethod, R, C extends Code>(
    method: M,
    asking: A,
    params: { workspaceId: string; commandId: string },
    work: (
      lifecycle: StudioChatLifecycleDomain,
      workspaceId: string,
      byOwner: boolean,
    ) => Promise<StudioChatLifecycleAnswer<R, C>>,
  ) {
    if (!lifecycle) return unserved(method)
    return options.kept(method, asking, params.commandId, async () =>
      answer(await work(lifecycle, params.workspaceId, asking.grant.owner)),
    )
  }

  return {
    'conversation.markUnread': (params, asking) =>
      change('conversation.markUnread', asking, params, (done, id, owner) => done.markUnread(id, owner)),
    'conversation.snooze': (params, asking) =>
      change('conversation.snooze', asking, params, (done, id, owner) => done.snooze(id, params.until, owner)),
    'conversation.highlight': ({ starred, color, ...params }, asking) =>
      change('conversation.highlight', asking, params, (done, id, owner) =>
        done.highlight(
          id,
          { ...(starred !== undefined ? { starred } : {}), ...(color !== undefined ? { color } : {}) },
          owner,
        ),
      ),
    'conversation.setAutoSettle': (params, asking) =>
      change('conversation.setAutoSettle', asking, params, (done, id, owner) =>
        done.setAutoSettle(id, params.enabled, owner),
      ),
    'conversation.setAutoCompact': (params, asking) =>
      change('conversation.setAutoCompact', asking, params, (done, id, owner) =>
        done.setAutoCompact(id, params.enabled, owner),
      ),
    'conversation.rename': (params, asking) =>
      change('conversation.rename', asking, params, (done, id, owner) => done.rename(id, params.name, owner)),
    'conversation.delete': (params, asking) =>
      change('conversation.delete', asking, params, (done, id, owner) => done.delete(id, owner)),
    'conversation.deletePlan': async ({ workspaceId }) => {
      if (!lifecycle) return unserved('conversation.deletePlan')
      return answer(await lifecycle.deletePlan(workspaceId))
    },
    'conversation.searchChats': async ({ query }) => {
      if (!lifecycle) return unserved('conversation.searchChats')
      return { ok: true, result: await lifecycle.searchChats(query) }
    },
  }
}
