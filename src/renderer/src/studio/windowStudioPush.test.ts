import assert from 'node:assert/strict'

import { beforeEach, test, vi } from 'vitest'

// The window's client, as a fake whose state and streams the test moves.
type Listener = { onPayload: (payload: unknown) => void; onEnd?: () => void }
const fake = vi.hoisted(() => ({
  state: 'open' as string,
  watchers: new Set<() => void>(),
  subscriptions: [] as Array<{ topic: string; listener: Listener; stopped: boolean }>,
}))

vi.mock('./windowStudioClient', () => {
  const client = {
    supports: () => true,
    subscribe: (topic: string, _params: unknown, listener: Listener) => {
      const subscription = { topic, listener, stopped: false }
      fake.subscriptions.push(subscription)
      return () => void (subscription.stopped = true)
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

const { followWindowStudioPush } = await import('./windowStudioPush')

const api = { studioWindowTicket: async () => ({}) } as never
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const becomes = async (state: string) => {
  fake.state = state
  for (const watcher of [...fake.watchers]) watcher()
  await settle()
}

beforeEach(() => {
  fake.state = 'open'
  fake.watchers.clear()
  fake.subscriptions.length = 0
})

test('a stream the client ended is followed again when the connection next opens, on the same client', async () => {
  const heard: unknown[] = []
  const stop = followWindowStudioPush({
    topic: 'module.notifications',
    params: {},
    capability: 'modules',
    onPayload: (payload) => heard.push(payload),
    api,
  })
  await settle()
  assert.equal(fake.subscriptions.length, 1)

  // Open again with the stream still live: nothing doubles.
  await becomes('open')
  assert.equal(fake.subscriptions.length, 1)

  // A refused credential parks the client and ends its streams; a wake opens it again.
  fake.subscriptions[0]!.listener.onEnd?.()
  await becomes('parked')
  await becomes('open')
  assert.equal(fake.subscriptions.length, 2, 'followed again once it opened')
  fake.subscriptions[1]!.listener.onPayload({ id: 'n1' })
  assert.deepEqual(heard, [{ id: 'n1' }])

  stop()
  assert.equal(fake.subscriptions[1]!.stopped, true)
  await becomes('open')
  assert.equal(fake.subscriptions.length, 2, 'nothing is followed once the caller stopped')
})

test('a follow is told each time the connection opens again, after it was lost, and not on its first open', async () => {
  let reopened = 0
  const stop = followWindowStudioPush({
    topic: 'schedules.changed',
    params: {},
    capability: 'schedules',
    onPayload: () => undefined,
    onReopen: () => reopened++,
    api,
  })
  await settle()
  await becomes('open')
  assert.equal(reopened, 0, 'open all along: nothing was missed')
  // Its Studio restarts: the connection drops and comes back.
  await becomes('reconnecting')
  await becomes('open')
  assert.equal(reopened, 1, 'read again once it is back')
  await becomes('reconnecting')
  await becomes('open')
  assert.equal(reopened, 2)
  stop()
  await becomes('reconnecting')
  await becomes('open')
  assert.equal(reopened, 2, 'not once the caller stopped')
})
