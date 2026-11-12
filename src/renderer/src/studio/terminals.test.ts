import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import type { StudioWebSocketConstructor } from '../../../../packages/client-runtime/src/public'
import { STUDIO_TERMINAL_MAX_WRITE_UNITS } from '../../../../packages/studio-protocol/src/public'
import { createStudioRpcServer, type StudioRpcServer } from '../../../server/rpc/studio-rpc-server'
import { createFakeAuthenticator, createFakeBackend } from '../../../server/rpc/studio-rpc.test-helper'
import { createStudioWindowListener } from '../../../server/rpc/studio-window-listener'
import type { StudioGrant } from '../../../../packages/studio-protocol/src/public'
import { createStudioTerminals } from '../../../server/terminals/studio-terminals'
import {
  createFakeTerminalRuntime,
  fakeTerminalSnapshot,
  type FakeTerminalRuntime,
} from '../../../server/terminals/fake-terminal-runtime.test-helper'
import {
  listTerminals,
  onTerminalData,
  onTerminalReplay,
  onTerminalSessionsDelta,
  openTerminal,
  resetTerminalsForTests,
  terminalWritePieces,
  writeTerminal,
} from './terminals'
import { configureWindowStudio, windowStudioClient } from './windowStudioClient'

// The window's terminals over its real connection: a window listener, a
// Studio RPC server in front of a fake runtime, and this module driving them
// as a pane does. What it holds the window to: a long paste arrives whole and
// in order; output keeps reaching a pane after its connection comes back and
// after its client is replaced; and the sessions stream starts even when the
// window's first connect fails.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  resetTerminalsForTests()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  delete (globalThis as { window?: unknown }).window
})

function socketFromWindow(sent?: string[]): StudioWebSocketConstructor {
  const NodeWebSocket = (globalThis as unknown as { WebSocket: new (url: string, init: unknown) => unknown }).WebSocket
  return class {
    constructor(url: string) {
      const socket = new NodeWebSocket(url, { headers: { origin: 'file://' } }) as { send(data: string): void }
      if (sent) {
        const send = socket.send.bind(socket)
        socket.send = (data: string) => {
          sent.push(String(data))
          send(data)
        }
      }
      return socket as never
    }
  } as unknown as StudioWebSocketConstructor
}

/** A window of its own over a Studio whose server can be restarted, as a crash and relaunch would. */
async function windowOver(
  runtime: FakeTerminalRuntime,
  options: { failFirstTickets?: number; withoutTerminalScopes?: boolean; sent?: string[] } = {},
) {
  const terminals = createStudioTerminals({ runtime })
  const serve = (): StudioRpcServer =>
    createStudioRpcServer({
      dataDir: '/nonexistent/window-terminals',
      version: '0.0.0-test',
      environmentId: 'env-window-terminals',
      backend: createFakeBackend(),
      authenticator: createFakeAuthenticator(),
      terminals,
    })
  let server = serve()
  // A connection whose grant holds no terminal scope, as a browser tab's does.
  const narrow = (grant: StudioGrant): StudioGrant => ({
    ...grant,
    owner: false,
    scopes: grant.scopes.filter((scope) => !scope.startsWith('terminal:')),
  })
  const listener = createStudioWindowListener({
    attach: (stream, authenticator, windowKey) =>
      options.withoutTerminalScopes
        ? server.attach(stream, {
            authenticator: {
              ...authenticator,
              authenticate: (auth, client) => {
                const outcome = authenticator.authenticate(auth, client)
                return outcome.ok ? { ...outcome, grant: narrow(outcome.grant) } : outcome
              },
              grantFor: (clientId) => {
                const grant = authenticator.grantFor(clientId)
                return grant ? narrow(grant) : null
              },
            },
            ownWindow: false,
            windowKey,
          })
        : server.attach(stream, { authenticator, ownWindow: true, windowKey }),
  })
  let failing = options.failFirstTickets ?? 0
  const api = {
    studioWindowTicket: async () => {
      if (failing > 0) {
        failing -= 1
        throw new Error('Studio is not up yet.')
      }
      return listener.ticket({ windowKey: 'window-1-1', origin: 'file://' })
    },
  }
  configureWindowStudio(api, { WebSocket: socketFromWindow(options.sent) })
  ;(globalThis as { window?: unknown }).window = { api }
  cleanups.push(async () => {
    const client = await windowStudioClient(api).catch(() => null)
    client?.close()
    await server.stop(1)
    await listener.stop()
  })
  return {
    api,
    /** The server goes and a new one takes its place: every connection drops and is made again. */
    async restart() {
      await server.stop(1)
      server = serve()
    },
  }
}

const until = async (check: () => boolean, what: string) => {
  const deadline = Date.now() + 10_000
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(check(), what)
}

test('a paste is cut into pieces the protocol takes, never splitting a character', () => {
  const pieces = terminalWritePieces('a'.repeat(9) + '😀' + 'b'.repeat(5), 10)
  assert.deepEqual(
    pieces,
    ['a'.repeat(9), '😀' + 'b'.repeat(5)].flatMap((piece) => terminalWritePieces(piece, 10)),
  )
  assert.ok(pieces.every((piece) => piece.length <= 10))
  assert.equal(pieces.join(''), 'a'.repeat(9) + '😀' + 'b'.repeat(5))
})

test('a long paste reaches the terminal whole and in order, before what is typed after it', async () => {
  const runtime = createFakeTerminalRuntime()
  await windowOver(runtime)
  assert.equal((await openTerminal('term-1', 80, 24)).ok, true)
  const paste = 'x'.repeat(STUDIO_TERMINAL_MAX_WRITE_UNITS * 2 + 17)
  const written = await Promise.all([writeTerminal('term-1', paste), writeTerminal('term-1', '\r')])
  assert.deepEqual(written, [true, true])
  const typed = runtime.terminals.get('term-1')!.written
  assert.equal(typed.length, 4, 'three pieces of the paste, then the return')
  assert.ok(typed.every((piece) => piece.length <= STUDIO_TERMINAL_MAX_WRITE_UNITS))
  assert.equal(typed.join(''), `${paste}\r`)
})

test('a pane keeps its output when the connection comes back and when the client is replaced', async () => {
  const runtime = createFakeTerminalRuntime()
  const window = await windowOver(runtime)
  let data = ''
  let replays = 0
  const stopData = onTerminalData('term-1', (chunk) => (data += chunk))
  const stopReplay = onTerminalReplay('term-1', () => (replays += 1))
  cleanups.push(stopData, stopReplay)
  assert.equal((await openTerminal('term-1', 80, 24)).ok, true)
  runtime.emit('term-1', 'one ')
  await until(() => data === 'one ', 'output before anything happened')

  // The server restarts: the connection drops and is made again, and the
  // pane is shown again fresh on the new one, so it is routed to again.
  await window.restart()
  await until(
    () => runtime.shown.some((shown) => shown.sessionId === 'term-1' && shown.freshPane && shown.visible),
    'shown again fresh on the new connection',
  )
  await until(() => replays >= 1, 'and repainted')
  runtime.emit('term-1', 'two ')
  await until(() => data === 'one two ', 'output after the reconnect')

  // The window's client closes for good and a new one takes its place.
  const shownBefore = runtime.shown.length
  ;(await windowStudioClient(window.api)).close()
  await until(() => runtime.shown.length > shownBefore, 'shown again by the new client')
  runtime.emit('term-1', 'three')
  await until(() => data === 'one two three', 'output on the new client')
})

test('the sessions stream starts, and the list is read, even when the first connect fails', async () => {
  const runtime = createFakeTerminalRuntime()
  runtime.terminals.set('term-1', {
    snapshot: fakeTerminalSnapshot('term-1'),
    viewer: null,
    screen: '',
    written: [],
    acked: 0,
  })
  await windowOver(runtime, { failFirstTickets: 2 })
  const deltas: string[][] = []
  let relisted = 0
  const stop = onTerminalSessionsDelta(
    (delta) => deltas.push(delta.removed),
    () => {
      relisted += 1
    },
  )
  cleanups.push(stop)
  await until(() => relisted >= 1, 'subscribed once the Studio could be reached')
  assert.deepEqual(
    (await listTerminals()).map((session) => session.sessionId),
    ['term-1'],
  )
  runtime.delta({ upserts: [], removed: ['term-0'] })
  await until(() => deltas.length === 1, 'and it hears what changes')
})

test('a stream the grant does not reach is asked for once per connection, not again on a timer', async () => {
  const sent: string[] = []
  await windowOver(createFakeTerminalRuntime(), { withoutTerminalScopes: true, sent })
  const stop = onTerminalSessionsDelta(() => undefined)
  cleanups.push(stop)
  const subscribes = () => sent.filter((frame) => frame.includes('"t":"sub"') && frame.includes('terminal.sessions'))
  await until(() => subscribes().length >= 1, 'asked once')
  // Retrying on a timer would ask again within 250 ms, 1 s and 2 s.
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  assert.equal(
    subscribes().length,
    1,
    'a refusal for what the grant is is not asked again until the connection opens anew',
  )
})
