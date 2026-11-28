import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { Workspace } from './workspace'
import {
  chatRestSeen,
  chatRestSeenIsStale,
  lifecycleSnapshotIsStale,
  workspaceLifecycleSnapshot,
} from './workspace-lifecycle'

const NOW = 1_000_000_000_000
const HOUR = 60 * 60 * 1000

const chat = (fields: Partial<Workspace> = {}) => ({ id: 'w', createdAt: NOW - 10 * HOUR, ...fields }) as Workspace

test('a snapshot is stale once the rest, the sleep or the activity has moved past it', () => {
  const before = chat({ lastTurnEndedAt: NOW - HOUR })
  const snapshot = workspaceLifecycleSnapshot(before)
  assert.equal(lifecycleSnapshotIsStale(before, snapshot), false, 'the chat it was taken of')
  assert.equal(lifecycleSnapshotIsStale(chat({ ...before, settledAt: NOW }), snapshot), true, 'settled since')
  assert.equal(lifecycleSnapshotIsStale(chat({ ...before, snoozedUntil: NOW + HOUR }), snapshot), true, 'snoozed')
  assert.equal(lifecycleSnapshotIsStale(chat({ ...before, settledOverride: 'active' }), snapshot), true)
  assert.equal(lifecycleSnapshotIsStale(chat({ ...before, lastUserMessageAt: NOW }), snapshot), true, 'a message')
  assert.equal(lifecycleSnapshotIsStale(chat({ ...before, lastTurnEndedAt: NOW }), snapshot), true, 'a turn end')
  // A reading that knows more than the record (a window ahead of main on the
  // keystroke clock) is current.
  assert.equal(lifecycleSnapshotIsStale(before, { ...snapshot, activityAt: NOW }), false)
  // Absent and null read alike.
  assert.equal(lifecycleSnapshotIsStale(chat({ ...before, settledAt: null }), snapshot), false)
})

test('a row reading is stale once the rest, the sleep or the activity has moved past it', () => {
  const before = chat({ lastTurnEndedAt: NOW - HOUR, snoozedUntil: NOW + HOUR })
  const seen = chatRestSeen(before, NOW)
  assert.deepEqual(seen, { settledAt: null, snoozedUntil: NOW + HOUR, activityAt: NOW - HOUR })
  assert.equal(chatRestSeenIsStale(before, seen, NOW), false, 'the chat it was drawn from')
  assert.equal(chatRestSeenIsStale(chat({ ...before, settledAt: NOW }), seen, NOW), true, 'settled since')
  assert.equal(chatRestSeenIsStale(chat({ ...before, snoozedUntil: null }), seen, NOW), true, 'woken since')
  assert.equal(chatRestSeenIsStale(chat({ ...before, lastUserMessageAt: NOW }), seen, NOW), true, 'a message')
  assert.equal(chatRestSeenIsStale(chat({ ...before, lastTerminalActivityAt: NOW }), seen, NOW), true, 'a keystroke')
  // What a row cannot see is not asked of it: a hand override, a snooze kept under a settle or run out.
  assert.equal(chatRestSeenIsStale(chat({ ...before, settledOverride: 'active' }), seen, NOW), false)
  const resting = chat({ settledAt: NOW - HOUR, snoozedUntil: NOW + HOUR })
  assert.equal(chatRestSeen(resting, NOW).snoozedUntil, null)
  assert.equal(chatRestSeen(chat({ snoozedUntil: NOW - 1 }), NOW).snoozedUntil, null)
  // A reading ahead of the record (a window that knows a keystroke first) is current.
  assert.equal(chatRestSeenIsStale(before, { ...seen, activityAt: NOW }, NOW), false)
})
