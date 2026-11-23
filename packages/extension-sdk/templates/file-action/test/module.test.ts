// Your tests, in TypeScript: `npm test` runs test/*.test.ts with `node --test`,
// loading the source as Studio loads it (see AGENTS.md). Drive the worker with
// the SDK's fake main host, handing it `manifest` from ./manifest, and run the
// command the way Studio does: its method, with what the menu was picked on.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeMainHost } from '@sprintengine/extension-sdk/testing'

import { activate, itemTitle } from '../extension/src/main'
import { manifest } from './manifest'

test('the picked files become one Backlog item', async () => {
  const main = createFakeMainHost({ manifest })
  activate(main.host)
  const answer = await main.methods.operate('add-to-backlog', {
    where: 'file',
    workspaceId: 'ws-app',
    filePaths: ['src/login.ts', 'README.md'],
  })
  assert.ok(answer.ok, JSON.stringify(answer))
  const [item] = main.services.backlog.items('ws-app')
  assert.equal(item?.title, 'Look at 2 files')
  assert.match(item?.sourceContent ?? '', /src\/login\.ts/)
  assert.deepEqual(main.undeclared, [], 'everything it used is declared in extension/extension.json')
})

test('the title names a single file', () => {
  assert.equal(itemTitle(['docs/setup.md']), 'Look at docs/setup.md')
})

test('run without a file, it says what to do', async () => {
  const main = createFakeMainHost({ manifest })
  activate(main.host)
  assert.deepEqual(await main.methods.operate('add-to-backlog', { where: 'palette', workspaceId: 'ws-app' }), {
    ok: false,
    code: 'invalid_params',
    message: 'Pick at least one file.',
  })
})
