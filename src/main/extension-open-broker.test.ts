import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { ExtensionOpenOutcome } from '../shared/extension-open'
import { EXTENSION_OPEN_REQUEST_CHANNEL, type ExtensionOpenWindowRequest } from '../shared/extension-open-ipc'
import {
  NO_WINDOW_MESSAGE,
  NO_WORKSPACE_MESSAGE,
  createExtensionOpenBroker,
  type ExtensionOpenBroker,
  type ExtensionOpenTarget,
} from './extension-open-broker'

// `extension.open`'s main half with fake windows: who is asked, in which
// order, and what the answers come to. A fake window answers through the
// broker as its IPC listener would, or stays silent.

type Answer = ExtensionOpenOutcome | 'silent'

type FakeWindow = ExtensionOpenTarget & { name: string; asked: ExtensionOpenWindowRequest[]; destroyed: boolean }

const asked: string[] = []

function fakeWindow(
  broker: () => ExtensionOpenBroker,
  name: string,
  options: { focused?: boolean; visible?: boolean; answer: Answer },
): FakeWindow {
  const window: FakeWindow = {
    name,
    id: { name },
    asked: [],
    destroyed: false,
    isDestroyed: () => window.destroyed,
    isFocused: () => options.focused === true,
    isVisible: () => options.visible === true,
    send(channel, payload) {
      assert.equal(channel, EXTENSION_OPEN_REQUEST_CHANNEL)
      const request = payload as ExtensionOpenWindowRequest
      window.asked.push(request)
      asked.push(name)
      if (options.answer !== 'silent') {
        const outcome = options.answer
        queueMicrotask(() => broker().handleAck(window.id, { requestId: request.requestId, outcome }))
      }
    },
  }
  // Nothing may raise or focus a window: a fake that is asked to fails the test.
  Object.assign(window, {
    focus: () => assert.fail(`${name} was focused`),
    show: () => assert.fail(`${name} was shown`),
  })
  return window
}

function setup(specs: Array<[string, { focused?: boolean; visible?: boolean; answer: Answer }]>) {
  asked.length = 0
  let ids = 0
  let windows: FakeWindow[] = []
  const broker = createExtensionOpenBroker({
    targets: () => windows,
    newRequestId: () => `r${++ids}`,
    waitMs: 20,
  })
  windows = specs.map(([name, options]) => fakeWindow(() => broker, name, options))
  return { broker, windows }
}

const REQUEST = { moduleId: 'local.weather-deck', panel: 'forecast' }
const OPENED = (workspaceId: string): ExtensionOpenOutcome => ({ ok: true, workspaceId })
const NO_WORKSPACE: ExtensionOpenOutcome = { ok: false, code: 'no_workspace', message: 'none here' }
const NOT_FOUND: ExtensionOpenOutcome = { ok: false, code: 'not_found', message: 'no such panel here' }

test('no workspace window at all is no_window', async () => {
  const { broker } = setup([])
  assert.deepEqual(await broker.open(REQUEST), { ok: false, code: 'no_window', message: NO_WINDOW_MESSAGE })
})

test('only destroyed windows is no_window, and none of them is sent anything', async () => {
  const { broker, windows } = setup([['a', { answer: OPENED('w1') }]])
  windows[0]!.destroyed = true
  assert.deepEqual(await broker.open(REQUEST), { ok: false, code: 'no_window', message: NO_WINDOW_MESSAGE })
  assert.deepEqual(asked, [])
})

test('the focused window is asked first, then the visible ones, then the rest, one at a time', async () => {
  const { broker, windows } = setup([
    ['hidden', { answer: NO_WORKSPACE }],
    ['visible', { visible: true, answer: NO_WORKSPACE }],
    ['focused', { focused: true, visible: true, answer: NO_WORKSPACE }],
    ['visible-2', { visible: true, answer: NO_WORKSPACE }],
  ])
  const outcome = await broker.open(REQUEST)
  assert.deepEqual(asked, ['focused', 'visible', 'visible-2', 'hidden'])
  assert.deepEqual(outcome, { ok: false, code: 'no_workspace', message: NO_WORKSPACE_MESSAGE })
  // Each window got the request as asked, with an id of its own.
  const ids = windows.flatMap((window) => window.asked.map((request) => request.requestId))
  assert.equal(new Set(ids).size, 4)
  assert.deepEqual({ ...windows[0]!.asked[0], requestId: undefined }, { ...REQUEST, requestId: undefined })
})

test('the first window that opens it wins, and no window after it is asked', async () => {
  const { broker } = setup([
    ['focused', { focused: true, answer: NO_WORKSPACE }],
    ['visible', { visible: true, answer: OPENED('ws-2') }],
    ['hidden', { answer: OPENED('ws-3') }],
  ])
  assert.deepEqual(await broker.open(REQUEST), { ok: true, workspaceId: 'ws-2' })
  assert.deepEqual(asked, ['focused', 'visible'])
})

test('not_found is kept while the others are asked, and is the answer when none opens it', async () => {
  const { broker } = setup([
    ['focused', { focused: true, answer: NOT_FOUND }],
    ['other', { answer: NO_WORKSPACE }],
  ])
  assert.deepEqual(await broker.open(REQUEST), NOT_FOUND)
  assert.deepEqual(asked, ['focused', 'other'])

  const later = setup([
    ['focused', { focused: true, answer: NOT_FOUND }],
    ['other', { answer: OPENED('ws-9') }],
  ])
  assert.deepEqual(await later.broker.open(REQUEST), { ok: true, workspaceId: 'ws-9' })
})

test('a silent window is passed over after its wait, and the next is asked', async () => {
  const { broker } = setup([
    ['focused', { focused: true, answer: 'silent' }],
    ['other', { answer: OPENED('ws-1') }],
  ])
  assert.deepEqual(await broker.open(REQUEST), { ok: true, workspaceId: 'ws-1' })
  assert.deepEqual(asked, ['focused', 'other'])

  const allSilent = setup([['only', { answer: 'silent' }]])
  assert.deepEqual(await allSilent.broker.open(REQUEST), {
    ok: false,
    code: 'no_workspace',
    message: NO_WORKSPACE_MESSAGE,
  })
})

test('an answer from a window the ask did not go to, or a late one, is ignored', async () => {
  const { broker, windows } = setup([
    ['focused', { focused: true, answer: 'silent' }],
    ['other', { answer: 'silent' }],
  ])
  const opening = broker.open(REQUEST)
  await Promise.resolve()
  const first = windows[0]!.asked[0]!
  // `other` answers the ask that went to `focused`: not heard.
  broker.handleAck(windows[1]!.id, { requestId: first.requestId, outcome: OPENED('forged') })
  // Malformed answers are not heard either.
  broker.handleAck(windows[0]!.id, { requestId: first.requestId, outcome: { ok: true } })
  broker.handleAck(windows[0]!.id, 'opened')
  await new Promise((resolve) => setTimeout(resolve, 30))
  // `focused` answers after its wait, while `other` is being asked: too late.
  broker.handleAck(windows[0]!.id, { requestId: first.requestId, outcome: OPENED('late') })
  const second = windows[1]!.asked[0]!
  broker.handleAck(windows[1]!.id, { requestId: second.requestId, outcome: OPENED('ws-2') })
  assert.deepEqual(await opening, { ok: true, workspaceId: 'ws-2' })
})

test('a window closed while an earlier one is asked is skipped', async () => {
  const { broker, windows } = setup([
    ['focused', { focused: true, answer: 'silent' }],
    ['other', { answer: OPENED('ws-1') }],
    ['last', { answer: OPENED('ws-3') }],
  ])
  const opening = broker.open(REQUEST)
  windows[1]!.destroyed = true
  assert.deepEqual(await opening, { ok: true, workspaceId: 'ws-3' })
  assert.deepEqual(asked, ['focused', 'last'])
})

test('dispose settles the ask in flight and refuses later ones as no_window', async () => {
  const { broker } = setup([['only', { answer: 'silent' }]])
  const opening = broker.open(REQUEST)
  broker.dispose()
  assert.deepEqual(await opening, { ok: false, code: 'no_window', message: NO_WINDOW_MESSAGE })
  assert.deepEqual(await broker.open(REQUEST), { ok: false, code: 'no_window', message: NO_WINDOW_MESSAGE })
})
