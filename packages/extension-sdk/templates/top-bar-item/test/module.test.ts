// Your tests, in TypeScript: `npm test` runs test/*.test.ts with `node --test`,
// loading the source as Studio loads it (see AGENTS.md). Drive the source with
// the SDK's fakes, handing them `manifest` from ./manifest.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeFrameStudio } from '@sprintengine/extension-sdk/testing'

import { formatRemaining, readEndsAt, saveEndsAt, timerView } from '../extension/src/timer'
import { manifest } from './manifest'

const surface = { point: 'doors', id: 'timer' } as const

test('the top bar button opens the timer door', () => {
  assert.deepEqual(
    manifest.contributes.topBarItems.map((item) => item.door),
    ['timer'],
  )
  assert.deepEqual(
    manifest.contributes.doors.map((door) => door.id),
    ['timer'],
  )
})

test('with no timer running, the door offers to start one', () => {
  assert.deepEqual(timerView(null, 0), { time: '25:00', action: 'Start 25 minutes of focus' })
})

test('a running timer counts down, and one that ran out says so', () => {
  assert.deepEqual(timerView(61_500, 0), { time: '1:02', action: 'Stop the timer' })
  assert.deepEqual(timerView(1000, 2000), { time: 'Time is up', action: 'Clear the timer' })
})

test('a started timer survives a restart', async () => {
  const frame = createFakeFrameStudio({ manifest })
  assert.equal(await readEndsAt(frame.studio(surface)), null)
  await saveEndsAt(frame.studio(surface), 1_700_000_000_000)
  assert.equal(await readEndsAt(frame.studio(surface)), 1_700_000_000_000)
  assert.deepEqual(frame.undeclared, [], 'everything it used is declared in extension/extension.json')
})

test('the time left reads as minutes and seconds', () => {
  assert.equal(formatRemaining(25 * 60_000), '25:00')
  assert.equal(formatRemaining(61_500), '1:02')
  assert.equal(formatRemaining(-5), '0:00')
})
