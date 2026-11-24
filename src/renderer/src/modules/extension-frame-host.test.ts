import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { StudioExtensionCallAnswer } from '../../../../packages/studio-protocol/src/public'
import { EXTENSION_FRAME_RATE_LIMIT } from '../../../shared/extension-frames'
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
  const host = createExtensionFrameHost({
    source: () => frame,
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
  const { send } = harness({}, {
    receive: (event, _payload, refused) => heard.push({ event, ...(refused ? { refused } : {}) }),
    takeGesture: () => false,
  })
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
