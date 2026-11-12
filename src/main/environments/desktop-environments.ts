import { meshEnvironmentSource, sshEnvironmentSource, wslEnvironmentSources } from '../../shared/environment-keys'
import type { ExecutionHostId, ExecutionHostSettings } from '../../shared/execution-host'
import type { MeshConnection } from '../../shared/tailnet-mesh'
import type { SavedSshEnvironment } from '../../shared/ssh-environments'
import { readStudioEnvironmentId } from '../../server/environment/environment-id'
import { createEnvironmentRegistry, type EnvironmentRegistry } from './environment-registry'

// The desktop's environment registry, fed by the owners of what names a
// machine today: the per-machine settings (WSL distributions), the saved SSH
// machines, and the paired desktops. Each owner's list is observed whole,
// once at start and again on every change it announces. This desktop's own
// id is its data directory's, the one its Studio server says in its welcome.

/** A list and its change hook, as each owner exposes it. */
export type ObservedList<T> = { list(): T[]; onChanged(listener: () => void): () => void }

export function createDesktopEnvironments(deps: {
  userDataDir: string
  platform: string
  /** The per-machine settings, in process or as the shell mirrors them. */
  hosts: {
    get(): Partial<Record<ExecutionHostId, ExecutionHostSettings>>
    onChanged(listener: () => void): () => void
  }
  /** The saved SSH machines, when their preview is on. */
  ssh: ObservedList<Pick<SavedSshEnvironment, 'id' | 'label' | 'destination' | 'resolved' | 'environmentId'>> | null
  /** The desktops paired over the tailnet, wherever the mesh runs. */
  mesh: ObservedList<Pick<MeshConnection, 'id' | 'machineName' | 'environmentId'>> | null
  log?: (message: string) => void
}): EnvironmentRegistry {
  const registry = createEnvironmentRegistry({
    userDataDir: deps.userDataDir,
    localEnvironmentId: readStudioEnvironmentId(deps.userDataDir, { log: deps.log }),
    platform: deps.platform,
    ...(deps.log ? { log: deps.log } : {}),
  })
  const observeHosts = () => registry.observe('wsl', wslEnvironmentSources(deps.hosts.get(), deps.platform))
  observeHosts()
  deps.hosts.onChanged(observeHosts)
  const { ssh, mesh } = deps
  if (ssh) {
    const observeSsh = () => registry.observe('ssh', ssh.list().map(sshEnvironmentSource))
    observeSsh()
    ssh.onChanged(observeSsh)
  }
  if (mesh) {
    const observeMesh = () => registry.observe('tailnet', mesh.list().map(meshEnvironmentSource))
    observeMesh()
    mesh.onChanged(observeMesh)
  }
  return registry
}
