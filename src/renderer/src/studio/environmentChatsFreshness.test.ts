import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  FOCUS_REREAD_GAP_MS,
  listFailureOf,
  readDue,
  REREAD_MAX_MS,
  REREAD_MS,
  rereadDelayMs,
} from './environmentChatsFreshness'

const MINUTE = 60_000

test('a refusal that is the answer is not a failure; a refused device and a broken read are', () => {
  assert.equal(listFailureOf('conversations_unsupported', 'x'), null, 'a Studio that does not serve them lists none')
  assert.equal(listFailureOf('scope_required', 'x'), null, 'a device that may not read them lists none')
  assert.deepEqual(listFailureOf('revoked', 'Revoked.'), { kind: 'unauthorized', message: 'Revoked.' })
  assert.deepEqual(listFailureOf('unauthorized', 'No.'), { kind: 'unauthorized', message: 'No.' })
  assert.deepEqual(listFailureOf('peer_mismatch', 'No.'), { kind: 'unauthorized', message: 'No.' })
  assert.deepEqual(listFailureOf('unavailable', 'Gone.'), { kind: 'unavailable', message: 'Gone.' })
  assert.deepEqual(listFailureOf('timeout', 'Slow.'), { kind: 'unavailable', message: 'Slow.' })
})

test('the clock reads an environment every few minutes, further apart while it fails, and focus no more than once in a while', () => {
  assert.equal(rereadDelayMs(0), REREAD_MS)
  assert.equal(rereadDelayMs(1), REREAD_MS * 2)
  assert.equal(rereadDelayMs(2), REREAD_MS * 4)
  assert.equal(rereadDelayMs(50), REREAD_MAX_MS, 'the backoff has a ceiling')
  assert.ok(REREAD_MS >= 2 * MINUTE && REREAD_MS <= 10 * MINUTE, 'a slow clock: a few minutes')

  assert.equal(readDue(undefined, 'clock', 0), true, 'an environment never asked is due')
  const answered = { askedAt: 0, failures: 0 }
  assert.equal(readDue(answered, 'clock', REREAD_MS - 1), false)
  assert.equal(readDue(answered, 'clock', REREAD_MS), true)
  const failing = { askedAt: 0, failures: 2 }
  assert.equal(readDue(failing, 'clock', REREAD_MS * 2), false, 'a failing environment waits longer')
  assert.equal(readDue(failing, 'clock', REREAD_MS * 4), true)
  assert.equal(readDue(answered, 'focus', FOCUS_REREAD_GAP_MS - 1), false, 'focus flapping asks nothing')
  assert.equal(readDue(failing, 'focus', FOCUS_REREAD_GAP_MS), true, 'a person back at the window is')
})
