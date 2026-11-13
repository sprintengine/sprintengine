import {
  studioNoParams,
  studioParams,
  studioParamsRefused as refuse,
  type StudioMethodTable,
  type StudioParsed,
  type StudioTopicTable,
} from './contract.js'
import { STUDIO_WEB_DEVICES_CAPABILITY } from './handshake.js'

// The browsers paired with a Studio's web listener, and the ones asking to be
// (Settings ▸ Browsers in a web tab): the list (`webDevices.status`, and the
// `webDevices.changed` stream), removing one (`webDevices.revoke`), and
// answering a browser that asks by approval (`webDevices.approve`, with the
// six digits it shows; `webDevices.decline`). Offered as `web-devices` by a
// Studio that runs the web listener (a standalone server started with it); a
// desktop's runs none.
//
// Grants. Every one is an owner's (`STUDIO_WEB_DEVICES_OWNER`), an owner's web
// tab included, since that tab is where this listener is administered; no
// paired device, app or embed reaches any of it. Nothing here answers a
// credential: a browser's session cookie is set on the browser that asked,
// never told to the one that approved, and there is no method for a pairing
// link (a one-time credential in the answer). A new browser is paired by
// approval from here, or by `studio-server pair` on the machine.
//
// Approving still grants: a stolen owner session could let in a second
// browser its thief holds. That browser is listed here with where it paired
// from, and removing it closes its connections at once.

export type WebDevice = {
  id: string
  name: string
  route: 'loopback' | 'tailnet'
  createdAt: string
  expiresAt: string
  lastSeenAt: string | null
  /** The browser asking: the one whose Settings this is. */
  current: boolean
}

export type WebPairRequest = {
  requestId: string
  name: string
  route: 'loopback' | 'tailnet'
  createdAt: string
  expiresAt: string
}

export type WebDevicesStatus = { devices: WebDevice[]; requests: WebPairRequest[]; origins: string[] }

/** Why the paired browsers are an owner's. */
export const STUDIO_WEB_DEVICES_OWNER =
  'It lists, lets in and removes the browsers that reach this Studio over its web listener.'

type Commanded<P> = P & { commandId: string }

export type StudioWebDevicesMethodMap = {
  /** The paired browsers, the asking ones, and the listener's origins. */
  'webDevices.status': { params: Record<string, never>; result: WebDevicesStatus }
  /** Remove a browser: its session ends and its connections close at once. */
  'webDevices.revoke': { params: Commanded<{ id: string }>; result: { revoked: boolean } }
  /** Let a browser that asked in, with the six digits it shows; a wrong code three times declines it. */
  'webDevices.approve': {
    params: Commanded<{ requestId: string; code: string }>
    result: { ok: true } | { ok: false; message: string }
  }
  /** Turn a browser that asked away. */
  'webDevices.decline': { params: Commanded<{ requestId: string }>; result: { declined: boolean } }
}

export type StudioWebDevicesTopicMap = {
  /** The status, whole, at subscribing and whenever a browser pairs, is removed or asks. */
  'webDevices.changed': { params: Record<string, never>; payload: WebDevicesStatus; stream: 'push' }
}

// ── Validation ──────────────────────────────────────────────────────────────

const COMMAND_ID = '"commandId" names this command: a string of 1 to 200 characters.'

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes('\0')
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

const request = (value: Record<string, unknown>): StudioParsed<{ requestId: string }> =>
  id(value.requestId) ? studioParams({ requestId: value.requestId }) : refuse('"requestId" names the request.')

// ── The table ───────────────────────────────────────────────────────────────

const owner = (mutation: boolean) =>
  ({
    scope: 'settings:write',
    mutation,
    capability: STUDIO_WEB_DEVICES_CAPABILITY,
    owner: STUDIO_WEB_DEVICES_OWNER,
  }) as const

export const STUDIO_WEB_DEVICES_METHODS: StudioMethodTable<StudioWebDevicesMethodMap> = {
  'webDevices.status': { ...owner(false), params: studioNoParams },
  'webDevices.revoke': {
    ...owner(true),
    params: commanded((value) => (id(value.id) ? studioParams({ id: value.id }) : refuse('"id" names the browser.'))),
  },
  'webDevices.approve': {
    ...owner(true),
    params: commanded((value) => {
      const asked = request(value)
      if (!asked.ok) return asked
      if (typeof value.code !== 'string' || value.code.length > 20) return refuse('"code" is the six digits it shows.')
      return studioParams({ requestId: asked.params.requestId, code: value.code })
    }),
  },
  'webDevices.decline': { ...owner(true), params: commanded(request) },
}

export const STUDIO_WEB_DEVICES_TOPICS: StudioTopicTable<StudioWebDevicesTopicMap> = {
  'webDevices.changed': {
    scope: 'settings:write',
    capability: STUDIO_WEB_DEVICES_CAPABILITY,
    push: true,
    owner: STUDIO_WEB_DEVICES_OWNER,
    params: studioNoParams,
  },
}
