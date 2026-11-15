import type {
  AutomationServerStatus,
  McpHttpCreateResult,
  McpHttpStatus,
  StudioAccessMethodMap,
  StudioErrorBody,
  StudioGrant,
  StudioHandlerOf,
  StudioLocalAppOfferInput,
  StudioLocalAppOfferView,
  StudioLocalAppsStatus,
  StudioLocalAppToolReach,
} from '../../../packages/studio-protocol/src/public'

// The router's answers to the access family (`gateway.status`, `mcpHttp.*`,
// `localApps.*`): each method's domain call, once the router has held the
// grant to an owner's connection, and the window-only ones to Studio's own
// desktop windows (the method table says which, and why). What is left here
// is the family's own rule: a command is carried out once per command id, a
// retry answered with the first answer, so a retried mint is not a second
// token or code.

/** Who may reach this Studio's agents from this machine, as the gateway and the owner socket hold it. */
export type StudioAccessDomain = {
  gatewayStatus(): AutomationServerStatus
  mcpHttpStatus(): McpHttpStatus
  createMcpHttp(name: string): Promise<McpHttpCreateResult>
  revokeMcpHttp(id: string): Promise<McpHttpStatus>
  localApps: {
    status(): StudioLocalAppsStatus
    offer(input: StudioLocalAppOfferInput): StudioLocalAppOfferView
    cancelOffer(id: string): StudioLocalAppsStatus
    revoke(id: string): Promise<StudioLocalAppsStatus>
    setReach(id: string, reach: StudioLocalAppToolReach): StudioLocalAppsStatus
    /** Every change to the paired apps, the codes waiting and who is connected. */
    onChanged(listener: (status: StudioLocalAppsStatus) => void): () => void
  }
}

export type StudioAccessAsking = {
  grant: StudioGrant
  voice: { failed(code: 'unavailable', detail: string | undefined, context: string): unknown }
}

type Method = keyof StudioAccessMethodMap
export type StudioAccessHandlers = {
  readonly [M in Method]: StudioHandlerOf<StudioAccessMethodMap[M], StudioAccessAsking>
}

type Refused = { ok: false; error: StudioErrorBody & { code: 'unavailable' } }

export type StudioAccessHandlerOptions = {
  /** The domain; without it, every method is answered `unavailable`. */
  access?: StudioAccessDomain
  /** The first answer to a command id is every retry's. */
  once: <A extends { ok: boolean; error?: StudioErrorBody }>(
    id: string,
    work: () => Promise<A>,
    voice: StudioAccessAsking['voice'],
    method: string,
  ) => Promise<A | Refused>
  /** A client's command id, namespaced by the client. */
  runtimeId(grant: StudioGrant, commandId: string): string
}

const unserved = (method: Method): Refused => ({
  ok: false,
  error: { code: 'unavailable', message: `This Studio does not serve ${method}.` },
})

function ok<T>(result: T): { ok: true; result: T } {
  return { ok: true, result }
}

export function createStudioAccessHandlers(options: StudioAccessHandlerOptions): StudioAccessHandlers {
  const { access } = options

  function command<R>(
    method: Method,
    commandId: string,
    asking: StudioAccessAsking,
    work: (access: StudioAccessDomain) => R | Promise<R>,
  ): Promise<{ ok: true; result: R } | Refused> | Refused {
    if (!access) return unserved(method)
    return options.once(
      `${method}:${options.runtimeId(asking.grant, commandId)}`,
      async () => ok(await work(access)),
      asking.voice,
      method,
    )
  }
  const read = <R>(method: Method, work: (access: StudioAccessDomain) => R) =>
    access ? ok(work(access)) : unserved(method)

  return {
    'gateway.status': () => read('gateway.status', (domain) => domain.gatewayStatus()),
    'mcpHttp.status': () => read('mcpHttp.status', (domain) => domain.mcpHttpStatus()),
    'mcpHttp.create': ({ commandId, name }, asking) =>
      command('mcpHttp.create', commandId, asking, (domain) => domain.createMcpHttp(name)),
    'mcpHttp.revoke': ({ commandId, id }, asking) =>
      command('mcpHttp.revoke', commandId, asking, (domain) => domain.revokeMcpHttp(id)),
    'localApps.status': () => read('localApps.status', (domain) => domain.localApps.status()),
    'localApps.offer': ({ commandId, input }, asking) =>
      command('localApps.offer', commandId, asking, (domain) => domain.localApps.offer(input)),
    'localApps.cancelOffer': ({ commandId, id }, asking) =>
      command('localApps.cancelOffer', commandId, asking, (domain) => domain.localApps.cancelOffer(id)),
    'localApps.revoke': ({ commandId, id }, asking) =>
      command('localApps.revoke', commandId, asking, (domain) => domain.localApps.revoke(id)),
    'localApps.setReach': ({ commandId, id, reach }, asking) =>
      command('localApps.setReach', commandId, asking, (domain) => domain.localApps.setReach(id, reach)),
  }
}
