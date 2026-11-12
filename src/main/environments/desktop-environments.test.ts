import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { formatEnvironmentRoute } from '../../../packages/studio-protocol/src/environment'
import {
  emptyExecutionHostSettings,
  wslHostId,
  type ExecutionHostId,
  type ExecutionHostSettings,
  type ExecutionHostSummary,
} from '../../shared/execution-host'
import type { SshEnvironmentState } from '../../shared/ssh-environments'
import type { MeshMachineReachability } from '../../shared/tailnet-mesh'
import { readStudioEnvironmentId } from '../../server/environment/environment-id'
import { meshConnection, sshConnection, wslConnectionReport } from '../../shared/environment-connections'
import { createDesktopEnvironments } from './desktop-environments'

const MINI = '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a'
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A list its owner changes, announcing each change as the real owners do. */
function owned<T>(initial: T[]) {
  let items = initial
  const listeners = new Set<() => void>()
  return {
    list: () => items,
    onChanged: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next: T[]) {
      items = next
      for (const listener of listeners) listener()
    },
  }
}

test("the desktop's registry follows each owner: settings, SSH machines and paired desktops", () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-environments-'))
  directories.push(dir)
  let hosts: Partial<Record<ExecutionHostId, ExecutionHostSettings>> = {}
  const hostListeners = new Set<() => void>()
  const ssh = owned<{ id: string; label: string; destination: string; resolved: null; environmentId: string | null }>([
    { id: 'm_box', label: 'build-box', destination: 'dev@build-box', resolved: null, environmentId: null },
  ])
  const mesh = owned<{ id: string; machineName: string; environmentId?: string }>([])
  const environments = createDesktopEnvironments({
    userDataDir: dir,
    platform: 'win32',
    hosts: {
      get: () => hosts,
      onChanged: (listener) => {
        hostListeners.add(listener)
        return () => hostListeners.delete(listener)
      },
    },
    ssh,
    mesh,
  })
  const routes = () => environments.list().map((entry) => entry.routes.map(formatEnvironmentRoute).join(' '))
  // This machine goes by its data directory's id, the one its server says in its welcome.
  assert.equal(environments.list()[0]?.environmentId, readStudioEnvironmentId(dir))
  assert.deepEqual(routes(), ['local', 'ssh:m_box'])

  hosts = { [wslHostId('Ubuntu')]: { ...emptyExecutionHostSettings(), enabled: true } }
  for (const listener of hostListeners) listener()
  mesh.set([{ id: 'tnc_1', machineName: 'mac-mini', environmentId: MINI }])
  assert.deepEqual(routes(), ['local', 'wsl:Ubuntu', 'tailnet:tnc_1', 'ssh:m_box'])

  // The SSH machine turns out to be the paired desktop.
  ssh.set([{ id: 'm_box', label: 'build-box', destination: 'dev@build-box', resolved: null, environmentId: MINI }])
  assert.deepEqual(routes(), ['local', 'wsl:Ubuntu', 'tailnet:tnc_1 ssh:m_box'])
})

test('each owner reports how its machines stand, and Retry asks the owner of the route', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-environments-'))
  directories.push(dir)
  const hosts = { [wslHostId('Ubuntu')]: { ...emptyExecutionHostSettings(), enabled: true } }
  const ssh = owned<{
    id: string
    label: string
    destination: string
    resolved: null
    environmentId: string | null
    state: SshEnvironmentState
    stateText: string
  }>([
    {
      id: 'm_box',
      label: 'build-box',
      destination: 'dev@build-box',
      resolved: null,
      environmentId: null,
      state: 'installing',
      stateText: 'Installing Studio server 0.4.0 (34 MB)',
    },
  ])
  const connected: string[] = []
  const checked: string[] = []
  const refreshed: boolean[] = []
  const mesh = owned<{ id: string; machineName: string; environmentId?: string }>([
    { id: 'tnc_1', machineName: 'mac-mini', environmentId: MINI },
  ])
  const reach = owned<MeshMachineReachability>([
    {
      connectionId: 'tnc_1',
      machineName: 'mac-mini',
      checking: false,
      reachable: false,
      unauthorized: false,
      checkedAt: 20,
      lastReachedAt: 10,
      detail: 'Timed out.',
    },
  ])
  let hostState: ExecutionHostSummary['state'] = 'stopped'
  const hostListeners = new Set<() => void>()
  const environments = createDesktopEnvironments({
    userDataDir: dir,
    platform: 'win32',
    hosts: { get: () => hosts, onChanged: () => () => undefined },
    hostStates: {
      list: async (options) => {
        refreshed.push(options?.refresh === true)
        return {
          hosts: [
            { id: 'local', kind: 'windows', label: 'This PC (Windows)', pathStyle: 'windows', state: 'ready' },
            {
              id: wslHostId('Ubuntu'),
              kind: 'wsl',
              label: 'WSL: Ubuntu',
              pathStyle: 'wsl',
              state: hostState,
              enabled: true,
              wslVersion: 2,
            },
          ],
        }
      },
      subscribe: (listener) => {
        hostListeners.add(listener)
        return () => hostListeners.delete(listener)
      },
    },
    ssh: { ...ssh, connect: async (id) => void connected.push(id) },
    mesh,
    meshReachability: { ...reach, check: async (id) => void checked.push(id) },
  })
  await settle()
  const states = () =>
    environments
      .list()
      .map((entry) => [formatEnvironmentRoute(entry.routes[0]!), entry.connection.state, entry.connection.detail])
  assert.deepEqual(states(), [
    ['local', 'up', 'Always available'],
    ['wsl:Ubuntu', 'unknown', 'Stopped — starts when a workspace on it needs it · WSL 2'],
    ['tailnet:tnc_1', 'offline', 'Not answering'],
    ['ssh:m_box', 'connecting', 'Installing Studio server 0.4.0 (34 MB)'],
  ])

  // Each owner's next word is the list's.
  hostState = 'ready'
  for (const listener of hostListeners) listener()
  reach.set([{ ...reach.list()[0]!, reachable: true, lastReachedAt: 30 }])
  ssh.set([{ ...ssh.list()[0]!, state: 'needs-sign-in', stateText: 'Sign in to build-box' }])
  await settle()
  assert.deepEqual(
    states().map(([route, state]) => [route, state]),
    [
      ['local', 'up'],
      ['wsl:Ubuntu', 'up'],
      ['tailnet:tnc_1', 'up'],
      ['ssh:m_box', 'signed-out'],
    ],
  )
  assert.equal(environments.list()[3]?.connection.remedy, 'Sign in')

  await environments.retry('ssh:m_box')
  await environments.retry('tailnet:tnc_1')
  await environments.retry('wsl:Ubuntu')
  // A route nobody lists is not anyone's to retry.
  await environments.retry('ssh:m_gone')
  assert.deepEqual(connected, ['m_box'])
  assert.deepEqual(checked, ['tnc_1'])
  assert.equal(refreshed.at(-1), true)
})

test('the owners’ states read as connections', () => {
  assert.equal(sshConnection({ state: 'connected', stateText: 'Connected' }).state, 'up')
  assert.equal(sshConnection({ state: 'reconnecting', stateText: 'Reconnecting' }).state, 'connecting')
  assert.equal(sshConnection({ state: 'version-blocked', stateText: 'Runs a newer Studio' }).state, 'offline')
  assert.equal(sshConnection({ state: 'idle', stateText: '' }).state, 'unknown')
  assert.equal(sshConnection({ state: 'idle', stateText: '' }).detail, null)
  assert.deepEqual(meshConnection(undefined), { state: 'unknown', detail: 'Paired', lastReachedAt: null })
  const reach: MeshMachineReachability = {
    connectionId: 'tnc_1',
    machineName: 'mac-mini',
    checking: true,
    reachable: false,
    unauthorized: false,
    checkedAt: null,
    lastReachedAt: null,
    detail: null,
  }
  assert.equal(meshConnection(reach).state, 'connecting')
  assert.equal(meshConnection({ ...reach, unauthorized: true }).remedy, 'Pair again')
  assert.equal(meshConnection({ ...reach, checking: false, checkedAt: 5, lastReachedAt: 3 }).lastReachedAt, 3)
  const host: ExecutionHostSummary = {
    id: wslHostId('Debian'),
    kind: 'wsl',
    label: 'WSL: Debian',
    pathStyle: 'wsl',
    state: 'unavailable',
    reason: 'This distribution is not installed.',
  }
  assert.deepEqual(wslConnectionReport(host), [
    {
      route: { kind: 'wsl', distro: 'Debian' },
      connection: { state: 'offline', detail: 'This distribution is not installed.', lastReachedAt: null },
    },
  ])
  assert.deepEqual(wslConnectionReport({ ...host, id: 'local', kind: 'windows' }), [])
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
