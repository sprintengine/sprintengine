// Your tests, in TypeScript: `npm test` bundles test/*.test.ts and runs them
// with `node --test` (see AGENTS.md). Drive the worker with the SDK's fake
// main host, handing it `manifest` from ./manifest, and run the command the
// way Studio does: its method, with what the menu was picked on.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeMainHost } from '@sprintengine/extension-sdk/testing'

import { activate } from '../src/main'
import { manifest } from './manifest'

test('planning an item starts a chat that names it', async () => {
  const main = createFakeMainHost({ manifest })
  main.services.backlog.seed('ws-app', [{ title: 'Fix the login page' }])
  const [item] = main.services.backlog.items('ws-app')
  activate(main.host)

  const answer = await main.methods.operate('plan-in-chat', {
    where: 'backlog.item',
    workspaceId: 'ws-app',
    backlogItemIds: [item!.id],
  })
  assert.ok(answer.ok, JSON.stringify(answer))
  const [chat] = main.services.conversations.all()
  assert.match(String(chat?.events.find((event) => event.type === 'user_message')?.payload?.text), /Fix the login page/)
  assert.deepEqual(main.undeclared, [], 'everything it used is declared in extension/extension.json')
})

test('run without an item, it says what to do', async () => {
  const main = createFakeMainHost({ manifest })
  activate(main.host)
  assert.deepEqual(await main.methods.operate('plan-in-chat', { where: 'palette', workspaceId: 'ws-app' }), {
    ok: false,
    code: 'invalid_params',
    message: 'Pick at least one Backlog item.',
  })
})
