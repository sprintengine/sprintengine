import assert from 'node:assert/strict'

import { createConversationApi } from './conversation'
import { test } from 'vitest'

// What the window still drives a chat's session through over IPC, each member
// on its own channel. Its sessions list, stop, suspend, terminal handoff,
// providers, keys and all-chats events are the Studio protocol's
// (`windowChatServices`), with no channel here.
test('each session member invokes its own channel', async () => {
  const calls: string[] = []
  const session = {
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock-provider',
    modelId: 'mock-model',
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
  }
  const api = createConversationApi({
    async invoke(channel: string): Promise<any> {
      calls.push(channel)
      return { ok: true, session }
    },
    on() {},
    removeListener() {},
  })

  await api.conversationSessionStart({
    workspaceRoot: '/workspace',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock-provider',
    modelId: 'mock-model',
  })
  await api.conversationSessionSendTurn({ sessionId: 'conv_1', message: 'hello' })
  await api.conversationSessionInterrupt({ sessionId: 'conv_1' })
  await api.conversationSessionRespondToRequest({ sessionId: 'conv_1', requestId: 'approval_1', approved: true })
  await api.conversationSessionSetPermission({ sessionId: 'conv_1', permissionPreset: 'bypass' })
  assert.deepEqual(calls, [
    'conversation:sessions:start',
    'conversation:sessions:send-turn',
    'conversation:sessions:interrupt',
    'conversation:sessions:respond-to-request',
    'conversation:sessions:set-permission',
  ])
  assert.equal('conversationSessionsList' in api, false)
  assert.equal('onConversationEvent' in api, false)
})
