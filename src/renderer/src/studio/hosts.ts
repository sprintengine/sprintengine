import {
  STUDIO_EXECUTION_HOSTS_CAPABILITY,
  STUDIO_FILE_SYSTEM_CAPABILITY,
  type ExecutionHostId,
  type HostsListResult,
} from '../../../../packages/studio-protocol/src/public'
import { distroOfHostId } from '../../../shared/execution-host'
import { machineSpellingOf } from '../../../shared/machine-spelling'
import { withEnvironmentStudio } from './environmentStudio'
import { followWindowStudioPush } from './windowStudioPush'
import { windowStudioClient } from './windowStudioClient'

// The machines this computer offers (this one, and on Windows its WSL
// distributions, each with how its Studio server stands), for New chat's
// machine list and Settings ▸ Machines: `hosts.list` and the `hosts.changed`
// stream on the window's own Studio, an owner's. A distribution's home, where
// New chat's folder picker opens, is that distribution's own word: asked of
// its Studio (`files.defaultWorkspaceParent`) and spelled as Windows opens it.

export type HostsApi = {
  /** This machine first, then its WSL distributions: every one with `all`, the enabled ones otherwise. `refresh` asks WSL again. */
  hostsList(options?: { refresh?: boolean; all?: boolean }): Promise<HostsListResult>
  /**
   * Where a WSL distribution keeps a person's projects (its Documents, else
   * its home), as the share Windows opens it by; null when it cannot say.
   */
  hostsHome(hostId: ExecutionHostId): Promise<string | null>
  /** The list may read differently now: ask again. Kept across reconnects. */
  onHostsChanged(cb: () => void): () => void
}

async function served() {
  const client = await windowStudioClient()
  if (!client.supports(STUDIO_EXECUTION_HOSTS_CAPABILITY))
    throw new Error("This Studio does not list this computer's machines.")
  return client
}

export const hostsApi: HostsApi = {
  hostsList: async (options = {}) =>
    (await served()).request('hosts.list', {
      ...(options.refresh ? { refresh: true } : {}),
      ...(options.all ? { all: true } : {}),
    }),
  hostsHome: async (hostId) => {
    const distro = distroOfHostId(hostId)
    if (!distro) return null
    const route = `wsl:${distro}`
    return withEnvironmentStudio({ route, name: `WSL: ${distro}` }, async (client) => {
      if (!client.supports(STUDIO_FILE_SYSTEM_CAPABILITY)) return null
      const { path } = await client.request('files.defaultWorkspaceParent', {})
      const spelling = machineSpellingOf(route, () => client.welcome.environment.driveMountRoot)
      return path && spelling ? spelling.fromMachine(path) : null
    })
  },
  onHostsChanged: (cb) =>
    followWindowStudioPush({
      topic: 'hosts.changed',
      params: {},
      capability: STUDIO_EXECUTION_HOSTS_CAPABILITY,
      onPayload: () => cb(),
    }),
}
