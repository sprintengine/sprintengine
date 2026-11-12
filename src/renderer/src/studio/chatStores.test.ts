import assert from 'node:assert/strict'

import { beforeEach, test, vi } from 'vitest'

// The stores' follows over a fake window client: a push is heard, and the
// whole state is read again each time the connection opens after being down,
// because a change made while it was down is never pushed.
type Listener = { onPayload: (payload: unknown) => void; onEnd?: () => void }
const fake = vi.hoisted(() => ({
  state: 'open' as string,
  watchers: new Set<() => void>(),
  subscriptions: [] as Array<{ topic: string; listener: Listener }>,
  requests: [] as Array<{ method: string; params: unknown }>,
  answer: { reading: 0 } as unknown,
}))

vi.mock('./windowStudioClient', () => {
  const client = {
    supports: () => true,
    subscribe: (topic: string, _params: unknown, listener: Listener) => {
      fake.subscriptions.push({ topic, listener })
      return () => undefined
    },
    request: async (method: string, params: unknown) => {
      fake.requests.push({ method, params })
      return fake.answer
    },
  }
  return {
    windowStudioClient: async () => client,
    windowStudioState: () => fake.state,
    watchWindowStudio: (_api: unknown, listener: () => void) => {
      fake.watchers.add(listener)
      return () => fake.watchers.delete(listener)
    },
  }
})

const { chatStoresApi } = await import('./chatStores')

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const becomes = async (state: string) => {
  fake.state = state
  for (const watcher of [...fake.watchers]) watcher()
  await settle()
}

beforeEach(() => {
  const host = globalThis as { window?: { api?: unknown } }
  host.window ??= {}
  host.window.api = { studioWindowTicket: async () => ({}) }
  fake.state = 'open'
  fake.watchers.clear()
  fake.subscriptions.length = 0
  fake.requests.length = 0
})

test('a follow hears pushes, and reads the state again only when the connection comes back', async () => {
  const heard: unknown[] = []
  const stop = chatStoresApi.onScheduledMessagesChanged((state) => heard.push(state))
  await settle()
  assert.deepEqual(
    fake.subscriptions.map((subscription) => subscription.topic),
    ['scheduledMessages.changed'],
  )

  fake.subscriptions[0]!.listener.onPayload({ pushed: 1 })
  assert.deepEqual(heard, [{ pushed: 1 }])

  // Still open: nothing is read again.
  await becomes('open')
  assert.equal(fake.requests.length, 0)

  // Down, then back: the state is read once and handed on.
  fake.answer = { reading: 2 }
  await becomes('reconnecting')
  await becomes('open')
  assert.deepEqual(
    fake.requests.map((request) => request.method),
    ['scheduledMessages.get'],
  )
  assert.deepEqual(heard, [{ pushed: 1 }, { reading: 2 }])

  // Stopped: a later reconnect reads nothing and hands nothing on.
  stop()
  await becomes('reconnecting')
  await becomes('open')
  assert.equal(fake.requests.length, 1)
  assert.equal(heard.length, 2)
})

test('each change carries a command id of its own, kept on the request a resend repeats', async () => {
  await chatStoresApi.updateScheduledMessage({ kind: 'delete', id: 's1' })
  await chatStoresApi.updateScheduledMessage({ kind: 'delete', id: 's1' })
  const ids = fake.requests.map((request) => (request.params as { commandId: string }).commandId)
  assert.equal(ids.length, 2)
  assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0))
  assert.notEqual(ids[0], ids[1])
})
