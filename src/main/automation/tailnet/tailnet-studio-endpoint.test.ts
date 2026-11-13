import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect as connectTcp } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import {
  connect,
  webSocketTransport,
  type ConversationEventStream,
  type ConversationFollowFrame,
  type StudioClient,
  type StudioClientState,
  type StudioWebSocketConstructor,
} from '../../../../packages/client-runtime/src/public'
import { createFakeBackend, startTestServer } from '../../../server/rpc/studio-rpc.test-helper'
import type { StudioDiscovery } from '../../../server/rpc/studio-rpc-types'
import type { TailnetScope } from '../../../shared/tailnet'
import { createTailnetDeviceStore, type TailnetDeviceStore } from './tailnet-devices'
import { createTailnetGatewayServer, type TailnetGatewayServer } from './tailnet-gateway-server'
import { TAILNET_STUDIO_PATH, TAILNET_WS_TICKET_PATH } from './tailnet-routes'
import { isDesktopWindowOrigin, tailnetDeviceGrant } from './tailnet-studio-endpoint'

// A paired device on the Studio protocol: the real tailnet listener on
// loopback, handing its socket to a real Studio server over a fake
// conversation backend, and the shared client runtime on the other end, as
// the phone and a paired desktop's window run it.

const ref = { workspaceId: 'ws-1', agentId: 'agent-1' }
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Rig = {
  gateway: TailnetGatewayServer
  devices: TailnetDeviceStore
  studio: Awaited<ReturnType<typeof startTestServer>>
  port(): number
  /** Pair a device with these scopes; answers its token. */
  pair(scopes: TailnetScope[], name?: string): { id: string; token: string }
  restartGateway(): Promise<void>
}

/** What the gateway's tools would answer, as the core gives it (src/server/core/studio-discovery.ts). */
const DISCOVERY: StudioDiscovery = {
  workspaces: async () => [{ id: 'ws-1', name: 'App', folderPath: '/Users/dev/app', projectHue: 210 }],
  runtimes: async (cli) =>
    cli && cli !== 'claude'
      ? { ok: false, code: 'not_found', message: `No agent CLI "${cli}" is registered in this app.` }
      : { ok: true, value: { clis: [{ id: 'claude', agentSelectable: true, conversational: true }] } },
  checkout: async (workspaceId) =>
    workspaceId === 'ws-1'
      ? { ok: true, value: { workspaceId, git: true, branch: 'main', worktrees: [] } }
      : { ok: false, code: 'not_found', message: 'That workspace is not open here.' },
  extensions: async (workspaceId, cli) => ({
    ok: true,
    value: { workspaceId, skills: [{ id: 'review' }], ...(cli ? { servers: [] } : {}) },
  }),
}

async function rig(clock: { now: number } | null = null): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-studio-'))
  const devices = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
  const studio = await startTestServer({ backend: createFakeBackend(['agent-1']), discovery: DISCOVERY })
  const build = (port: number) =>
    createTailnetGatewayServer({
      bindAddress: '127.0.0.1',
      port,
      serverName: 'sprintengine-studio',
      serverVersion: '9.9.9',
      resolveTools: () => [],
      isMutation: () => false,
      devices,
      peers: { identify: async () => null, resolve: async () => null },
      ...(clock ? { now: () => clock.now } : {}),
      // As the core links it (src/server/core/studio-rpc.ts → connectDevice).
      studio: () => ({
        attach: (stream, authenticator) =>
          void studio.server.attach(stream, { authenticator, ownWindow: false, audited: true, knownFoldersOnly: true }),
      }),
    })
  let gateway = build(0)
  await gateway.start()
  const state = {
    get gateway() {
      return gateway
    },
    devices,
    studio,
    port: () => gateway.address()!.port,
    pair(scopes: TailnetScope[], name = 'android-phone') {
      const minted = devices.mintDevice({ name, scopes, origin: { kind: 'code', by: null } })
      return { id: minted.device.id, token: minted.deviceToken }
    },
    async restartGateway() {
      const port = gateway.address()!.port
      await gateway.stop()
      gateway = build(port)
      await gateway.start()
    },
  }
  cleanups.push(async () => {
    await gateway.stop()
    await studio.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  return state as Rig
}

async function ticketFor(port: number, token: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${TAILNET_WS_TICKET_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as { ticket?: string; error?: { code: string } } }
}

/** Node's WebSocket, saying this origin (or none). */
function socketSaying(origin: string | null): StudioWebSocketConstructor {
  const NodeWebSocket = (globalThis as unknown as { WebSocket: new (url: string, init?: unknown) => unknown }).WebSocket
  return class {
    constructor(url: string) {
      return new NodeWebSocket(url, origin === null ? undefined : { headers: { origin } }) as never
    }
  } as unknown as StudioWebSocketConstructor
}

async function deviceClient(
  r: Rig,
  token: string,
  options: { origin?: string; states?: StudioClientState[] } = {},
): Promise<StudioClient> {
  const client = await connect({
    client: { name: 'Phone' },
    transport: webSocketTransport({
      WebSocket: socketSaying(options.origin ?? null),
      ticket: async () => {
        const minted = await ticketFor(r.port(), token, options.origin ? { origin: options.origin } : {})
        if (!minted.body.ticket) throw new Error(`ticket refused: ${minted.status}`)
        return {
          url: `ws://127.0.0.1:${r.port()}${TAILNET_STUDIO_PATH}?ticket=${encodeURIComponent(minted.body.ticket)}`,
          token: minted.body.ticket,
        }
      },
    }),
    reconnect: { initialDelayMs: 20, maxDelayMs: 100 },
    ...(options.states ? { onStateChange: (state: StudioClientState) => options.states!.push(state) } : {}),
  })
  cleanups.push(() => client.close())
  return client
}

/** An upgrade by hand, for what a client library would not send: the status line it is answered with. */
function rawUpgrade(port: number, path: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, '127.0.0.1', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        '',
        '',
      ]
      socket.write(lines.join('\r\n'))
    })
    let heard = ''
    socket.on('data', (chunk) => {
      heard += chunk.toString('utf8')
      if (heard.includes('\r\n')) {
        resolve(heard.split('\r\n')[0]!)
        socket.destroy()
      }
    })
    socket.on('error', reject)
  })
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    return (error as { code?: string }).code ?? String(error)
  }
  return 'answered'
}

async function read(
  stream: ConversationEventStream,
  until: (frame: ConversationFollowFrame) => boolean,
): Promise<ConversationFollowFrame[]> {
  const seen: ConversationFollowFrame[] = []
  for (;;) {
    const step = await stream.next()
    if (step.done) return seen
    seen.push(step.value)
    if (until(step.value)) return seen
  }
}
const seqs = (frames: ConversationFollowFrame[]) =>
  frames.map((frame) =>
    frame.type === 'event' ? frame.event.seq : frame.type === 'synchronized' ? 'fence' : 'snapshot',
  )

async function until(check: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 300; tries++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(`timed out waiting for ${what}`)
}

test('a device is never an owner, and its scopes carry only the chat, workspace and backlog reach it was paired with', () => {
  const base = { id: 'd1', name: 'android-phone', createdAt: '', lastSeenAt: null, origin: { kind: 'code', by: null } }
  const full = tailnetDeviceGrant({
    ...base,
    scopes: ['workspace:operate', 'backlog:operate', 'conversation:operate'],
  } as never)
  assert.equal(full.owner, false)
  assert.deepEqual([...full.scopes].sort(), [
    'backlog:operate',
    'backlog:read',
    'conversation:create',
    'conversation:operate',
    'conversation:read',
    'workspaces:operate',
    'workspaces:read',
  ])
  const reading = tailnetDeviceGrant({ ...base, scopes: ['conversation:read', 'workspace:read'] } as never)
  assert.deepEqual([...reading.scopes].sort(), ['conversation:read', 'workspaces:read'])
  // A retired terminal scope a stored device still names carries nothing.
  assert.deepEqual(tailnetDeviceGrant({ ...base, scopes: ['terminal:control'] } as never).scopes, [])
})

test('only a desktop window’s origin may be named on a ticket', () => {
  assert.equal(isDesktopWindowOrigin('file://'), true)
  assert.equal(isDesktopWindowOrigin('http://localhost:5173'), true)
  assert.equal(isDesktopWindowOrigin('http://127.0.0.1:5173'), true)
  for (const origin of [
    'null',
    'https://example.com',
    'http://localhost',
    'http://localhost:5173/',
    'http://evil.example:5173',
    'file:///Users/dev',
  ])
    assert.equal(isDesktopWindowOrigin(origin), false, origin)
})

test('a paired device reads and starts chats over the Studio protocol, with its own grant', async () => {
  const r = await rig()
  const phone = r.pair(['workspace:read', 'conversation:operate'])
  const client = await deviceClient(r, phone.token)
  assert.equal(client.grant.owner, false)
  assert.equal(client.grant.clientId, `tailnet:${phone.id}`)
  assert.ok((await client.rpc['conversation.list']({})).conversations.length >= 1)
  assert.deepEqual(
    (await client.rpc['workspaces.list']({})).workspaces.map((workspace) => workspace.id),
    ['ws-1'],
  )
  const created = await client.rpc['conversation.create']({ workspaceId: 'ws-1', prompt: 'hi', commandId: 'c-1' })
  assert.equal(created.conversation.workspaceId, 'ws-1')
  assert.equal(r.studio.backend.creates.length, 1)
  // Owner-only and unscoped surfaces stay shut: no other device reaches a
  // terminal here, and its scopes carry no filesystem.
  assert.equal(await refusal(client.request('terminal.list', {})), 'owner_required')
  assert.equal(await refusal(client.request('files.stat', { path: '/' })), 'scope_required')
  // Nor does it start or stop a program here, or change which tools an agent
  // may call (the whole table is tailnet-device-reach.test.ts).
  const server = { conversation: ref, id: 'srv-1' }
  assert.equal(await refusal(client.request('localServers.run', server)), 'owner_required')
  assert.equal(await refusal(client.request('localServers.stop', server)), 'owner_required')
  assert.equal(await refusal(client.request('localServers.list', {})), 'owner_required')
  assert.equal(
    await refusal(client.request('tools.grant', { key: ref, toolset: 'acme', granted: true, commandId: 'g-1' })),
    'scope_required',
  )
})

test('a device reads what New needs before it starts a chat: CLIs, a checkout, a project’s skills', async () => {
  const r = await rig()
  const phone = r.pair(['workspace:read', 'conversation:operate'])
  const client = await deviceClient(r, phone.token)
  assert.equal(client.supports('workspaces'), true)
  assert.deepEqual(
    (await client.rpc['cliRuntimes.list']({})).clis.map((cli) => cli.id),
    ['claude'],
  )
  assert.equal(await refusal(client.rpc['cliRuntimes.list']({ cli: 'nope' })), 'not_found')
  assert.equal((await client.rpc['workspaces.checkout']({ workspaceId: 'ws-1' })).branch, 'main')
  assert.equal(await refusal(client.rpc['workspaces.checkout']({ workspaceId: 'ws-9' })), 'not_found')
  assert.deepEqual(
    (await client.rpc['workspaces.extensions']({ workspaceId: 'ws-1', cli: 'claude' })).skills.map((skill) => skill.id),
    ['review'],
  )
  // A device paired without the workspace scopes reads none of them.
  const chatsOnly = await deviceClient(r, r.pair(['conversation:operate'], 'build-box').token)
  for (const ask of [
    () => chatsOnly.rpc['cliRuntimes.list']({}),
    () => chatsOnly.rpc['workspaces.checkout']({ workspaceId: 'ws-1' }),
    () => chatsOnly.rpc['workspaces.extensions']({ workspaceId: 'ws-1' }),
  ])
    assert.equal(await refusal(ask()), 'scope_required')
})

test('a read-only device follows but may neither drive nor start a chat', async () => {
  const r = await rig()
  const phone = r.pair(['conversation:read'])
  const client = await deviceClient(r, phone.token)
  assert.ok((await client.rpc['conversation.list']({})).conversations.length >= 1)
  assert.equal(
    await refusal(client.rpc['conversation.create']({ workspaceId: 'ws-1', commandId: 'c-1' })),
    'scope_required',
  )
  assert.equal(
    await refusal(client.conversations.send(ref, { message: 'hello', commandId: 'send-1' }).then(assertRefused)),
    'scope_required',
  )
  assert.equal(await refusal(client.rpc['workspaces.list']({})), 'scope_required')
  assert.equal(r.studio.backend.creates.length, 0)
})

/** A conversation command answers its refusal; read it as one. */
function assertRefused(result: { ok: true } | { ok: false; code: string }): never {
  throw Object.assign(new Error('refused'), { code: result.ok ? 'answered' : result.code })
}

test('a narrowed pairing applies to the next request, and a removed one closes the connection', async () => {
  const r = await rig()
  const phone = r.pair(['workspace:read', 'conversation:operate'])
  const states: StudioClientState[] = []
  const client = await deviceClient(r, phone.token, { states })
  assert.ok(await client.rpc['workspaces.list']({}))
  r.devices.updateDeviceScopes(phone.id, ['conversation:read'])
  assert.equal(await refusal(client.rpc['workspaces.list']({})), 'scope_required')
  assert.equal(
    await refusal(client.rpc['conversation.create']({ workspaceId: 'ws-1', commandId: 'c-2' })),
    'scope_required',
  )
  r.devices.revokeDevice(phone.id)
  await until(() => client.state !== 'open', 'the revoked connection to close')
  // Its token mints no ticket any more, so nothing opens again.
  assert.equal((await ticketFor(r.port(), phone.token)).status, 401)
  assert.ok(!states.slice(-1).includes('open'))
})

test('a dropped device socket comes back and resumes its chat by cursor: no gap, no repeat', async () => {
  const r = await rig()
  const phone = r.pair(['conversation:read'])
  const states: StudioClientState[] = []
  const client = await deviceClient(r, phone.token, { states })
  r.studio.backend.emit('agent-1', 'content_delta', { text: 'a' })
  const stream = client.conversation(ref).events()
  cleanups.push(() => stream.close())
  assert.deepEqual(seqs(await read(stream, (frame) => frame.type === 'synchronized')), ['snapshot', 'fence'])
  r.studio.backend.emit('agent-1', 'turn_started')
  assert.deepEqual(seqs(await read(stream, () => true)), [2])

  // The listener goes (the phone backgrounded, Tailscale dropped); events
  // happen while it is away; it comes back on the same address.
  await r.restartGateway()
  r.studio.backend.emit('agent-1', 'content_delta', { text: 'b' })
  r.studio.backend.emit('agent-1', 'turn_completed')
  const after = await read(stream, (frame) => frame.type === 'synchronized')
  assert.deepEqual(seqs(after), [3, 4, 'fence'])
  assert.ok(states.includes('reconnecting'))
  r.studio.backend.emit('agent-1', 'turn_started')
  assert.deepEqual(seqs(await read(stream, () => true)), [5])
})

test('a desktop window’s socket says exactly the origin its ticket names, and no other socket says one', async () => {
  const r = await rig()
  const desktop = r.pair(['workspace:read', 'conversation:operate'], 'dev-macbook-air')
  // The window's ticket names its origin, and its socket opens with it.
  const window = await deviceClient(r, desktop.token, { origin: 'file://' })
  assert.equal(window.grant.owner, false)
  assert.ok(await window.rpc['workspaces.list']({}))

  // A web page's origin cannot be named.
  assert.equal((await ticketFor(r.port(), desktop.token, { origin: 'https://example.com' })).status, 400)
  // A ticket for one origin does not open a socket that says another, or none.
  const forWindow = (await ticketFor(r.port(), desktop.token, { origin: 'file://' })).body.ticket!
  assert.match(
    await rawUpgrade(r.port(), `${TAILNET_STUDIO_PATH}?ticket=${forWindow}`, { Origin: 'http://localhost:5173' }),
    / 403 /u,
  )
  const forWindowAgain = (await ticketFor(r.port(), desktop.token, { origin: 'file://' })).body.ticket!
  assert.match(await rawUpgrade(r.port(), `${TAILNET_STUDIO_PATH}?ticket=${forWindowAgain}`), / 403 /u)
  // A ticket that names none does not open a socket that says one.
  const plain = (await ticketFor(r.port(), desktop.token)).body.ticket!
  assert.match(await rawUpgrade(r.port(), `${TAILNET_STUDIO_PATH}?ticket=${plain}`, { Origin: 'file://' }), / 403 /u)
  // And a window's ticket opens nothing but the Studio socket.
  const elsewhere = (await ticketFor(r.port(), desktop.token, { origin: 'file://' })).body.ticket!
  assert.match(await rawUpgrade(r.port(), `/tailnet/v1/stream?ticket=${elsewhere}`, { Origin: 'file://' }), / 403 /u)
  // A ticket is good once.
  const once = (await ticketFor(r.port(), desktop.token)).body.ticket!
  assert.match(await rawUpgrade(r.port(), `${TAILNET_STUDIO_PATH}?ticket=${once}`), / 101 /u)
  assert.match(await rawUpgrade(r.port(), `${TAILNET_STUDIO_PATH}?ticket=${once}`), / 401 /u)
})

test('the phone’s socket says an empty Origin, which is none; a ticket is good for thirty seconds', async () => {
  const clock = { now: Date.now() }
  const r = await rig(clock)
  const phone = r.pair(['conversation:read'])
  // React Native, told to say no origin of its own, sends `Origin: ` empty.
  const plain = (await ticketFor(r.port(), phone.token)).body.ticket!
  assert.match(await rawUpgrade(r.port(), `${TAILNET_STUDIO_PATH}?ticket=${plain}`, { Origin: '' }), / 101 /u)
  // A ticket not spent within thirty seconds opens nothing.
  const stale = (await ticketFor(r.port(), phone.token)).body.ticket!
  clock.now += 30_001
  assert.match(await rawUpgrade(r.port(), `${TAILNET_STUDIO_PATH}?ticket=${stale}`), / 401 /u)
})

test('a hello that presents another ticket than the socket was opened with is refused', async () => {
  const r = await rig()
  const phone = r.pair(['conversation:read'])
  const first = (await ticketFor(r.port(), phone.token)).body.ticket!
  const second = (await ticketFor(r.port(), phone.token)).body.ticket!
  const outcome = await refusal(
    connect({
      client: { name: 'Phone' },
      reconnect: false,
      transport: webSocketTransport({
        ticket: async () => ({
          url: `ws://127.0.0.1:${r.port()}${TAILNET_STUDIO_PATH}?ticket=${first}`,
          token: second,
        }),
      }),
    }),
  )
  assert.equal(outcome, 'unauthorized')
})
