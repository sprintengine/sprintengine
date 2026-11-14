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
  const stop = chatStoresApi.onUsageLimitResumesChanged((state) => heard.push(state))
  await settle()
  assert.deepEqual(
    fake.subscriptions.map((subscription) => subscription.topic),
    ['usageLimitResumes.changed'],
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
    ['usageLimitResumes.get'],
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
  await chatStoresApi.updateUsageLimitResume({ kind: 'dismiss', workspaceId: 'w1', agentId: 'a1' })
  await chatStoresApi.updateUsageLimitResume({ kind: 'dismiss', workspaceId: 'w1', agentId: 'a1' })
  const ids = fake.requests.map((request) => (request.params as { commandId: string }).commandId)
  assert.equal(ids.length, 2)
  assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0))
  assert.notEqual(ids[0], ids[1])
})

test('the schedules list is read again when the connection comes back, as every store that follows a feed is', async () => {
  // The real module: every suite else gets its double (tests/setup.ts).
  const { schedulesApi } = await vi.importActual<typeof import('./schedules')>('./schedules')
  const lists: unknown[] = []
  const pauses: unknown[] = []
  const stopList = schedulesApi.onScheduledAgentsChanged((schedules) => lists.push(schedules))
  const stopPause = schedulesApi.onScheduledAgentsPauseChanged((pause) => pauses.push(pause))
  await settle()
  // A run the server's start recovered changed the list while the window was away.
  fake.answer = { schedules: [{ id: 'sa-1' }], pausedAll: null }
  await becomes('reconnecting')
  await becomes('open')
  assert.deepEqual(
    fake.requests.map((request) => request.method),
    ['schedules.list', 'schedules.list'],
  )
  assert.deepEqual(lists, [[{ id: 'sa-1' }]])
  assert.deepEqual(pauses, [null])
  stopList()
  stopPause()
})
