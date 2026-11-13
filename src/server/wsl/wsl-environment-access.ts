import type { Duplex } from 'node:stream'

import type {
  StudioRelayedDeviceScope,
  StudioRelayedEnvironment,
} from '../../../packages/studio-protocol/src/environment-access'
import {
  STUDIO_DEVICE_TICKETS_CAPABILITY,
  STUDIO_WINDOW_TICKETS_CAPABILITY,
} from '../../../packages/studio-protocol/src/handshake'
import { createLoopbackRoute, type LoopbackRoute } from '../../main/environments/environment-route'
import type { WslEnvironmentManager, WslServerConnection } from './wsl-environment-manager'

// How this desktop's windows and paired devices reach a WSL distribution's
// own Studio (design-wsl-ssh-direct PR 3), the twin of what main does for an
// SSH machine (`SshEnvironments`): a ticket minted by the distribution's own
// window listener, asked for over the desktop's owner connection, and a
// 127.0.0.1 route on this PC whose every socket is spliced onto a fresh `ws`
// stream of the distribution's front door (loopback or the stdio bridge,
// whichever the server is reached by). The route's port is chosen once and
// kept for the run, so a server that restarts keeps the window's route.
//
// A window's ticket starts the server if it is not running: opening a chat
// there is using it. A device's does too, since the server lives under this
// desktop. A socket on the route never starts one: it carries bytes to the
// server up now, or is closed, and the window asks again.

export type EnvironmentTicketAnswer =
  { ok: true; url: string; token: string } | { ok: false; code: string; message: string }

export type DeviceTicketAnswer =
  { ok: true; token: string; path: string } | { ok: false; code: string; message: string }

export type WslEnvironmentAccess = {
  /** A ticket for one connection of a window to the distribution's Studio, with this PC's route to it. */
  windowTicket(distro: string, request: { windowKey: string; origin: string }): Promise<EnvironmentTicketAnswer>
  /** A window's document has gone: every distribution it was given a ticket for ends its connections. */
  revokeWindow(windowKey: string): void
  /** The distributions a paired device may be relayed to: each whose environment id this desktop has heard. */
  relayedEnvironments(): StudioRelayedEnvironment[]
  /** A ticket for one connection of a paired device this desktop relays, never an owner's. */
  deviceTicket(
    environmentId: string,
    device: { deviceId: string; name: string; scopes: StudioRelayedDeviceScope[] },
  ): Promise<DeviceTicketAnswer>
  /** A fresh stream to the window listener of the distribution whose environment this is (the front door's `ws`). */
  openEnvironment(environmentId: string): Promise<Duplex>
  /** Stop every route. */
  close(): Promise<void>
}

const label = (distro: string) => `WSL: ${distro}`

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createWslEnvironmentAccess(deps: {
  manager: Pick<WslEnvironmentManager, 'connect' | 'current'>
  /** Hear each new connection to a distribution's server, to learn its environment id. */
  onConnected(listener: (connection: WslServerConnection) => void): void
  log?: (message: string) => void
}): WslEnvironmentAccess {
  const log = deps.log ?? (() => undefined)
  const routes = new Map<string, LoopbackRoute>()
  // The distributions each window document was given a ticket for.
  const windowDistros = new Map<string, Set<string>>()
  // Each distribution's environment id, as its server last said it: a
  // device names the environment, never the distribution.
  const environments = new Map<string, string>()
  deps.onConnected((connection) => environments.set(connection.distro, connection.environmentId))

  const distroOf = (environmentId: string): string | null => {
    for (const [distro, id] of environments) if (id === environmentId) return distro
    return null
  }

  function routeFor(distro: string): LoopbackRoute {
    let route = routes.get(distro)
    if (!route) {
      route = createLoopbackRoute({
        open: async () => {
          const connection = deps.manager.current(distro)
          if (!connection) throw new Error(`The Studio server in ${label(distro)} is not running.`)
          return connection.open('ws')
        },
        log,
      })
      routes.set(distro, route)
    }
    return route
  }

  async function connected(distro: string): Promise<WslServerConnection> {
    const connection = await deps.manager.connect(distro)
    environments.set(distro, connection.environmentId)
    return connection
  }

  return {
    async windowTicket(distro, request) {
      let connection: WslServerConnection
      try {
        connection = await connected(distro)
      } catch (error) {
        return { ok: false, code: 'unavailable', message: failure(error) }
      }
      if (!connection.owner.supports(STUDIO_WINDOW_TICKETS_CAPABILITY))
        return {
          ok: false,
          code: 'outdated',
          message: `The Studio server in ${label(distro)} is older than this app. Restart the app to update it.`,
        }
      try {
        const minted = await connection.owner.request('environment.windowTicket', request)
        const port = await routeFor(distro).port()
        let distros = windowDistros.get(request.windowKey)
        if (!distros) windowDistros.set(request.windowKey, (distros = new Set()))
        distros.add(distro)
        return { ok: true, url: `ws://127.0.0.1:${port}${minted.path}`, token: minted.token }
      } catch (error) {
        return {
          ok: false,
          code: 'unavailable',
          message: `${label(distro)} did not give this window a ticket: ${failure(error)}`,
        }
      }
    },

    revokeWindow(windowKey) {
      const distros = windowDistros.get(windowKey)
      windowDistros.delete(windowKey)
      for (const distro of distros ?? []) {
        // A server not running now holds none of its connections, and its
        // tickets lapse in thirty seconds.
        const connection = deps.manager.current(distro)
        if (!connection?.owner.supports(STUDIO_WINDOW_TICKETS_CAPABILITY)) continue
        void connection.owner
          .request('environment.revokeWindow', { windowKey })
          .catch((error: unknown) =>
            log(`A closed window's connections to ${label(distro)} were not ended there: ${failure(error)}`),
          )
      }
    },

    relayedEnvironments() {
      return [...environments].map(([distro, environmentId]) => ({
        environmentId,
        name: label(distro),
        kind: 'wsl' as const,
        connected: deps.manager.current(distro)?.environmentId === environmentId,
      }))
    },

    async deviceTicket(environmentId, device) {
      const distro = distroOf(environmentId)
      if (!distro) return { ok: false, code: 'unknown_route', message: 'This desktop holds no machine by that id.' }
      let connection: WslServerConnection
      try {
        connection = await connected(distro)
      } catch (error) {
        return { ok: false, code: 'unavailable', message: failure(error) }
      }
      // The server answering now must be the one the device asked for.
      if (connection.environmentId !== environmentId)
        return {
          ok: false,
          code: 'unavailable',
          message: `${label(distro)} now runs another Studio than the one asked for.`,
        }
      if (!connection.owner.supports(STUDIO_DEVICE_TICKETS_CAPABILITY))
        return { ok: false, code: 'outdated', message: `The Studio server in ${label(distro)} is older than this app.` }
      try {
        const minted = await connection.owner.request('environment.deviceTicket', device)
        return { ok: true, token: minted.token, path: minted.path }
      } catch (error) {
        return {
          ok: false,
          code: 'unavailable',
          message: `${label(distro)} did not give this device a ticket: ${failure(error)}`,
        }
      }
    },

    async openEnvironment(environmentId) {
      const distro = distroOf(environmentId)
      const connection = distro ? deps.manager.current(distro) : null
      if (!connection || connection.environmentId !== environmentId)
        throw new Error('That machine is not connected to this desktop.')
      return connection.open('ws')
    },

    async close() {
      const closing = [...routes.values()]
      routes.clear()
      await Promise.all(closing.map((route) => route.close()))
    },
  }
}
