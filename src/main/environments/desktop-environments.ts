import { formatEnvironmentRoute, type EnvironmentRoute } from '../../../packages/studio-protocol/src/environment'
import { meshEnvironmentSource, sshEnvironmentSource, wslEnvironmentSources } from '../../shared/environment-keys'
import { meshConnection, sshConnection, wslConnectionReport } from '../../shared/environment-connections'
import type { ExecutionHostId, ExecutionHostSettings, ExecutionHostSummary } from '../../shared/execution-host'
import type { MeshConnection, MeshMachineReachability } from '../../shared/tailnet-mesh'
import type { SshEnvironmentSummary } from '../../shared/ssh-environments'
import { readStudioEnvironmentId } from '../../server/environment/environment-id'
import { createEnvironmentRegistry, type EnvironmentRegistry } from './environment-registry'

// The desktop's environment registry, fed by the owners of what names a
// machine today: the per-machine settings (WSL distributions), the saved SSH
// machines, and the paired desktops. Each owner's list is observed whole,
// once at start and again on every change it announces, and so is how its
// connections stand: the SSH machines' states, the paired desktops'
// reachability, the distributions' states. This desktop's own id is its data
// directory's, the one its Studio server says in its welcome.
//
// When the machines become direct environments, their connection supervisors
// report instead of these owners; nothing that reads the list changes.

/** A list and its change hook, as each owner exposes it. */
export type ObservedList<T> = { list(): T[]; onChanged(listener: () => void): () => void }

export type DesktopEnvironments = EnvironmentRegistry & {
  /**
   * Ask the owner of a route (`formatEnvironmentRoute`) to try it again now:
   * connect an SSH machine, check a paired desktop, read the distributions
   * again. Resolves when that owner has answered; its report follows.
   */
  retry(route: string): Promise<void>
}

export function createDesktopEnvironments(deps: {
  userDataDir: string
  platform: string
  /** The per-machine settings, in process or as the shell mirrors them. */
  hosts: {
    get(): Partial<Record<ExecutionHostId, ExecutionHostSettings>>
    onChanged(listener: () => void): () => void
  }
  /** How this computer's machines stand (`HostRegistry`): the distributions' states. */
  hostStates?: HostStates | null
  /** The saved SSH machines, when their preview is on. */
  ssh:
    | (ObservedList<
        Pick<SavedSshFields, 'id' | 'label' | 'destination' | 'resolved' | 'environmentId'> &
          Partial<Pick<SshEnvironmentSummary, 'state' | 'stateText'>>
      > & { connect?(id: string): Promise<unknown> })
    | null
  /** The desktops paired over the tailnet, wherever the mesh runs. */
  mesh: ObservedList<Pick<MeshConnection, 'id' | 'machineName' | 'environmentId'>> | null
  /** Whether each paired desktop answers, wherever the mesh runs; and the check that asks again. */
  meshReachability?: (ObservedList<MeshMachineReachability> & { check?(connectionId: string): Promise<unknown> }) | null
  log?: (message: string) => void
}): DesktopEnvironments {
  const registry = createEnvironmentRegistry({
    userDataDir: deps.userDataDir,
    localEnvironmentId: readStudioEnvironmentId(deps.userDataDir, { log: deps.log }),
    platform: deps.platform,
    ...(deps.log ? { log: deps.log } : {}),
  })
  // This machine always answers: it is the one asking.
  registry.report('local', [
    { route: { kind: 'local' }, connection: { state: 'up', detail: 'Always available', lastReachedAt: null } },
  ])
  const observeHosts = () => registry.observe('wsl', wslEnvironmentSources(deps.hosts.get(), deps.platform))
  observeHosts()
  deps.hosts.onChanged(observeHosts)

  const { ssh, mesh, meshReachability, hostStates } = deps
  let retryHosts: (() => Promise<void>) | null = null
  if (hostStates) {
    // A read that lands after a newer one is dropped, so a slow `wsl.exe`
    // cannot put an older state back.
    let asked = 0
    const reportHosts = (refresh = false): Promise<void> => {
      const ticket = ++asked
      return hostStates
        .list(refresh ? { refresh: true } : {})
        .then((listing) => {
          if (ticket !== asked) return
          registry.report('wsl', listing.hosts.flatMap(wslConnectionReport))
        })
        .catch((error: unknown) => deps.log?.(`Could not read the WSL machines' states: ${String(error)}`))
    }
    void reportHosts()
    hostStates.subscribe(() => void reportHosts())
    retryHosts = () => reportHosts(true)
  }
  if (ssh) {
    const observeSsh = () => {
      const machines = ssh.list()
      registry.observe('ssh', machines.map(sshEnvironmentSource))
      registry.report(
        'ssh',
        machines.map((machine) => ({
          route: { kind: 'ssh', machine: machine.id },
          connection: sshConnection(machine),
        })),
      )
    }
    observeSsh()
    ssh.onChanged(observeSsh)
  }
  if (mesh) {
    const observeMesh = () => registry.observe('tailnet', mesh.list().map(meshEnvironmentSource))
    observeMesh()
    mesh.onChanged(observeMesh)
  }
  if (meshReachability) {
    const reportMesh = () => {
      const reach = new Map(meshReachability.list().map((entry) => [entry.connectionId, entry]))
      registry.report(
        'tailnet',
        (mesh?.list() ?? []).map((connection) => ({
          route: { kind: 'tailnet', connection: connection.id },
          connection: meshConnection(reach.get(connection.id)),
        })),
      )
    }
    reportMesh()
    meshReachability.onChanged(reportMesh)
    mesh?.onChanged(reportMesh)
  }

  async function retry(value: string): Promise<void> {
    const route = registry
      .list()
      .flatMap((entry) => entry.routes)
      .find((known) => formatEnvironmentRoute(known) === value)
    if (!route) return
    await retryRoute(route)
  }

  async function retryRoute(route: EnvironmentRoute): Promise<void> {
    switch (route.kind) {
      case 'local':
        return
      case 'wsl':
        await retryHosts?.()
        return
      case 'ssh':
        await ssh?.connect?.(route.machine)
        return
      case 'tailnet':
        await meshReachability?.check?.(route.connection)
        return
    }
  }

  return { ...registry, retry }
}

type SavedSshFields = Parameters<typeof sshEnvironmentSource>[0]

type HostStates = {
  list(options?: { refresh?: boolean }): Promise<{ hosts: ExecutionHostSummary[] }>
  subscribe(listener: () => void): () => void
}
