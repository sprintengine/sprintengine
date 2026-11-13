import assert from 'node:assert/strict'
import { test } from 'vitest'

import { formatEnvironmentRoute, parseChatAddress } from '../../packages/studio-protocol/src/environment'
import {
  chatAddressKeyOfRemoteChat,
  chatAddressOfWorkspace,
  environmentRouteOfHostId,
  environmentRouteOfMachinePath,
  environmentRouteOfMeshConnection,
  environmentRouteOfWorkspace,
  environmentRouteOfWorkspaceEnvironment,
  hostIdOfEnvironmentRoute,
  localEnvironmentSource,
  machinePathOnEnvironmentRoute,
  meshConnectionIdOfEnvironmentRoute,
  meshEnvironmentSource,
  sshEnvironmentSource,
  wslEnvironmentSources,
} from './environment-keys'
import { emptyExecutionHostSettings, LOCAL_HOST_ID, wslHostId, type ExecutionHostId } from './execution-host'
import { machineIdOf } from './machine-identity'
import { machinePath, parseMachinePath } from './machine-paths'
import { remoteChatKey } from '../renderer/src/components/workspace/remoteBand/remoteSessionsModel'

const LOCAL_ID = '6f1c2a9e-4b7d-4e2f-9a1b-0c3d5e7f9a1b'
const PAIRED_ID = '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a'

test('a host id is a route on this computer, and back', () => {
  assert.equal(formatEnvironmentRoute(environmentRouteOfHostId(LOCAL_HOST_ID)), 'local')
  assert.equal(formatEnvironmentRoute(environmentRouteOfHostId(wslHostId('Ubuntu-22.04'))), 'wsl:Ubuntu-22.04')
  // A route string for this computer's machines is the host id itself.
  for (const hostId of [LOCAL_HOST_ID, wslHostId('Ubuntu'), wslHostId('Debian')] as ExecutionHostId[]) {
    const route = environmentRouteOfHostId(hostId)
    assert.equal(formatEnvironmentRoute(route), hostId)
    assert.equal(hostIdOfEnvironmentRoute(route), hostId)
  }
  assert.equal(hostIdOfEnvironmentRoute({ kind: 'ssh', machine: 'm1' }), null)
  assert.equal(hostIdOfEnvironmentRoute({ kind: 'tailnet', connection: 'tnc_1' }), null)
})

test('a folder spelled on an SSH machine is that machine, and the route spells it back', () => {
  const spelled = machinePath('ssh_k3J9x', '/home/dev/repo')
  const route = environmentRouteOfMachinePath(spelled)
  assert.deepEqual(route, { kind: 'ssh', machine: 'ssh_k3J9x' })
  assert.ok(route?.kind === 'ssh')
  assert.equal(machinePathOnEnvironmentRoute(route, '/home/dev/repo'), spelled)
  assert.deepEqual(parseMachinePath(spelled), { id: 'ssh_k3J9x', path: '/home/dev/repo' })
  for (const plain of ['/Users/dev/repo', 'C:\\Users\\dev\\repo', '\\\\wsl.localhost\\Ubuntu\\home', '', null])
    assert.equal(environmentRouteOfMachinePath(plain), null, String(plain))
})

test("a workspace's SSH record and a pairing id are routes, and the pairing id comes back", () => {
  assert.equal(
    formatEnvironmentRoute(environmentRouteOfWorkspaceEnvironment({ kind: 'ssh', id: 'ssh_k3J9x' })),
    'ssh:ssh_k3J9x',
  )
  const route = environmentRouteOfMeshConnection('tnc_AbC123')
  assert.equal(formatEnvironmentRoute(route), 'tailnet:tnc_AbC123')
  assert.equal(meshConnectionIdOfEnvironmentRoute(route), 'tnc_AbC123')
  assert.equal(meshConnectionIdOfEnvironmentRoute({ kind: 'local' }), null)
})

test('a workspace runs on its machine: pairing, then SSH, then its machine on Windows, else here', () => {
  const route = (workspace: Parameters<typeof environmentRouteOfWorkspace>[0], platform = 'win32') =>
    formatEnvironmentRoute(environmentRouteOfWorkspace(workspace, platform))
  assert.equal(
    route({ remoteOrigin: { connectionId: 'tnc_1', workspaceId: 'ws_remote' }, hostId: 'wsl:Ubuntu' }),
    'tailnet:tnc_1',
  )
  assert.equal(route({ environment: { kind: 'ssh', id: 'm1' }, hostId: 'wsl:Ubuntu' }), 'ssh:m1')
  assert.equal(route({ folderPath: machinePath('m2', '/srv/app') }), 'ssh:m2')
  assert.equal(route({ hostId: 'wsl:Ubuntu', folderPath: 'C:\\code\\app' }), 'wsl:Ubuntu')
  // The machine the person picked wins over the folder's distribution (owner ruling 2026-10-03).
  assert.equal(route({ hostId: 'local', folderPath: '\\\\wsl.localhost\\Debian\\home\\dev\\app' }), 'local')
  // A workspace that records no machine goes by its folder.
  assert.equal(route({ folderPath: '\\\\wsl.localhost\\Debian\\home\\dev\\app' }), 'wsl:Debian')
  assert.equal(route({}), 'local')
  // Off Windows a WSL id names nothing: the route is here.
  assert.equal(route({ hostId: 'wsl:Ubuntu' }, 'darwin'), 'local')
  assert.equal(route({ environment: { kind: 'ssh', id: 'm1' } }, 'linux'), 'ssh:m1')
})

test("a chat's address today: this desktop's for every record it holds, the paired desktop's for one born there", () => {
  const environments = {
    local: LOCAL_ID,
    ofRoute: (route: Parameters<typeof formatEnvironmentRoute>[0]) =>
      formatEnvironmentRoute(route) === 'tailnet:tnc_1' ? PAIRED_ID : null,
  }
  // Local, WSL and SSH chats are all this desktop's records today.
  for (const workspace of [{ id: 'ws_local' }, { id: 'ws_wsl' }, { id: 'ws_ssh' }])
    assert.deepEqual(chatAddressOfWorkspace(workspace, environments), { environmentId: LOCAL_ID, chatId: workspace.id })
  // A row born on a paired desktop is that desktop's chat, under its id there.
  assert.deepEqual(
    chatAddressOfWorkspace(
      { id: 'ws_row', remoteOrigin: { connectionId: 'tnc_1', workspaceId: 'ws_there' } },
      environments,
    ),
    { environmentId: PAIRED_ID, chatId: 'ws_there' },
  )
  // A paired desktop that has not said its id yet has no address.
  assert.equal(
    chatAddressOfWorkspace(
      { id: 'ws_row', remoteOrigin: { connectionId: 'tnc_2', workspaceId: 'ws_there' } },
      environments,
    ),
    null,
  )
  // The remote chat key (`<pairing>:<chat>`) maps onto the same address.
  assert.equal(remoteChatKey('tnc_1', 'ws_there'), 'tnc_1:ws_there')
  const key = chatAddressKeyOfRemoteChat('tnc_1', 'ws_there', environments.ofRoute)
  assert.deepEqual(parseChatAddress(key), { environmentId: PAIRED_ID, chatId: 'ws_there' })
  assert.equal(chatAddressKeyOfRemoteChat('tnc_2', 'ws_there', environments.ofRoute), null)
})

test("today's records are sources, and each machine's mark id follows from its source", () => {
  const local = localEnvironmentSource(LOCAL_ID, 'darwin')
  assert.deepEqual(local, {
    route: { kind: 'local' },
    displayName: 'This Mac',
    machine: { kind: 'local' },
    environmentId: LOCAL_ID,
  })
  assert.equal(machineIdOf(local.machine), null)

  const hosts = {
    [wslHostId('Ubuntu')]: { ...emptyExecutionHostSettings(), enabled: true },
    [wslHostId('Debian')]: { ...emptyExecutionHostSettings(), enabled: false },
    [LOCAL_HOST_ID]: { ...emptyExecutionHostSettings(), enabled: true },
  }
  const wsl = wslEnvironmentSources(hosts, 'win32')
  assert.deepEqual(
    wsl.map((source) => [formatEnvironmentRoute(source.route), source.displayName, machineIdOf(source.machine)]),
    [['wsl:Ubuntu', 'WSL: Ubuntu', 'wsl:Ubuntu']],
  )
  assert.deepEqual(wslEnvironmentSources(hosts, 'darwin'), [], 'no WSL off Windows')

  const ssh = sshEnvironmentSource({
    id: 'ssh_k3J9x',
    label: 'Build box',
    destination: 'dev@build-box',
    resolved: { hostname: 'build-box.example.ts.net', user: 'dev', port: 2222, proxyJump: null },
    environmentId: PAIRED_ID,
  })
  assert.equal(formatEnvironmentRoute(ssh.route), 'ssh:ssh_k3J9x')
  assert.equal(ssh.displayName, 'Build box')
  assert.equal(ssh.environmentId, PAIRED_ID)
  assert.equal(machineIdOf(ssh.machine), 'ssh:build-box.example.ts.net:2222')
  const unresolved = sshEnvironmentSource({
    id: 'm2',
    label: 'm2',
    destination: 'dev@mac-mini',
    resolved: null,
    environmentId: null,
  })
  assert.equal(machineIdOf(unresolved.machine), 'ssh:mac-mini')
  assert.equal(unresolved.environmentId, null)

  const paired = meshEnvironmentSource({
    id: 'tnc_1',
    machineName: 'mac-mini.example.ts.net',
    environmentId: PAIRED_ID,
  })
  assert.equal(formatEnvironmentRoute(paired.route), 'tailnet:tnc_1')
  assert.equal(paired.environmentId, PAIRED_ID)
  assert.equal(machineIdOf(paired.machine), 'tailnet:mac-mini')
  assert.equal(meshEnvironmentSource({ id: 'tnc_2', machineName: 'build-box' }).environmentId, null)
})
