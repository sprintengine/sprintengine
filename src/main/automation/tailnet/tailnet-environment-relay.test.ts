import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect as connectTcp } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'

import { afterEach, test } from 'vitest'

import {
  connect,
  webSocketTransport,
  type StudioClient,
  type StudioWebSocketConstructor,
} from '../../../../packages/client-runtime/src/public'
import { createFakeAuthenticator, createFakeBackend } from '../../../server/rpc/studio-rpc.test-helper'
import { createStudioRpcServer } from '../../../server/rpc/studio-rpc-server'
import { createStudioWindowListener } from '../../../server/rpc/studio-window-listener'
import type { TailnetScope } from '../../../shared/tailnet'
import { createTailnetDeviceStore } from './tailnet-devices'
import { createTailnetGatewayServer } from './tailnet-gateway-server'
import { TAILNET_STUDIO_PATH, TAILNET_WS_TICKET_PATH } from './tailnet-routes'
import type { TailnetEnvironmentRelay } from './tailnet-studio-endpoint'
import { refusalOf, until } from './tailnet-studio.test-helper'

// A paired device reaching a machine this desktop holds behind its front door
// (an SSH machine's server), through this desktop's tailnet listener: the
// device proves itself here, the machine mints its ticket with the device's
// grant cut to the relayed ceiling, and the socket is carried to the
// machine's own listener. The machine is a real Studio server and window
// listener on loopback; the front door's `ws` stream is a TCP connection to
// that listener, which is what the relay's stream ends in.

const MACHINE = 'env-build-box'
const OTHER = 'env-elsewhere'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** An upgrade by hand, answered with its status: 101 once the machine has answered the handshake. */
function upgradeStatus(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...headers,
      },
    })
    req.on('response', (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    req.on('upgrade', (_response, socket) => {
      socket.destroy()
      resolve(101)
    })
    req.on('error', reject)
    req.end()
  })
}

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-relay-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const devices = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
  // The machine's Studio, and its window listener serving relayed devices.
  const machine = createStudioRpcServer({
    dataDir: '/nonexistent/relayed-machine',
    version: '0.0.0-test',
    environmentId: MACHINE,
    hostKind: 'ssh',
    backend: createFakeBackend(['agent-1']),
    authenticator: createFakeAuthenticator(),
  })
  const listener = createStudioWindowListener({
    attach: (stream, authenticator) => machine.attach(stream, { authenticator, ownWindow: true }),
    attachDevice: (stream, authenticator) =>
      machine.attach(stream, { authenticator, ownWindow: false, audited: true, knownFoldersOnly: true }),
  })
  cleanups.push(async () => {
    await machine.stop(1)
    await listener.stop()
  })
  const asked: unknown[] = []
  const relay: TailnetEnvironmentRelay = {
    async ticket(environmentId, device) {
      asked.push({ environmentId, ...device })
      if (environmentId !== MACHINE) return { ok: false, code: 'unknown_route', message: 'No such machine here.' }
      const minted = await listener.deviceTicket(device)
      const url = new URL(minted.url)
      return { ok: true, token: minted.token, path: `${url.pathname}${url.search}` }
    },
    async open() {
      const port = Number(new URL(listener.address()!).port)
      const socket = connectTcp({ host: '127.0.0.1', port })
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      return socket as Duplex
    },
  }
  const gateway = createTailnetGatewayServer({
    bindAddress: '127.0.0.1',
    port: 0,
    serverName: 'sprintengine-studio',
    serverVersion: '9.9.9',
    resolveTools: () => [],
    isMutation: () => false,
    devices,
    peers: { identify: async () => null, resolve: async () => null },
    environments: () => relay,
  })
  await gateway.start()
  cleanups.push(() => gateway.stop())
  const port = () => gateway.address()!.port
  const NodeWebSocket = (globalThis as unknown as { WebSocket: StudioWebSocketConstructor }).WebSocket

  const askTicket = async (token: string, environmentId: string) => {
    const response = await fetch(`http://127.0.0.1:${port()}${TAILNET_WS_TICKET_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ environmentId }),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }

  return {
    devices,
    asked,
    askTicket,
    port,
    pair(scopes: TailnetScope[]) {
      const minted = devices.mintDevice({ name: 'android-phone', scopes, origin: { kind: 'code', by: null } })
      return { id: minted.device.id, token: minted.deviceToken }
    },
    /** The phone's client of the machine, through this desktop. */
    async client(token: string, options: { path?: (studioPath: string) => string } = {}): Promise<StudioClient> {
      const client = await connect({
        client: { name: 'Phone' },
        transport: webSocketTransport({
          WebSocket: NodeWebSocket,
          ticket: async () => {
            const { status, body } = await askTicket(token, MACHINE)
            if (typeof body.ticket !== 'string' || typeof body.studioPath !== 'string')
              throw new Error(`ticket refused: ${status}`)
            const path = options.path ? options.path(body.studioPath) : body.studioPath
            return {
              url: `ws://127.0.0.1:${port()}${path}?ticket=${encodeURIComponent(body.ticket)}`,
              token: body.ticket,
            }
          },
        }),
        reconnect: false,
      })
      cleanups.push(() => client.close())
      return client
    },
  }
}

test('a paired device reaches the machine through this desktop, as itself, never as an owner, and never to a terminal', async () => {
  const relay = await rig()
  const phone = relay.pair(['conversation:read', 'conversation:operate', 'workspace:read', 'backlog:operate'])
  const client = await relay.client(phone.token)
  assert.equal(client.welcome.environment.id, MACHINE)
  assert.equal(client.grant.owner, false)
  assert.equal(client.grant.clientId, `relay:${phone.id}`)
  // Its scopes here, cut to the relayed ceiling: the backlog stays on the desktop.
  assert.deepEqual(client.grant.scopes, [
    'conversation:read',
    'conversation:operate',
    'conversation:create',
    'workspaces:read',
  ])
  assert.deepEqual(relay.asked, [
    {
      environmentId: MACHINE,
      deviceId: phone.id,
      name: 'android-phone',
      scopes: ['conversation:read', 'conversation:operate', 'conversation:create', 'workspaces:read'],
    },
  ])
  await client.request('conversation.list', {})
  // The owner ruling: a phone reaching an SSH chat gets no terminal.
  assert.equal(await refusalOf(client.request('terminal.list', {})), 'owner_required')
  assert.equal(await refusalOf(client.request('terminal.open', { cwd: '/home/dev' } as never)), 'owner_required')
  assert.equal(
    await refusalOf(client.request('environment.windowTicket', { windowKey: 'w', origin: 'file://' })),
    'owner_required',
  )
})

test('a read-only pairing follows the machine’s chats but may not drive them; one that may not read is given no ticket', async () => {
  const relay = await rig()
  const reader = relay.pair(['conversation:read'])
  const client = await relay.client(reader.token)
  assert.deepEqual(client.grant.scopes, ['conversation:read'])
  await client.request('conversation.list', {})
  assert.equal(
    await refusalOf(
      client.request('conversation.send', {
        key: { workspaceId: 'ws-1', agentId: 'agent-1' },
        commandId: 'c1',
        message: 'hello',
      } as never),
    ),
    'scope_required',
  )

  const backlogOnly = relay.pair(['backlog:read'])
  const refused = await relay.askTicket(backlogOnly.token, MACHINE)
  assert.equal(refused.status, 403)
  assert.equal(relay.asked.length, 1, 'the machine was never asked for that device')
})

test('a revoked device is refused, and a device whose grant changes is carried again with its new one', async () => {
  const relay = await rig()
  const phone = relay.pair(['conversation:read', 'conversation:operate'])
  const client = await relay.client(phone.token)
  await client.request('conversation.list', {})

  relay.devices.updateDeviceScopes(phone.id, ['conversation:read'])
  await until(() => client.state !== 'open', 'the relayed socket to close on a narrowed grant')
  const narrowed = await relay.client(phone.token)
  assert.deepEqual(narrowed.grant.scopes, ['conversation:read'])

  relay.devices.revokeDevice(phone.id)
  await until(() => narrowed.state !== 'open', 'the relayed socket to close on a revoke')
  const after = await relay.askTicket(phone.token, MACHINE)
  assert.equal(after.status, 401)
})

test('a machine ticket opens that machine’s path only, and this desktop’s own ticket opens none of a machine’s', async () => {
  const relay = await rig()
  const phone = relay.pair(['conversation:read'])
  // A machine this desktop does not hold.
  const unknown = await relay.askTicket(phone.token, OTHER)
  assert.equal(unknown.status, 404)
  // A machine's ticket on another machine's path, or on this desktop's own Studio path: refused, and spent.
  const elsewhere = await relay.askTicket(phone.token, MACHINE)
  const otherPath = String(elsewhere.body.studioPath).replace(MACHINE, OTHER)
  assert.equal(await upgradeStatus(relay.port(), `${otherPath}?ticket=${elsewhere.body.ticket}`), 401)
  assert.equal(await upgradeStatus(relay.port(), `${elsewhere.body.studioPath}?ticket=${elsewhere.body.ticket}`), 401)
  const own = await relay.askTicket(phone.token, MACHINE)
  assert.equal(await upgradeStatus(relay.port(), `${TAILNET_STUDIO_PATH}?ticket=${own.body.ticket}`), 401)
  // A page in a browser says its origin, which no ticket for the phone named.
  const fromPage = await relay.askTicket(phone.token, MACHINE)
  assert.equal(
    await upgradeStatus(relay.port(), `${fromPage.body.studioPath}?ticket=${fromPage.body.ticket}`, {
      Origin: 'https://example.com',
    }),
    403,
  )
  // The good one, presented as it was minted, opens.
  const good = await relay.askTicket(phone.token, MACHINE)
  assert.equal(await upgradeStatus(relay.port(), `${good.body.studioPath}?ticket=${good.body.ticket}`), 101)
  // An environment id that is not one.
  const bad = await relay.askTicket(phone.token, '../etc')
  assert.equal(bad.status, 400)
})
