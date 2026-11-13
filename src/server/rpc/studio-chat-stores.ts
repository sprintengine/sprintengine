import type {
  StudioChatStoresMethod,
  StudioChatStoresMethodMap,
  StudioGrant,
  StudioHandlerOf,
} from '../../../packages/studio-protocol/src/public'
import type { StudioChatStores } from '../chat-stores/chat-stores-domain'

// The router's answers to `usageLimits.*`, `usageLimitResumes.*`,
// `scheduledMessages.*`, `usage.report`, `usage.rows` and `conversationImport.*`: each
// method's store call, once the router has held the grant to the method's
// scope (and the report and the import to an owner). A change is carried out
// once per command id: a retry after a dropped connection is answered with
// the first answer, and a held message is held under the command it came in
// on, so the same ask holds it once even across a restart.

type Asking = { grant: StudioGrant }

export type StudioChatStoresHandlers<A extends Asking = Asking> = {
  readonly [M in StudioChatStoresMethod]: StudioHandlerOf<StudioChatStoresMethodMap[M], A>
}

type Answer<R> = { ok: true; result: R } | { ok: false; error: { code: 'unavailable'; message: string } }

export type StudioChatStoresHandlerOptions<A extends Asking = Asking> = {
  /** The stores; without them every method is answered `unavailable`. */
  stores?: StudioChatStores
  /** The client's command id, namespaced as every runtime command id is (`owner:…`, `client:<id>:…`). */
  commandIdOf(grant: StudioGrant, commandId: string): string
  /** The first answer to a method's command id, for every retry of it; new work otherwise. */
  kept<R>(method: StudioChatStoresMethod, asking: A, commandId: string, work: () => Promise<R>): Promise<Answer<R>>
}

const unserved = (method: StudioChatStoresMethod) =>
  ({ ok: false, error: { code: 'unavailable', message: `This Studio does not serve ${method}.` } }) as const

function ok<T>(result: T): { ok: true; result: T } {
  return { ok: true, result }
}

export function createStudioChatStoresHandlers<A extends Asking>(
  options: StudioChatStoresHandlerOptions<A>,
): StudioChatStoresHandlers<A> {
  const { stores } = options
  return {
    'usageLimits.get': async () => (stores ? ok(await stores.usageLimits()) : unserved('usageLimits.get')),
    'usageLimitResumes.get': () => (stores ? ok(stores.usageLimitResumes()) : unserved('usageLimitResumes.get')),
    'usageLimitResumes.update': ({ commandId, action, ...chat }, asking) =>
      stores
        ? options.kept('usageLimitResumes.update', asking, commandId, async () =>
            stores.updateUsageLimitResume({ kind: action, ...chat }),
          )
        : unserved('usageLimitResumes.update'),
    'usageLimitResumes.setAuto': ({ commandId, enabled }, asking) =>
      stores
        ? options.kept('usageLimitResumes.setAuto', asking, commandId, async () =>
            stores.updateUsageLimitResume({ kind: 'auto', enabled }),
          )
        : unserved('usageLimitResumes.setAuto'),
    'scheduledMessages.get': () => (stores ? ok(stores.scheduledMessages()) : unserved('scheduledMessages.get')),
    'scheduledMessages.update': ({ commandId, update }, asking) =>
      stores
        ? options.kept('scheduledMessages.update', asking, commandId, async () => stores.updateScheduledMessage(update))
        : unserved('scheduledMessages.update'),
    'usage.report': async (request) => (stores ? ok(await stores.usageReport(request)) : unserved('usage.report')),
    'usage.rows': async (args) => (stores ? ok(await stores.usageRows(args)) : unserved('usage.rows')),
    'conversationImport.scan': async () =>
      stores ? ok(await stores.scanImports()) : unserved('conversationImport.scan'),
    'conversationImport.import': ({ commandId, sessions }, asking) =>
      stores
        ? options.kept('conversationImport.import', asking, commandId, () => stores.importConversations({ sessions }))
        : unserved('conversationImport.import'),
  }
}
