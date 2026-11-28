import assert from 'node:assert/strict'

import { test } from 'vitest'

import { StudioError, type StudioClient } from '../../../packages/client-runtime/src/public'
import type { EnvironmentClients } from '../../shared/environment-clients'
import { chatEnvironments, environmentCommand, environmentPage } from './environment-chat-calls'

// The desktop's own callers (the gateway's conversation tools) acting on a
// chat an SSH machine holds: the same protocol method a window sends, on this
// desktop's client of that machine, never this core's runtime; a machine it
// cannot reach answered in words; this core's own chats untouched.

const ROUTE = 'ssh:build-box'
const KEY = { workspaceId: 'w1', agentId: 'a1', workspaceRoot: 'ssh://build-box/home/dev/repo' }

function machine(answer: (method: string, params: Record<string, unknown>) => unknown) {
  const asked: Array<{ method: string; params: Record<string, unknown> }> = []
  const client = {
    async request(method: string, params: Record<string, unknown>) {
      asked.push({ method, params })
      return answer(method, params)
    },
    conversations: {
      async loadEarlier(ref: unknown, before: number, turns: number) {
        asked.push({ method: 'conversation.loadEarlier', params: { ref, before, turns } })
        return { ok: true, page: { events: [{ seq: 1 }], hasMore: false, beforeCursor: null } }
      },
    },
  } as unknown as StudioClient
  const clients: EnvironmentClients = {
    clientFor: async (route) =>
      route === ROUTE
        ? { ok: true, client, name: 'build-box' }
        : { ok: false, code: 'unavailable', message: 'other-box is not connected.' },
    onConnected: () => () => undefined,
  }
  return { clients, asked }
}

test("send, interrupt and an approval's answer go to the machine as the method a window sends, under the same command id", async () => {
  const { clients, asked } = machine(() => ({ notice: 'queued' }))
  const sent = await environmentCommand(clients, ROUTE, KEY, 'cmd-1', { kind: 'send', message: 'hello' } as never)
  assert.deepEqual(sent, { ok: true, notice: 'queued' })
  await environmentCommand(clients, ROUTE, KEY, 'cmd-2', { kind: 'interrupt' } as never)
  await environmentCommand(clients, ROUTE, KEY, 'cmd-3', {
    kind: 'resolveApproval',
    requestId: 'r1',
    decision: 'once',
  } as never)
  assert.deepEqual(
    asked.map((entry) => [entry.method, entry.params.commandId]),
    [
      ['conversation.send', 'cmd-1'],
      ['conversation.interrupt', 'cmd-2'],
      ['conversation.resolveApproval', 'cmd-3'],
    ],
  )
  assert.equal(asked[0]?.params.message, 'hello')
  assert.deepEqual(asked[0]?.params.key, KEY)
})

test('a read pages the transcript there', async () => {
  const { clients, asked } = machine(() => ({}))
  const page = await environmentPage(clients, ROUTE, KEY, { turns: 5 })
  assert.ok(page.ok)
  assert.deepEqual(page.events, [{ seq: 1 }])
  assert.equal(asked[0]?.method, 'conversation.loadEarlier')
})

test('a machine that cannot be reached, or refuses, is answered in words', async () => {
  const { clients } = machine(() => {
    throw new StudioError('not_found', 'No such chat.')
  })
  const away = await environmentCommand(clients, 'ssh:other-box', KEY, 'c', { kind: 'interrupt' } as never)
  assert.deepEqual(away, { ok: false, code: 'unavailable', message: 'other-box is not connected.' })
  const refused = await environmentCommand(clients, ROUTE, KEY, 'c', { kind: 'interrupt' } as never)
  assert.ok(!refused.ok && refused.message?.startsWith('build-box: '))
  const unread = await environmentPage(null, ROUTE, KEY, { turns: 5 })
  assert.ok(!unread.ok)
})

test("a chat is placed on the machine its address or its copy's record names; this core's own is here", async () => {
  const { clients } = machine(() => ({}))
  const environments = chatEnvironments({
    clients,
    ownEnvironmentId: () => 'env-here',
    routesOf: async (id) => (id === 'env-ssh' ? [ROUTE] : []),
    recordOf: (workspaceId) => (workspaceId === 'w1' ? { environment: { kind: 'ssh', id: 'build-box' } } : {}),
  })
  assert.deepEqual(await environments.place({ environmentId: 'env-ssh', chatId: 'w9' }), {
    ok: true,
    route: ROUTE,
    workspaceId: 'w9',
  })
  // A copy's id (until the copies go) is its machine's chat, under the same id.
  assert.deepEqual(await environments.place({ environmentId: null, chatId: 'w1' }), {
    ok: true,
    route: ROUTE,
    workspaceId: 'w1',
  })
  assert.deepEqual(await environments.place({ environmentId: 'env-here', chatId: 'w-local' }), {
    ok: true,
    route: null,
    workspaceId: 'w-local',
  })
  const unknown = await environments.place({ environmentId: 'env-gone', chatId: 'w1' })
  assert.ok(!unknown.ok && unknown.code === 'unknown_environment')
})

test("a chat started on a machine is that machine's conversation.create, answered as this core's launch answers", async () => {
  const { clients, asked } = machine(() => ({
    conversation: {
      workspaceId: 'w1',
      agentId: 'new',
      sessionId: 's1',
      name: 'Chat',
      cli: 'claude-code',
      providerId: 'claude',
      modelId: 'm',
    },
  }))
  const environments = chatEnvironments({
    clients,
    ownEnvironmentId: () => 'env-here',
    routesOf: null,
    recordOf: () => null,
  })
  const there = await environments.launch(ROUTE, {
    workspaceId: 'w1',
    newChat: true,
    prompt: 'Go',
    cli: 'claude-code',
    launchCommandId: 'L1',
  })
  assert.ok(there.ok && there.agentId === 'new' && there.sessionId === 's1')
  assert.equal(asked[0]?.method, 'conversation.create')
  assert.deepEqual(asked[0]?.params, {
    commandId: 'L1',
    workspaceId: 'w1',
    newChat: true,
    cli: 'claude-code',
    prompt: 'Go',
  })
  const away = await environments.launch('ssh:other-box', { noProject: true })
  assert.ok(!away.ok && away.code === 'unavailable')
})
