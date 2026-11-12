// Your tests, in TypeScript: `npm test` bundles test/*.test.ts and runs them
// with `node --test` (see AGENTS.md). Drive the source with the SDK's fakes:
// the main half against a fake host whose chats you can make the agent answer
// in, the window half against a fake renderer that calls its methods.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createFakeMainHost, createFakeRendererHost } from '@sprintengine/module-sdk/testing'

import manifest from '../module/manifest.json'
import { registerMain } from '../src/main'
import { registerRenderer } from '../src/renderer'

test('starting a summary opens a chat, and its end is announced', async () => {
  const main = createFakeMainHost({ manifest })
  await registerMain(main.host)
  await main.startup()

  const answer = await main.methods.operate('start', { workspaceId: 'ws-app' })
  assert.ok(answer.ok, JSON.stringify(answer))
  const started = answer.result as { conversation: { workspaceId: string; agentId: string } }
  const [chat] = main.services.conversations.all()
  assert.match(String(chat?.events.find((event) => event.type === 'user_message')?.payload?.text), /README/)

  // The agent finishes its turn: nothing went wrong, so the bell is left alone.
  main.services.conversations.emitEvent(started.conversation, { type: 'turn_completed' })
  assert.deepEqual(main.notifications, [])
  assert.ok(main.emitted.some((event) => event.topic === 'conversations-changed'), 'windows are told to read again')
  assert.deepEqual(main.undeclared, [])
})

test('a turn that fails says so in the bell', async () => {
  const main = createFakeMainHost({ manifest })
  await registerMain(main.host)
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
  await registerMain(main.host)
  assert.deepEqual(await main.methods.operate('start', {}), {
    ok: false,
    code: 'invalid_params',
    message: 'Pick a workspace first.',
  })
})

test('the door renders, and calls the main half’s methods', async () => {
  const main = createFakeMainHost({ manifest })
  await registerMain(main.host)
  const renderer = createFakeRendererHost({ main })
  await registerRenderer(renderer.host)
  assert.match(await renderer.render.surface('{{id}}'), /None yet/)
  assert.deepEqual(await renderer.host.methods().read('list', {}), { ok: true, result: [] })
  assert.deepEqual(renderer.undeclared, [])
})
