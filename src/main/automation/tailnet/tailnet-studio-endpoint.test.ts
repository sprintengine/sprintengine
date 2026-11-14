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
import { gatewayCallSignal } from '../../../server/tools/client-tool-gateway'
import type { McpToolRegistration } from '../../../shared/modules/mcp-tools'
import type { TailnetScope } from '../../../shared/tailnet'
import { createTailnetDeviceStore, type TailnetDeviceStore } from './tailnet-devices'
import {
  createTailnetGatewayServer,
  MAX_DEVICE_ANSWER_BYTES,
  MAX_DEVICE_OUTSTANDING_REQUESTS,
  MAX_SOCKETS_PER_DEVICE,
  MAX_STREAM_QUEUED_MESSAGES,
  MAX_TICKETS_PER_DEVICE,
  type TailnetGatewayServer,
} from './tailnet-gateway-server'
import { TAILNET_MCP_PATH, TAILNET_STREAM_PATH, TAILNET_STUDIO_PATH, TAILNET_WS_TICKET_PATH } from './tailnet-routes'
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

async function rig(clock: { now: number } | null = null, tools: McpToolRegistration[] = []): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-studio-'))
  const devices = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
  const studio = await startTestServer({ backend: createFakeBackend(['agent-1']), discovery: DISCOVERY })
  const build = (port: number) =>
    createTailnetGatewayServer({
      bindAddress: '127.0.0.1',
      port,
      serverName: 'sprintengine-studio',
      serverVersion: '9.9.9',
      resolveTools: () => tools,
      isMutation: () => false,
      devices,
      peers: { identify: async () => null, resolve: async () => null },
      ...(clock ? { now: () => clock.now } : {}),
      // As the core links it (src/server/core/studio-rpc.ts → connectDevice).
      studio: () => ({
        attach: (stream, authenticator, workBudget) =>
          void studio.server.attach(stream, {
            authenticator,
            ownWindow: false,
            audited: true,
            knownFoldersOnly: true,
            workBudget,
          }),
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
        ...('Sec-WebSocket-Key' in headers ? [] : ['Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==']),
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

test('every window of a paired desktop keeps a socket of its own; past the cap the oldest goes, not the newest', async () => {
  const r = await rig()
  const desktop = r.pair(['workspace:read', 'conversation:read'], 'mac-mini')
  // A desktop with many windows, each reading this machine, and its server's own client beside them.
  const windows: Array<{ client: StudioClient; states: StudioClientState[] }> = []
  for (let index = 0; index < MAX_SOCKETS_PER_DEVICE; index++) {
    const states: StudioClientState[] = []
    windows.push({ client: await deviceClient(r, desktop.token, { origin: 'file://', states }), states })
  }
  // Every one of them is answered: none was let go to make room for another.
  for (const { client } of windows) assert.ok(await client.rpc['workspaces.list']({}))
  assert.ok(windows.every(({ states }) => !states.includes('reconnecting')))
  // One more than the cap: the oldest is closed, and the newest works.
  const extra = await deviceClient(r, desktop.token, { origin: 'file://' })
  assert.ok(await extra.rpc['workspaces.list']({}))
  await until(() => windows[0]!.states.includes('reconnecting'), 'the oldest socket to be let go')
  assert.ok(windows.slice(1).every(({ states }) => !states.includes('reconnecting')))
})

/** A tool stream opened as a device (no origin), answering its close code once it closes. */
async function toolStream(port: number, token: string): Promise<{ socket: WebSocket; closed: Promise<number> }> {
  const minted = await ticketFor(port, token)
  if (!minted.body.ticket) throw new Error(`ticket refused: ${minted.status}`)
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}${TAILNET_STREAM_PATH}?ticket=${encodeURIComponent(minted.body.ticket)}`,
  )
  const closed = new Promise<number>((resolve) => socket.addEventListener('close', (event) => resolve(event.code)))
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('the stream did not open')))
  })
  cleanups.push(() => socket.close())
  return { socket, closed }
}

test("a device's tool streams and Studio sockets share one budget: past it the oldest of either kind goes", async () => {
  const r = await rig()
  const desktop = r.pair(['workspace:read', 'conversation:read'], 'mac-mini')
  const streams: Array<{ socket: WebSocket; closed: Promise<number>; code: number | null }> = []
  for (let index = 0; index < MAX_SOCKETS_PER_DEVICE; index++) {
    const stream = { ...(await toolStream(r.port(), desktop.token)), code: null as number | null }
    void stream.closed.then((code) => (stream.code = code))
    streams.push(stream)
  }
  assert.equal(r.gateway.streamCount(), MAX_SOCKETS_PER_DEVICE)
  // A Studio socket past the budget lets the oldest stream go, not a newer one.
  const states: StudioClientState[] = []
  const window = await deviceClient(r, desktop.token, { origin: 'file://', states })
  assert.ok(await window.rpc['workspaces.list']({}))
  assert.equal(await streams[0]!.closed, 1001)
  await until(() => r.gateway.streamCount() === MAX_SOCKETS_PER_DEVICE - 1, 'the oldest stream to be dropped')
  assert.ok(streams.slice(1).every((stream) => stream.code === null))
  // And a stream past it lets the oldest go, which is now the oldest stream.
  const extra = await toolStream(r.port(), desktop.token)
  assert.equal(await streams[1]!.closed, 1001)
  assert.ok(!states.includes('reconnecting'), 'the newer Studio socket stays')
  extra.socket.close()
  // Another device's budget is its own.
  const phone = r.pair(['workspace:read'])
  const its = await toolStream(r.port(), phone.token)
  assert.equal(its.socket.readyState, WebSocket.OPEN)
})

/**
 * A tool stream on a raw socket that never answers a close: what a hostile
 * client does to stay open past its budget. Answers what the server sent.
 */
async function stubbornStream(
  port: number,
  token: string,
): Promise<{ send(text: string): void; heard(): string; ended: Promise<void> }> {
  const minted = await ticketFor(port, token)
  if (!minted.body.ticket) throw new Error(`ticket refused: ${minted.status}`)
  const path = `${TAILNET_STREAM_PATH}?ticket=${encodeURIComponent(minted.body.ticket)}`
  // Half-open allowed: the server's FIN is not answered with one, as a client ignoring the close would not.
  const socket = connectTcp({ port, host: '127.0.0.1', allowHalfOpen: true })
  cleanups.push(() => void socket.destroy())
  let heard = ''
  const ended = new Promise<void>((resolve) => socket.on('close', () => resolve()))
  socket.on('error', () => undefined)
  socket.on('data', (chunk: Buffer) => (heard += chunk.toString('latin1')))
  await new Promise<void>((resolve) => socket.on('connect', () => resolve()))
  socket.write(
    [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      '',
      '',
    ].join('\r\n'),
  )
  await until(() => heard.includes('\r\n\r\n'), 'the upgrade')
  if (!heard.startsWith('HTTP/1.1 101')) throw new Error(`not upgraded: ${heard.split('\r\n')[0]}`)
  const mask = Buffer.from([1, 2, 3, 4])
  return {
    send(text) {
      const body = Buffer.from(text, 'utf8')
      if (body.length >= 126) throw new Error('kept short in this test')
      const masked = Buffer.from(body)
      for (let index = 0; index < masked.length; index += 1) masked[index]! ^= mask[index % 4]!
      socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, masked]))
    },
    heard: () => heard,
    ended,
  }
}

test('a stream evicted past its budget is served nothing more, and let go of, though its client ignores the close', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-stream-evicted-'))
  const devices = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
  let calls = 0
  const gateway = createTailnetGatewayServer({
    bindAddress: '127.0.0.1',
    port: 0,
    serverName: 'sprintengine-studio',
    serverVersion: '9.9.9',
    resolveTools: () => [
      {
        name: 'workspace.count',
        description: 'Counts its calls.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
          calls += 1
          return { content: [{ type: 'text', text: String(calls) }] }
        },
      },
    ],
    isMutation: () => false,
    devices,
    peers: { identify: async () => null, resolve: async () => null },
  })
  await gateway.start()
  cleanups.push(async () => {
    await gateway.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  const { deviceToken } = devices.mintDevice({
    name: 'mac-mini',
    scopes: ['workspace:read'],
    origin: { kind: 'code', by: null },
  })
  const port = gateway.address()!.port
  const call = (id: number) =>
    JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'workspace.count', arguments: {} } })
  const stubborn = await stubbornStream(port, deviceToken)
  stubborn.send(call(1))
  await until(() => calls === 1, 'the first call')
  for (let index = 0; index < MAX_SOCKETS_PER_DEVICE; index++) await toolStream(port, deviceToken)
  await until(() => stubborn.heard().includes('newer connection'), 'the eviction close')
  // Evicted, it runs nothing more it is sent.
  stubborn.send(call(2))
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(calls, 1, 'a call on the evicted stream ran')
  // And past the close's grace the server has let the socket go: writing to
  // it again is reset, which the client hears as its socket closing.
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  let closed = false
  void stubborn.ended.then(() => (closed = true))
  for (let id = 3; id < 50 && !closed; id++) {
    stubborn.send(call(id))
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(closed, 'the evicted socket was kept open')
  assert.equal(calls, 1)
})

test('a device holds only its newest tickets', async () => {
  const r = await rig()
  const phone = r.pair(['workspace:read'])
  const tickets: string[] = []
  for (let index = 0; index < MAX_TICKETS_PER_DEVICE + 1; index++)
    tickets.push((await ticketFor(r.port(), phone.token)).body.ticket!)
  assert.match(
    await rawUpgrade(r.port(), `${TAILNET_STREAM_PATH}?ticket=${encodeURIComponent(tickets[0]!)}`),
    / 401 /,
    'the oldest was let go',
  )
  assert.match(
    await rawUpgrade(r.port(), `${TAILNET_STREAM_PATH}?ticket=${encodeURIComponent(tickets.at(-1)!)}`),
    / 101 /,
  )
})

test('a tool stream that sends faster than it is answered is closed, not queued for without end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-stream-queue-'))
  const devices = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
  let started = 0
  const never = new Promise<never>(() => undefined)
  const gateway = createTailnetGatewayServer({
    bindAddress: '127.0.0.1',
    port: 0,
    serverName: 'sprintengine-studio',
    serverVersion: '9.9.9',
    resolveTools: () => [
      {
        name: 'workspace.stall',
        description: 'Answers never.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
          started += 1
          return never
        },
      },
    ],
    isMutation: () => false,
    devices,
    peers: { identify: async () => null, resolve: async () => null },
  })
  await gateway.start()
  cleanups.push(async () => {
    await gateway.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  const minted = devices.mintDevice({
    name: 'android-phone',
    scopes: ['workspace:read'],
    origin: { kind: 'code', by: null },
  })
  const { socket, closed } = await toolStream(gateway.address()!.port, minted.deviceToken)
  for (let id = 1; id <= MAX_STREAM_QUEUED_MESSAGES + 1; id++)
    socket.send(
      JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'workspace.stall', arguments: {} } }),
    )
  assert.equal(await closed, 1008)
  // Answered one at a time, and closed with the rest still waiting: none of
  // those runs. (All may arrive in one read, closing it before even the first starts.)
  assert.ok(started <= 1, 'answered one at a time: the rest only waited')
  await until(() => gateway.streamCount() === 0, 'the stream to be dropped')
})

/** A tool call on a stream, as JSON-RPC. */
const toolCall = (id: number, name: string) =>
  JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })

/** A tool that is held until the test lets it go or its call is cancelled, and says which. */
function heldTool(name: string, record: { started: number; cancelled: number }, letGo: Promise<void>) {
  return {
    name,
    description: 'Holds until let go.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      record.started += 1
      const signal = gatewayCallSignal()
      await new Promise<void>((resolve) => {
        void letGo.then(resolve)
        signal?.addEventListener('abort', () => {
          record.cancelled += 1
          resolve()
        })
      })
      return { content: [{ type: 'text' as const, text: 'done' }] }
    },
  }
}

test('a closed tool stream runs nothing it had waiting, and the call it was running is cancelled', async () => {
  const record = { started: 0, cancelled: 0 }
  let letGo!: () => void
  const r = await rig(null, [heldTool('workspace.hold', record, new Promise<void>((resolve) => (letGo = resolve)))])
  const phone = r.pair(['workspace:read'])
  const { socket, closed } = await toolStream(r.port(), phone.token)
  for (let id = 1; id <= 3; id++) socket.send(toolCall(id, 'workspace.hold'))
  await until(() => record.started === 1, 'the first call to start')
  socket.close()
  await closed
  await until(() => r.gateway.streamCount() === 0, 'the stream to be dropped')
  await until(() => record.cancelled === 1, 'the running call to be cancelled')
  // Were the call not cancelled, letting it go now would start the two behind it.
  letGo()
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(record.started, 1, 'a request the closed stream had waiting ran')
})

test("a device's requests share one budget across its sockets: closing and reopening them does not pile up work", async () => {
  // A tool that never stops, cancelled or not: the worst a device's work can be.
  let started = 0
  const stuck = {
    name: 'workspace.stuck',
    description: 'Never answers.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      started += 1
      return new Promise<never>(() => undefined)
    },
  }
  const r = await rig(null, [stuck])
  const phone = r.pair(['workspace:read', 'conversation:read'])
  // A stream's waiting requests stop counting the moment it closes; the one it was running does not.
  const first = await toolStream(r.port(), phone.token)
  for (let id = 1; id <= 10; id++) first.socket.send(toolCall(id, 'workspace.stuck'))
  await until(() => started === 1, 'the first call to start')
  first.socket.close()
  await first.closed
  for (let index = 1; index < MAX_DEVICE_OUTSTANDING_REQUESTS; index++) {
    const stream = await toolStream(r.port(), phone.token)
    stream.socket.send(toolCall(1, 'workspace.stuck'))
    await until(() => started === index + 1, `call ${index + 1} to start`)
    stream.socket.close()
    await stream.closed
  }
  // The budget is spent by calls whose sockets are all gone: the next is answered busy and never run.
  const last = await toolStream(r.port(), phone.token)
  const answered = new Promise<{ id: number | null; error?: { code: number } }>((resolve) => {
    last.socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data))))
    // Run rather than refused, the call is never answered.
    setTimeout(() => resolve({ id: null }), 3_000).unref?.()
  })
  last.socket.send(toolCall(7, 'workspace.stuck'))
  const answer = await answered
  assert.equal(answer.id, 7)
  assert.equal(answer.error?.code, -32000)
  assert.equal(started, MAX_DEVICE_OUTSTANDING_REQUESTS)
  // And a Studio socket of the same device draws on the same budget.
  const window = await deviceClient(r, phone.token)
  assert.equal(await refusal(window.rpc['workspaces.list']({})), 'busy')
})

test("the MCP endpoint's calls draw on the device's budget too: parallel POSTs are no way around it", async () => {
  let started = 0
  const stuck = {
    name: 'workspace.stuck',
    description: 'Never answers.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      started += 1
      return new Promise<never>(() => undefined)
    },
  }
  const r = await rig(null, [stuck])
  const phone = r.pair(['workspace:read'])
  const abort = new AbortController()
  cleanups.push(() => abort.abort())
  const post = (id: number) =>
    fetch(`http://127.0.0.1:${r.port()}${TAILNET_MCP_PATH}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${phone.token}`, 'content-type': 'application/json' },
      body: toolCall(id, 'workspace.stuck'),
      signal: abort.signal,
    })
  for (let id = 1; id <= MAX_DEVICE_OUTSTANDING_REQUESTS; id++) void post(id).catch(() => undefined)
  await until(() => started === MAX_DEVICE_OUTSTANDING_REQUESTS, 'the budget to be spent')
  const refused = await post(999)
  assert.equal(refused.status, 429)
  const body = (await refused.json()) as { id: number; error: { code: number } }
  assert.equal(body.id, 999)
  assert.equal(body.error.code, -32000)
  assert.equal(started, MAX_DEVICE_OUTSTANDING_REQUESTS, 'the refused call never ran')
})

test('an answer past the size a device is sent is refused under its id, on the MCP endpoint and a tool stream', async () => {
  const huge = {
    name: 'workspace.huge',
    description: 'Answers more than a device is sent.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ content: [{ type: 'text' as const, text: 'a'.repeat(MAX_DEVICE_ANSWER_BYTES) }] }),
  }
  const r = await rig(null, [huge])
  const phone = r.pair(['workspace:read'])
  const response = await fetch(`http://127.0.0.1:${r.port()}${TAILNET_MCP_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phone.token}`, 'content-type': 'application/json' },
    body: toolCall(5, 'workspace.huge'),
  })
  const text = await response.text()
  assert.ok(text.length < 1024, `the answer was sent: ${text.length} bytes`)
  const posted = JSON.parse(text) as { id: number; error?: { message: string } }
  assert.equal(posted.id, 5)
  assert.match(posted.error?.message ?? '', /over the 8 MB a device is sent/)

  const { socket } = await toolStream(r.port(), phone.token)
  const streamed = new Promise<string>((resolve) =>
    socket.addEventListener('message', (event) => {
      if (String(event.data).includes('"id":6')) resolve(String(event.data))
    }),
  )
  socket.send(toolCall(6, 'workspace.huge'))
  const frame = await streamed
  assert.ok(frame.length < 1024, `the answer was sent: ${frame.length} bytes`)
  assert.equal((JSON.parse(frame) as { id: number }).id, 6)
  socket.close()
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
  // A key that is not sixteen bytes in base64 opens nothing, before its ticket is spent.
  const keyed = (await ticketFor(r.port(), desktop.token)).body.ticket!
  assert.match(
    await rawUpgrade(r.port(), `${TAILNET_STUDIO_PATH}?ticket=${keyed}`, { 'Sec-WebSocket-Key': 'not a key' }),
    / 400 /u,
  )
  assert.match(await rawUpgrade(r.port(), `${TAILNET_STUDIO_PATH}?ticket=${keyed}`), / 101 /u)
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

test('a device reaches no machine through this desktop: naming one buys only this Studio, and no machine path is served', async () => {
  const r = await rig()
  const phone = r.pair(['conversation:read', 'conversation:operate'])
  const named = await ticketFor(r.port(), phone.token, { environmentId: '7d1e2f30-4a5b-4c6d-8e9f-0a1b2c3d4e5f' })
  assert.equal(named.status, 200)
  assert.equal((named.body as { studioPath?: string }).studioPath, TAILNET_STUDIO_PATH)
  assert.match(
    await rawUpgrade(
      r.port(),
      `/tailnet/v1/environments/7d1e2f30-4a5b-4c6d-8e9f-0a1b2c3d4e5f/studio?ticket=${named.body.ticket}`,
    ),
    / 404 /u,
  )
})
