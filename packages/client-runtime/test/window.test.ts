import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

import { createTicketAuthenticator, framePortStream, mintStudioTicket } from '../../../src/server/rpc/studio-frame-port'
import { createStudioRpcServer, type StudioRpcServer } from '../../../src/server/rpc/studio-rpc-server'
import {
  createFakeAuthenticator,
  createFakeBackend,
  type FakeBackend,
} from '../../../src/server/rpc/studio-rpc.test-helper'
import type { StudioChatBackend } from '../../../src/server/rpc/studio-rpc-types'
import type { ConversationSessionFrame } from '../../../src/shared/conversation-runtime'
import { createMemoryChannel, type MemoryChannelEnd } from '../../../tests/memory-channel'
import { memoryWebSocketClass } from '../../../tests/memory-websocket'
import {
  connect,
  webSocketTransport,
  type ConnectOptions,
  type StudioClient,
  type StudioClientState,
  type StudioTransportFactory,
} from '../src/public'

// The client over a connection that brings its own credential, as a Studio
// window's does: `webSocketTransport` with a fresh ticket per socket, good for
// its one hello.

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Window = {
  server: StudioRpcServer
  backend: FakeBackend
  /** Every frame the client sent, decoded. */
  sent: Array<Record<string, unknown>>
  /** The tickets handed out, one per connection. */
  tickets: string[]
  /** Drop the open connection, as a reload of the server would. */
  drop(): void
  /** From now on, connections reach a different Studio. */
  replace(environmentId: string): void
  /** The same Studio started again on another port: the old one refuses sockets, and only a new ticket names the new one. */
  restart(): Promise<void>
  /** The port the latest ticket named. */
  readonly port: number
  /** Studio refuses each hello's ticket, as a stale or wrong one is. */
  refuseTickets: boolean
  /** No ticket can be had (main cannot reach its server). */
  ticketsFail: boolean
  /** Nothing Studio sends on the open connection reaches the client, and its socket stays open: a line a sleep left half-open. */
  silence(): void
  commandListeners: Set<(catalog: unknown) => void>
  transport: StudioTransportFactory
}

function window(
  options: {
    follow?: FakeBackend['follow']
    rewrite?: (frame: Record<string, unknown>) => Record<string, unknown>
  } = {},
): Window {
  const backend = createFakeBackend()
  if (options.follow) backend.follow = options.follow
  const commandListeners = new Set<(catalog: unknown) => void>()
  const chat = {
    onCommandsChanged: (listener: (catalog: unknown) => void) => {
      commandListeners.add(listener)
      return () => commandListeners.delete(listener)
    },
    releaseFileSearches: () => undefined,
  } as unknown as StudioChatBackend
  const make = (environmentId: string) => {
    const made = createStudioRpcServer({
      dataDir: '/nonexistent/sdk-window',
      version: '0.0.0-test',
      environmentId,
      backend,
      chat: () => chat,
      authenticator: createFakeAuthenticator(),
    })
    cleanups.push(() => made.stop(1))
    return made
  }
  let server = make('env-test')
  let port = 1
  const sent: Array<Record<string, unknown>> = []
  const tickets: string[] = []
  let open: MemoryChannelEnd | null = null
  const flags = { refuseTickets: false, ticketsFail: false }
  let silenced: MemoryChannelEnd | null = null
  // The window's own transport: a fresh ticket asked for before each socket,
  // admitted as the window listener admits one, by the ticket its URL names.
  const transport = webSocketTransport({
    ticket: async () => {
      if (flags.ticketsFail) throw new Error('Studio is not running.')
      const ticket = mintStudioTicket()
      tickets.push(ticket)
      return { url: `ws://127.0.0.1:${port}/ws?ticket=${encodeURIComponent(ticket)}`, token: ticket }
    },
    WebSocket: memoryWebSocketClass((url) => {
      const address = new URL(url)
      const ticket = address.searchParams.get('ticket')
      if (!ticket || Number(address.port) !== port) return null
      const [serverEnd, clientEnd] = createMemoryChannel()
      const admits = flags.refuseTickets ? mintStudioTicket() : ticket
      server.attach(framePortStream(serverEnd), { authenticator: createTicketAuthenticator(admits), ownWindow: true })
      open = clientEnd
      return {
        post: (frame: string) => {
          sent.push(JSON.parse(frame) as Record<string, unknown>)
          clientEnd.post(frame)
        },
        onFrame: (listener: (frame: string) => void) =>
          clientEnd.onFrame((frame) =>
            silenced === clientEnd
              ? undefined
              : listener(
                  options.rewrite
                    ? JSON.stringify(options.rewrite(JSON.parse(frame) as Record<string, unknown>))
                    : frame,
                ),
          ),
        onClose: (listener: () => void) => clientEnd.onClose(listener),
        close: () => clientEnd.close(),
        get closed() {
          return clientEnd.closed
        },
      }
    }),
  })
  return {
    get server() {
      return server
    },
    backend,
    sent,
    tickets,
    drop: () => open?.close(),
    replace: (environmentId) => {
      server = make(environmentId)
    },
    async restart() {
      const stopping = server
      port += 1
      server = make('env-test')
      open?.close()
      await stopping.stop(1)
    },
    get port() {
      return port
    },
    get refuseTickets() {
      return flags.refuseTickets
    },
    set refuseTickets(value) {
      flags.refuseTickets = value
    },
    get ticketsFail() {
      return flags.ticketsFail
    },
    set ticketsFail(value) {
      flags.ticketsFail = value
    },
    silence: () => {
      silenced = open
    },
    commandListeners,
    transport,
  }
}

async function connected(target: Window, options: Partial<ConnectOptions> = {}): Promise<StudioClient> {
  const client = await connect({
    transport: target.transport,
    client: { name: 'Studio window' },
    reconnect: { initialDelayMs: 5, maxDelayMs: 20 },
    ...options,
  })
  cleanups.push(() => client.close())
  return client
}

const until = async (check: () => boolean) => {
  for (let tries = 0; !check() && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(check())
}

test('a transport’s own credential says each hello, a fresh one for every connection, and no auth is needed', async () => {
  const target = window()
  const client = await connected(target)
  assert.equal(client.grant.owner, true)
  assert.equal(client.grant.name, 'Studio window')
  target.drop()
  await until(() => target.tickets.length === 2 && client.state === 'open')
  const hellos = target.sent.filter((frame) => frame.t === 'hello')
  assert.deepEqual(
    hellos.map((frame) => (frame.auth as { token: string }).token),
    target.tickets,
  )
  assert.equal(new Set(target.tickets).size, 2, 'a ticket is never said twice')
  await assert.rejects(
    connect({
      transport: async () => {
        const transport = await target.transport()
        return { ...transport, credential: undefined }
      },
      client: { name: 'nobody' },
      reconnect: false,
    }),
    /No credential/,
  )
})

test('a push stream hears each payload, and is subscribed again on the next connection', async () => {
  const target = window()
  const client = await connected(target)
  const heard: unknown[] = []
  const stop = client.subscribe('conversation.commands', {}, { onPayload: (payload) => heard.push(payload) })
  await until(() => target.commandListeners.size === 1)
  for (const listener of target.commandListeners) listener({ cli: 'codex', commands: [] })
  await until(() => heard.length === 1)
  target.drop()
  await until(() => target.tickets.length === 2 && target.commandListeners.size === 1)
  for (const listener of target.commandListeners) listener({ cli: 'codex', commands: [{ name: 'review' }] })
  await until(() => heard.length === 2)
  assert.deepEqual(heard, [
    { cli: 'codex', commands: [] },
    { cli: 'codex', commands: [{ name: 'review' }] },
  ])
  stop()
  await until(() => target.commandListeners.size === 0)
})

test('a ref names its folder to a Studio that serves folders', async () => {
  const target = window()
  const client = await connected(target)
  const ref = { workspaceId: 'ws-1', agentId: 'agent-1', workspaceRoot: '/Users/dev/app/.worktrees/run-1' }
  const frames: string[] = []
  const stop = client.conversations.follow(ref, undefined, (frame) => frames.push(frame.type))
  await until(() => frames.includes('synchronized'))
  stop()
  const sub = target.sent.find((frame) => frame.t === 'sub')
  assert.deepEqual((sub?.params as { key: unknown }).key, ref)
})

test('a consumer that retries by itself hears a stream Studio could not start, instead of a silent retry', async () => {
  let follows = 0
  const failing: FakeBackend['follow'] = (_key, _cursor, listener: (frame: ConversationSessionFrame) => void) => {
    follows++
    queueMicrotask(() => listener({ type: 'error', message: 'Transcript is busy' }))
    return { dispose: () => undefined, ready: Promise.resolve() }
  }
  const target = window({ follow: failing })
  const client = await connected(target)
  const ref = { workspaceId: 'ws-1', agentId: 'agent-1' }
  const frames: Array<{ type: string; message?: string }> = []
  client.conversations.follow(ref, { resubscribe: false }, (frame) => frames.push(frame))
  await until(() => frames.length === 1)
  assert.deepEqual(frames, [{ type: 'error', message: 'Transcript is busy' }])
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(follows, 1, 'and nothing subscribes again behind its back')
})

test('a reconnect that reaches a different Studio is refused: no cursor resumed, no command sent again', async () => {
  const target = window()
  const client = await connected(target)
  assert.equal(client.welcome.environment.id, 'env-test')
  const ref = { workspaceId: 'ws-1', agentId: 'agent-1' }
  const frames: Array<{ type: string; message?: string }> = []
  client.conversations.follow(ref, undefined, (frame) => frames.push(frame))
  await until(() => frames.some((frame) => frame.type === 'synchronized'))
  const subscribed = () => target.sent.filter((frame) => frame.t === 'sub').length
  const before = subscribed()
  target.replace('env-elsewhere')
  target.drop()
  const pending = client.request('server.info', {})
  await assert.rejects(client.closed, (error: { code?: string }) => error.code === 'environment_changed')
  await assert.rejects(pending, (error: { code?: string }) => error.code === 'environment_changed')
  assert.equal(subscribed(), before, 'no stream resumed its cursor over there')
  const infos = target.sent.filter((frame) => frame.t === 'req' && frame.method === 'server.info')
  assert.equal(infos.length, 1, 'and the request in flight was not sent again')
  assert.equal(frames.at(-1)?.type, 'error')

  // A client bound to a Studio up front refuses any other from the start.
  await assert.rejects(
    connect({ transport: target.transport, client: { name: 'w' }, environmentId: 'env-test', reconnect: false }),
    (error: { code?: string }) => error.code === 'environment_changed',
  )
})

test('offline, a client parks with what it was asked kept, and the network coming back wakes it', async () => {
  const events = new EventTarget()
  const navigator = { onLine: true }
  vi.stubGlobal('navigator', navigator)
  vi.stubGlobal('addEventListener', events.addEventListener.bind(events))
  vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events))
  try {
    const target = window()
    const client = await connected(target)
    navigator.onLine = false
    target.drop()
    const stateOf = () => client.state as string
    for (let tries = 0; stateOf() !== 'parked' && tries < 100; tries++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(stateOf(), 'parked')
    assert.equal(target.tickets.length, 1, 'and it does not try while offline')
    // Kept, not refused: it goes out once the network is back.
    const asked = client.request('workspaces.list', {} as never).then(
      () => 'answered',
      (error: { code?: string }) => error.code,
    )
    navigator.onLine = true
    events.dispatchEvent(new Event('online'))
    for (let tries = 0; stateOf() !== 'open' && tries < 100; tries++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(stateOf(), 'open')
    assert.equal(target.tickets.length, 2)
    // This test's chat surface has no workspaces: refused, but by Studio, so it went out.
    assert.notEqual(await asked, 'offline')
  } finally {
    vi.unstubAllGlobals()
  }
})

test('a client of a Studio on this machine keeps reconnecting while the device is offline', async () => {
  vi.stubGlobal('navigator', { onLine: false })
  try {
    const target = window()
    const client = await connect({
      transport: target.transport,
      client: { name: 'Studio window' },
      reconnect: { initialDelayMs: 5, maxDelayMs: 20 },
      parkWhenOffline: false,
    })
    cleanups.push(() => client.close())
    target.drop()
    await until(() => target.tickets.length === 2 && client.state === 'open')
  } finally {
    vi.unstubAllGlobals()
  }
})

test('a stream’s cursor is what its consumer has read, never what is still waiting to be read', async () => {
  const target = window()
  const client = await connected(target)
  const stream = client.conversation({ workspaceId: 'ws-1', agentId: 'agent-1' }).events()
  for (let next = await stream.next(); next.value?.type !== 'synchronized'; next = await stream.next());
  const fenced = stream.cursor
  assert.ok(fenced)
  // A second follower on the same connection says when both events have
  // reached this client, so the stream has them waiting, unread.
  const arrived: string[] = []
  let watchingLive = false
  const watching = client.conversations.follow({ workspaceId: 'ws-1', agentId: 'agent-1' }, undefined, (frame) => {
    if (frame.type === 'synchronized') watchingLive = true
    if (frame.type === 'event') arrived.push(String(frame.event.payload?.text))
  })
  await until(() => watchingLive)
  target.backend.emit('agent-1', 'user_message', { text: 'one' })
  target.backend.emit('agent-1', 'user_message', { text: 'two' })
  await until(() => arrived.length === 2)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(arrived, ['one', 'two'])
  // Received, not yet read: the cursor has not moved.
  assert.deepEqual(stream.cursor, fenced)
  const first = await stream.next()
  assert.equal(first.value?.type === 'event' && first.value.event.payload?.text, 'one')
  assert.equal(stream.cursor?.afterSeq, (first.value?.type === 'event' && first.value.event.seq) || -1)
  const second = await stream.next()
  assert.equal(stream.cursor?.afterSeq, (second.value?.type === 'event' && second.value.event.seq) || -1)
  stream.close()
  watching()
})

test('a request answered busy just before a drop is sent once on the next connection, not again by its retry', async () => {
  let refused: string | null = null
  let target: Window | null = null
  target = window({
    rewrite: (frame) => {
      if (frame.t !== 'res' || typeof frame.id !== 'string' || !frame.id.startsWith('r')) return frame
      // Its answer on the next connection is held back, so the request is still waiting when the retry is due.
      if (refused === frame.id) return { t: 'held' }
      refused = frame.id
      // Busy, and then the connection drops before the retry is due.
      setTimeout(() => target?.drop(), 0)
      return { t: 'res', id: frame.id, ok: false, error: { code: 'busy', message: 'Busy.', retryAfterMs: 150 } }
    },
  })
  const client = await connected(target)
  void client.conversations.list().catch(() => undefined)
  await until(() => refused !== null && target!.tickets.length === 2 && client.state === 'open')
  await new Promise((resolve) => setTimeout(resolve, 300))
  const secondHello = target.sent.findIndex((frame, index) => frame.t === 'hello' && index > 0)
  const resent = target.sent.slice(secondHello).filter((frame) => frame.t === 'req' && frame.id === refused)
  assert.equal(resent.length, 1)
})

test('a socket that never opens is given up after its open timeout, and closed', async () => {
  let closed = 0
  class Silent {
    readyState = 0
    send(): void {}
    close(): void {
      closed++
    }
    addEventListener(): void {}
  }
  const transport = webSocketTransport({
    ticket: async () => ({ url: 'ws://127.0.0.1:1/ws?ticket=t', token: 't' }),
    WebSocket: Silent as never,
    openTimeoutMs: 20,
  })
  await assert.rejects(transport(), /did not answer in time/)
  assert.equal(closed, 1)
})

// ── Reconnecting, as the window meets it ────────────────────────────────────
// One case each: a dropped socket, a refused ticket, a sleep and a wake, and a
// server that came back on another port. The client's connection is kept by
// the runtime's connection supervisor, so these are its rules as a window
// sees them.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('a dropped socket is made again with a fresh ticket: its stream resumes and a request in flight is sent once', async () => {
  const target = window()
  const states: StudioClientState[] = []
  const client = await connected(target, { onStateChange: (state) => states.push(state) })
  const ref = { workspaceId: 'ws-1', agentId: 'agent-1' }
  const texts: string[] = []
  let fences = 0
  client.conversations.follow(ref, undefined, (frame) => {
    if (frame.type === 'synchronized') fences++
    if (frame.type === 'event') texts.push(String(frame.event.payload?.text))
  })
  await until(() => fences === 1)
  target.backend.emit('agent-1', 'user_message', { text: 'before' })
  await until(() => texts.length === 1)
  target.drop()
  const answered = client.request('server.info', {})
  target.backend.emit('agent-1', 'user_message', { text: 'while away' })
  await until(() => client.state === 'open' && fences === 2)
  await answered
  target.backend.emit('agent-1', 'user_message', { text: 'after' })
  await until(() => texts.length === 3)
  assert.deepEqual(texts, ['before', 'while away', 'after'], 'no gap and no repeat')
  assert.deepEqual(states, ['open', 'reconnecting', 'open'])
  assert.equal(target.tickets.length, 2)
  const secondHello = target.sent.findIndex((frame, index) => frame.t === 'hello' && index > 0)
  const infos = target.sent.slice(secondHello).filter((frame) => frame.t === 'req' && frame.method === 'server.info')
  assert.equal(infos.length, 1, 'asked once on the new connection')
})

test('a refused ticket parks the window: what waited hears why, nothing is asked again, and a wake asks a new ticket', async () => {
  const target = window()
  const states: StudioClientState[] = []
  const client = await connected(target, { onStateChange: (state) => states.push(state) })
  const stream = client.conversation({ workspaceId: 'ws-1', agentId: 'agent-1' }).events()
  for (let next = await stream.next(); next.value?.type !== 'synchronized'; next = await stream.next());
  target.refuseTickets = true
  target.drop()
  await until(() => client.state === 'parked')
  await assert.rejects(stream.next(), (error: { code?: string }) => error.code === 'unauthorized')
  await assert.rejects(client.request('server.info', {}), (error: { code?: string }) => error.code === 'unauthorized')
  const asked = target.tickets.length
  await sleep(100)
  assert.equal(target.tickets.length, asked, 'a refused credential is not tried again on a timer')
  assert.deepEqual(states, ['open', 'reconnecting', 'parked'])
  target.refuseTickets = false
  client.wake()
  await until(() => client.state === 'open')
  assert.equal(target.tickets.length, asked + 1)
  assert.deepEqual(states, ['open', 'reconnecting', 'parked', 'reconnecting', 'open'])
})

test('after a sleep, a wake pings the connection and keeps it if it answers, and makes it again if not', async () => {
  const target = window()
  const states: StudioClientState[] = []
  const client = await connected(target, {
    onStateChange: (state) => states.push(state),
    heartbeat: { intervalMs: 60_000, timeoutMs: 50 },
  })
  const pings = () => target.sent.filter((frame) => frame.t === 'req' && frame.method === 'server.ping').length
  // Awake and answering: one ping, and the same connection.
  client.wake()
  await until(() => pings() === 1)
  await sleep(100)
  assert.equal(client.state, 'open')
  assert.equal(target.tickets.length, 1, 'a connection that answers is not made again')
  assert.deepEqual(states, ['open'])
  // Half-open after the sleep: the ping goes unanswered, and the connection is replaced at once.
  target.silence()
  client.wake()
  await until(() => pings() === 2)
  await until(() => target.tickets.length === 2 && client.state === 'open')
  assert.deepEqual(states, ['open', 'reconnecting', 'open'])

  // Asleep through a long backoff: a wake tries at once instead of waiting it out.
  const sleeper = window()
  const parked = await connected(sleeper, { reconnect: { initialDelayMs: 60_000, maxDelayMs: 60_000 } })
  sleeper.ticketsFail = true
  sleeper.drop()
  await until(() => parked.state === 'reconnecting')
  await sleep(20)
  sleeper.ticketsFail = false
  parked.wake()
  await until(() => parked.state === 'open')
  assert.equal(sleeper.tickets.length, 2)
})

test('a server restarted on another port is found again by the next ticket, and its streams resume', async () => {
  const target = window()
  const client = await connected(target)
  const ref = { workspaceId: 'ws-1', agentId: 'agent-1' }
  const texts: string[] = []
  let fences = 0
  client.conversations.follow(ref, undefined, (frame) => {
    if (frame.type === 'synchronized') fences++
    if (frame.type === 'event') texts.push(String(frame.event.payload?.text))
  })
  await until(() => fences === 1)
  target.backend.emit('agent-1', 'user_message', { text: 'one' })
  await until(() => texts.length === 1)
  // Down for a moment: no ticket can be had, and the client keeps trying.
  target.ticketsFail = true
  await target.restart()
  await until(() => client.state === 'reconnecting')
  await sleep(30)
  assert.equal(client.state, 'reconnecting')
  target.backend.emit('agent-1', 'user_message', { text: 'two' })
  target.ticketsFail = false
  await until(() => client.state === 'open' && fences === 2)
  assert.equal(target.port, 2)
  target.backend.emit('agent-1', 'user_message', { text: 'three' })
  await until(() => texts.length === 3)
  assert.deepEqual(texts, ['one', 'two', 'three'])
  assert.equal(client.welcome.environment.id, 'env-test')
})
