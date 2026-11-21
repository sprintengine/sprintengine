// Your tests, in TypeScript: `npm test` bundles test/*.test.ts and runs them
// with `node --test` (see AGENTS.md). Drive the source with the SDK's fakes:
// the worker against a fake main host whose chats you can make the agent
// answer in, the panel against a fake renderer that calls the worker's methods.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createElement } from 'react'

import { createFakeFrameStudio, createFakeMainHost, renderToHtml } from '@sprintengine/extension-sdk/testing'

import { CompanionPanel } from '../src/companion'
import { activate } from '../src/main'
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

test('the panel draws, and reaches the worker’s methods', async () => {
  const main = createFakeMainHost({ manifest })
  activate(main.host)
  const frame = createFakeFrameStudio({ manifest, main })
  const studio = frame.studio({ point: 'panels', id: 'chats', workspaceId: 'ws-app' })
  assert.match(await renderToHtml(createElement(CompanionPanel, { studio })), /Summarise this project/)
  assert.deepEqual(await studio.methods().read('list', {}), { ok: true, result: [] })
  assert.deepEqual(frame.undeclared, [])
})
