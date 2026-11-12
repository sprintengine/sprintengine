import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import type { StudioParsedServerFrame } from '../../../packages/studio-protocol/src/public'
import type { ConversationThread as IndexedThread } from '../../shared/conversation-index'
import type { ConversationBackend } from '../core/conversation-backend'
import {
  createConversationGatewayHost,
  type ConversationListWorkspace,
} from '../../main/automation/tailnet/tailnet-conversation-host'
import { studioRpcConversationCapabilities } from './studio-rpc-server'
import { connectLineClient, createFakeBackend, hello, pairFakeClient, startTestServer } from './studio-rpc.test-helper'

// The Studio socket advertises `conversation-lifecycle`, as the tailnet lane
// does, and its list keeps the promise the capability makes on both: settled
// chats left out, the rest in the sidebar's order. A host built without the
// lifecycle list (Studio's own sends) lists every chat by when each last moved.

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function thread(agentId: string, updatedAt: number): IndexedThread {
  return {
    agentId,
    title: `First message of ${agentId}`,
    titleSource: 'first-message',
    createdAt: 1,
    updatedAt,
    turnCount: 1,
    model: 'default',
    providerId: 'mock',
    lastSeq: 4,
    firstUserText: 'hello',
  }
}

const threads: Record<string, IndexedThread[]> = {
  resting: [thread('agent-1', 300)],
  written: [thread('agent-1', 100)],
  moved: [thread('agent-1', 200)],
}
const records: Record<string, ConversationListWorkspace> = {
  resting: { name: 'Resting', createdAt: 1, settledAt: 50 },
  written: { name: 'Written', createdAt: 1, lastUserMessageAt: 900 },
  moved: { name: 'Moved', createdAt: 1, lastUserMessageAt: 10 },
}

/** The conversation host as the core builds it, for one door or the other. */
function host(lifecycleList: boolean) {
  const runtime = {
    listSessions: () => ({ ok: true, sessions: [] }),
    listThreads: async (key: { workspaceId: string }) => ({ ok: true, threads: threads[key.workspaceId] ?? [] }),
    getProviderCapabilities: () => undefined,
  } as unknown as ConversationBackend
  return createConversationGatewayHost(
    runtime,
    () => '/Users/dev/app',
    () => Object.keys(threads).map((workspaceId) => ({ workspaceId, workspaceRoot: '/Users/dev/app' })),
    () => 'bypass',
    () => null,
    async () => null,
    {},
    {
      workspaceOf: (workspaceId) => records[workspaceId] ?? null,
      ...(lifecycleList ? { lifecycleList: true } : {}),
    },
  )
}

test('the Studio socket advertises conversation-lifecycle and lists as it promises', async () => {
  const conversationHost = host(true)
  const fake = createFakeBackend()
  const backend = {
    ...fake,
    list: () => conversationHost.list(),
    followed: {
      settle: () => ({ ok: true as const, settledAt: 1 }),
      visit: () => ({ ok: true as const, lastVisitedAt: 1 }),
    },
  }
  const started = await startTestServer({ backend })
  cleanups.push(() => started.dispose())
  const c = await connectLineClient(started.path)
  cleanups.push(() => c.close())
  c.send(hello({ token: pairFakeClient(started.auth, 'reader', ['conversation:read']) }))
  const welcome = await c.next((frame: StudioParsedServerFrame) => frame.t === 'welcome')
  assert.ok(welcome.t === 'welcome' && welcome.conversation.capabilities.includes('conversation-lifecycle'))

  c.send({ t: 'req', id: 'l1', method: 'conversation.list' })
  const listed = await c.next((frame: StudioParsedServerFrame) => frame.t === 'res' && frame.id === 'l1')
  assert.ok(listed.t === 'res' && listed.ok)
  const conversations = (listed.result as { conversations: Array<{ workspaceId: string }> }).conversations
  assert.deepEqual(
    conversations.map((conversation) => conversation.workspaceId),
    ['written', 'moved'],
  )
})

test('a Studio that cannot settle a chat does not advertise conversation-lifecycle', () => {
  assert.equal(studioRpcConversationCapabilities(createFakeBackend()).includes('conversation-lifecycle'), false)
})

test('a host without the lifecycle list lists every chat, settled ones too, by when each last moved', async () => {
  const listed = await host(false).list()
  assert.deepEqual(
    listed.map((conversation) => conversation.workspaceId),
    ['resting', 'moved', 'written'],
  )
})

test('the tailnet lane’s host leaves the settled chat out and lists in the sidebar’s order', async () => {
  const listed = await host(true).list()
  assert.deepEqual(
    listed.map((conversation) => conversation.workspaceId),
    ['written', 'moved'],
  )
})
