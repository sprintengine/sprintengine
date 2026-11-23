// The door. `npm test` runs test/*.test.ts with `node --test`; a test has no
// DOM, so what the door draws is in the shots `npm run dev` writes.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DOOR_TEXT, mount } from '../extension/src/door'
import { manifest } from './manifest'

test('the door is declared, and its source exports mount', () => {
  assert.deepEqual(
    manifest.contributes.doors.filter((door) => door.id === 'door').map((door) => door.entry),
    ['src/door.ts'],
  )
  assert.equal(typeof mount, 'function')
  assert.match(DOOR_TEXT.heading, /Nothing here yet/)
})
