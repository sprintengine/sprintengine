import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { StudioWebSocketConstructor } from '../packages/client-runtime/src/public'
import { parseEnvironmentRoute } from '../packages/studio-protocol/src/environment'
import { createTailnetMeshService, type TailnetMeshService } from '../src/main/automation/tailnet/tailnet-mesh-service'
import { peerStudioTicket } from '../src/main/automation/tailnet/tailnet-peer-studio'
import { pairingUrl } from '../src/main/automation/tailnet/tailnet-service'
import { closePairedStudio, configurePairedStudio } from '../src/renderer/src/studio/pairedStudio'
import type { EnvironmentEntry, EnvironmentTicketResult } from '../src/shared/environments'
import type { TailnetScope } from '../src/shared/tailnet'

// A desktop window paired with another machine, for tests and the
// cross-client gate (design-lane-on-protocol D1): this desktop's mesh pairs as
// a person does and keeps the device token; the window's own client of that
// machine's Studio (`src/renderer/src/studio/pairedStudio.ts`) is given each
// connection's ticket by the mesh, for a window loaded from the app's files,
// and opens its socket saying that origin, as Chromium does for a real window.

/** A machine to pair with: where its tailnet listener is, and how it offers a pairing. */
export type PairableMachine = {
  port(): number
  devices: { offerPairing(input: { scopes: TailnetScope[] }): { token: string } }
}

/** Node's WebSocket, saying a desktop window's origin, as a window's own socket does. */
function windowSocket(origin: string): StudioWebSocketConstructor {
  const NodeWebSocket = (globalThis as unknown as { WebSocket: new (url: string, init?: unknown) => unknown }).WebSocket
  return class {
    constructor(url: string) {
      return new NodeWebSocket(url, { headers: { origin } }) as never
    }
  } as unknown as StudioWebSocketConstructor
}

export type PairedWindow = {
  /** This desktop's mesh, paired with the rig's machine: it keeps the device token and buys tickets. */
  mesh: TailnetMeshService
  /** The paired machine as the window knows it. */
  machine: { id: string; machineName: string; scopes: TailnetScope[] }
  /** The window's bridge: tickets from the mesh, for a `file://` window. */
  api: {
    environmentsTicket: (route: string) => Promise<EnvironmentTicketResult>
    environmentsList: () => Promise<EnvironmentEntry[]>
    onEnvironmentsChanged: (listener: () => void) => () => void
  }
  /** Say the machine list changed (a pairing forgotten here). */
  environmentsChanged(): void
  /** How many tickets the window was given. */
  tickets(): number
  close(): Promise<void>
}

/** The meshes of the windows open now, by the pairing each holds: one window's bridge serves them all. */
const openWindows = new Map<string, TailnetMeshService>()
const changeListeners = new Set<() => void>()
let ticketsGiven = 0
const windowApi: PairedWindow['api'] = {
  async environmentsTicket(route) {
    const parsed = parseEnvironmentRoute(route)
    const mesh = parsed?.kind === 'tailnet' ? openWindows.get(parsed.connection) : undefined
    if (parsed?.kind !== 'tailnet' || !mesh)
      return { ok: false, code: 'unknown_route', message: 'Not a paired machine.' }
    ticketsGiven += 1
    return mesh.windowTicket(parsed.connection, 'file://')
  },
  environmentsList: async () =>
    [...openWindows.values()].flatMap((mesh) =>
      mesh.listConnections().map((connection) => ({
        environmentId: null,
        displayName: connection.machineName,
        routes: [{ kind: 'tailnet' as const, connection: connection.id }],
        machine: { kind: 'tailnet', name: connection.machineName } as unknown as EnvironmentEntry['machine'],
        descriptor: null,
        connection: { state: 'up' as const, detail: null, lastReachedAt: null },
        compatibility: 'unknown' as const,
      })),
    ),
  onEnvironmentsChanged: (listener) => {
    changeListeners.add(listener)
    return () => changeListeners.delete(listener)
  },
}
configurePairedStudio(windowApi, { WebSocket: windowSocket('file://') })
let windowBefore: unknown

/**
 * A desktop window paired with the rig's machine (design-lane-on-protocol D1):
 * this desktop's mesh pairs as a person does, and the window's own client of
 * that machine's Studio (`src/renderer/src/studio/pairedStudio.ts`) is given
 * its tickets by the mesh, for a window loaded from the app's files, and opens
 * its socket saying that origin. Installed as `window.api` while any lasts.
 */
export async function pairedWindow(peer: PairableMachine, scopes: TailnetScope[]): Promise<PairedWindow> {
  const offer = peer.devices.offerPairing({ scopes })
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-paired-window-'))
  const mesh = createTailnetMeshService({
    resolveUserDataDir: () => dir,
    resolveDeviceName: () => 'dev-macbook-air',
    resolvePeerName: async () => null,
  })
  const paired = await mesh.pair({ pairingUrl: pairingUrl('127.0.0.1', peer.port(), offer.token) })
  if (!paired.ok) throw new Error(`pairing was refused: ${paired.message}`)
  const id = paired.connection.id
  const closeWindow = openPairedWindow(mesh, id)
  const ticketsBefore = ticketsGiven
  return {
    mesh,
    machine: { id, machineName: paired.connection.machineName, scopes },
    api: windowApi,
    environmentsChanged: () => {
      for (const listener of changeListeners) listener()
    },
    tickets: () => ticketsGiven - ticketsBefore,
    async close() {
      closeWindow()
      mesh.shutdown()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * A window on a pairing an existing mesh holds: its tickets come from that
 * mesh. Installed as `window.api` while any window lasts. Returns the close,
 * which closes the window's client of that machine.
 */
export function openPairedWindow(mesh: TailnetMeshService, connectionId: string): () => void {
  const global = globalThis as unknown as { window?: unknown }
  if (openWindows.size === 0) {
    windowBefore = global.window
    global.window = { api: windowApi }
  }
  openWindows.set(connectionId, mesh)
  return () => {
    closePairedStudio(connectionId, windowApi)
    if (!openWindows.delete(connectionId)) return
    if (openWindows.size === 0) global.window = windowBefore
  }
}

/**
 * A window's bridge to one machine by a device token held here, with no mesh:
 * each connection's ticket bought with that token for a `file://` window, as
 * main buys it. For a coordinator's own tests (`pairedStudios(api)`); the
 * caller closes its clients with `closePairedStudios(api)`.
 */
export function deviceWindowApi(target: {
  endpoint: { host: string; port: number }
  deviceToken: string
  machineName: string
}): { environmentsTicket: (route: string) => Promise<EnvironmentTicketResult> } {
  const api = {
    environmentsTicket: async (): Promise<EnvironmentTicketResult> => {
      try {
        return { ok: true, ...(await peerStudioTicket(target, 'file://')) }
      } catch (error) {
        const code = (error as { code?: unknown }).code
        return { ok: false, code: typeof code === 'string' ? code : 'unavailable', message: String(error) }
      }
    },
  }
  configurePairedStudio(api, { WebSocket: windowSocket('file://') })
  return api
}
