import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import type { StudioModuleEvent, StudioModuleNotification } from '../../../packages/studio-protocol/src/public'
import { createStudioModuleHub, type StudioModules } from './studio-modules'
import { connectLineClient, hello, OWNER_TOKEN, pairFakeClient, startTestServer } from './studio-rpc.test-helper'

// `module.events` and `module.notifications` over the owner socket: the
// capability, the scope, the module filter, and the bell's kept rows sent
// before the live ones. The hub is the real one; the kernel behind it is not
// here (module-events.test.ts and module-notifications.test.ts hold it).

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function event(sourceModuleId: string, topic: string, payload?: unknown): StudioModuleEvent {
  return { sourceModuleId, topic, emittedAt: 1, ...(payload === undefined ? {} : { payload }) }
}

function row(id: string, title: string): StudioModuleNotification {
  return { id, sourceModuleId: 'acme.board', sourceModuleName: 'Board', severity: 'info', title, emittedAt: 1 }
}

/** The real hub, saying when a connection starts listening. */
function hubWithListening() {
  const hub = createStudioModuleHub()
  const waiting: Array<() => void> = []
  const listening = () => new Promise<void>((resolve) => waiting.push(resolve))
  const heard = () => waiting.splice(0).forEach((resolve) => resolve())
  const watched: StudioModules = {
    ...hub,
    onEvent: (listener) => {
      const stop = hub.onEvent(listener)
      heard()
      return stop
    },
    onNotification: (listener) => {
      const stop = hub.onNotification(listener)
      heard()
      return stop
    },
  }
  return { hub: watched, listening }
}

async function clientOver(
  modules: StudioModules | undefined,
  token?: (started: Awaited<ReturnType<typeof startTestServer>>) => string,
) {
  const started = await startTestServer(modules ? { modules } : {})
  cleanups.push(() => started.dispose())
  const client = await connectLineClient(started.path)
  cleanups.push(() => client.close())
  client.send(hello({ token: token ? token(started) : OWNER_TOKEN }))
  const welcome = await client.next((frame) => frame.t === 'welcome')
  return { client, welcome }
}

test('a Studio with a module kernel advertises modules, and one without refuses the streams', async () => {
  const { welcome } = await clientOver(createStudioModuleHub())
  assert.equal(welcome.t === 'welcome' && welcome.capabilities.includes('modules'), true)
  const without = await clientOver(undefined)
  assert.equal(without.welcome.t === 'welcome' && without.welcome.capabilities.includes('modules'), false)
  without.client.send({ t: 'sub', id: 's1', topic: 'module.events', params: {} })
  const failed = await without.client.next((frame) => frame.t === 'subFailed' && frame.sub === 's1')
  assert.equal(failed.t === 'subFailed' && failed.code, 'unavailable')
})

test("every module's events, or one module's, in the order the kernel delivered them", async () => {
  const { hub, listening } = hubWithListening()
  const { client } = await clientOver(hub)
  const both = listening()
  client.send({ t: 'sub', id: 'all', topic: 'module.events', params: {} })
  await both
  const one = listening()
  client.send({ t: 'sub', id: 'radar', topic: 'module.events', params: { moduleId: 'acme.radar' } })
  await one
  hub.deliverEvent(event('acme.board', 'changed', { id: 1 }))
  hub.deliverEvent(event('acme.radar', 'run-status', { phase: 'started' }))
  hub.deliverEvent(event('acme.radar', 'run-status', { phase: 'done' }))
  const all = [] as unknown[]
  const radar = [] as unknown[]
  while (all.length < 3 || radar.length < 2) {
    const frame = await client.next((next) => next.t === 'push')
    if (frame.t !== 'push') continue
    ;(frame.sub === 'all' ? all : radar).push(frame.payload)
  }
  assert.deepEqual(
    all.map((payload) => (payload as StudioModuleEvent).sourceModuleId),
    ['acme.board', 'acme.radar', 'acme.radar'],
  )
  assert.deepEqual(radar, [
    event('acme.radar', 'run-status', { phase: 'started' }),
    event('acme.radar', 'run-status', { phase: 'done' }),
  ])
})

test('a malformed module filter is refused', async () => {
  const { client } = await clientOver(createStudioModuleHub())
  client.send({ t: 'sub', id: 's1', topic: 'module.events', params: { moduleId: 7 } })
  const failed = await client.next((frame) => frame.t === 'subFailed' && frame.sub === 's1')
  assert.equal(failed.t === 'subFailed' && failed.code, 'invalid_params')
})

test('the bell sends the kept rows first, then each new one, and again on a new subscription', async () => {
  const { hub, listening } = hubWithListening()
  const kept = [row('k1-0', 'Failed to load')]
  hub.readRecentFrom(() => kept)
  const { client } = await clientOver(hub)
  const subscribed = listening()
  client.send({ t: 'sub', id: 'bell', topic: 'module.notifications', params: {} })
  await subscribed
  kept.push(row('k1-1', 'Standup ready'))
  hub.deliverNotification(row('k1-1', 'Standup ready'))
  const first = await client.next((frame) => frame.t === 'push' && frame.sub === 'bell')
  const second = await client.next((frame) => frame.t === 'push' && frame.sub === 'bell')
  assert.deepEqual(
    [first, second].map((frame) => frame.t === 'push' && (frame.payload as StudioModuleNotification).id),
    ['k1-0', 'k1-1'],
  )
  client.send({ t: 'sub', id: 'again', topic: 'module.notifications', params: {} })
  const resent = [
    await client.next((frame) => frame.t === 'push' && frame.sub === 'again'),
    await client.next((frame) => frame.t === 'push' && frame.sub === 'again'),
  ]
  assert.deepEqual(
    resent.map((frame) => frame.t === 'push' && (frame.payload as StudioModuleNotification).id),
    ['k1-0', 'k1-1'],
    'a client that subscribes again (a reconnect) hears the kept rows again; their ids dedupe them',
  )
})

test('a paired client needs modules:read, and holds it only when granted', async () => {
  const hub = createStudioModuleHub()
  const without = await clientOver(hub, (started) => pairFakeClient(started.auth, 'app', ['conversation:read']))
  without.client.send({ t: 'sub', id: 's1', topic: 'module.notifications', params: {} })
  const failed = await without.client.next((frame) => frame.t === 'subFailed' && frame.sub === 's1')
  assert.equal(failed.t === 'subFailed' && failed.code, 'scope_required')

  const { hub: watched, listening } = hubWithListening()
  const granted = await clientOver(watched, (started) => pairFakeClient(started.auth, 'reader', ['modules:read']))
  const subscribed = listening()
  granted.client.send({ t: 'sub', id: 's2', topic: 'module.events', params: {} })
  await subscribed
  watched.deliverEvent(event('acme.board', 'changed'))
  const pushed = await granted.client.next((frame) => frame.t === 'push' && frame.sub === 's2')
  assert.deepEqual(pushed.t === 'push' && pushed.payload, event('acme.board', 'changed'))
})

test('one listener that throws does not keep an event from the others', () => {
  const hub = createStudioModuleHub()
  const heard: string[] = []
  hub.onEvent(() => {
    throw new Error('socket gone')
  })
  hub.onEvent((delivered) => heard.push(delivered.topic))
  hub.deliverEvent(event('acme.board', 'changed'))
  assert.deepEqual(heard, ['changed'])
})
