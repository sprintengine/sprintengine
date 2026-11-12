import assert from 'node:assert/strict'
import { test } from 'vitest'

import { environmentAnswering, environmentStatus, since } from './environment-status'
import type { EnvironmentConnection, EnvironmentEntry } from './environments'

const NOW = Date.parse('2026-01-01T12:00:00.000Z')

function entry(
  connection: Partial<EnvironmentConnection> & Pick<EnvironmentConnection, 'state'>,
  compatibility: EnvironmentEntry['compatibility'] = null,
): Pick<EnvironmentEntry, 'connection' | 'compatibility' | 'displayName'> {
  return { displayName: 'build-box', connection: { detail: null, lastReachedAt: null, ...connection }, compatibility }
}

test('every connection state reads as one status, with its words and its one action', () => {
  const read = (value: ReturnType<typeof entry>) => {
    const status = environmentStatus(value, NOW)
    return [status.kind, status.tone, status.words, status.action, status.actionLabel]
  }
  assert.deepEqual(read(entry({ state: 'up' })), ['ready', 'good', 'Connected', null, null])
  assert.deepEqual(read(entry({ state: 'up', detail: 'Always available' })), [
    'ready',
    'good',
    'Always available',
    null,
    null,
  ])
  assert.deepEqual(read(entry({ state: 'connecting' })), ['connecting', 'working', 'Connecting…', null, null])
  assert.deepEqual(read(entry({ state: 'connecting', detail: 'Installing Studio server 0.4.0' })), [
    'connecting',
    'working',
    'Installing Studio server 0.4.0',
    null,
    null,
  ])
  // Offline says for how long, when the machine was ever reached.
  assert.deepEqual(read(entry({ state: 'offline', lastReachedAt: NOW - 2 * 3_600_000 })), [
    'offline',
    'neutral',
    'Not answering · 2 h',
    'retry',
    'Retry',
  ])
  assert.equal(environmentStatus(entry({ state: 'offline' }), NOW).words, 'Not answering')
  assert.deepEqual(read(entry({ state: 'signed-out', detail: 'Revoked this device', remedy: 'Pair again' })), [
    'signed-out',
    'danger',
    'Revoked this device',
    'open-settings',
    'Pair again',
  ])
  assert.deepEqual(read(entry({ state: 'unknown' })), [
    'not-set-up',
    'neutral',
    'Not connected yet',
    'retry',
    'Connect',
  ])
})

test('a server outside the protocol window is incompatible whatever its socket does, and says where it is fixed', () => {
  const newer = environmentStatus(entry({ state: 'up' }, 'client-outdated'), NOW)
  assert.equal(newer.kind, 'incompatible')
  assert.equal(newer.tone, 'danger')
  assert.equal(newer.action, 'open-settings')
  assert.match(newer.words, /update this app/u)
  assert.match(environmentStatus(entry({ state: 'offline' }, 'server-outdated'), NOW).words, /update it there/u)
  // Compatible, or not known yet, leaves the connection to speak.
  assert.equal(environmentStatus(entry({ state: 'up' }, 'compatible'), NOW).kind, 'ready')
  assert.equal(environmentStatus(entry({ state: 'up' }, 'unknown'), NOW).kind, 'ready')
})

test('answering is ready, and nothing else', () => {
  assert.equal(environmentAnswering(entry({ state: 'up' })), true)
  assert.equal(environmentAnswering(entry({ state: 'up' }, 'server-outdated')), false)
  assert.equal(environmentAnswering(entry({ state: 'connecting' })), false)
})

test('how long a state has held, without the "ago"', () => {
  assert.equal(since(NOW - 10_000, NOW), 'under a min')
  assert.equal(since(NOW - 5 * 60_000, NOW), '5 min')
  assert.equal(since(NOW - 26 * 3_600_000, NOW), '1 day')
})
