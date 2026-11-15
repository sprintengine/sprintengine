import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test, vi } from 'vitest'

import { STUDIO_WINDOW_TICKET_CHANNEL } from '../../shared/studio-connection'

// Main's half of a window's connection: a ticket only for an app window's own
// document, minted for that document's origin, under a name that is the
// document's alone, and revoked the moment the document goes.

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: (sender: { window?: object }) => sender.window ?? null },
}))

const appUrl = 'file:///Applications/SprintEngine%20Studio.app/Contents/Resources/app.asar/out/renderer/index.html'

function windowEvent(id: number, options: { url?: string; parent?: object | null } = {}) {
  const sender = Object.assign(new EventEmitter(), { id, window: {} })
  return { sender, senderFrame: { parent: options.parent ?? null, url: options.url ?? appUrl } }
}

async function register(mint?: (request: { windowKey: string; origin: string }) => Promise<void>) {
  const { registerStudioWindowTicketIpc } = await import('./studio-window-ticket-ipc')
  const handlers = new Map<string, (event: unknown) => Promise<unknown>>()
  const asked: Array<{ windowKey: string; origin: string }> = []
  const revoked: string[] = []
  registerStudioWindowTicketIpc(
    {
      handle: (channel: string, handler: (event: unknown) => Promise<unknown>) => handlers.set(channel, handler),
    } as never,
    {
      windowTicket: async (request) => {
        asked.push(request)
        await mint?.(request)
        return { url: `ws://127.0.0.1:4100/ws?ticket=t${asked.length}`, token: `t${asked.length}` }
      },
      revokeWindow: (windowKey) => void revoked.push(windowKey),
    },
  )
  return { ask: handlers.get(STUDIO_WINDOW_TICKET_CHANNEL)!, asked, revoked }
}

test('an app window gets a ticket for its own origin, under one name for the life of its document', async () => {
  const { ask, asked } = await register()
  const event = windowEvent(7)
  assert.deepEqual(await ask(event), { url: 'ws://127.0.0.1:4100/ws?ticket=t1', token: 't1' })
  await ask(event)
  assert.equal(asked.length, 2)
  assert.equal(asked[0].origin, 'file://')
  assert.equal(asked[0].windowKey, asked[1].windowKey, 'a reconnect is the same window')
  // Under the dev server, the window's origin is the dev server's.
  const dev = await register()
  vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
  try {
    await dev.ask(windowEvent(8, { url: 'http://localhost:5173/' }))
    assert.equal(dev.asked[0].origin, 'http://localhost:5173')
  } finally {
    vi.unstubAllEnvs()
  }
})

test('a subframe, a page the window navigated to, or a guest is given no ticket', async () => {
  const { ask, asked } = await register()
  await assert.rejects(ask(windowEvent(1, { parent: {} })), /did not come from a SprintEngine Studio window/)
  await assert.rejects(ask(windowEvent(2, { url: 'https://example.com/' })), /SprintEngine Studio window/)
  const guest = windowEvent(3)
  ;(guest.sender as { window?: object }).window = undefined
  await assert.rejects(ask(guest), /SprintEngine Studio window/)
  assert.equal(asked.length, 0)
})

test('a document that goes is revoked at once, and the next document is a window of its own', async () => {
  const { ask, asked, revoked } = await register()
  const event = windowEvent(9)
  await ask(event)
  const first = asked[0].windowKey

  // A hash change keeps the document; a subframe's navigation is not the
  // window's. Nor is a navigation that only starts: Electron emits
  // `did-start-navigation` before `will-navigate`, where the window guard
  // refuses one that leaves the app, and that document stays.
  event.sender.emit('did-navigate-in-page', {}, `${appUrl}#x`, true)
  event.sender.emit('did-frame-navigate', {}, 'https://example.com/', 200, 'OK', false)
  event.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://example.com/' })
  assert.deepEqual(revoked, [])

  // A reload, or any navigation that commits, replaces it.
  event.sender.emit('did-navigate', {}, appUrl, 200, 'OK')
  assert.deepEqual(revoked, [first])
  await ask(event)
  const second = asked[1].windowKey
  assert.notEqual(second, first)

  // A crashed renderer, then a closed window.
  event.sender.emit('render-process-gone')
  assert.deepEqual(revoked, [first, second])
  await ask(event)
  event.sender.emit('destroyed')
  assert.deepEqual(revoked, [first, second, asked[2].windowKey])
  // Each document was revoked once, however many of its events came after.
  event.sender.emit('destroyed')
  assert.equal(revoked.length, 3)
})

test('a document that goes while its ticket is minted gets none, and the ticket is revoked again', async () => {
  const event = windowEvent(11)
  let minted!: () => void
  const { ask, asked, revoked } = await register(() => new Promise<void>((resolve) => (minted = resolve)))
  const asking = ask(event)
  await vi.waitFor(() => assert.equal(asked.length, 1))
  // The revoke may reach nothing (a server still starting), so it is sent again after the mint.
  event.sender.emit('did-navigate', {}, appUrl, 200, 'OK')
  minted()
  await assert.rejects(asking, /changed while it was connecting/)
  assert.deepEqual(revoked, [asked[0].windowKey, asked[0].windowKey])
})

test('a machine reached through the environments bridge keys each document afresh, and is told when it goes', async () => {
  const { registerEnvironmentsIpc } = await import('./environments-ipc')
  const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>()
  const asked: Array<{ route: string; windowKey: string }> = []
  const revoked: string[] = []
  registerEnvironmentsIpc(
    {
      handle: (channel: string, handler: (event: unknown, payload?: unknown) => Promise<unknown>) =>
        handlers.set(channel, handler),
      removeHandler: () => undefined,
    } as never,
    {
      environments: { list: () => [], onChanged: () => () => undefined, retry: async () => undefined } as never,
      broadcast: () => undefined,
      ticket: async (route, _origin, windowKey) => {
        asked.push({ route: `${route.kind}:${(route as { machine?: string }).machine ?? ''}`, windowKey })
        return { ok: true, url: 'ws://127.0.0.1:4200/ws?ticket=t', token: 't' }
      },
      revokeWindow: (windowKey) => void revoked.push(windowKey),
    },
  )
  const ask = handlers.get('environments:ticket')!
  const event = windowEvent(11)
  await ask(event, { route: 'ssh:m1' })
  await ask(event, { route: 'ssh:m1' })
  assert.equal(asked[0].windowKey, asked[1].windowKey, 'a reconnect is the same document')
  assert.match(asked[0].windowKey, /^window-11-\d+$/u)
  // A reload is a new document: the machine is told the old one went, and the new one has a name of its own.
  event.sender.emit('did-navigate')
  assert.deepEqual(revoked, [asked[0].windowKey])
  await ask(event, { route: 'ssh:m1' })
  assert.notEqual(asked[2].windowKey, asked[0].windowKey)
  event.sender.emit('destroyed')
  assert.deepEqual(revoked, [asked[0].windowKey, asked[2].windowKey])
})
