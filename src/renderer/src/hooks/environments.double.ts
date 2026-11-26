import type { EnvironmentConnection, EnvironmentEntry } from '../../../shared/environments'
import { sshConnection } from '../../../shared/environment-connections'
import { sshMachineRef } from './useMachineIdentity'

// The environment list a test's window reads (`environmentsList`), made from
// the per-kind records the test already holds: this computer's machines (as
// `hostsList` answers them), the saved SSH machines and the paired desktops.
// One list, as main's registry would build it, so a surface under test reads
// machines the one way the app does.

type TestHost = { id: string; label: string; state?: string; reason?: string | null }
type TestSsh = {
  id: string
  label: string
  destination?: string
  resolved?: unknown
  state?: string
  stateText?: string
}
type TestPaired = { id: string; machineName: string }

const unknown: EnvironmentConnection = { state: 'unknown', detail: null, lastReachedAt: null }

export function environmentsForTest({
  hosts = [],
  ssh = [],
  paired = [],
}: {
  hosts?: readonly TestHost[]
  ssh?: readonly TestSsh[]
  paired?: readonly TestPaired[]
}): EnvironmentEntry[] {
  const local = hosts.find((host) => host.id === 'local')
  const entries: EnvironmentEntry[] = [
    {
      environmentId: 'env-local',
      displayName: local?.label ?? 'This Mac',
      routes: [{ kind: 'local' }],
      machine: { kind: 'local' },
      descriptor: null,
      connection: { state: 'up', detail: null, lastReachedAt: null },
      compatibility: 'compatible',
    },
  ]
  for (const host of hosts) {
    if (!host.id.startsWith('wsl:')) continue
    entries.push({
      environmentId: null,
      displayName: host.label,
      routes: [{ kind: 'wsl', distro: host.id.slice('wsl:'.length) }],
      machine: { kind: 'wsl', hostId: host.id as `wsl:${string}` },
      descriptor: null,
      connection:
        host.state === 'unavailable'
          ? { state: 'offline', detail: host.reason ?? 'Not available.', lastReachedAt: null }
          : host.state === 'ready'
            ? { state: 'up', detail: null, lastReachedAt: null }
            : unknown,
      compatibility: 'unknown',
    })
  }
  for (const machine of ssh)
    entries.push({
      environmentId: null,
      displayName: machine.label,
      routes: [{ kind: 'ssh', machine: machine.id }],
      machine: sshMachineRef(machine as Parameters<typeof sshMachineRef>[0]),
      descriptor: null,
      connection: sshConnection(machine as Parameters<typeof sshConnection>[0]),
      compatibility: machine.state === 'version-blocked' ? 'server-outdated' : 'unknown',
    })
  for (const machine of paired)
    entries.push({
      environmentId: null,
      displayName: machine.machineName,
      routes: [{ kind: 'tailnet', connection: machine.id }],
      machine: { kind: 'paired', name: machine.machineName },
      descriptor: null,
      connection: unknown,
      compatibility: 'unknown',
    })
  return entries
}
