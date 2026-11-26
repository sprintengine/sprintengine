import { testChatDatabase } from '../../tests/studio-database'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { ConversationRuntime } from './conversation-runtime'
import type {
  ConversationProviderAdapter,
  ConversationProviderLiveSession,
  MockAdapterSessionInput,
  MockAdapterTurnInput,
} from './providers/conversation-provider-adapter'
import type { ConversationEvent, ConversationEventType } from '../shared/conversation-runtime'

// What the Sessions list counts as running is read off the runtime's
// summaries: a session whose child is gone must say it rests, and a session
// whose chat is gone must not be listed at all.

const runtimes = new Set<ConversationRuntime>()
afterEach(async () => {
  const open = Array.from(runtimes)
  runtimes.clear()
  await Promise.all(open.map((runtime) => runtime.shutdown().catch(() => undefined)))
})

function event(
  input: Pick<MockAdapterSessionInput, 'sessionId' | 'workspaceId' | 'agentId' | 'providerId' | 'modelId'>,
  type: ConversationEventType,
  payload?: Record<string, unknown>,
): ConversationEvent {
  return {
    id: '',
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    providerId: input.providerId,
    modelId: input.modelId,
    type,
    createdAt: 0,
    payload,
  }
}

/**
 * A stateful provider whose child starts with the first turn and stays until
 * it is disposed or `exit` ends it by itself, as a CLI that quits on its own.
 */
function childProvider() {
  const children = new Map<string, { input: MockAdapterSessionInput; alive: boolean }>()
  const stopped: string[] = []
  const adapter: ConversationProviderAdapter = {
    id: 'child-provider',
    sessions: 'stateful',
    listModels: () => ['model'],
    startSession(input) {
      children.set(input.sessionId, { input, alive: false })
      return [event(input, 'session_started'), event(input, 'session_ready')]
    },
    async *sendTurn(input: MockAdapterTurnInput) {
      const child = children.get(input.sessionId)
      if (child) child.alive = true
      yield event(input, 'turn_started', { turnId: input.turnId })
      yield event(input, 'turn_completed', { turnId: input.turnId })
    },
    resolveApproval: () => [],
    interrupt: () => [],
    stopSession(input) {
      stopped.push(input.sessionId)
      const child = children.get(input.sessionId)
      if (child) child.alive = false
      return [event(input, 'session_closed')]
    },
    listLiveSessions(): ConversationProviderLiveSession[] {
      return Array.from(children.values(), ({ input, alive }) => ({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        workspaceRoot: input.workspaceRoot ?? '',
        providerSessionId: null,
        hasChildProcess: alive,
        childPid: alive ? 4242 : null,
        turnActive: false,
        pendingApproval: false,
        lastActivityAt: 0,
        spawnedAt: alive ? 0 : null,
      }))
    },
    disposeChildProcess(sessionId) {
      const child = children.get(sessionId)
      if (!child?.alive) return false
      child.alive = false
      return true
    },
  }
  return {
    adapter,
    stopped,
    /** The child ends by itself, and tells the runtime as a provider does. */
    exit(sessionId: string) {
      const child = children.get(sessionId)
      if (!child) throw new Error(`no child for ${sessionId}`)
      child.alive = false
      child.input.onChildExited?.()
    },
  }
}

async function setup(now: () => number = () => 1_000) {
  const provider = childProvider()
  const runtime = new ConversationRuntime({
    database: testChatDatabase(),
    adapters: [provider.adapter],
    getProviderById: () => undefined,
    secretStore: {
      getStatus: async () => ({ ok: false, message: 'unused' }),
      resolveSecret: async () => ({ ok: false, message: 'unused' }),
    },
    now,
  })
  runtimes.add(runtime)
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'session-count-'))
  const start = async (workspaceId: string, agentId = 'agent-1') => {
    const started = await runtime.startSession({
      workspaceRoot,
      workspaceId,
      agentId,
      providerId: 'child-provider',
      modelId: 'model',
    })
    assert.ok(started.ok, started.ok ? '' : started.message)
    return started.session.sessionId
  }
  const summary = (sessionId: string) => {
    const listed = runtime.listSessions()
    return listed.ok ? listed.sessions.find((session) => session.sessionId === sessionId) : undefined
  }
  return { runtime, provider, start, summary }
}

test('a child that exits by itself while the chat is idle leaves the session resting, and the lists are told', async () => {
  const { runtime, provider, start, summary } = await setup()
  const sessionId = await start('ws-1')
  const sent = await runtime.sendTurn({ sessionId, message: 'hello' })
  assert.equal(sent.ok, true)
  assert.equal(summary(sessionId)?.status, 'ready')
  assert.equal(summary(sessionId)?.resting, undefined, 'its child is live after the turn')

  const told: ConversationEvent[] = []
  runtime.onEvent((event) => told.push(event))
  provider.exit(sessionId)

  assert.equal(summary(sessionId)?.status, 'ready', 'the session stays, so the next message resumes it')
  assert.equal(summary(sessionId)?.resting, true, 'it holds no process now')
  assert.deepEqual(
    told.map((event) => [event.type, event.payload?.resting]),
    [['session_updated', true]],
  )

  // The next message starts the child again, and the session is live once more.
  assert.equal((await runtime.sendTurn({ sessionId, message: 'again' })).ok, true)
  assert.equal(summary(sessionId)?.resting, undefined)
})

test('the idle sweep marks a session resting whose child never started or already went', async () => {
  let clock = 1_000
  const { runtime, start, summary } = await setup(() => clock)
  runtime.setIdleThresholdMs(60_000)
  const sessionId = await start('ws-1')
  assert.equal(summary(sessionId)?.resting, undefined)

  clock += 61_000
  // Nothing was disposed: there was no child to dispose.
  assert.deepEqual(runtime.sweepIdleSessions(clock), [])
  assert.equal(summary(sessionId)?.resting, true, 'a chat opened and never sent to holds no process')
})

test('removing a chat stops its sessions and drops them from the list', async () => {
  const { runtime, provider, start, summary } = await setup()
  const removed = await start('ws-gone')
  const kept = await start('ws-kept')
  await runtime.sendTurn({ sessionId: removed, message: 'hello' })

  const forgotten = await runtime.forgetWorkspaceSessions('ws-gone')

  assert.deepEqual(forgotten, [removed])
  assert.deepEqual(provider.stopped, [removed], 'its child was stopped')
  assert.equal(summary(removed), undefined, 'no longer listed under any chat')
  assert.equal(summary(kept)?.status, 'ready', "another chat's session is left alone")
})

test('removing a chat keeps the session of an agent that was moved to another chat', async () => {
  const { runtime, provider, start, summary } = await setup()
  const moved = await start('ws-source', 'agent-moved')
  const stays = await start('ws-source', 'agent-1')

  const forgotten = await runtime.forgetWorkspaceSessions('ws-source', {
    followedElsewhere: (agentId) => agentId === 'agent-moved',
  })

  assert.deepEqual(forgotten, [stays])
  assert.deepEqual(provider.stopped, [stays])
  assert.equal(summary(moved)?.status, 'ready')
})
