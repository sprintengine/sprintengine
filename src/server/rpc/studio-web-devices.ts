import type {
  StudioErrorBody,
  StudioGrant,
  StudioHandlerOf,
  StudioWebDevicesMethodMap,
  WebDevicesStatus,
} from '../../../packages/studio-protocol/src/public'

// The router's answers to the paired browsers (`webDevices.*`): each method's
// call on the web listener's sessions and pair requests, once the router has
// held the grant to an owner's connection, which every one of them is. The
// listener is the web front door's, which starts after this server and hands
// its domain over (`provideWebDevices`); until it does, and on a Studio that
// runs none, every method is answered `unavailable` and the capability is not
// offered. A command is carried out once per command id.

/** The browsers paired with the web listener and the ones asking, as the front door holds them. */
export type StudioWebDevicesDomain = {
  /** The status as the client `clientId` is shown it: its own browser marked `current`. */
  status(clientId: string): WebDevicesStatus
  revoke(id: string): boolean
  approve(requestId: string, code: string): { ok: true } | { ok: false; message: string }
  decline(requestId: string): boolean
  /** Every change: a browser paired, removed or asking. */
  onChanged(listener: () => void): () => void
}

export type StudioWebDevicesAsking = {
  grant: StudioGrant
  voice: { failed(code: 'unavailable', detail: string | undefined, context: string): unknown }
}

type Method = keyof StudioWebDevicesMethodMap
export type StudioWebDevicesHandlers = {
  readonly [M in Method]: StudioHandlerOf<StudioWebDevicesMethodMap[M], StudioWebDevicesAsking>
}

type Refused = { ok: false; error: StudioErrorBody & { code: 'unavailable' } }

export type StudioWebDevicesHandlerOptions = {
  /** The domain, once the front door gave it; null where no web listener runs. */
  webDevices: () => StudioWebDevicesDomain | null
  /** The first answer to a command id is every retry's. */
  once: <A extends { ok: boolean; error?: StudioErrorBody }>(
    id: string,
    work: () => Promise<A>,
    voice: StudioWebDevicesAsking['voice'],
    method: string,
  ) => Promise<A | Refused>
  /** A client's command id, namespaced by the client. */
  runtimeId(grant: StudioGrant, commandId: string): string
}

const unserved = (method: Method): Refused => ({
  ok: false,
  error: { code: 'unavailable', message: `This Studio runs no web listener, so it does not serve ${method}.` },
})

function ok<T>(result: T): { ok: true; result: T } {
  return { ok: true, result }
}

export function createStudioWebDevicesHandlers(options: StudioWebDevicesHandlerOptions): StudioWebDevicesHandlers {
  function command<R>(
    method: Method,
    commandId: string,
    asking: StudioWebDevicesAsking,
    work: (domain: StudioWebDevicesDomain) => R,
  ): Promise<{ ok: true; result: R } | Refused> | Refused {
    const domain = options.webDevices()
    if (!domain) return unserved(method)
    return options.once(
      `${method}:${options.runtimeId(asking.grant, commandId)}`,
      async () => ok(work(domain)),
      asking.voice,
      method,
    )
  }

  return {
    'webDevices.status': (_params, { grant }) => {
      const domain = options.webDevices()
      return domain ? ok(domain.status(grant.clientId)) : unserved('webDevices.status')
    },
    'webDevices.revoke': ({ commandId, id }, asking) =>
      command('webDevices.revoke', commandId, asking, (domain) => ({ revoked: domain.revoke(id) })),
    'webDevices.approve': ({ commandId, requestId, code }, asking) =>
      command('webDevices.approve', commandId, asking, (domain) => domain.approve(requestId, code)),
    'webDevices.decline': ({ commandId, requestId }, asking) =>
      command('webDevices.decline', commandId, asking, (domain) => ({ declined: domain.decline(requestId) })),
  }
}
