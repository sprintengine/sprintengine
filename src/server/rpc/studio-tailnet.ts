import type {
  MeshConnection,
  MeshEvent,
  MeshLiveState,
  MeshPairResult,
  MeshRequestPairingResult,
  StudioErrorBody,
  StudioGrant,
  StudioHandlerOf,
  StudioTailnetMethodMap,
  TailnetApprovePairRequestView,
  TailnetForgetMachineResult,
  TailnetLiveState,
  TailnetPairingOfferView,
  TailnetPeerScan,
  TailnetPushPayload,
  TailnetRemoteStatus,
  TailnetScope,
  TailnetShareResult,
  TailnetShareStatus,
} from '../../../packages/studio-protocol/src/public'

// The router's answers to the tailnet family (`tailnet.*`, `mesh.*`): each
// method's domain call, once the router has held the grant to an owner's
// connection, and the window-only ones to Studio's own desktop windows (the
// method table says which, and why). What is left here is the family's own
// rules:
// - a command is carried out once per command id, a retry answered with the
//   first answer, so a retried offer is not a second code;
// - an answer to a pairing request says which door it came through
//   (`via`): a window's, which alone may approve an MCP client's sign-in and
//   which the service audits itself, or one the router already audits.

/** Which door an answer to a pairing request came through; `tool` is one audited before the service sees it. */
export type TailnetAnswerVia = 'window' | 'tool'

/** This machine's tailnet listener and the machines it drives, as the gateway holds them. */
export type StudioTailnetDomain = {
  status(): TailnetRemoteStatus
  liveState(): TailnetLiveState
  setEnabled(enabled: boolean): Promise<TailnetRemoteStatus>
  setHttps(enabled: boolean): Promise<TailnetRemoteStatus>
  offerPairing(scopes: TailnetScope[] | undefined): TailnetPairingOfferView
  cancelPairing(): TailnetRemoteStatus
  approvePairRequest(input: { id: string; scopes: TailnetScope[]; code: string }): TailnetApprovePairRequestView
  denyPairRequest(id: string, via: TailnetAnswerVia): TailnetRemoteStatus
  revokeDevice(id: string): TailnetRemoteStatus
  updateDeviceScopes(id: string, scopes: TailnetScope[]): TailnetRemoteStatus
  forgetMachine(input: { deviceId?: string; connectionId?: string }): TailnetForgetMachineResult
  resetMcpRegistrations(): TailnetRemoteStatus
  peers(): Promise<TailnetPeerScan>
  shares(): Promise<TailnetShareStatus>
  share(localPort: number): Promise<TailnetShareResult>
  unshare(servePort: number): Promise<TailnetShareResult>
  /** Every change to the listener, its requests and its live connections. */
  onChanged(listener: (payload: TailnetPushPayload) => void): () => void
  mesh: {
    connections(): MeshConnection[]
    liveState(): MeshLiveState
    pair(pairingUrl: string): Promise<MeshPairResult>
    requestPairing(input: {
      endpoint: string
      scopes?: TailnetScope[]
      reverseScopes?: TailnetScope[]
    }): Promise<MeshRequestPairingResult>
    cancelPairing(requestId: string): void
    forget(connectionId: string): MeshConnection[]
    /** Every whole-app fact of the mesh: a machine paired, forgotten, identified, answering, asked. */
    onChanged(listener: (event: MeshEvent) => void): () => void
  }
}

/** What the listener says when a client starts following it: nothing happened, here it is. */
export function currentTailnet(tailnet: StudioTailnetDomain): TailnetPushPayload {
  const live = tailnet.liveState()
  return { revision: live.revision, event: { kind: 'current' }, status: tailnet.status(), live }
}

/** The same for the mesh: the requests waiting and each machine's last reachability. */
export function currentMesh(tailnet: StudioTailnetDomain): MeshEvent {
  return { kind: 'current', ...tailnet.mesh.liveState() }
}

export type StudioTailnetAsking = {
  grant: StudioGrant
  /** Whether the router audits this connection's mutations (`audited`), unset for a window's. */
  context: { ownWindow?: boolean; audited?: boolean }
  voice: { failed(code: 'unavailable', detail: string | undefined, context: string): unknown }
}

type Method = keyof StudioTailnetMethodMap
export type StudioTailnetHandlers = {
  readonly [M in Method]: StudioHandlerOf<StudioTailnetMethodMap[M], StudioTailnetAsking>
}

type Refused = { ok: false; error: StudioErrorBody & { code: 'unavailable' } }

export type StudioTailnetHandlerOptions = {
  /** The domain; without it, every method is answered `unavailable`. */
  tailnet?: StudioTailnetDomain
  /** The first answer to a command id is every retry's. */
  once: <A extends { ok: boolean; error?: StudioErrorBody }>(
    id: string,
    work: () => Promise<A>,
    voice: StudioTailnetAsking['voice'],
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

/** The router audits every mutation but a window's, as its rule says. */
function auditedByRouter(context: StudioTailnetAsking['context']): boolean {
  return context.audited ?? context.ownWindow !== true
}

export function createStudioTailnetHandlers(options: StudioTailnetHandlerOptions): StudioTailnetHandlers {
  const { tailnet } = options

  function command<R>(
    method: Method,
    commandId: string,
    asking: StudioTailnetAsking,
    work: (tailnet: StudioTailnetDomain) => R | Promise<R>,
  ): Promise<{ ok: true; result: R } | Refused> | Refused {
    if (!tailnet) return unserved(method)
    return options.once(
      `${method}:${options.runtimeId(asking.grant, commandId)}`,
      async () => ok(await work(tailnet)),
      asking.voice,
      method,
    )
  }
  const read = async <R>(method: Method, work: (tailnet: StudioTailnetDomain) => R | Promise<R>) =>
    tailnet ? ok(await work(tailnet)) : unserved(method)

  return {
    'tailnet.status': () => read('tailnet.status', (domain) => domain.status()),
    'tailnet.liveState': () => read('tailnet.liveState', (domain) => domain.liveState()),
    'tailnet.setEnabled': ({ commandId, enabled }, asking) =>
      command('tailnet.setEnabled', commandId, asking, (domain) => domain.setEnabled(enabled)),
    'tailnet.setHttps': ({ commandId, enabled }, asking) =>
      command('tailnet.setHttps', commandId, asking, (domain) => domain.setHttps(enabled)),
    'tailnet.offerPairing': ({ commandId, scopes }, asking) =>
      command('tailnet.offerPairing', commandId, asking, (domain) => domain.offerPairing(scopes)),
    'tailnet.cancelPairing': ({ commandId }, asking) =>
      command('tailnet.cancelPairing', commandId, asking, (domain) => domain.cancelPairing()),
    // Served to a window only (the table's `window`), which is the door that
    // may approve an MCP client's sign-in.
    'tailnet.approvePairRequest': ({ commandId, id, scopes, code }, asking) =>
      command('tailnet.approvePairRequest', commandId, asking, (domain) =>
        domain.approvePairRequest({ id, scopes, code }),
      ),
    'tailnet.denyPairRequest': ({ commandId, id }, asking) =>
      command('tailnet.denyPairRequest', commandId, asking, (domain) =>
        domain.denyPairRequest(id, auditedByRouter(asking.context) ? 'tool' : 'window'),
      ),
    'tailnet.revokeDevice': ({ commandId, id }, asking) =>
      command('tailnet.revokeDevice', commandId, asking, (domain) => domain.revokeDevice(id)),
    'tailnet.updateDeviceScopes': ({ commandId, id, scopes }, asking) =>
      command('tailnet.updateDeviceScopes', commandId, asking, (domain) => domain.updateDeviceScopes(id, scopes)),
    'tailnet.forgetMachine': ({ commandId, deviceId, connectionId }, asking) =>
      command('tailnet.forgetMachine', commandId, asking, (domain) =>
        domain.forgetMachine({
          ...(deviceId !== undefined ? { deviceId } : {}),
          ...(connectionId !== undefined ? { connectionId } : {}),
        }),
      ),
    'tailnet.resetMcpRegistrations': ({ commandId }, asking) =>
      command('tailnet.resetMcpRegistrations', commandId, asking, (domain) => domain.resetMcpRegistrations()),
    'tailnet.peers': () => read('tailnet.peers', (domain) => domain.peers()),
    'tailnet.shares': () => read('tailnet.shares', (domain) => domain.shares()),
    'tailnet.share': ({ commandId, localPort }, asking) =>
      command('tailnet.share', commandId, asking, (domain) => domain.share(localPort)),
    'tailnet.unshare': ({ commandId, servePort }, asking) =>
      command('tailnet.unshare', commandId, asking, (domain) => domain.unshare(servePort)),
    'mesh.connections': () => read('mesh.connections', (domain) => domain.mesh.connections()),
    'mesh.liveState': () => read('mesh.liveState', (domain) => domain.mesh.liveState()),
    'mesh.pair': ({ commandId, pairingUrl }, asking) =>
      command('mesh.pair', commandId, asking, (domain) => domain.mesh.pair(pairingUrl)),
    'mesh.requestPairing': ({ commandId, endpoint, scopes, reverseScopes }, asking) =>
      command('mesh.requestPairing', commandId, asking, (domain) =>
        domain.mesh.requestPairing({
          endpoint,
          ...(scopes ? { scopes } : {}),
          ...(reverseScopes ? { reverseScopes } : {}),
        }),
      ),
    'mesh.cancelPairing': ({ commandId, requestId }, asking) =>
      command('mesh.cancelPairing', commandId, asking, (domain) => {
        domain.mesh.cancelPairing(requestId)
        return {}
      }),
    'mesh.forget': ({ commandId, connectionId }, asking) =>
      command('mesh.forget', commandId, asking, (domain) => domain.mesh.forget(connectionId)),
  }
}
