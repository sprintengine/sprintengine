// Your tests, in TypeScript: `npm test` runs test/*.test.ts with `node --test`,
// loading the source as Studio loads it (see AGENTS.md). Drive the source with
// the SDK's fakes, handing them `manifest` from ./manifest.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeMainHost } from '@sprintengine/extension-sdk/testing'

import { activate } from '../extension/src/main'
import { manifest } from './manifest'

test('an agent can count words', async () => {
  const fake = createFakeMainHost({ manifest })
  activate(fake.host)
  const result = await fake.tools.call('{{toolPrefix}}_word_count', { text: 'one two\nthree' })
  assert.deepEqual(result.structuredContent, { words: 3, lines: 2, characters: 13 })
  const refused = await fake.tools.call('{{toolPrefix}}_word_count', { text: 42 })
  assert.equal(refused.isError, true)
})

test('an agent can list the open workspaces', async () => {
  const fake = createFakeMainHost({
    manifest,
    workspaces: [{ id: 'ws-docs', name: 'Docs', folderPath: '/Users/dev/docs', mode: 'standard' }],
  })
  activate(fake.host)
  const result = await fake.tools.call('{{toolPrefix}}_open_workspaces')
  assert.equal(result.content[0]?.type === 'text' && result.content[0].text, 'Docs — /Users/dev/docs')
  assert.deepEqual(fake.undeclared, [], 'everything it used is declared in extension/extension.json')
})

test('extension.json declares every tool the worker serves, read-only', () => {
  const fake = createFakeMainHost({ manifest })
  activate(fake.host)
  assert.deepEqual(
    fake.tools.list().map((tool) => [tool.name, tool.mutates]),
    manifest.contributes.mcpTools.map((tool) => [tool.name, false]),
  )
})
