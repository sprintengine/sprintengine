import type { StudioClient } from '../../../packages/client-runtime/src/public'
import { parseEnvironmentRoute } from '../../../packages/studio-protocol/src/environment'
import type { StudioCapability } from '../../../packages/studio-protocol/src/handshake'
import type { EnvironmentClients } from '../../shared/environment-clients'
import { machineStudioClient } from '../../shared/machine-studio-client'

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
  } | null
}): EnvironmentClients {
  return {
    async clientFor(route, capability = null) {
      const parsed = parseEnvironmentRoute(route)
      if (parsed?.kind === 'ssh' && deps.ssh) {
        const owner = await deps.ssh.ownerClient(parsed.machine, capability)
        return owner.ok
          ? { ok: true, client: machineStudioClient(owner.client, parsed.machine), name: owner.label }
          : owner
      }
      return { ok: false, code: 'unsupported_route', message: 'That machine cannot be reached from this computer.' }
    },
  }
}
