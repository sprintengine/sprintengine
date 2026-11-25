import assert from 'node:assert/strict'
import { test, vi } from 'vitest'

import type { StudioExtensionCallAnswer } from '../../../../packages/studio-protocol/src/public'
import { COMPONENT_FRAME_MAX_TIMERS, EXTENSION_FRAME_RATE_LIMIT } from '../../../shared/extension-frames'
import { createExtensionFrameHost, type ExtensionFrameComponentsChannel } from './extension-frame-host'

// The window's side of a frame's bridge: it hears the frame's own window
// alone, holds each message to the frame's budget, passes host calls to the
// Studio and carries out a client method only once the Studio admitted it.

const frame = { name: 'frame' } as unknown as MessageEventSource
const stranger = { name: 'stranger' } as unknown as MessageEventSource

function harness(
  answers: Record<string, StudioExtensionCallAnswer> = {},
  components?: ExtensionFrameComponentsChannel,
) {
  const opened: string[] = []
  const posted: Array<Record<string, unknown>> = []
  const called: string[] = []
  const toasts: unknown[] = []
  const ready: number[] = []
  const left: boolean[] = []
  // Studio's events the window follows for the frame, and the deliver of each.
  const followed: Array<{ event: string; deliver: (payload: unknown) => void; stopped: boolean }> = []
  let clock = 0
  // The frame's window, until the surface's frame is taken out of the page.
  let source: MessageEventSource | null = frame
  const host = createExtensionFrameHost({
    source: () => source,
    post: (message) => posted.push(message as Record<string, unknown>),
    workspaceId: 'ws-1',
    call: async (method) => {
      called.push(method)
      return answers[method] ?? { ok: true, result: { from: method } }
    },
    client: {
      toast: (params) => toasts.push(params),
      chatDraft: async () => ({ ok: true }),
      openDoor: (id) => id === 'deck',
      focusTab: () => true,
      followStudioEvent: (event, deliver) => {
        const entry = { event, deliver, stopped: false }
        followed.push(entry)
        return () => void (entry.stopped = true)
      },
      openExternal: async (url) => {
        opened.push(url)
        return true
      },
    },
    locale: () => 'en-GB',
    ...(components ? { components } : {}),
    theme: () => ({ colorScheme: 'dark', tokens: { '--bg-app': '#000' } }),
    onReady: (at) => ready.push(at),
    onPaint: () => undefined,
    onFailed: () => undefined,
    onLeaving: () => void left.push(true),
    now: () => clock,
  })
  const send = (data: unknown, source: MessageEventSource = frame) =>
    host.receive({ source, data } as unknown as MessageEvent)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  return {
    host,
    posted,
    called,
    toasts,
    ready,
    left,
    followed,
    opened,
    send,
    settle,
    tick: (ms: number) => (clock += ms),
    detach: () => void (source = null),
  }
}

test('the frame is answered hello with the theme and its workspace; a stranger is not heard', () => {
  const { posted, send } = harness()
  send({ se: 1, kind: 'evt', event: 'ready' }, stranger)
  send({ se: 2, kind: 'evt', event: 'ready' })
  assert.deepEqual(posted, [])
  send({ se: 1, kind: 'evt', event: 'ready' })
  assert.deepEqual(posted, [
    {
      se: 1,
      kind: 'evt',
      event: 'hello',
      payload: {
        theme: { colorScheme: 'dark', tokens: { '--bg-app': '#000' } },
        locale: 'en-GB',
        client: 'desktop',
        workspaceId: 'ws-1',
      },
    },
  ])
})

test('a host call goes to the Studio, its result or its refusal back to the frame', async () => {
  const { posted, called, send, settle } = harness({
    'files.read': { ok: false, code: 'not_permitted', message: 'Not approved.' },
  })
  send({ se: 1, kind: 'req', id: 1, method: 'workspace.list', params: {} })
  send({ se: 1, kind: 'req', id: 2, method: 'files.read', params: { path: 'a' } })
  await settle()
  assert.deepEqual(called, ['workspace.list', 'files.read'])
  assert.deepEqual(posted, [
    { se: 1, kind: 'res', id: 1, result: { from: 'workspace.list' } },
    { se: 1, kind: 'res', id: 2, error: { code: 'not_permitted', message: 'Not approved.', retryable: false } },
  ])
})

test('a client method is carried out in the window only once the Studio admitted it', async () => {
  const { posted, toasts, send, settle } = harness({
    'doors.open': { ok: false, code: 'approval_required', message: 'Not approved.' },
  })
  send({ se: 1, kind: 'req', id: 1, method: 'toast', params: { tone: 'good', message: 'Hi' } })
  send({ se: 1, kind: 'req', id: 2, method: 'doors.open', params: { id: 'deck' } })
  await settle()
  assert.deepEqual(toasts, [{ tone: 'good', message: 'Hi' }])
  const byId = (id: number) => posted.find((message) => message.id === id)
  assert.deepEqual(byId(1), { se: 1, kind: 'res', id: 1, result: { ok: true } })
  assert.equal((byId(2)!.error as { code: string }).code, 'approval_required')
})

test('one of Studio’s events is followed once the Studio admitted it, once per event, and stopped with the frame', async () => {
  const { host, posted, followed, send, settle } = harness({
    'events.subscribe': { ok: true, result: null },
  })
  send({ se: 1, kind: 'req', id: 1, method: 'events.subscribe', params: { event: 'workspace.created' } })
  send({ se: 1, kind: 'req', id: 2, method: 'events.subscribe', params: { event: 'workspace.created' } })
  await settle()
  assert.deepEqual(
    followed.map((entry) => entry.event),
    ['workspace.created'],
  )
  followed[0]!.deliver({ workspaceId: 'ws-2' })
  assert.deepEqual(posted.at(-1), {
    se: 1,
    kind: 'evt',
    event: 'studio',
    payload: { event: 'workspace.created', payload: { workspaceId: 'ws-2' } },
  })
  host.dispose()
  assert.equal(followed[0]!.stopped, true)
})

test('an event the Studio refused is not followed', async () => {
  const { posted, followed, send, settle } = harness({
    'events.subscribe': { ok: false, code: 'not_permitted', message: 'Not approved for "conversation:read".' },
  })
  send({ se: 1, kind: 'req', id: 1, method: 'events.subscribe', params: { event: 'agent.status.changed' } })
  await settle()
  assert.deepEqual(followed, [])
  assert.equal((posted.at(-1)!.error as { code: string }).code, 'not_permitted')
})

test('a frame is held to its budget: a message too large, and too many in ten seconds', async () => {
  const { posted, called, send, settle, tick } = harness()
  send({ se: 1, kind: 'req', id: 1, method: 'workspace.list', params: { padding: 'x'.repeat(70_000) } })
  for (let id = 2; id <= EXTENSION_FRAME_RATE_LIMIT.maxMessages + 2; id += 1)
    send({ se: 1, kind: 'req', id, method: 'workspace.list', params: {} })
  await settle()
  const codes = posted.map((message) => (message.error as { code?: string } | undefined)?.code ?? 'ok')
  assert.equal(codes[0], 'too_large')
  assert.equal(codes.filter((code) => code === 'rate_limited').length, 2)
  assert.equal(called.length, EXTENSION_FRAME_RATE_LIMIT.maxMessages - 1)
  tick(EXTENSION_FRAME_RATE_LIMIT.perMs + 1)
  send({ se: 1, kind: 'req', id: 999, method: 'workspace.list', params: {} })
  await settle()
  assert.equal(called.length, EXTENSION_FRAME_RATE_LIMIT.maxMessages)
})

test('a cancelled call is not answered, readiness is reported, and nothing is sent once disposed', async () => {
  const { host, posted, ready, send, settle } = harness()
  send({ se: 1, kind: 'req', id: 1, method: 'workspace.list', params: {} })
  send({ se: 1, kind: 'cancel', id: 1 })
  send({ se: 1, kind: 'evt', event: 'surface.ready', payload: { at: 1234 } })
  await settle()
  assert.deepEqual(posted, [])
  assert.deepEqual(ready, [1234])
  host.dispose()
  host.push('outlook', { sunny: true })
  host.sendTheme()
  assert.deepEqual(posted, [])
})

test('a cancel counts only for a call still waiting, and is forgotten once the call is answered', async () => {
  const { posted, send, settle } = harness()
  send({ se: 1, kind: 'cancel', id: 7 })
  send({ se: 1, kind: 'req', id: 7, method: 'workspace.list', params: {} })
  await settle()
  assert.equal(posted.length, 1, 'a cancel sent before its call does not swallow the answer')
  send({ se: 1, kind: 'req', id: 8, method: 'workspace.list', params: {} })
  send({ se: 1, kind: 'cancel', id: 8 })
  await settle()
  send({ se: 1, kind: 'req', id: 8, method: 'workspace.list', params: {} })
  await settle()
  assert.deepEqual(
    posted.map((message) => message.id),
    [7, 8],
    'the id is answered again once reused',
  )
})

test('a frame whose document unloads loses the bridge at once', async () => {
  const { posted, called, left, send, settle } = harness()
  send({ se: 1, kind: 'evt', event: 'leaving' })
  assert.deepEqual(left, [true])
  send({ se: 1, kind: 'req', id: 1, method: 'workspace.list', params: {} })
  send({ se: 1, kind: 'evt', event: 'ready' })
  await settle()
  assert.deepEqual(called, [])
  assert.deepEqual(posted, [])
})

test('a custom editor’s edits are answered by the window’s document, never sent to the Studio', async () => {
  const posted: Array<Record<string, unknown>> = []
  const called: string[] = []
  const flushed: Array<[number, boolean]> = []
  let saves = 0
  let readied = 0
  const host = createExtensionFrameHost({
    source: () => frame,
    post: (message) => posted.push(message as Record<string, unknown>),
    workspaceId: 'ws-1',
    document: {
      applyEdit: (params) =>
        (params as { baseVersion: number }).baseVersion === 2
          ? { ok: true }
          : { ok: false, code: 'conflict', message: 'Changed outside.', document: { version: 2 } },
      flushed: (id, ok) => void flushed.push([id, ok]),
      save: () => void (saves += 1),
    },
    onFrameReady: () => void (readied += 1),
    call: async (method) => {
      called.push(method)
      return { ok: true, result: null }
    },
    client: {
      toast: () => undefined,
      chatDraft: async () => ({}),
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
  const send = (data: unknown) => host.receive({ source: frame, data } as unknown as MessageEvent)
  send({ se: 1, kind: 'evt', event: 'ready' })
  assert.equal(readied, 1)
  // An edit far past a frame's 64 KiB message: a document travels whole.
  const big = 'x'.repeat(200 * 1024)
  send({
    se: 1,
    kind: 'req',
    id: 1,
    method: 'document.applyEdit',
    params: { baseVersion: 2, content: { kind: 'text', text: big } },
  })
  send({
    se: 1,
    kind: 'req',
    id: 2,
    method: 'document.applyEdit',
    params: { baseVersion: 1, content: { kind: 'text', text: 'y' } },
  })
  send({ se: 1, kind: 'evt', event: 'document.flushed', payload: { id: 7, ok: true } })
  send({ se: 1, kind: 'evt', event: 'document.save', payload: {} })
  host.sendDocument({ version: 3 })
  assert.deepEqual(called, [])
  assert.deepEqual(posted.slice(1), [
    { se: 1, kind: 'res', id: 1, result: null },
    {
      se: 1,
      kind: 'res',
      id: 2,
      error: { code: 'conflict', message: 'Changed outside.', retryable: false, document: { version: 2 } },
    },
    { se: 1, kind: 'evt', event: 'document', payload: { version: 3 } },
  ])
  assert.deepEqual(flushed, [[7, true]])
  assert.equal(saves, 1)
})

test('a frame that is not a custom editor has no document to edit', () => {
  const { posted, called, send } = harness()
  send({
    se: 1,
    kind: 'req',
    id: 1,
    method: 'document.applyEdit',
    params: { baseVersion: 1, content: { kind: 'text', text: 'y' } },
  })
  assert.deepEqual(called, [])
  assert.equal((posted[0]!.error as { code: string }).code, 'unknown_method')
})

test('a components panel’s ui events ride a lane of their own, larger than a call’s', () => {
  const heard: Array<{ event: string; refused?: string }> = []
  const { send } = harness(
    {},
    {
      receive: (event, _payload, refused) => heard.push({ event, ...(refused ? { refused } : {}) }),
      takeGesture: () => false,
    },
  )
  // A 200 KiB tree is over a call's 64 KiB, and within the render lane.
  const tree = { type: 'Text', props: {}, children: ['x'.repeat(200 * 1024)] }
  send({ se: 1, kind: 'evt', event: 'ui.render', payload: { document: 'd', revision: 1, tree } })
  const huge = { type: 'Text', props: {}, children: ['x'.repeat(700 * 1024)] }
  send({ se: 1, kind: 'evt', event: 'ui.render', payload: { document: 'd', revision: 2, tree: huge } })
  assert.deepEqual(heard, [{ event: 'ui.render' }, { event: 'ui.render', refused: 'too_large' }])
})

test('shell.openExternal needs a press a components panel granted; a frame drawing itself never has one', async () => {
  let granted = false
  const panel = harness({}, { receive: () => undefined, takeGesture: () => granted && !(granted = false) })
  panel.send({ se: 1, kind: 'req', id: 1, method: 'shell.openExternal', params: { url: 'https://example.com/a' } })
  await panel.settle()
  assert.deepEqual(panel.called, [])
  assert.equal((panel.posted.at(-1)!.error as { code: string }).code, 'not_permitted')
  granted = true
  panel.send({ se: 1, kind: 'req', id: 2, method: 'shell.openExternal', params: { url: 'https://example.com/a' } })
  await panel.settle()
  assert.deepEqual(panel.called, ['shell.openExternal'])
  assert.deepEqual(panel.opened, ['https://example.com/a'])
  assert.deepEqual(panel.posted.at(-1), { se: 1, kind: 'res', id: 2, result: { opened: true } })

  const page = harness()
  page.send({ se: 1, kind: 'req', id: 1, method: 'shell.openExternal', params: { url: 'https://example.com/a' } })
  await page.settle()
  assert.deepEqual(page.called, [])
  assert.deepEqual(page.opened, [])
  assert.equal((page.posted.at(-1)!.error as { code: string }).code, 'not_permitted')
})

// A components panel's frame is not drawn, and the browser runs an undrawn
// frame's own timers about once a second, so the window keeps its timers.
test('a components panel’s timers are kept by the window, bounded, and stopped with the frame', async () => {
  vi.useFakeTimers()
  try {
    const panel = harness({}, { receive: () => undefined, takeGesture: () => false })
    panel.send({ se: 1, kind: 'timer', id: 1, ms: 16 })
    // Not an id the frame's clock gives out, or not a delay: not kept.
    panel.send({ se: 1, kind: 'timer', id: 2, ms: 16 })
    panel.send({ se: 1, kind: 'timer', id: 3, ms: -1 })
    vi.advanceTimersByTime(15)
    assert.deepEqual(panel.posted, [])
    vi.advanceTimersByTime(1)
    assert.deepEqual(panel.posted, [{ se: 1, kind: 'wake', id: 1 }])

    panel.posted.length = 0
    for (let id = 1; id < 2 * (COMPONENT_FRAME_MAX_TIMERS + 10); id += 2)
      panel.send({ se: 1, kind: 'timer', id, ms: 5 })
    vi.advanceTimersByTime(5)
    assert.equal(panel.posted.length, COMPONENT_FRAME_MAX_TIMERS, 'no more than the bound wait at once')

    panel.send({ se: 1, kind: 'timer', id: 7, ms: 50 })
    panel.host.dispose()
    panel.posted.length = 0
    vi.advanceTimersByTime(100)
    assert.deepEqual(panel.posted, [])

    // A frame that draws itself keeps its own timers.
    const page = harness()
    page.send({ se: 1, kind: 'timer', id: 1, ms: 1 })
    vi.advanceTimersByTime(5)
    assert.deepEqual(page.posted, [])
  } finally {
    vi.useRealTimers()
  }
})

test('a components panel’s timer the frame cleared gives the window’s slot back, once, and never wakes', () => {
  vi.useFakeTimers()
  try {
    const panel = harness({}, { receive: () => undefined, takeGesture: () => false })
    // 600 long deadlines, each cleared when its call finished.
    for (let index = 0; index < 600; index++) {
      const id = 1 + 2 * index
      panel.send({ se: 1, kind: 'timer', id, ms: 120_000 })
      panel.send({ se: 1, kind: 'clear', id })
      // A second clear, or one for an id never kept, frees nothing more.
      panel.send({ se: 1, kind: 'clear', id })
    }
    panel.send({ se: 1, kind: 'clear', id: 999_999 })
    // Every slot is free again: the full bound of timers is kept, and each wakes.
    for (let index = 0; index < COMPONENT_FRAME_MAX_TIMERS + 5; index++)
      panel.send({ se: 1, kind: 'timer', id: 10_001 + 2 * index, ms: 16 })
    vi.advanceTimersByTime(16)
    assert.equal(panel.posted.length, COMPONENT_FRAME_MAX_TIMERS)
    assert.ok(panel.posted.every((message) => message.kind === 'wake'))
    panel.posted.length = 0
    vi.advanceTimersByTime(200_000)
    assert.deepEqual(panel.posted, [], 'a cleared timer never wakes')

    // An interval armed again for its next turn holds one slot, not two.
    panel.send({ se: 1, kind: 'timer', id: 1, ms: 10 })
    panel.send({ se: 1, kind: 'timer', id: 1, ms: 10 })
    vi.advanceTimersByTime(10)
    assert.deepEqual(panel.posted, [{ se: 1, kind: 'wake', id: 1 }])
  } finally {
    vi.useRealTimers()
  }
})

test('a components panel’s persisted writes ride a lane of their own, and a refusal for too many names its wait', async () => {
  const channel: ExtensionFrameComponentsChannel = { receive: () => undefined, takeGesture: () => false }
  const { send, posted, called, settle } = harness({}, channel)
  // About 70 KiB: over a call's 64 KiB, within the atoms lane.
  const entries = [{ scope: 'plugin', key: 'big', version: 1, value: 'x'.repeat(70 * 1024) }]
  send({ se: 1, kind: 'req', id: 1, method: 'atoms.write', params: { entries } })
  await settle()
  assert.deepEqual(called, ['atoms.write'])
  assert.deepEqual(posted.at(-1), { se: 1, kind: 'res', id: 1, result: { from: 'atoms.write' } })
  // Any other call that large is still refused.
  send({ se: 1, kind: 'req', id: 2, method: 'storage.set', params: { key: 'k', value: 'x'.repeat(70 * 1024) } })
  assert.equal((posted.at(-1)!.error as { code: string }).code, 'too_large')
  for (let id = 3; id < 3 + 60; id++)
    send({
      se: 1,
      kind: 'req',
      id,
      method: 'atoms.write',
      params: { entries: [{ scope: 'plugin', key: 'n', version: 1, value: id }] },
    })
  await settle()
  // The first write and these 59 fill the lane's ten seconds; the 60th is refused.
  const refused = posted.find((message) => message.id === 62)!.error as {
    code: string
    retryable: boolean
    retryAfterMs?: number
  }
  assert.deepEqual(
    { code: refused.code, retryable: refused.retryable, retryAfterMs: refused.retryAfterMs },
    { code: 'rate_limited', retryable: true, retryAfterMs: 1000 },
  )
})

test('a closed components panel still passes on its unloading document’s last writes, until it says it is leaving', async () => {
  const heard: string[] = []
  const channel: ExtensionFrameComponentsChannel = { receive: (event) => heard.push(event), takeGesture: () => false }
  const { host, send, called, settle, detach, left } = harness({}, channel)
  send({ se: 1, kind: 'req', id: 1, method: 'events.subscribe', params: { event: 'workspace.changed' } })
  await settle()
  let closed = false
  void host.close(300).then(() => (closed = true))
  // The frame is out of the page now; its document unloads and flushes.
  detach()
  send({
    se: 1,
    kind: 'req',
    id: 2,
    method: 'atoms.write',
    params: { entries: [{ scope: 'plugin', key: 'a', version: 1, value: 1 }] },
  })
  send({ se: 1, kind: 'evt', event: 'ui.retain', payload: { document: 'd', entries: [] } })
  // Nothing else is heard while closing: no other call, no timer, no render.
  send({ se: 1, kind: 'req', id: 3, method: 'toast', params: { message: 'late' } })
  send({ se: 1, kind: 'evt', event: 'ui.render', payload: { document: 'd', revision: 9, tree: null } })
  send({ se: 1, kind: 'req', id: 4, method: 'atoms.write', params: {} }, stranger)
  send({ se: 1, kind: 'evt', event: 'leaving', payload: {} })
  await settle()
  assert.equal(closed, true)
  assert.deepEqual(called, ['events.subscribe', 'atoms.write'])
  assert.deepEqual(heard, ['ui.retain'])
  assert.deepEqual(left, [], 'a closed surface is not failed for leaving')
  // Stopped for good.
  send({ se: 1, kind: 'req', id: 5, method: 'atoms.write', params: {} })
  await settle()
  assert.deepEqual(called, ['events.subscribe', 'atoms.write'])
})

test('a closed surface whose document never says it is leaving stops after the grace', async () => {
  vi.useFakeTimers()
  try {
    const { host, send, called, detach } = harness({}, { receive: () => undefined, takeGesture: () => false })
    let closed = false
    void host.close(300).then(() => (closed = true))
    detach()
    await vi.advanceTimersByTimeAsync(301)
    assert.equal(closed, true)
    send({ se: 1, kind: 'req', id: 1, method: 'atoms.write', params: {} })
    assert.deepEqual(called, [])
  } finally {
    vi.useRealTimers()
  }
})
