import { parseEnvironmentRoute } from '../../../packages/studio-protocol/src/environment'
import type { EnvironmentClients } from '../../shared/environment-clients'
import { machineSpellingOf, type MachineSpelling } from '../../shared/machine-spelling'
import { machineStudioClient } from '../../shared/machine-studio-client'
import type { WslEnvironmentManager, WslServerConnection } from './wsl-environment-manager'

// The desktop core's clients of its WSL distributions' own Studios
// (design-wsl-ssh-direct PR 3c), for every caller here that acts on a chat a
// distribution holds: the record copy, the hand-over, the gateway's
// conversation tools. Each is the core's owner connection to that server
// (`WslServerConnection.owner`), its paths spelled as Windows spells them:
// the distribution's share, or a drive under its own mount root. Asking for
// one starts the server, as opening a chat there does.

export type WslEnvironmentClients = EnvironmentClients & {
  /**
   * How a distribution spells its paths, once its server has said where it
   * mounts the drives (it is connected); null before then.
   */
  spellingOf(route: string): MachineSpelling | null
}

const label = (distro: string) => `WSL: ${distro}`

export function createWslEnvironmentClients(deps: {
  manager: Pick<WslEnvironmentManager, 'connect' | 'current'>
  onConnected(listener: (connection: WslServerConnection) => void): void
}): WslEnvironmentClients {
  const listeners = new Set<(route: string) => void>()
  deps.onConnected((connection) => {
    for (const listener of [...listeners]) listener(`wsl:${connection.distro}`)
  })
  const spellingOfConnection = (route: string, connection: WslServerConnection): MachineSpelling | null =>
    machineSpellingOf(route, () => connection.driveMountRoot)
  return {
    onConnected(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async clientFor(route, capability = null) {
      const parsed = parseEnvironmentRoute(route)
      if (parsed?.kind !== 'wsl')
        return { ok: false, code: 'unsupported_route', message: 'That machine cannot be reached from this computer.' }
      let connection: WslServerConnection
      try {
        connection = await deps.manager.connect(parsed.distro)
      } catch (error) {
        return { ok: false, code: 'unavailable', message: error instanceof Error ? error.message : String(error) }
      }
      const owner = connection.owner
      if (capability && !owner.supports(capability))
        return {
          ok: false,
          code: 'outdated',
          message: `The Studio server in ${label(parsed.distro)} is older than this app. Restart it in Settings › Machines.`,
        }
      const spelling = spellingOfConnection(route, connection)
      return spelling
        ? { ok: true, client: machineStudioClient(owner, spelling), name: label(parsed.distro) }
        : { ok: false, code: 'unsupported_route', message: 'That machine cannot be reached from this computer.' }
    },
    spellingOf(route) {
      const parsed = parseEnvironmentRoute(route)
      const connection = parsed?.kind === 'wsl' ? deps.manager.current(parsed.distro) : null
      return connection ? spellingOfConnection(route, connection) : null
    },
  }
}

/**
 * One set of clients over several: each route to the clients that reach its
 * kind (a WSL distribution's to the core's own, the rest to main's), every
 * connect heard from all of them.
 */
export function combineEnvironmentClients(
  wsl: WslEnvironmentClients | null,
  others: EnvironmentClients | null,
): (EnvironmentClients & { spellingOf(route: string): MachineSpelling | null }) | null {
  if (!wsl && !others) return null
  return {
    onConnected(listener) {
      const off = [wsl?.onConnected(listener), others?.onConnected(listener)]
      return () => {
        for (const each of off) each?.()
      }
    },
    clientFor(route, capability) {
      const kind = parseEnvironmentRoute(route)?.kind
      const clients = kind === 'wsl' ? wsl : others
      return clients
        ? clients.clientFor(route, capability)
        : Promise.resolve({
            ok: false,
            code: 'unsupported_route',
            message: 'That machine cannot be reached from this computer.',
          })
    },
    spellingOf(route) {
      return parseEnvironmentRoute(route)?.kind === 'wsl' ? (wsl?.spellingOf(route) ?? null) : machineSpellingOf(route)
    },
  }
}
