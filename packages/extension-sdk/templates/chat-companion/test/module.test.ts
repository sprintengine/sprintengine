// Your tests, in TypeScript: `npm test` runs test/*.test.ts with `node --test`,
// loading the source as Studio loads it (see AGENTS.md). Drive the source with
// the SDK's fakes: the worker against a fake main host whose chats you can make
// the agent answer in, the panel's calls against a fake frame that reaches the
// worker's methods.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeFrameStudio, createFakeMainHost } from '@sprintengine/extension-sdk/testing'

import { chatLabel } from '../extension/src/companion'
import { activate } from '../extension/src/main'
import type { CompanionMethods } from '../extension/src/protocol'
import { manifest } from './manifest'

test('starting a summary opens a chat, and its end is announced', async () => {
  const main = createFakeMainHost({ manifest })
  activate(main.host)
  await main.startup()

  const answer = await main.methods.operate('start', { workspaceId: 'ws-app' })
  assert.ok(answer.ok, JSON.stringify(answer))
  const started = answer.result as { conversation: { workspaceId: string; agentId: string } }
  const [chat] = main.services.conversations.all()
  assert.match(String(chat?.events.find((event) => event.type === 'user_message')?.payload?.text), /README/)

  // The agent finishes its turn: nothing went wrong, so the bell is left alone.
  main.services.conversations.emitEvent(started.conversation, { type: 'turn_completed' })
  assert.deepEqual(main.notifications, [])
  assert.ok(
    main.emitted.some((event) => event.topic === 'conversations-changed'),
    'windows are told to read again',
  )
  assert.deepEqual(main.undeclared, [])
  await main.shutdown()
})

test('a turn that fails says so in the bell', async () => {
  const main = createFakeMainHost({ manifest })
  activate(main.host)
  const answer = await main.methods.operate('start', { workspaceId: 'ws-app' })
  assert.ok(answer.ok, JSON.stringify(answer))
  const started = answer.result as { conversation: { workspaceId: string; agentId: string } }
  main.services.conversations.emitEvent(started.conversation, { type: 'turn_failed' })
  assert.deepEqual(
    main.notifications.map((notification) => notification.title),
    ['Project summary did not finish'],
  )
})

test('a bad request is answered, not thrown', async () => {
  const main = createFakeMainHost({ manifest })
  activate(main.host)
  assert.deepEqual(await main.methods.operate('start', {}), {
    ok: false,
    code: 'invalid_params',
    message: 'Pick a workspace first.',
  })
})

test('the panel reaches the worker’s methods, and names each chat with how it is doing', async () => {
  const main = createFakeMainHost({ manifest })
  activate(main.host)
  const frame = createFakeFrameStudio({ manifest, main })
  const studio = frame.studio({ point: 'panels', id: 'chats', workspaceId: 'ws-app' })
  const methods = studio.methods<CompanionMethods>()
  assert.deepEqual(await methods.read('list', {}), { ok: true, result: [] })
  const started = await methods.operate('start', { workspaceId: 'ws-app' })
  assert.ok(started.ok, JSON.stringify(started))
  const listed = await methods.read('list', {})
  assert.ok(listed.ok)
  assert.match(chatLabel(listed.result[0]!), /^Project summary · /)
  assert.deepEqual(frame.undeclared, [])
})
