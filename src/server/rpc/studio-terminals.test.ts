import assert from 'node:assert/strict'

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
  STUDIO_TERMINAL_MAX_WRITE_UNITS,
  type StudioGrant,
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

test('grants: an owner and an operate grant drive; a read grant lists only; a revoked one is ended', async () => {
  const { started, runtime } = await serve()
  runtime.terminals.set('term-1', { snapshot: revealingSession(), viewer: null, screen: 'hi', written: [], acked: 0 })
  const operateToken = pairFakeClient(started.auth, 'app-operate', ['terminal:operate'])
  const readToken = pairFakeClient(started.auth, 'app-read', ['terminal:read'])
  const noneToken = pairFakeClient(started.auth, 'app-none', ['conversation:read'])

  for (const token of [OWNER_TOKEN, operateToken]) {
    const driver = await client(started.path, token)
    await driver.subscribe('terminal.output', { sessionId: 'term-1' })
    assert.deepEqual(resultOf(await driver.request('terminal.open', open('term-1'))), { ok: true, sessionId: 'term-1' })
    const write = await driver.request('terminal.write', {
      sessionId: 'term-1',
      data: 'ls\r',
      writer: `w-${token}`,
      seq: 1,
    })
    assert.deepEqual(resultOf(write), { written: true })
    assert.equal(resultOf<{ sessions: unknown[] }>(await driver.request('terminal.list', {})).sessions.length, 1)
  }

  const reader = await client(started.path, readToken)
  assert.equal(resultOf<{ sessions: unknown[] }>(await reader.request('terminal.list', {})).sessions.length, 1)
  assert.deepEqual(resultOf(await reader.request('terminal.status', { sessionId: 'term-1' })), {
    processAlive: true,
    suspended: false,
  })
  for (const [method, params] of [
    ['terminal.open', open('term-1', 'reader-open')],
    ['terminal.write', { sessionId: 'term-1', data: 'x', writer: 'w', seq: 1 }],
    ['terminal.resize', { sessionId: 'term-1', cols: 80, rows: 24 }],
    ['terminal.close', { sessionId: 'term-1', commandId: 'reader-close' }],
  ] as const)
    assert.deepEqual([method, codeOf(await reader.request(method, params))], [method, 'scope_required'])
  const refusedOutput = await reader.subscribe('terminal.output', { sessionId: 'term-1' })
  const failed = await reader.line.next((frame) => frame.t === 'subFailed' && frame.sub === refusedOutput)
  assert.equal(failed.t === 'subFailed' && failed.code, 'scope_required')
  // Read-only, the sessions stream is served.
  const sessions = await reader.subscribe('terminal.sessions')
  await new Promise((resolve) => setTimeout(resolve, 20))
  runtime.delta({ upserts: [revealingSession()], removed: [] })
  await reader.line.next((frame) => frame.t === 'push' && frame.sub === sessions)

  const outsider = await client(started.path, noneToken)
  assert.equal(codeOf(await outsider.request('terminal.list', {})), 'scope_required')
  // The owner's own: the machine's policy and the prompts a person wrote.
  const operator = await client(started.path, operateToken)
  assert.equal(codeOf(await operator.request('terminal.configure', { idleSuspendMs: 1000 })), 'owner_required')
  assert.equal(codeOf(await operator.request('terminal.takeUndeliveredPrompts', {})), 'owner_required')

  // Revoked while it follows output: the next frame ends it.
  const watching = await client(started.path, operateToken)
  await watching.subscribe('terminal.output', { sessionId: 'term-1' })
  await watching.request('terminal.open', open('term-1', 'watching-open'))
  started.auth.grants.delete('app-operate')
  runtime.emit('term-1', 'after the revoke')
  const bye = await watching.line.next((frame) => frame.t === 'bye')
  assert.equal(bye.t === 'bye' && bye.code, 'revoked')
  assert.equal(
    watching.line.frames.some((frame) => frame.t === 'push' && JSON.stringify(frame).includes('after the revoke')),
    false,
  )
})

test('a client other than the window is never sent a prompt or MCP secrets; a read grant not the folders', async () => {
  const { started, runtime } = await serve()
  runtime.terminals.set('term-1', { snapshot: revealingSession(), viewer: null, screen: '', written: [], acked: 0 })
  const operateToken = pairFakeClient(started.auth, 'app-operate', ['terminal:operate'])
  const readToken = pairFakeClient(started.auth, 'app-read', ['terminal:read'])

  for (const token of [OWNER_TOKEN, operateToken, readToken]) {
    const listed = resultOf<{ sessions: TerminalSessionSnapshot[] }>(
      await (await client(started.path, token)).request('terminal.list', {}),
    ).sessions[0]!
    const wire = JSON.stringify(listed)
    assert.equal(wire.includes('my private prompt'), false, 'no prompt')
    assert.equal(wire.includes('lin_secret') || wire.includes('Bearer secret'), false, 'no MCP env or headers')
    assert.equal(listed.agentRecord?.name, 'Scout', 'the rest of the record stays')
    assert.equal(wire.includes('/Users/dev/app'), token !== readToken, 'folders only to a grant that may open them')
  }

  const reader = await client(started.path, readToken)
  const sub = await reader.subscribe('terminal.sessions')
  await new Promise((resolve) => setTimeout(resolve, 20))
  runtime.delta({ upserts: [revealingSession()], removed: [] })
  const pushed = await reader.line.next((frame) => frame.t === 'push' && frame.sub === sub)
  const wire = JSON.stringify(pushed)
  assert.equal(wire.includes('my private prompt') || wire.includes('lin_secret') || wire.includes('/Users/dev'), false)

  // The app's own window sees what main sees.
  const router = createStudioRpcRouter({
    backend: createFakeBackend(),
    info: () => ({}) as never,
    terminals: createStudioTerminals({ runtime }),
  })
  const owner: StudioGrant = {
    clientId: 'owner',
    name: 'Studio',
    owner: true,
    scopes: ['terminal:operate'],
    ceiling: 'bypass',
  }
  const own = await router.handle(owner, 'terminal.list', {}, { connectionId: 'w1', slot: 1, ownWindow: true })
  assert.ok(JSON.stringify(own).includes('my private prompt'), 'the window is the app')
  router.close()
})

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
