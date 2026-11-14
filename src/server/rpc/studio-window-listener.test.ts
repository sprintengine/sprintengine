import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { request } from 'node:http'
import { afterEach, test } from 'vitest'

import {
  connect,
  webSocketTransport,
  type StudioClient,
  type StudioWebSocketConstructor,
} from '../../../packages/client-runtime/src/public'
import { createFakeAuthenticator, createFakeBackend, type FakeBackend } from './studio-rpc.test-helper'
import { createStudioRpcServer, type StudioRpcServer } from './studio-rpc-server'
import { createStudioWindowListener, WINDOW_TICKET_TTL_MS, type StudioWindowListener } from './studio-window-listener'

// A window's way to its server: a WebSocket on 127.0.0.1, admitted only by a
// ticket main asked for on that window's behalf, from that window's origin.
// Each refusal is checked on a raw upgrade, as any process on the machine
// could send one; the admitted path is driven by the SDK client over Node's
// own WebSocket, as the window's renderer drives it.

const APP_ORIGIN = 'file://'
const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Host = {
  backend: FakeBackend
  server: StudioRpcServer
  listener: StudioWindowListener
  clock: { now: number }
}

function host(backend: FakeBackend = createFakeBackend(), clock = { now: Date.now() }): Host {
  const server = createStudioRpcServer({
    dataDir: '/nonexistent/window-listener',
    version: '0.0.0-test',
    environmentId: 'env-window',
    backend,
    authenticator: createFakeAuthenticator(),
  })
  const listener = createStudioWindowListener({
    attach: (stream, authenticator) => server.attach(stream, { authenticator, ownWindow: true }),
    now: () => clock.now,
  })
  cleanups.push(async () => {
    await server.stop(1)
    await listener.stop()
  })
  return { backend, server, listener, clock }
}

/** Node's WebSocket, saying the origin a window's would. */
function socketFrom(origin: string): StudioWebSocketConstructor {
  const NodeWebSocket = (globalThis as unknown as { WebSocket: new (url: string, init: unknown) => unknown }).WebSocket
  return class {
    constructor(url: string) {
      return new NodeWebSocket(url, { headers: { origin } }) as never
    }
  } as unknown as StudioWebSocketConstructor
}

async function windowClient(ticket: () => ReturnType<StudioWindowListener['ticket']>): Promise<StudioClient> {
  const client = await connect({
    transport: webSocketTransport({ ticket, WebSocket: socketFrom(APP_ORIGIN) }),
    client: { name: 'Studio window' },
    reconnect: { initialDelayMs: 5, maxDelayMs: 20 },
  })
  cleanups.push(() => client.close())
  return client
}

/** An upgrade by hand: what the listener answers before any WebSocket exists. */
function upgrade(
  url: string,
  /** A header given `null` is not sent at all. */
  headers: Record<string, string | null> = {},
): Promise<{ status: number; code: string | undefined }> {
  const target = new URL(url)
  const sent = Object.fromEntries(
    Object.entries({
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      Origin: APP_ORIGIN,
      ...headers,
    }).filter((entry): entry is [string, string] => entry[1] !== null),
  )
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: Number(target.port),
      path: `${target.pathname}${target.search}`,
      headers: sent,
    })
    req.on('response', (response) => {
      response.resume()
      resolve({ status: response.statusCode ?? 0, code: response.headers['x-studio-error'] as string | undefined })
    })
    req.on('upgrade', (_response, socket) => {
      socket.destroy()
      resolve({ status: 101, code: undefined })
    })
    req.on('error', reject)
    req.end()
  })
}

const until = async (check: () => boolean) => {
  for (let tries = 0; !check() && tries < 400; tries++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(check())
}

test('a window connects with its ticket over a loopback socket, as the owner, and only on 127.0.0.1', async () => {
  const { listener } = host()
  const issued: string[] = []
  const client = await windowClient(async () => {
    const ticket = await listener.ticket({ windowKey: 'window-1-1', origin: APP_ORIGIN })
    issued.push(ticket.token)
    return ticket
  })
  assert.equal(client.state, 'open')
  assert.equal(client.grant.owner, true)
  assert.match(listener.address() ?? '', /^ws:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(issued.length, 1)
})

test('a socket without a good ticket is refused before it opens', async () => {
  const { listener } = host()
  const base = listener.address() ?? (await listener.ticket({ windowKey: 'w', origin: APP_ORIGIN })).url
  const port = new URL(base).port

  assert.deepEqual(await upgrade(`ws://127.0.0.1:${port}/ws`), { status: 401, code: 'ticket_required' })
  assert.deepEqual(await upgrade(`ws://127.0.0.1:${port}/ws?ticket=seticket_made_up_ticket_000000`), {
    status: 401,
    code: 'ticket_spent_or_expired',
  })

  // Good once: the second presentation is refused.
  const once = await listener.ticket({ windowKey: 'w', origin: APP_ORIGIN })
  assert.equal((await upgrade(once.url)).status, 101)
  assert.deepEqual(await upgrade(once.url), { status: 401, code: 'ticket_spent_or_expired' })

  // Good for thirty seconds.
  const clock = host().clock
  const late = host(createFakeBackend(), clock)
  const stale = await late.listener.ticket({ windowKey: 'w', origin: APP_ORIGIN })
  clock.now += WINDOW_TICKET_TTL_MS + 1
  assert.deepEqual(await upgrade(stale.url), { status: 401, code: 'ticket_spent_or_expired' })
})

test('a page on another origin, a rebound host name and another path are refused, and spend the ticket', async () => {
  const { listener } = host()
  const foreign = await listener.ticket({ windowKey: 'w', origin: APP_ORIGIN })
  assert.deepEqual(await upgrade(foreign.url, { Origin: 'https://example.com' }), {
    status: 403,
    code: 'origin_refused',
  })
  assert.deepEqual(await upgrade(foreign.url), { status: 401, code: 'ticket_spent_or_expired' })

  const unlabelled = await listener.ticket({ windowKey: 'w', origin: 'http://localhost:5173' })
  assert.deepEqual(await upgrade(unlabelled.url, { Origin: APP_ORIGIN }), { status: 403, code: 'origin_refused' })

  // An opaque origin (a sandboxed frame, a data: page) is no file-loaded window.
  const opaque = await listener.ticket({ windowKey: 'w', origin: 'file://' })
  assert.deepEqual(await upgrade(opaque.url, { Origin: 'null' }), { status: 403, code: 'origin_refused' })

  const rebound = await listener.ticket({ windowKey: 'w', origin: APP_ORIGIN })
  const port = new URL(rebound.url).port
  assert.deepEqual(await upgrade(rebound.url, { Host: `studio.example.com:${port}` }), {
    status: 403,
    code: 'wrong_host',
  })

  assert.deepEqual(await upgrade(`ws://127.0.0.1:${port}/ws/ipc`), { status: 404, code: 'not_found' })
})

test('a hello that presents anything but its socket’s ticket is refused', async () => {
  const { listener } = host()
  await assert.rejects(
    connect({
      transport: webSocketTransport({
        ticket: async () => ({
          ...(await listener.ticket({ windowKey: 'w', origin: APP_ORIGIN })),
          token: 'seticket_not_the_ticket_000000',
        }),
        WebSocket: socketFrom(APP_ORIGIN),
      }),
      client: { name: 'Studio window' },
      reconnect: false,
    }),
    /spent, expired or wrong/,
  )
})

test('a window that goes takes its connections and its unspent tickets with it; another window keeps its own', async () => {
  const { listener } = host()
  const gone = await windowClient(() => listener.ticket({ windowKey: 'window-1-1', origin: APP_ORIGIN }))
  const kept = await windowClient(() => listener.ticket({ windowKey: 'window-2-1', origin: APP_ORIGIN }))
  const unspent = await listener.ticket({ windowKey: 'window-1-1', origin: APP_ORIGIN })

  listener.revokeWindow('window-1-1')
  // Told it was revoked, the client stops: it does not reconnect behind a window that has gone.
  await until(() => gone.state === 'parked')
  assert.equal(kept.state, 'open')
  assert.deepEqual(await upgrade(unspent.url), { status: 401, code: 'ticket_spent_or_expired' })
})

test('a window holds a few connections at most; past them its oldest is closed', async () => {
  const { listener } = host()
  const clients: StudioClient[] = []
  for (let index = 0; index < 5; index++)
    clients.push(await windowClient(() => listener.ticket({ windowKey: 'window-1-1', origin: APP_ORIGIN })))
  await until(() => clients[0].state === 'parked')
  assert.deepEqual(
    clients.slice(1).map((client) => client.state),
    ['open', 'open', 'open', 'open'],
  )
})

test('after the server restarts on another port, the window comes back with a fresh ticket and resumes with no gap or repeat', async () => {
  const backend = createFakeBackend()
  let current = host(backend)
  const tickets: string[] = []
  const client = await windowClient(async () => {
    const ticket = await current.listener.ticket({ windowKey: 'window-1-1', origin: APP_ORIGIN })
    tickets.push(ticket.token)
    return ticket
  })
  const seqs: number[] = []
  const stop = client.conversations.follow({ workspaceId: 'ws-1', agentId: 'agent-1' }, undefined, (frame) => {
    if (frame.type === 'event') seqs.push(frame.event.seq ?? -1)
  })
  cleanups.push(() => stop())
  await until(() => backend.followers('agent-1') === 1)
  backend.emit('agent-1', 'content_delta', { text: 'one' })
  backend.emit('agent-1', 'content_delta', { text: 'two' })
  await until(() => seqs.length === 2)

  // The server goes; what is written meanwhile is waiting in the log.
  const firstPort = new URL(current.listener.address() ?? '').port
  await current.server.stop(1)
  await current.listener.stop()
  backend.emit('agent-1', 'content_delta', { text: 'three' })
  current = host(backend)
  backend.emit('agent-1', 'content_delta', { text: 'four' })

  await until(() => seqs.length === 4 && client.state === 'open')
  assert.notEqual(new URL(current.listener.address() ?? '').port, firstPort, 'the restarted server listens elsewhere')
  backend.emit('agent-1', 'content_delta', { text: 'five' })
  await until(() => seqs.length === 5)
  assert.deepEqual(seqs, [1, 2, 3, 4, 5])
  assert.ok(tickets.length >= 2)
  assert.equal(new Set(tickets).size, tickets.length, 'a ticket is never presented twice')
})

/**
 * A stand-in for the front door's `ws`: each socket on its own port carried
 * to the listener as a plain duplex (no socket's methods), as a mux stream is.
 */
async function carrier(listener: StudioWindowListener): Promise<number> {
  const { createServer } = await import('node:net')
  const { Duplex } = await import('node:stream')
  const relay = createServer((socket) => {
    const carried = new Duplex({
      read() {
        socket.resume()
      },
      write(chunk, _encoding, callback) {
        socket.write(chunk, callback)
      },
      final(callback) {
        socket.end()
        callback()
      },
      destroy(error, callback) {
        socket.destroy()
        callback(error)
      },
    })
    socket.on('data', (chunk) => {
      if (!carried.push(chunk)) socket.pause()
    })
    socket.on('end', () => carried.push(null))
    socket.on('close', () => carried.destroy())
    listener.accept(carried)
  })
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => relay.close(() => resolve())))
  return (relay.address() as { port: number }).port
}

/** A ticket's URL, sent to the carrier's port in its place, as main's loopback route does. */
const through = (url: string, port: number) => url.replace(/^ws:\/\/127\.0\.0\.1:\d+/u, `ws://127.0.0.1:${port}`)

test('a window socket carried to the listener as a stream is held to everything a socket on its port is', async () => {
  const { listener } = host()
  const port = await carrier(listener)
  const client = await windowClient(async () => {
    const ticket = await listener.ticket({ windowKey: 'window-1-1', origin: APP_ORIGIN })
    return { ...ticket, url: through(ticket.url, port) }
  })
  assert.equal(client.state, 'open')
  assert.equal(client.grant.owner, true)

  const once = await listener.ticket({ windowKey: 'w', origin: APP_ORIGIN })
  assert.equal((await upgrade(through(once.url, port))).status, 101)
  assert.deepEqual(await upgrade(through(once.url, port)), { status: 401, code: 'ticket_spent_or_expired' })
  assert.deepEqual(await upgrade(`ws://127.0.0.1:${port}/ws`), { status: 401, code: 'ticket_required' })
  const foreign = await listener.ticket({ windowKey: 'w', origin: APP_ORIGIN })
  assert.deepEqual(await upgrade(through(foreign.url, port), { Origin: 'https://example.com' }), {
    status: 403,
    code: 'origin_refused',
  })
  const rebound = await listener.ticket({ windowKey: 'w', origin: APP_ORIGIN })
  assert.deepEqual(await upgrade(through(rebound.url, port), { Host: `studio.example.com:${port}` }), {
    status: 403,
    code: 'wrong_host',
  })
})

test('a stream carried to a listener that has stopped is closed, not served', async () => {
  const { listener } = host()
  await listener.ticket({ windowKey: 'w', origin: APP_ORIGIN })
  await listener.stop()
  const { PassThrough } = await import('node:stream')
  const stream = new PassThrough()
  listener.accept(stream)
  await until(() => stream.destroyed)
})

test('a listener serves no path for paired devices: a window ticket on `/device` is not found', async () => {
  const { listener } = host()
  const windowTicket = await listener.ticket({ windowKey: 'w', origin: APP_ORIGIN })
  assert.deepEqual(await upgrade(windowTicket.url.replace('/ws?', '/device?')), { status: 404, code: 'not_found' })
})
