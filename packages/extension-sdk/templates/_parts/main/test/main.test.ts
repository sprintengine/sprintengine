// The worker, against the SDK's fake main host. `npm test` runs
// test/*.test.ts with `node --test` (see AGENTS.md).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeMainHost } from '@sprintengine/extension-sdk/testing'

import { activate } from '../extension/src/main'
import { manifest } from './manifest'

test('a surface can ask when the worker started', async () => {
  const fake = createFakeMainHost({ manifest })
  activate(fake.host)
  const status = await fake.methods.read('status', {})
  assert.ok(status.ok, JSON.stringify(status))
  assert.equal(typeof (status.result as { startedAt: number }).startedAt, 'number')
  assert.deepEqual(fake.undeclared, [])
})
