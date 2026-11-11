import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { ConversationRuntime } from './conversation-runtime'
import { createMockConversationProvider } from './providers/mock-conversation-provider'

// The person's words for one agent go through the chat's own model, as a message
// Studio sends, addressed by the agent's task id, and only where the provider
// says it can. What they typed is what the lane records, not what the model was
// asked.

async function fixture(options: { capability?: boolean; ceiling?: 'manual' | 'auto' } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'message-subagent-'))
  const expected: string[] = []
  const capability = options.capability ?? true
  const mock = createMockConversationProvider({ messageSubagent: capability })
  const runtime = new ConversationRuntime({
    adapters: [
      {
        ...mock,
        ...(capability ? { expectSubagentMessage: (_: string, taskId: string) => void expected.push(taskId) } : {}),
        async setPermissionPreset() {
          return { ok: true as const }
        },
      },
    ],
    getProviderById: () => undefined,
    ...(options.ceiling ? { subagentPresetCeiling: () => options.ceiling } : {}),
  })
  const started = await runtime.startSession({
    workspaceRoot,
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock-provider',
    modelId: 'mock-model',
  })
  assert.ok(started.ok)
  const sessionId = started.session.sessionId
  const internal = runtime as unknown as { sessions: Map<string, { subagentLanes: Map<string, string> }> }
  internal.sessions.get(sessionId)!.subagentLanes.set('task-1', 'toolu_agent')
  return {
    runtime,
    sessionId,
    expected,
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

const sent = async (runtime: ConversationRuntime, input: Parameters<ConversationRuntime['messageSubagent']>[0]) => {
  const events: { type: string; payload?: Record<string, unknown> }[] = []
  const stop = runtime.onEvent((event) => events.push(event))
  const result = await runtime.messageSubagent(input)
  stop()
  return { result, message: events.find((event) => event.type === 'user_message') }
}

test('the words go to the chat as Studio’s, naming the agent’s task id, and the lane keeps what was typed', async () => {
  const f = await fixture()
  try {
    const { result, message } = await sent(f.runtime, {
      sessionId: f.sessionId,
      toolUseId: 'toolu_agent',
      message: '  Check the e2e too  ',
    })
    assert.equal(result.ok, true)
    assert.deepEqual(f.expected, ['task-1'])
    assert.deepEqual(message?.payload?.origin, { kind: 'studio', reason: 'agent-message' })
    assert.deepEqual(message?.payload?.subagentMessage, { toolUseId: 'toolu_agent', text: 'Check the e2e too' })
    assert.match(String(message?.payload?.text), /SendMessage tool, to: 'task-1'/u)
    assert.match(String(message?.payload?.text), /Check the e2e too$/u)
  } finally {
    await f.cleanup()
  }
})

test('a chat whose provider cannot is refused in words, and nothing goes', async () => {
  const f = await fixture({ capability: false })
  try {
    const { result, message } = await sent(f.runtime, {
      sessionId: f.sessionId,
      toolUseId: 'toolu_agent',
      message: 'Hi',
    })
    assert.deepEqual(result, { ok: false, message: 'This chat cannot pass a message to one agent.' })
    assert.equal(message, undefined)
  } finally {
    await f.cleanup()
  }
})

test('an agent with no task id on record cannot be addressed, and an empty message is refused', async () => {
  const f = await fixture()
  try {
    assert.equal(
      (await sent(f.runtime, { sessionId: f.sessionId, toolUseId: 'toolu_x', message: 'Hi' })).result.ok,
      false,
    )
    assert.equal(
      (await sent(f.runtime, { sessionId: f.sessionId, toolUseId: 'toolu_agent', message: ' ' })).result.ok,
      false,
    )
    assert.deepEqual(f.expected, [])
  } finally {
    await f.cleanup()
  }
})

test('a sub-agent cannot be switched past its ceiling, by any path, and may go stricter', async () => {
  const f = await fixture({ ceiling: 'auto' })
  try {
    const refused = await f.runtime.setPermission({ sessionId: f.sessionId, permissionPreset: 'bypass' })
    assert.deepEqual(refused, { ok: false, message: 'A subagent cannot run with more permission than its parent.' })
    const stricter = await f.runtime.setPermission({ sessionId: f.sessionId, permissionPreset: 'manual' })
    assert.equal(stricter.ok, true)
  } finally {
    await f.cleanup()
  }
})

test('the mock provider’s `/subagent` leaves an agent running whose lane a message reaches', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'message-subagent-mock-'))
  const runtime = new ConversationRuntime({
    adapters: [createMockConversationProvider()],
    getProviderById: () => undefined,
  })
  try {
    const started = await runtime.startSession({
      workspaceRoot,
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'mock-provider',
      modelId: 'mock-model',
    })
    assert.ok(started.ok)
    const sessionId = started.session.sessionId
    const events: { type: string; payload?: Record<string, unknown> }[] = []
    const stop = runtime.onEvent((event) => events.push(event))
    assert.equal((await runtime.sendTurn({ sessionId, message: '/subagent' })).ok, true)
    const status = events.find((event) => event.type === 'subagent_status')
    assert.equal(status?.payload?.status, 'running')
    const toolUseId = String(status?.payload?.toolUseId)
    const result = await runtime.messageSubagent({ sessionId, toolUseId, message: 'Check the e2e too' })
    stop()
    assert.equal(result.ok, true)
    const message = events.find((event) => event.type === 'user_message' && event.payload?.subagentMessage)
    assert.deepEqual(message?.payload?.subagentMessage, { toolUseId, text: 'Check the e2e too' })
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
