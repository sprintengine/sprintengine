import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { StudioExtensionCallAnswer } from '../../../../packages/studio-protocol/src/public'
import { EXTENSION_FRAME_RATE_LIMIT } from '../../../shared/extension-frames'
import { createExtensionFrameHost } from './extension-frame-host'

// The window's side of a frame's bridge: it hears the frame's own window
// alone, holds each message to the frame's budget, passes host calls to the
// Studio and carries out a client method only once the Studio admitted it.

const frame = { name: 'frame' } as unknown as MessageEventSource
const stranger = { name: 'stranger' } as unknown as MessageEventSource

function harness(answers: Record<string, StudioExtensionCallAnswer> = {}) {
  const posted: Array<Record<string, unknown>> = []
  const called: string[] = []
  const toasts: unknown[] = []
  const ready: number[] = []
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
    },
    theme: () => ({ colorScheme: 'dark', tokens: { '--bg-app': '#000' } }),
    onReady: (at) => ready.push(at),
    onPaint: () => undefined,
    onFailed: () => undefined,
    now: () => clock,
  })
  const send = (data: unknown, source: MessageEventSource = frame) =>
    host.receive({ source, data } as unknown as MessageEvent)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  return { host, posted, called, toasts, ready, send, settle, tick: (ms: number) => (clock += ms) }
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
      payload: { theme: { colorScheme: 'dark', tokens: { '--bg-app': '#000' } }, workspaceId: 'ws-1' },
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
