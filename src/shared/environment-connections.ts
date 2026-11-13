import type { EnvironmentRoute } from '../../packages/studio-protocol/src/environment'
import { environmentRouteOfHostId } from './environment-keys'
import type { EnvironmentConnection } from './environments'
import { executionHostStateWords, type ExecutionHostSummary } from './execution-host'
import type { SshEnvironmentSummary } from './ssh-environments'
import type { MeshMachineReachability } from './tailnet-mesh'

// How each kind of machine's own owner says it stands, as an environment's
// connection (design-environments): the SSH machines' state machine, the
// mesh's reachability checks, the WSL distributions' states. Main's registry
// is fed through these; once the machines are direct environments, their
// connection supervisors report instead and these go.

/** An SSH machine's connection, from its own state machine and in its own words. */
export function sshConnection(
  machine: Partial<Pick<SshEnvironmentSummary, 'state' | 'stateText'>>,
): EnvironmentConnection {
  const detail = machine.stateText?.trim() ? machine.stateText : null
  const at = (state: EnvironmentConnection['state']): EnvironmentConnection => ({ state, detail, lastReachedAt: null })
  switch (machine.state) {
    case 'connected':
      return at('up')
    case 'resolving':
    case 'connecting':
    case 'asking':
    case 'probing':
    case 'installing':
    case 'starting':
    case 'upgrading':
    case 'reconnecting':
      return at('connecting')
    case 'needs-sign-in':
      return { ...at('signed-out'), remedy: 'Sign in' }
    case 'version-blocked':
    case 'unsupported':
    case 'failed':
    case 'disconnected':
      return at('offline')
    case 'idle':
    case undefined:
      return at('unknown')
  }
}

/** A paired desktop's connection, from the mesh's last reachability check of it. */
export function meshConnection(reach: MeshMachineReachability | undefined): EnvironmentConnection {
  if (!reach) return { state: 'unknown', detail: 'Paired', lastReachedAt: null }
  if (reach.unauthorized)
    return {
      state: 'signed-out',
      detail: 'Revoked this device',
      lastReachedAt: reach.lastReachedAt,
      remedy: 'Pair again',
    }
  if (reach.checking && reach.checkedAt === null)
    return { state: 'connecting', detail: 'Checking…', lastReachedAt: null }
  if (reach.checkedAt === null) return { state: 'unknown', detail: 'Paired', lastReachedAt: null }
  if (reach.reachable) return { state: 'up', detail: null, lastReachedAt: null }
  return { state: 'offline', detail: 'Not answering', lastReachedAt: reach.lastReachedAt }
}

/**
 * A machine a paired desktop relays this one to: as that desktop answers,
 * and, while it does, as that desktop's own connection to the machine stands.
 */
export function relayConnection(reach: MeshMachineReachability | undefined, connected: boolean): EnvironmentConnection {
  const through = meshConnection(reach)
  if (through.state !== 'up') return through
  return connected
    ? through
    : { state: 'offline', detail: `Not connected on ${reach!.machineName}`, lastReachedAt: null }
}

/** A WSL distribution's connection, from its state on this PC. Only those turned on as machines are listed. */
export function wslConnectionReport(
  host: ExecutionHostSummary,
): Array<{ route: EnvironmentRoute; connection: EnvironmentConnection }> {
  if (host.kind !== 'wsl') return []
  const route = environmentRouteOfHostId(host.id)
  if (route.kind !== 'wsl') return []
  const detail = executionHostStateWords(host)
  const state: EnvironmentConnection['state'] =
    host.state === 'ready'
      ? 'up'
      : host.state === 'starting'
        ? 'connecting'
        : host.state === 'unavailable'
          ? 'offline'
          : 'unknown'
  return [{ route, connection: { state, detail, lastReachedAt: null } }]
}
