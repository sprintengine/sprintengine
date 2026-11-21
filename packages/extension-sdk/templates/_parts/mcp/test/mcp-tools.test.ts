// The MCP tools, called the way an agent calls them, against the SDK's fake
// main host. `npm test` bundles test/*.test.ts and runs them with `node --test`.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeMainHost } from '@sprintengine/extension-sdk/testing'

import { activate } from '../src/main'
import { manifest } from './manifest'

test('an agent can ask which extension this is', async () => {
  const fake = createFakeMainHost({ manifest })
  await activate(fake.host)
  const result = await fake.tools.call('{{toolPrefix}}_about')
  assert.deepEqual(result.structuredContent, { extension: `local.${manifest.id}` })
})
