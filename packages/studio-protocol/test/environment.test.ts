import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  ENVIRONMENT_ROUTE_KINDS,
  environmentDescriptorOf,
  formatChatAddress,
  formatEnvironmentRoute,
  isChatAddress,
  isEnvironmentId,
  isEnvironmentRoute,
  orderEnvironmentRoutes,
  parseChatAddress,
  parseEnvironmentRoute,
  sameChatAddress,
  sameEnvironmentRoute,
  type EnvironmentRoute,
} from '../src/environment'
import { relayedEnvironmentsOf } from '../src/environment-access'

const ENV = '6f1c2a9e-4b7d-4e2f-9a1b-0c3d5e7f9a1b'

test('an environment id is what a Studio mints, and nothing an address key could not carry', () => {
  assert.equal(isEnvironmentId(ENV), true)
  assert.equal(isEnvironmentId('env-test'), true)
  for (const bad of ['', 'a:b', 'a/b', 'a b', 'x'.repeat(129), 42, null, undefined])
    assert.equal(isEnvironmentId(bad), false, String(bad))
})

test('a descriptor is the welcome under the name the client gives it', () => {
  const welcome = {
    protocolVersion: 1,
    minProtocolVersion: 1,
    server: { name: 'SprintEngine Studio', version: '0.40.0' },
    environment: { id: ENV, hostKind: 'wsl' as const, os: 'linux', arch: 'x64' },
    capabilities: ['conversations', 'conversation-create'],
  }
  const descriptor = environmentDescriptorOf(welcome, 'WSL: Ubuntu')
  assert.deepEqual(descriptor, {
    environmentId: ENV,
    kind: 'wsl',
    displayName: 'WSL: Ubuntu',
    serverVersion: '0.40.0',
    protocolVersion: 1,
    minProtocolVersion: 1,
    capabilities: ['conversations', 'conversation-create'],
  })
  // A copy: the welcome's list is not shared.
  descriptor.capabilities.push('x')
  assert.equal(welcome.capabilities.length, 2)
})

test('every route round-trips through its string', () => {
  const routes: EnvironmentRoute[] = [
    { kind: 'local' },
    { kind: 'wsl', distro: 'Ubuntu-22.04' },
    { kind: 'ssh', machine: 'ssh_k3J9x' },
    { kind: 'tailnet', connection: 'mesh-4f2a' },
  ]
  const strings = routes.map(formatEnvironmentRoute)
  assert.deepEqual(strings, ['local', 'wsl:Ubuntu-22.04', 'ssh:ssh_k3J9x', 'tailnet:mesh-4f2a'])
  assert.deepEqual(strings.map(parseEnvironmentRoute), routes)
})

test('a route string that names nothing is not a route, and formatting one throws', () => {
  for (const bad of ['', 'Local', 'wsl:', 'wsl:two words', 'ssh:a/b', 'ssh:a:b', 'tailnet:', 'lan:1.2.3.4', 'wsl', 7])
    assert.equal(parseEnvironmentRoute(bad), null, String(bad))
  assert.throws(() => formatEnvironmentRoute({ kind: 'ssh', machine: 'a/b' }))
  // A record read from disk is checked whole: a missing field is not the word "undefined".
  for (const bad of [null, 7, {}, { kind: 'wsl' }, { kind: 'ssh', machine: 5 }, { kind: 'lan', host: 'x' }])
    assert.equal(isEnvironmentRoute(bad), false, JSON.stringify(bad))
  assert.equal(isEnvironmentRoute({ kind: 'tailnet', connection: 'tnc_1' }), true)
  assert.throws(() => formatEnvironmentRoute({ kind: 'wsl', distro: '' }))
})

test('routes are ordered this machine, WSL, tailnet, SSH, relay, keeping the order within a kind and each once', () => {
  assert.deepEqual([...ENVIRONMENT_ROUTE_KINDS], ['local', 'wsl', 'tailnet', 'ssh', 'relay'])
  const given: EnvironmentRoute[] = [
    { kind: 'relay', via: 't1', environment: 'env-b' },
    { kind: 'ssh', machine: 'b' },
    { kind: 'tailnet', connection: 't2' },
    { kind: 'ssh', machine: 'a' },
    { kind: 'wsl', distro: 'Ubuntu' },
    { kind: 'tailnet', connection: 't1' },
    { kind: 'local' },
    { kind: 'ssh', machine: 'b' },
  ]
  const before = JSON.stringify(given)
  assert.deepEqual(orderEnvironmentRoutes(given).map(formatEnvironmentRoute), [
    'local',
    'wsl:Ubuntu',
    'tailnet:t2',
    'tailnet:t1',
    'ssh:b',
    'ssh:a',
    'relay:t1.env-b',
  ])
  assert.equal(JSON.stringify(given), before, 'the input is not sorted in place')
  assert.equal(sameEnvironmentRoute({ kind: 'ssh', machine: 'a' }, { kind: 'ssh', machine: 'a' }), true)
  assert.equal(sameEnvironmentRoute({ kind: 'ssh', machine: 'a' }, { kind: 'tailnet', connection: 'a' }), false)
})

test('a chat address round-trips through its key, and the key has exactly one colon', () => {
  const address = { environmentId: ENV, chatId: 'ws_8fK2' }
  const key = formatChatAddress(address)
  assert.equal(key, `${ENV}:ws_8fK2`)
  assert.deepEqual(parseChatAddress(key), address)
  assert.equal(sameChatAddress(address, { ...address }), true)
  assert.equal(sameChatAddress(address, { ...address, chatId: 'other' }), false)
  for (const bad of ['', ENV, `${ENV}:`, `:chat`, `${ENV}:a:b`, `${ENV}:a/b`, 5, null])
    assert.equal(parseChatAddress(bad), null, String(bad))
  assert.equal(isChatAddress({ environmentId: ENV }), false)
  assert.throws(() => formatChatAddress({ environmentId: 'a:b', chatId: 'c' }))
})

test('a relay route names the pairing it goes through and the machine it reaches, and reads back the same', () => {
  const route: EnvironmentRoute = { kind: 'relay', via: 'pair-1', environment: '0b9f-4c' }
  assert.equal(formatEnvironmentRoute(route), 'relay:pair-1.0b9f-4c')
  assert.deepEqual(parseEnvironmentRoute('relay:pair-1.0b9f-4c'), route)
  for (const bad of ['relay:', 'relay:pair-1', 'relay:.env', 'relay:pair-1.', 'relay:a.b.c', 'relay:a b.c'])
    assert.equal(parseEnvironmentRoute(bad), null, bad)
  assert.ok(sameEnvironmentRoute(route, { kind: 'relay', via: 'pair-1', environment: '0b9f-4c' }))
  assert.ok(!sameEnvironmentRoute(route, { kind: 'relay', via: 'pair-2', environment: '0b9f-4c' }))
})

test("a desktop's relayed list is read as a client may use it: an entry that cannot be a route is dropped, the rest kept", () => {
  const BOX = '7d1e2f30-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
  const DISTRO = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
  const answer = {
    environments: [
      {
        environmentId: BOX,
        name: 'build-box',
        kind: 'ssh',
        connected: true,
        machine: { host: 'build-box', port: 22 },
        mark: { kind: 'server', color: 'teal' },
      },
      // A dot would split the route; a slash would leave the socket path.
      { environmentId: 'a.b', name: 'dotted', kind: 'ssh', connected: true },
      { environmentId: '../x', name: 'climbing', kind: 'ssh', connected: true },
      { environmentId: ENV, name: '', kind: 'ssh', connected: true },
      { environmentId: DISTRO, name: 'other kind', kind: 'docker', connected: true },
      { environmentId: BOX, name: 'twice', kind: 'ssh', connected: true },
      { environmentId: ENV, name: 'half a mark', kind: 'ssh', connected: 'yes', mark: { kind: 'server' } },
      // A WSL distribution the desktop runs.
      { environmentId: DISTRO, name: 'WSL: Ubuntu', kind: 'wsl', connected: true },
      null,
      'build-box',
    ],
  }
  assert.deepEqual(relayedEnvironmentsOf(answer), [
    { environmentId: BOX, name: 'build-box', kind: 'ssh', connected: true, mark: { kind: 'server', color: 'teal' } },
    { environmentId: ENV, name: 'half a mark', kind: 'ssh', connected: false },
    { environmentId: DISTRO, name: 'WSL: Ubuntu', kind: 'wsl', connected: true },
  ])
  for (const bad of [null, {}, { environments: 'all' }, []]) assert.deepEqual(relayedEnvironmentsOf(bad), [])
})
