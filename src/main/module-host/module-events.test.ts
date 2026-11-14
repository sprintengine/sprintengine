import assert from 'node:assert/strict'

import type { ModuleEventEnvelope } from '../../shared/modules/events'
import { loadMainModules, type CapabilityModule } from './load-modules'
import { createMainKernel } from './main-host'
import { test } from 'vitest'

test('module-events', async () => {
  // A module's events: the push to its client half a module gets through its
  // scoped host (the Studio's `module.events` stream), and the subscribe verb the request/response bridge
  // does not have. What is pinned here is the routing contract — identity is the
  // host's, topic and payload are the module's — plus the two decisions the item
  // asked for: no replay buffer, and no flood bound.

  function testEmitStampsScopedIdentityAndTime(): void {
    const delivered: ModuleEventEnvelope[] = []
    let clock = 1_000
    const kernel = createMainKernel({
      deliverModuleEvent: (event) => delivered.push(event),
      now: () => (clock += 1),
    })

    kernel.hostFor('widgets').emit('run-status', { phase: 'done' })
    kernel.hostFor('weather-deck').emit('outlook-refreshed')

    assert.deepEqual(delivered, [
      { sourceModuleId: 'widgets', topic: 'run-status', payload: { phase: 'done' }, emittedAt: 1_001 },
      { sourceModuleId: 'weather-deck', topic: 'outlook-refreshed', emittedAt: 1_002 },
    ])
    assert.equal(
      'payload' in delivered[1],
      false,
      'a bare signal carries no payload key at all, rather than an explicit undefined',
    )
  }

  function testEmitValidatesTheTopic(): void {
    const kernel = createMainKernel({ deliverModuleEvent: () => {} })
    const host = kernel.hostFor('widgets')

    assert.throws(() => host.emit('', {}), /non-empty topic/)
    assert.throws(() => host.emit('   ', {}), /non-empty topic/)
    assert.throws(() => host.emit('x'.repeat(129), {}), /at most 128 characters/)
    assert.throws(
      () => host.emit(undefined as unknown as string, {}),
      /non-empty topic/,
      'module code calls emit directly, so the topic is untrusted input',
    )
  }

  function testTopicIsTrimmedNotRewritten(): void {
    const delivered: ModuleEventEnvelope[] = []
    createMainKernel({ deliverModuleEvent: (event) => delivered.push(event) })
      .hostFor('widgets')
      .emit('  run-status  ')
    assert.equal(delivered[0]?.topic, 'run-status', 'the topic is trimmed, never prefixed by the host')
  }

  function testNothingIsBufferedForLateWindows(): void {
    // The deliberate difference from notifications, which buffer their recent set
    // so a window opened after startup still sees launch diagnostics. Events are
    // signals: one emitted with no window open is dropped, and a subscriber must
    // be correct having missed it.
    const kernel = createMainKernel()
    assert.doesNotThrow(
      () => kernel.hostFor('widgets').emit('run-status', { phase: 'done' }),
      'an emit with no delivery wired is a no-op, never a throw',
    )
    assert.equal(
      (kernel as unknown as { recentModuleEvents?: unknown }).recentModuleEvents,
      undefined,
      'the kernel exposes no event buffer to replay from',
    )
  }

  function testEmitIsNotFloodBounded(): void {
    // Notifications drop identical repeats and rate overruns because they are
    // user-visible. Dropping an event would instead make a subscriber wrong — a
    // door that never learns its run finished — so nothing here is bounded.
    const delivered: ModuleEventEnvelope[] = []
    const kernel = createMainKernel({
      deliverModuleEvent: (event) => delivered.push(event),
      now: () => 0,
    })
    const host = kernel.hostFor('widgets')
    for (let index = 0; index < 100; index += 1) host.emit('run-status', { phase: 'grouping' })
    assert.equal(delivered.length, 100, 'every emit is delivered, identical repeats included')
  }

  async function testEmitFlowsThroughALoadedModule(): Promise<void> {
    const delivered: ModuleEventEnvelope[] = []
    const module: CapabilityModule = {
      manifest: { id: 'widgets', displayName: 'Widgets', version: 1, defaultEnabled: true },
      registerMain(host) {
        host.onStartup(() => {
          host.emit('run-status', { phase: 'reading' })
        })
      },
    }
    const loaded = loadMainModules({
      modules: [module],
      deliverModuleEvent: (event) => delivered.push(event),
    })
    assert.deepEqual(loaded.report.errors, [])
    return loaded.kernel.runStartup().then(() => {
      assert.equal(delivered.length, 1, 'a loaded module reaches the delivery sink through its scoped host')
      assert.equal(delivered[0]?.sourceModuleId, 'widgets')
      assert.equal(delivered[0]?.topic, 'run-status')
    })
  }

  function testUnsendablePayloadThrowsToTheModule(): void {
    // The delivery is best effort per client, so a payload that cannot cross
    // to a client is refused at `emit`, back to the module that sent it.
    const delivered: ModuleEventEnvelope[] = []
    const host = createMainKernel({ deliverModuleEvent: (event) => delivered.push(event) }).hostFor('widgets')
    assert.throws(() => host.emit('run-status', { onDone: () => undefined }), /widgets.*run-status.*cannot be sent/)
    assert.equal(delivered.length, 0, 'nothing half-sent')
    assert.throws(() => host.emit('run-status', { at: new Date(0) }), /payload\.at is a Date, not a plain object/)
    assert.throws(() => host.emit('run-status', { ratio: Number.NaN }), /payload\.ratio is NaN/)
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    assert.throws(() => host.emit('run-status', cycle), /refers back to itself/)
    assert.equal(delivered.length, 0, 'nothing half-sent')
    const shared = { phase: 'done' }
    host.emit('run-status', {
      at: '1970-01-01T00:00:00.000Z',
      tags: ['a'],
      first: shared,
      second: shared,
      skipped: undefined,
    })
    assert.equal(delivered.length, 1, 'a JSON value is delivered, a value seen twice (not a cycle) included')
  }

  testEmitStampsScopedIdentityAndTime()
  testEmitValidatesTheTopic()
  testUnsendablePayloadThrowsToTheModule()
  testTopicIsTrimmedNotRewritten()
  testNothingIsBufferedForLateWindows()
  testEmitIsNotFloodBounded()
  const suiteRun = testEmitFlowsThroughALoadedModule()
    .then(() => console.log('module-events tests passed'))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })

  await suiteRun
})
