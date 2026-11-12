import { timingSafeEqual } from 'node:crypto'
import type { Duplex } from 'node:stream'

import type { StudioGrant } from '../../../../packages/studio-protocol/src/public'
import type { StudioAuthenticator } from '../../../server/rpc/studio-rpc-types'
import { tailnetDeviceStudioScopes, type TailnetDevice } from '../../../shared/tailnet'
import type { TailnetDeviceStore } from './tailnet-devices'

// A paired device on the Studio protocol (`/tailnet/v1/studio`): the phone and
// another desktop's window speak the one contract every client speaks, to the
// same Studio server this machine's own windows use.
//
// - The socket is opened with a ticket from `ws-ticket`, minted behind the
//   device token and the peer's tailnet node, good once for thirty seconds.
//   Its hello presents the same ticket, so the connection is the device's and
//   no other's.
// - The grant is the device's as it stands now: read from the device store at
//   every request the connection makes (the router asks `grantFor` each time),
//   so a narrowed pairing applies to the next frame and a removed one closes
//   the connection. It is never an owner's.
// - What its scopes carry is `tailnetDeviceStudioScopes` (src/shared/tailnet.ts),
//   and nothing else: no terminal, no filesystem, no settings.

/** The Studio server the endpoint hands an admitted socket to. */
export type TailnetStudioHost = {
  /** Serve one device's socket under the authenticator given; it ends when the stream does. */
  attach(stream: Duplex, authenticator: StudioAuthenticator): void
}

/** A device's client id on the Studio protocol: its own, kept apart from apps and browsers. */
function tailnetStudioClientId(deviceId: string): string {
  return `tailnet:${deviceId}`
}

/** The grant a paired device holds on the Studio protocol, from the device as it stands. */
export function tailnetDeviceGrant(device: TailnetDevice): StudioGrant {
  return {
    clientId: tailnetStudioClientId(device.id),
    name: device.name,
    owner: false,
    scopes: tailnetDeviceStudioScopes(device.scopes),
    // A device has always chosen any preset for a chat it drives or starts
    // (the lane and the gateway's tools put no ceiling on one): the person who
    // paired it chose to let it drive this machine's chats.
    ceiling: 'bypass',
  }
}

/**
 * The origin a desktop window's socket may say, when the ticket it asked for
 * named it: a window loaded from the app's files (`file://`), or from the
 * development server on the machine it runs on. A page served on loopback
 * could say the latter too, so the origin is never the credential: the
 * single-use ticket, minted behind the device token that only the desktop's
 * main process holds, is.
 */
export function isDesktopWindowOrigin(origin: string): boolean {
  if (origin === 'file://') return true
  try {
    const url = new URL(origin)
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
      url.port !== '' &&
      url.origin === origin
    )
  } catch {
    return false
  }
}

function sameSecret(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Who may say hello on one admitted socket: the device the ticket was minted
 * for, presenting that same ticket, once.
 */
export function createTailnetDeviceAuthenticator(input: {
  devices: Pick<TailnetDeviceStore, 'listDevices' | 'onDeviceRevoked' | 'onDeviceScopesChanged' | 'recordSeen'>
  deviceId: string
  ticket: string
  /** The node the socket came from, recorded as the device's last sighting. */
  peerNode?: string | null
}): StudioAuthenticator {
  const clientId = tailnetStudioClientId(input.deviceId)
  const current = (): TailnetDevice | null =>
    input.devices.listDevices().find((device) => device.id === input.deviceId) ?? null
  let spent = false
  return {
    authenticate(auth) {
      if (spent || !('token' in auth) || !sameSecret(auth.token, input.ticket))
        return { ok: false, message: 'This connection’s ticket is spent or wrong. Reconnect.' }
      const device = current()
      if (!device) return { ok: false, message: 'This device is no longer paired with this machine. Pair it again.' }
      spent = true
      return { ok: true, grant: tailnetDeviceGrant(device) }
    },
    grantFor(id) {
      if (!spent || id !== clientId) return null
      const device = current()
      return device ? tailnetDeviceGrant(device) : null
    },
    onRevoked: (listener) =>
      input.devices.onDeviceRevoked((revoked) => {
        if (revoked === input.deviceId) listener(clientId)
      }),
    onGrantChanged: (listener) =>
      input.devices.onDeviceScopesChanged((device) => {
        if (device.id === input.deviceId) listener(clientId)
      }),
    recordSeen: () => input.devices.recordSeen(input.deviceId, input.peerNode ?? null),
  }
}
