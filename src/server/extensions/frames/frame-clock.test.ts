// @vitest-environment jsdom

import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'

import { createExtensionFrameHost } from '../../../renderer/src/modules/extension-frame-host'
import { COMPONENT_FRAME_MAX_TIMERS } from '../../../shared/extension-frames'
import { frameBootstrapScript } from './frame-bootstrap'

// A components panel's frame is not drawn, and a browser runs an undrawn
// frame's timers about once a second; its bootstrap hands its timers to the
// window instead (`timer`), runs each when the window wakes it (`wake`), and
// tells the window of one it cleared first (`clear`).

const sent: Array<Record<string, unknown>> = []
const native = { setTimeout: window.setTimeout, setInterval: window.setInterval, clearTimeout: window.clearTimeout }
let hear: (event: MessageEvent) => void

beforeAll(() => {
  hear = (event: MessageEvent) => {
    const data = event.data as Record<string, unknown>
    if (data && data.se === 1 && (data.kind === 'timer' || data.kind === 'clear')) sent.push(data)
  }
  window.addEventListener('message', hear)
  const script = frameBootstrapScript({
    entryPath: 'src/panel.tsx',
    modules: [],
    token: 'se-module-none-',
    surface: { point: 'panels', id: 'p' },
    colorScheme: 'dark',
    components: true,
  })
  // The prelude's own changes to the window are not this test's.
  new Function(script.slice(script.indexOf(';(function (C) {') + 1))()
})

afterAll(() => {
  window.removeEventListener('message', hear)
  Object.assign(window, native)
})

const turn = () => new Promise((resolve) => native.setTimeout(resolve, 0))
// The window wakes timer `id`, as its bridge does (extension-frame-host.ts).
// Here the frame is the top window, so its host is itself.
const wake = (id: unknown) =>
  window.dispatchEvent(new MessageEvent('message', { data: { se: 1, kind: 'wake', id }, source: window }))

test('a timer is asked of the window, and runs when the window wakes it, with its arguments', async () => {
  const ran: unknown[] = []
  const id = window.setTimeout((value: unknown) => ran.push(value), 16, 'arg')
  await turn()
  assert.deepEqual(sent.at(-1), { se: 1, kind: 'timer', id, ms: 16 })
  assert.deepEqual(ran, [])
  wake(id)
  await turn()
  assert.deepEqual(ran, ['arg'])
  wake(id)
  await turn()
  assert.deepEqual(ran, ['arg'], 'a timeout runs once')
})

test('a cleared timer does not run when woken; an interval runs until cleared', async () => {
  const ran: string[] = []
  const once = window.setTimeout(() => ran.push('once'), 5)
  window.clearTimeout(once)
  wake(once)
  const every = window.setInterval(() => ran.push('every'), 1)
  await turn()
  assert.equal(sent.at(-1)!.ms, 4, 'an interval waits at least 4 ms')
  wake(every)
  await turn()
  wake(every)
  await turn()
  window.clearInterval(every)
  wake(every)
  await turn()
  assert.deepEqual(ran, ['every', 'every'])
})

test('only the window wakes a timer', async () => {
  const ran: string[] = []
  const id = window.setTimeout(() => ran.push('x'), 5)
  window.dispatchEvent(new MessageEvent('message', { data: { se: 1, kind: 'wake', id }, source: null }))
  await turn()
  assert.deepEqual(ran, [])
})

test('a woken timer gives its slot back once: a second wake for it is not another run', async () => {
  const ran: string[] = []
  const id = window.setTimeout(() => ran.push('x'), 5)
  wake(id)
  await turn()
  wake(id)
  await turn()
  assert.deepEqual(ran, ['x'])
  // Cleared after it ran: nothing for the window to drop.
  sent.length = 0
  window.clearTimeout(id)
  assert.deepEqual(sent, [])
})

// The frame's bootstrap and the window's real bridge, wired to each other:
// each finished host call clears its long deadline, and those must not fill
// the window's slots and send the frame back to the browser's slow timers.
test('600 long timers set and cleared give their slots back on both sides, and a 16 ms timer is still kept by the window', async () => {
  const host = createExtensionFrameHost({
    source: () => window,
    post: (message) => window.dispatchEvent(new MessageEvent('message', { data: message, source: window })),
    components: { receive: () => undefined, takeGesture: () => false },
    call: async () => ({ ok: true, result: {} }),
    client: {
      toast: () => undefined,
      chatDraft: async () => ({ ok: true }),
      openDoor: () => false,
      focusTab: () => false,
      followStudioEvent: () => () => undefined,
      openExternal: async () => false,
    },
    theme: () => ({ colorScheme: 'dark', tokens: {} }),
    onReady: () => undefined,
    onPaint: () => undefined,
    onFailed: () => undefined,
  })
  // The window hears what the frame posts about its clock. Here both share one
  // realm, so the window's bridge is handed the browser's own timers while it
  // works, as it has in its own window.
  const asWindow = (work: () => void) => {
    const frameTimers = { setTimeout: window.setTimeout, clearTimeout: window.clearTimeout }
    Object.assign(window, { setTimeout: native.setTimeout, clearTimeout: native.clearTimeout })
    try {
      work()
    } finally {
      Object.assign(window, frameTimers)
    }
  }
  const bridge = (event: MessageEvent) => {
    const data = event.data as Record<string, unknown>
    // jsdom's postMessage names no source; the frame here is this window.
    if (data && (data.kind === 'timer' || data.kind === 'clear'))
      asWindow(() => host.receive({ source: window, data } as unknown as MessageEvent))
  }
  window.addEventListener('message', bridge)
  try {
    sent.length = 0
    const ran: string[] = []
    for (let index = 0; index < 600; index++) {
      const id = window.setTimeout(() => ran.push('long'), 120_000)
      window.clearTimeout(id)
    }
    await turn()
    assert.equal(sent.filter((message) => message.kind === 'timer').length, 600)
    assert.equal(sent.filter((message) => message.kind === 'clear').length, 600, 'each cleared timer is dropped')

    const quick = window.setTimeout(() => ran.push('quick'), 16)
    assert.equal(quick % 2, 1, 'held by the window, not the browser’s own throttled timer')
    await new Promise((resolve) => native.setTimeout(resolve, 80))
    assert.deepEqual(ran, ['quick'])

    // The window's count is back to 0: every one of its slots takes a timer, and each one wakes.
    sent.length = 0
    let woke = 0
    asWindow(() => {
      for (let index = 0; index < COMPONENT_FRAME_MAX_TIMERS; index++)
        host.receive({
          source: window,
          data: { se: 1, kind: 'timer', id: 100_001 + 2 * index, ms: 1 },
        } as unknown as MessageEvent)
    })
    const count = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown>
      if (data && data.kind === 'wake' && Number(data.id) > 100_000) woke++
    }
    window.addEventListener('message', count)
    await new Promise((resolve) => native.setTimeout(resolve, 80))
    window.removeEventListener('message', count)
    assert.equal(woke, COMPONENT_FRAME_MAX_TIMERS)
  } finally {
    window.removeEventListener('message', bridge)
    asWindow(() => host.dispose())
  }
})
