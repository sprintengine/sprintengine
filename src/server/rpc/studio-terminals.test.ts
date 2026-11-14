import assert from 'node:assert/strict'
import { Duplex, PassThrough } from 'node:stream'

import { afterEach, test } from 'vitest'

import {
  connect,
  webSocketTransport,
  type StudioClient,
  type StudioWebSocketConstructor,
} from '../../../packages/client-runtime/src/public'
import {
  STUDIO_MAX_CLIENT_FRAME_BYTES,
  STUDIO_METHODS,
  STUDIO_SCOPES,
  STUDIO_TERMINAL_MAX_WRITE_UNITS,
  STUDIO_TERMINALS_METHODS,
  STUDIO_TERMINALS_TOPICS,
  type StudioGrant,
  type StudioScope,
  type TerminalOutputEvent,
  type TerminalSessionSnapshot,
  type TerminalSessionsDelta,
} from '../../../packages/studio-protocol/src/public'
import { createStudioTerminals, type StudioTerminals } from '../terminals/studio-terminals'
import {
  createFakeTerminalRuntime,
  fakeTerminalSnapshot,
  type FakeTerminalRuntime,
} from '../terminals/fake-terminal-runtime.test-helper'
import { createStudioRpcRouter } from './studio-rpc-router'
import { createStudioRpcServer } from './studio-rpc-server'
import {
  connectLineClient,
  createFakeAuthenticator,
  createFakeBackend,
  hello,
  OWNER_TOKEN,
  pairFakeClient,
  startTestServer,
  type LineClient,
} from './studio-rpc.test-helper'
import { createStudioWindowListener } from './studio-window-listener'

// `terminal.*` over a real connection: who may do what, what a client other
// than the app's own window is told, and that a screen replayed to several
// panes at once is paced rather than taken for a reader that stopped. The
// runtime behind it is a fake; what the real one does with a viewer is
// src/main/terminal-runtime.test.ts's.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const SECRET_MCP = {
  syncEnabled: false,
  servers: {
    linear: {
      id: 'linear',
      name: 'Linear',
      transport: 'stdio' as const,
      env: { LINEAR_API_KEY: 'lin_secret' },
      headers: { Authorization: 'Bearer secret' },
      enabled: true,
      clients: ['claude-code'],
      scope: 'workspace' as const,
      source: 'custom' as const,
      riskLevel: 'secrets' as const,
    },
  },
}

/** A session that carries everything a projection must leave out. */
function revealingSession(): TerminalSessionSnapshot {
  return fakeTerminalSnapshot('term-1', {
    cwd: '/Users/dev/app',
    worktreePath: '/Users/dev/app-wt',
    lastPrompt: { text: 'my private prompt', at: 1 },
    agentRecord: {
      agentId: 'agent-1',
      name: 'Scout',
      cli: 'claude-code',
      cliPermissionPreset: 'auto',
      connectorMcpSettings: SECRET_MCP,
      worktreePath: '/Users/dev/app-wt',
    },
    fileChanges: [{ path: '/Users/dev/app/src/a.ts', additions: 1, deletions: 0, edits: 1, lastEditedAt: 1 }],
  })
}

async function serve(runtime: FakeTerminalRuntime = createFakeTerminalRuntime()) {
  const terminals = createStudioTerminals({ runtime })
  const started = await startTestServer({ terminals })
  cleanups.push(() => started.dispose())
  return { started, runtime, terminals }
}

type Client = {
  line: LineClient
  welcome: Awaited<ReturnType<LineClient['next']>>
  request(method: string, params: unknown): Promise<Awaited<ReturnType<LineClient['next']>>>
  subscribe(topic: string, params?: unknown): Promise<string>
}

async function client(path: string, token: string): Promise<Client> {
  const line = await connectLineClient(path)
  cleanups.push(() => line.close())
  line.send(hello({ token }))
  const welcome = await line.next((frame) => frame.t === 'welcome' || frame.t === 'bye')
  let seq = 0
  return {
    line,
    welcome,
    async request(method, params) {
      const id = `r${++seq}`
      line.send({ t: 'req', id, method, params })
      return line.next((frame) => frame.t === 'res' && frame.id === id)
    },
    async subscribe(topic, params = {}) {
      const id = `s${++seq}`
      line.send({ t: 'sub', id, topic, params })
      return id
    },
  }
}

const codeOf = (frame: { t: string; ok?: boolean; error?: { code: string } }) =>
  frame.t === 'res' && !frame.ok ? frame.error?.code : null
const resultOf = <T>(frame: { t: string; ok?: boolean; result?: unknown }) =>
  (frame.t === 'res' && frame.ok ? frame.result : undefined) as T
const open = (sessionId: string, commandId = `open-${sessionId}`) => ({ sessionId, cols: 80, rows: 24, commandId })

test('a Studio holding a terminal runtime advertises terminals; one without refuses them', async () => {
  const { started } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  assert.equal(owner.welcome.t === 'welcome' && owner.welcome.capabilities.includes('terminals'), true)

  const bare = await startTestServer()
  cleanups.push(() => bare.dispose())
  const without = await client(bare.path, OWNER_TOKEN)
  assert.equal(without.welcome.t === 'welcome' && without.welcome.capabilities.includes('terminals'), false)
  assert.equal(codeOf(await without.request('terminal.list', {})), 'unavailable')
})

test('a start or an end is a command, with no read timeout; typing and the rest are not', () => {
  for (const method of ['terminal.open', 'terminal.resume', 'terminal.close'] as const)
    assert.equal(STUDIO_METHODS[method].mutation, true, `${method} carries a commandId and waits as long as it takes`)
  for (const method of ['terminal.list', 'terminal.write', 'terminal.ack', 'terminal.setVisible'] as const)
    assert.equal(STUDIO_METHODS[method].mutation, false, method)
})

test('a start that waits on its folder outlives the client read timeout', async () => {
  const runtime = createFakeTerminalRuntime()
  runtime.spawnDelayMs = 300
  const terminals = createStudioTerminals({ runtime })
  const { url, ticket } = await windowHost(terminals)
  const sdk = await connect({
    transport: webSocketTransport({ ticket, WebSocket: socketFrom(url) }),
    client: { name: 'Studio window' },
    readTimeoutMs: 100,
  })
  cleanups.push(() => sdk.close())
  const opened = await sdk.request('terminal.open', open('slow'))
  assert.deepEqual(opened, { ok: true, sessionId: 'slow' })
})

test('only an owner’s connection reaches the terminals: a paired, a read-only and a local app’s grant are refused every method and stream', async () => {
  const { started, runtime } = await serve()
  runtime.terminals.set('term-1', { snapshot: revealingSession(), viewer: null, screen: 'hi', written: [], acked: 0 })
  const owner = await client(started.path, OWNER_TOKEN)
  await owner.subscribe('terminal.output', { sessionId: 'term-1' })
  assert.deepEqual(resultOf(await owner.request('terminal.open', open('term-1'))), { ok: true, sessionId: 'term-1' })
  const write = await owner.request('terminal.write', { sessionId: 'term-1', data: 'ls\r', writer: 'w-owner', seq: 1 })
  assert.deepEqual(resultOf(write), { written: true })
  assert.equal(resultOf<{ sessions: unknown[] }>(await owner.request('terminal.list', {})).sessions.length, 1)

  const refused = {
    // Every scope there is: none reaches a terminal.
    paired: pairFakeClient(started.auth, 'paired', [...STUDIO_SCOPES]),
    'read-only': pairFakeClient(started.auth, 'read-only', ['conversation:read']),
    // A local app granted the terminal scopes before they were removed holds names no longer read.
    'local app': pairFakeClient(started.auth, 'local-app', [
      ...STUDIO_SCOPES,
      ...(['terminal:read', 'terminal:operate'] as unknown as StudioScope[]),
    ]),
  }
  for (const [who, token] of Object.entries(refused)) {
    const app = await client(started.path, token)
    for (const method of Object.keys(STUDIO_TERMINALS_METHODS))
      assert.deepEqual(
        [who, method, codeOf(await app.request(method, { sessionId: 'term-1', commandId: `${who}-${method}` }))],
        [who, method, 'owner_required'],
      )
    for (const topic of Object.keys(STUDIO_TERMINALS_TOPICS)) {
      const sub = await app.subscribe(topic, { sessionId: 'term-1' })
      const failed = await app.line.next((frame) => frame.t === 'subFailed' && frame.sub === sub)
      assert.deepEqual([who, topic, failed.t === 'subFailed' && failed.code], [who, topic, 'owner_required'])
    }
  }
  // Nothing they asked for reached the terminal.
  assert.deepEqual(runtime.terminals.get('term-1')?.written, ['ls\r'])
})

test('a browser, an owner’s own tab included, is not offered the terminals and is refused them', async () => {
  const { started, runtime } = await serve()
  runtime.terminals.set('term-1', { snapshot: revealingSession(), viewer: null, screen: '', written: [], acked: 0 })
  // As the web front door attaches an owner's tab: an owner's grant, Studio's own view.
  const browser = attachRaw(started.server, {
    authenticator: started.auth,
    ownWindow: true,
    audited: true,
    browser: true,
  })
  browser.send(hello({ token: OWNER_TOKEN }))
  const welcome = await browser.until((frame) => frame.t === 'welcome')
  assert.equal((welcome.grant as StudioGrant).owner, true)
  const offered = welcome.capabilities as string[]
  assert.equal(offered.includes('terminals'), false)
  assert.equal(offered.includes('session-terminal-handoff'), false)
  for (const [id, method, params] of [
    ['b1', 'terminal.list', {}],
    ['b2', 'terminal.write', { sessionId: 'term-1', data: 'x', writer: 'w', seq: 1 }],
    ['b3', 'session.terminalHandoff', { commandId: 'c1', sessionId: 's1' }],
  ] as const) {
    browser.send({ t: 'req', id, method, params })
    const answer = await browser.until((frame) => frame.t === 'res' && frame.id === id)
    assert.deepEqual([method, (answer.error as { code?: string } | undefined)?.code], [method, 'owner_required'])
  }
  browser.send({ t: 'sub', id: 's1', topic: 'terminal.sessions', params: {} })
  const failed = await browser.until((frame) => frame.t === 'subFailed' && frame.sub === 's1')
  assert.equal(failed.code, 'owner_required')
  assert.deepEqual(runtime.terminals.get('term-1')?.written, [])
})

test('an owner’s connection other than the window is never sent a prompt or MCP secrets', async () => {
  const { started, runtime } = await serve()
  runtime.terminals.set('term-1', { snapshot: revealingSession(), viewer: null, screen: '', written: [], acked: 0 })
  const owner = await client(started.path, OWNER_TOKEN)
  const listed = resultOf<{ sessions: TerminalSessionSnapshot[] }>(await owner.request('terminal.list', {}))
    .sessions[0]!
  const wire = JSON.stringify(listed)
  assert.equal(wire.includes('my private prompt'), false, 'no prompt')
  assert.equal(wire.includes('lin_secret') || wire.includes('Bearer secret'), false, 'no MCP env or headers')
  assert.equal(listed.agentRecord?.name, 'Scout', 'the rest of the record stays')
  assert.equal(wire.includes('/Users/dev/app'), true, 'the folders stay')

  const sub = await owner.subscribe('terminal.sessions')
  await new Promise((resolve) => setTimeout(resolve, 20))
  runtime.delta({ upserts: [revealingSession()], removed: [] })
  const pushed = JSON.stringify(await owner.line.next((frame) => frame.t === 'push' && frame.sub === sub))
  assert.equal(pushed.includes('my private prompt') || pushed.includes('lin_secret'), false)

  // The app's own window sees what main sees.
  const router = createStudioRpcRouter({
    backend: createFakeBackend(),
    info: () => ({}) as never,
    terminals: createStudioTerminals({ runtime }),
  })
  const window: StudioGrant = { clientId: 'owner', name: 'Studio', owner: true, scopes: [], ceiling: 'bypass' }
  const own = await router.handle(window, 'terminal.list', {}, { connectionId: 'w1', slot: 1, ownWindow: true })
  assert.ok(JSON.stringify(own).includes('my private prompt'), 'the window is the app')
  router.close()
})

/** A connection attached as main attaches one, read and written as lines. */
function attachRaw(server: ReturnType<typeof createStudioRpcServer>, options: Parameters<typeof server.attach>[1]) {
  const toClient = new PassThrough()
  const serverSide = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      toClient.write(chunk)
      callback()
    },
  })
  server.attach(serverSide, options)
  cleanups.push(() => serverSide.destroy())
  const frames: Array<Record<string, unknown>> = []
  let buffer = ''
  toClient.setEncoding('utf8')
  toClient.on('data', (chunk: string) => {
    buffer += chunk
    for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
      frames.push(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>)
      buffer = buffer.slice(newline + 1)
    }
  })
  return {
    send: (frame: unknown) => serverSide.push(`${JSON.stringify(frame)}\n`),
    async until(match: (frame: Record<string, unknown>) => boolean) {
      for (let tries = 0; tries < 200; tries++) {
        const found = frames.find(match)
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error(`No matching frame in ${JSON.stringify(frames)}`)
    },
  }
}

test('a write sent again after a reconnect is dropped, and one over the limit is refused, not swallowed', async () => {
  const { started, runtime } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  await owner.request('terminal.open', open('term-1'))
  const write = (seq: number, data: string) =>
    owner.request('terminal.write', { sessionId: 'term-1', data, writer: 'pane-1', seq })
  assert.deepEqual(resultOf(await write(1, 'a')), { written: true })
  assert.deepEqual(resultOf(await write(2, 'b')), { written: true })
  assert.deepEqual(resultOf(await write(2, 'b')), { written: false }, 'the same piece again is not typed twice')
  assert.deepEqual(runtime.terminals.get('term-1')?.written, ['a', 'b'])
  const tooLong = await write(3, 'x'.repeat(STUDIO_TERMINAL_MAX_WRITE_UNITS + 1))
  assert.equal(codeOf(tooLong), 'too_large')
  // The largest piece, escaped at its worst, fits a client frame.
  const worst = JSON.stringify({
    t: 'req',
    id: 'r1',
    method: 'terminal.write',
    params: {
      sessionId: 'x'.repeat(200),
      writer: 'y'.repeat(200),
      seq: Number.MAX_SAFE_INTEGER,
      data: '\u001b'.repeat(STUDIO_TERMINAL_MAX_WRITE_UNITS),
    },
  })
  assert.ok(Buffer.byteLength(worst) < STUDIO_MAX_CLIENT_FRAME_BYTES)
})

// ── Replays over the window's own connection ────────────────────────────────

/** Node's WebSocket, saying the origin a window's would. */
function socketFrom(_url: string): StudioWebSocketConstructor {
  const NodeWebSocket = (globalThis as unknown as { WebSocket: new (url: string, init: unknown) => unknown }).WebSocket
  return class {
    constructor(url: string) {
      return new NodeWebSocket(url, { headers: { origin: 'file://' } }) as never
    }
  } as unknown as StudioWebSocketConstructor
}

async function windowHost(terminals: StudioTerminals) {
  const server = createStudioRpcServer({
    dataDir: '/nonexistent/terminals',
    version: '0.0.0-test',
    environmentId: 'env-terminals',
    backend: createFakeBackend(),
    authenticator: createFakeAuthenticator(),
    terminals,
  })
  const listener = createStudioWindowListener({
    attach: (stream, authenticator, windowKey) => server.attach(stream, { authenticator, ownWindow: true, windowKey }),
  })
  cleanups.push(async () => {
    await server.stop(1)
    await listener.stop()
  })
  const ticket = () => listener.ticket({ windowKey: 'window-1-1', origin: 'file://' })
  return { url: '', ticket, server, listener }
}

test('several large screens replayed at once reach their panes, and the connection is kept', async () => {
  const runtime = createFakeTerminalRuntime()
  const terminals = createStudioTerminals({ runtime })
  const { ticket } = await windowHost(terminals)
  const sdk: StudioClient = await connect({
    transport: webSocketTransport({ ticket, WebSocket: socketFrom('') }),
    client: { name: 'Studio window' },
    reconnect: false,
  })
  cleanups.push(() => sdk.close())

  // A recent-tier screen, 2.5 MiB of colour escapes, which JSON writes six times over.
  const screen = '\u001b[0m'.repeat((2.5 * 1024 * 1024) / 4)
  const ids = ['t-1', 't-2', 't-3', 't-4']
  for (const id of ids)
    runtime.terminals.set(id, { snapshot: fakeTerminalSnapshot(id), viewer: null, screen, written: [], acked: 0 })
  const replays = new Map<string, number>()
  const after = new Map<string, string>()
  const ended: unknown[] = []
  for (const id of ids)
    sdk.subscribe(
      'terminal.output',
      { sessionId: id },
      {
        onPayload: (event: TerminalOutputEvent) => {
          if (event.type === 'replay') replays.set(id, event.data.length)
          else if (event.type === 'data') after.set(id, (after.get(id) ?? '') + event.data)
        },
        onEnd: (error) => ended.push(error),
      },
    )
  // A window showing all four (its load, or a reconnect re-showing them).
  const opened = await Promise.all(ids.map((id) => sdk.request('terminal.open', open(id))))
  assert.ok(opened.every((answer) => answer.ok))
  for (const id of ids) runtime.emit(id, `live ${id}`)
  const deadline = Date.now() + 30_000
  while ((replays.size < ids.length || after.size < ids.length) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20))
  for (const id of ids) {
    assert.equal(replays.get(id), screen.length, `${id}: its whole screen`)
    assert.equal(after.get(id), `live ${id}`, `${id}: and what came after, behind it`)
  }
  assert.equal(sdk.state, 'open', 'not closed as a reader that stopped')
  assert.deepEqual(ended, [])
})

test('the sessions stream sends each delta as it comes', async () => {
  const { started, runtime } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  const sub = await owner.subscribe('terminal.sessions')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const delta: TerminalSessionsDelta = { upserts: [fakeTerminalSnapshot('term-9')], removed: ['term-0'] }
  runtime.delta(delta)
  const pushed = await owner.line.next((frame) => frame.t === 'push' && frame.sub === sub)
  assert.deepEqual(pushed.t === 'push' && (pushed.payload as TerminalSessionsDelta).removed, ['term-0'])
})

test('a window that follows no output for a terminal speaks for it as a pane that has gone', async () => {
  const { started, runtime } = await serve()
  const showing = await client(started.path, OWNER_TOKEN)
  await showing.subscribe('terminal.output', { sessionId: 'term-1' })
  await showing.request('terminal.open', open('term-1'))
  const routed = runtime.terminals.get('term-1')!.viewer
  // Another window sweeping its hidden terminals names this one too.
  const sweeping = await client(started.path, OWNER_TOKEN)
  await sweeping.request('terminal.setVisible', { sessionId: 'term-1', visible: false })
  const said = runtime.shown.at(-1)!
  assert.ok(said.viewer && said.viewer !== routed, 'not as the pane the terminal streams to')
  assert.equal(said.viewer.isGone(), true, 'so the routing rule holds it to that pane')
  assert.equal(runtime.terminals.get('term-1')!.viewer, routed)
})
