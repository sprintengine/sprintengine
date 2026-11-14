
import { STUDIO_WINDOW_TICKETS_CAPABILITY } from '../../../packages/studio-protocol/src/handshake'
import { createLoopbackRoute, type LoopbackRoute } from '../../main/environments/environment-route'
import type { WslEnvironmentManager, WslServerConnection } from './wsl-environment-manager'

// How this desktop's windows reach a WSL distribution's
// own Studio (design-wsl-ssh-direct PR 3), the twin of what main does for an
// SSH machine (`SshEnvironments`): a ticket minted by the distribution's own
// window listener, asked for over the desktop's owner connection, and a
// 127.0.0.1 route on this PC whose every socket is spliced onto a fresh `ws`
// stream of the distribution's front door (loopback or the stdio bridge,
// whichever the server is reached by). The route's port is chosen once and
// kept for the run, so a server that restarts keeps the window's route.
//
// A window's ticket starts the server if it is not running: opening a chat
// there is using it. A socket on the route never starts one: it carries bytes
// to the server up now, or is closed, and the window asks again.
//
// No paired device reaches a distribution: it is reached only from this
// desktop.

export type EnvironmentTicketAnswer =
  { ok: true; url: string; token: string } | { ok: false; code: string; message: string }

export type WslEnvironmentAccess = {
  /** A ticket for one connection of a window to the distribution's Studio, with this PC's route to it. */
  windowTicket(distro: string, request: { windowKey: string; origin: string }): Promise<EnvironmentTicketAnswer>
  /** A window's document has gone: every distribution it was given a ticket for ends its connections. */
  revokeWindow(windowKey: string): void
  /** Stop every route. */
  close(): Promise<void>
}

const label = (distro: string) => `WSL: ${distro}`

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createWslEnvironmentAccess(deps: {
  manager: Pick<WslEnvironmentManager, 'connect' | 'current'>
  log?: (message: string) => void
}): WslEnvironmentAccess {
  const log = deps.log ?? (() => undefined)
  const routes = new Map<string, LoopbackRoute>()
  // The distributions each window document was given a ticket for.
  const windowDistros = new Map<string, Set<string>>()
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

  return {
    async windowTicket(distro, request) {
      let connection: WslServerConnection
      try {
        connection = await deps.manager.connect(distro)
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

    async close() {
      const closing = [...routes.values()]
      routes.clear()
      await Promise.all(closing.map((route) => route.close()))
    },
  }
}
