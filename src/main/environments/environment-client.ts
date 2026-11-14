import type { StudioClient } from '../../../packages/client-runtime/src/public'
import { parseEnvironmentRoute } from '../../../packages/studio-protocol/src/environment'
import type { StudioCapability } from '../../../packages/studio-protocol/src/handshake'
import type { EnvironmentClients } from '../../shared/environment-clients'
import { routeStudioClient } from '../../shared/machine-studio-client'

// Main's clients of other environments' Studios (shared/environment-clients.ts):
// its owner connection to each machine, its paths spelled as this computer
// spells them. A machine that cannot be reached is said so in words.

export function createEnvironmentClients(deps: {
  /** The saved SSH machines' owner connections; absent where SSH machines are off. */
  ssh?: {
    ownerClient(
      id: string,
      capability?: StudioCapability | null,
    ): Promise<{ ok: true; client: StudioClient; label: string } | { ok: false; code: string; message: string }>
    onConnected(listener: (connection: { key: string }) => void): void
  } | null
}): EnvironmentClients {
  const listeners = new Set<(route: string) => void>()
  // The machine's key is its route (`ssh:<id>`).
  deps.ssh?.onConnected((connection) => {
    for (const listener of listeners) listener(connection.key)
  })
  return {
    onConnected(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async clientFor(route, capability = null) {
      const parsed = parseEnvironmentRoute(route)
      if (parsed?.kind === 'ssh' && deps.ssh) {
        const owner = await deps.ssh.ownerClient(parsed.machine, capability)
        return owner.ok ? { ok: true, client: routeStudioClient(owner.client, route), name: owner.label } : owner
      }
      return { ok: false, code: 'unsupported_route', message: 'That machine cannot be reached from this computer.' }
    },
  }
}
