import {
  studioNoParams,
  studioParams,
  studioParamsRefused as refuse,
  type StudioMethodTable,
  type StudioParsed,
  type StudioTopicTable,
} from './contract.js'
import { STUDIO_TAILNET_CAPABILITY } from './handshake.js'
import {
  TAILNET_SCOPES,
  type MeshConnection,
  type MeshEvent,
  type MeshLiveState,
  type MeshPairResult,
  type MeshRequestPairingResult,
  type TailnetApprovePairRequestView,
  type TailnetForgetMachineResult,
  type TailnetLiveState,
  type TailnetPairingOfferView,
  type TailnetPeerScan,
  type TailnetPushPayload,
  type TailnetRemoteStatus,
  type TailnetScope,
  type TailnetShareResult,
  type TailnetShareStatus,
} from './tailnet-types.js'

// Who reaches this machine over the tailnet, and the machines it reaches:
// this Studio's listener (`tailnet.*`: turned on, offered, asked, approved,
// revoked; its dev servers shared), and pairing with another machine
// (`mesh.*`). Offered as `tailnet`. The shapes are `tailnet-types.ts`.
//
// Grants. Every method and both streams are an owner's, and no device reaches
// any of them (tailnet-device-reach.test.ts says so for each): a device that
// could pair, approve or widen could manufacture the next grant, and revoking
// the device it came in on would not take those away. Beyond that:
// - What answers a credential or lets someone in from elsewhere is served to
//   Studio's own desktop windows only (`window`): turning the listener or its
//   HTTPS on, a pairing offer (its code), approving a request, widening a
//   device's scopes, sharing a dev server, the sweep that finds machines to
//   pair with, and every step of pairing with another machine (its answer
//   and its stream carry the code read out to that machine's person). An
//   owner's web tab is refused them, so a stolen browser session cannot mint
//   a way in that outlives it; so is a script or app holding the owner's
//   credential, so a paired app or an agent cannot pair the next one.
// - What only reads, or narrows reach, is an owner's, a web tab included:
//   the listener's status and live connections and its stream, withdrawing an
//   offer, declining a request, revoking a device or a machine, forgetting
//   MCP client registrations, the dev servers shared and taking one down, the
//   machines this one drives and forgetting one. None carries a credential:
//   a status names devices and requests, never a token or a request's code.
// The agents' own way to part of this, the gateway's local-socket
// `tailnet.*` tools, is the same service, unchanged.

/** Why the listener's state is an owner's. */
export const STUDIO_TAILNET_OWNER =
  'It lists and narrows who reaches this machine over the tailnet: its paired devices, the requests waiting, its live connections and the dev servers it publishes.'

/** Why letting someone in over the tailnet is Studio's own windows'. */
export const STUDIO_TAILNET_WINDOW =
  'It lets someone reach this machine over the tailnet, or answers a pairing code: turning the listener or HTTPS on, offering or approving a pairing, widening a device, sharing a dev server or finding a machine to pair with, so it is decided at Studio’s own desktop window; a browser session or a paired app cannot make the next way in.'

/** Why the machines this one drives are an owner's. */
export const STUDIO_MESH_OWNER = 'It lists and forgets the machines this one is paired to drive.'

/** Why pairing with another machine is Studio's own windows'. */
export const STUDIO_MESH_WINDOW =
  'It pairs this machine with another, and shows the code read out to the person there while it waits, so it is decided at Studio’s own desktop window.'

type Commanded<P> = P & { commandId: string }

export type StudioTailnetMethodMap = {
  /** The listener: on or off, its address, paired devices, the offer (never its code) and the requests waiting. */
  'tailnet.status': { params: Record<string, never>; result: TailnetRemoteStatus }
  /** Each paired device's live connections. */
  'tailnet.liveState': { params: Record<string, never>; result: TailnetLiveState }
  /** Turn the listener on or off. */
  'tailnet.setEnabled': { params: Commanded<{ enabled: boolean }>; result: TailnetRemoteStatus }
  /** Publish the listener over HTTPS through Tailscale Serve, or stop. */
  'tailnet.setHttps': { params: Commanded<{ enabled: boolean }>; result: TailnetRemoteStatus }
  /** Mint a one-time pairing code with these scopes (absent: the default set): answered this once. */
  'tailnet.offerPairing': { params: Commanded<{ scopes?: TailnetScope[] }>; result: TailnetPairingOfferView }
  /** Withdraw the offer. */
  'tailnet.cancelPairing': { params: Commanded<Record<never, never>>; result: TailnetRemoteStatus }
  /** Allow a request from another machine with the scopes chosen here and the code read off its screen. */
  'tailnet.approvePairRequest': {
    params: Commanded<{ id: string; scopes: TailnetScope[]; code: string }>
    result: TailnetApprovePairRequestView
  }
  /** Decline a request. */
  'tailnet.denyPairRequest': { params: Commanded<{ id: string }>; result: TailnetRemoteStatus }
  /** Revoke a paired device. */
  'tailnet.revokeDevice': { params: Commanded<{ id: string }>; result: TailnetRemoteStatus }
  /** Replace a paired device's scopes. */
  'tailnet.updateDeviceScopes': {
    params: Commanded<{ id: string; scopes: TailnetScope[] }>
    result: TailnetRemoteStatus
  }
  /** End a pairing both ways: the device that machine holds here, and this machine's connection there. */
  'tailnet.forgetMachine': {
    params: Commanded<{ deviceId?: string; connectionId?: string }>
    result: TailnetForgetMachineResult
  }
  /** Forget every MCP client registration; signed-in clients stay until revoked. */
  'tailnet.resetMcpRegistrations': { params: Commanded<Record<never, never>>; result: TailnetRemoteStatus }
  /** The machines on this tailnet, and which of them answer as a Studio. */
  'tailnet.peers': { params: Record<string, never>; result: TailnetPeerScan }
  /** The dev servers this machine publishes on the tailnet. */
  'tailnet.shares': { params: Record<string, never>; result: TailnetShareStatus }
  /** Publish a loopback dev server on the tailnet. */
  'tailnet.share': { params: Commanded<{ localPort: number }>; result: TailnetShareResult }
  /** Take one down. */
  'tailnet.unshare': { params: Commanded<{ servePort: number }>; result: TailnetShareResult }
  /** The machines this one is paired to drive. */
  'mesh.connections': { params: Record<string, never>; result: MeshConnection[] }
  /** The requests this machine made that wait, with their codes, and each machine's last reachability. */
  'mesh.liveState': { params: Record<string, never>; result: MeshLiveState }
  /** Pair with a machine by the link it showed. */
  'mesh.pair': { params: Commanded<{ pairingUrl: string }>; result: MeshPairResult }
  /** Ask a machine to pair; `reverseScopes` offers it a device here too. */
  'mesh.requestPairing': {
    params: Commanded<{ endpoint: string; scopes?: TailnetScope[]; reverseScopes?: TailnetScope[] }>
    result: MeshRequestPairingResult
  }
  /** Forget a request this machine made. */
  'mesh.cancelPairing': { params: Commanded<{ requestId: string }>; result: Record<string, never> }
  /** Forget this machine's connection to another. */
  'mesh.forget': { params: Commanded<{ connectionId: string }>; result: MeshConnection[] }
}

export type StudioTailnetTopicMap = {
  /** The listener, whole, at following (`current`) and on every change to it, a request or a live connection. */
  'tailnet.changed': { params: Record<string, never>; payload: TailnetPushPayload; stream: 'push' }
  /** The mesh's whole-app facts: at following (`current`), then a machine paired, forgotten, answering, or asked. */
  'mesh.changed': { params: Record<string, never>; payload: MeshEvent; stream: 'push' }
}

// ── Validation ──────────────────────────────────────────────────────────────

const COMMAND_ID = '"commandId" names this command: a string of 1 to 200 characters.'

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0')
}
function id(value: unknown): value is string {
  return text(value, 200) && value.length > 0
}
function scopes(value: unknown): value is TailnetScope[] {
  return (
    Array.isArray(value) &&
    value.length <= TAILNET_SCOPES.length * 2 &&
    value.every((scope) => typeof scope === 'string' && (TAILNET_SCOPES as readonly string[]).includes(scope))
  )
}
function port(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536
}

function commanded<P>(
  read: (value: Record<string, unknown>) => StudioParsed<P>,
): (value: Record<string, unknown>) => StudioParsed<Commanded<P>> {
  return (value) => {
    if (!id(value.commandId)) return refuse(COMMAND_ID)
    const parsed = read(value)
    return parsed.ok ? studioParams({ ...parsed.params, commandId: value.commandId }) : parsed
  }
}

const SCOPES = `"scopes" lists what to grant, each one of ${TAILNET_SCOPES.join(', ')}.`

const nothing = commanded(() => studioParams({}))
const switched = commanded((value) =>
  typeof value.enabled === 'boolean' ? studioParams({ enabled: value.enabled }) : refuse('"enabled" is true or false.'),
)
const named = commanded((value) =>
  id(value.id) ? studioParams({ id: value.id }) : refuse('"id" names the one to change.'),
)
const offer = commanded((value): StudioParsed<{ scopes?: TailnetScope[] }> => {
  if (value.scopes === undefined) return studioParams({})
  return scopes(value.scopes) ? studioParams({ scopes: value.scopes }) : refuse(SCOPES)
})
const approve = commanded((value): StudioParsed<{ id: string; scopes: TailnetScope[]; code: string }> => {
  if (!id(value.id)) return refuse('"id" names the request.')
  if (!scopes(value.scopes)) return refuse(SCOPES)
  if (!text(value.code, 32)) return refuse('"code" is the six digits on the asking machine’s screen.')
  return studioParams({ id: value.id, scopes: value.scopes, code: value.code })
})
const widened = commanded((value): StudioParsed<{ id: string; scopes: TailnetScope[] }> => {
  if (!id(value.id)) return refuse('"id" names the device.')
  return scopes(value.scopes) ? studioParams({ id: value.id, scopes: value.scopes }) : refuse(SCOPES)
})
const forgotten = commanded((value): StudioParsed<{ deviceId?: string; connectionId?: string }> => {
  if (value.deviceId !== undefined && !id(value.deviceId)) return refuse('"deviceId" names that machine’s device here.')
  if (value.connectionId !== undefined && !id(value.connectionId))
    return refuse('"connectionId" names this machine’s connection there.')
  if (value.deviceId === undefined && value.connectionId === undefined)
    return refuse('Name the machine’s "deviceId" here, its "connectionId" there, or both.')
  return studioParams({
    ...(value.deviceId !== undefined ? { deviceId: value.deviceId as string } : {}),
    ...(value.connectionId !== undefined ? { connectionId: value.connectionId as string } : {}),
  })
})
const shared = commanded((value) =>
  port(value.localPort)
    ? studioParams({ localPort: value.localPort })
    : refuse('"localPort" is the dev server’s port.'),
)
const unshared = commanded((value) =>
  port(value.servePort)
    ? studioParams({ servePort: value.servePort })
    : refuse('"servePort" is the port it is published at.'),
)
const pairing = commanded((value) =>
  text(value.pairingUrl, 4096) && value.pairingUrl.length > 0
    ? studioParams({ pairingUrl: value.pairingUrl })
    : refuse('"pairingUrl" is the link the other machine showed.'),
)
const asking = commanded(
  (value): StudioParsed<{ endpoint: string; scopes?: TailnetScope[]; reverseScopes?: TailnetScope[] }> => {
    if (!text(value.endpoint, 512) || value.endpoint.length === 0)
      return refuse('"endpoint" is the machine’s address and port.')
    if (value.scopes !== undefined && !scopes(value.scopes)) return refuse(SCOPES)
    if (value.reverseScopes !== undefined && !scopes(value.reverseScopes))
      return refuse(`"reverseScopes" lists what that machine may do here, each one of ${TAILNET_SCOPES.join(', ')}.`)
    return studioParams({
      endpoint: value.endpoint,
      ...(value.scopes !== undefined ? { scopes: value.scopes as TailnetScope[] } : {}),
      ...(value.reverseScopes !== undefined ? { reverseScopes: value.reverseScopes as TailnetScope[] } : {}),
    })
  },
)
const request = commanded((value) =>
  id(value.requestId) ? studioParams({ requestId: value.requestId }) : refuse('"requestId" names the request.'),
)
const connection = commanded((value) =>
  id(value.connectionId) ? studioParams({ connectionId: value.connectionId }) : refuse('"connectionId" names it.'),
)

// ── The table ───────────────────────────────────────────────────────────────

const owner = (reason: string, mutation: boolean) =>
  ({ scope: 'settings:write', mutation, capability: STUDIO_TAILNET_CAPABILITY, owner: reason }) as const
const ownWindow = (reason: string, mutation: boolean) => ({ ...owner(reason, mutation), window: reason }) as const

export const STUDIO_TAILNET_METHODS: StudioMethodTable<StudioTailnetMethodMap> = {
  'tailnet.status': { ...owner(STUDIO_TAILNET_OWNER, false), params: studioNoParams },
  'tailnet.liveState': { ...owner(STUDIO_TAILNET_OWNER, false), params: studioNoParams },
  'tailnet.setEnabled': { ...ownWindow(STUDIO_TAILNET_WINDOW, true), params: switched },
  'tailnet.setHttps': { ...ownWindow(STUDIO_TAILNET_WINDOW, true), params: switched },
  'tailnet.offerPairing': { ...ownWindow(STUDIO_TAILNET_WINDOW, true), params: offer },
  'tailnet.cancelPairing': { ...owner(STUDIO_TAILNET_OWNER, true), params: nothing },
  'tailnet.approvePairRequest': { ...ownWindow(STUDIO_TAILNET_WINDOW, true), params: approve },
  'tailnet.denyPairRequest': { ...owner(STUDIO_TAILNET_OWNER, true), params: named },
  'tailnet.revokeDevice': { ...owner(STUDIO_TAILNET_OWNER, true), params: named },
  'tailnet.updateDeviceScopes': { ...ownWindow(STUDIO_TAILNET_WINDOW, true), params: widened },
  'tailnet.forgetMachine': { ...owner(STUDIO_TAILNET_OWNER, true), params: forgotten },
  'tailnet.resetMcpRegistrations': { ...owner(STUDIO_TAILNET_OWNER, true), params: nothing },
  'tailnet.peers': { ...ownWindow(STUDIO_TAILNET_WINDOW, false), params: studioNoParams },
  'tailnet.shares': { ...owner(STUDIO_TAILNET_OWNER, false), params: studioNoParams },
  'tailnet.share': { ...ownWindow(STUDIO_TAILNET_WINDOW, true), params: shared },
  'tailnet.unshare': { ...owner(STUDIO_TAILNET_OWNER, true), params: unshared },
  'mesh.connections': { ...owner(STUDIO_MESH_OWNER, false), params: studioNoParams },
  'mesh.liveState': { ...ownWindow(STUDIO_MESH_WINDOW, false), params: studioNoParams },
  'mesh.pair': { ...ownWindow(STUDIO_MESH_WINDOW, true), params: pairing },
  'mesh.requestPairing': { ...ownWindow(STUDIO_MESH_WINDOW, true), params: asking },
  'mesh.cancelPairing': { ...owner(STUDIO_MESH_OWNER, true), params: request },
  'mesh.forget': { ...owner(STUDIO_MESH_OWNER, true), params: connection },
}

export const STUDIO_TAILNET_TOPICS: StudioTopicTable<StudioTailnetTopicMap> = {
  'tailnet.changed': {
    scope: 'settings:write',
    capability: STUDIO_TAILNET_CAPABILITY,
    push: true,
    owner: STUDIO_TAILNET_OWNER,
    params: studioNoParams,
  },
  'mesh.changed': {
    scope: 'settings:write',
    capability: STUDIO_TAILNET_CAPABILITY,
    push: true,
    owner: STUDIO_MESH_WINDOW,
    window: STUDIO_MESH_WINDOW,
    params: studioNoParams,
  },
}
