// @vitest-environment jsdom

import assert from 'node:assert/strict'
import { afterAll, beforeAll, test } from 'vitest'

import { frameBootstrapScript } from './frame-bootstrap'

// A components panel's frame is not drawn, and a browser runs an undrawn
// frame's timers about once a second; its bootstrap hands its timers to the
// window instead (`timer`), and runs each when the window wakes it (`wake`).

const sent: Array<Record<string, unknown>> = []
const native = { setTimeout: window.setTimeout, setInterval: window.setInterval, clearTimeout: window.clearTimeout }
let hear: (event: MessageEvent) => void

beforeAll(() => {
  hear = (event: MessageEvent) => {
    const data = event.data as Record<string, unknown>
    if (data && data.se === 1 && data.kind === 'timer') sent.push(data)
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
