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

async function register() {
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

  // A hash change keeps the document; a subframe's navigation is not the window's.
  event.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  event.sender.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
  assert.deepEqual(revoked, [])

  // A reload replaces it.
  event.sender.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
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
