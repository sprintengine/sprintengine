import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { McpConnectionContext } from '../../shared/modules/mcp-tools'
import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import { OWN_SETTLE_GRACE_MS } from './conversation-lifecycle'
import { createConversationSelfCompact } from './conversation-self-compact'
import { createConversationTools } from './conversation-tools'
import { localOnlyGatewayToolReason } from './tailnet/tailnet-scopes'

// An agent compacting its own chat: held for the end of its turn, sent then
// as Studio's own `/compact`, and let go when the chat moves on first.

function fixture(options: { providerId?: string; status?: ConversationSessionSummary['status'] } = {}) {
  const session = {
    sessionId: 'conv-1',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: options.providerId ?? 'claude-agent',
    modelId: 'default',
    status: options.status ?? 'active',
    phase: options.status === 'ready' ? 'completed' : 'running',
  } as ConversationSessionSummary
  const state = { session: session as ConversationSessionSummary | null, messageWaiting: false, refuse: false }
  const sends: Array<{ sessionId: string; commandId: string }> = []
  const timers: Array<{ job: () => void; ms: number; cancelled: boolean }> = []
  const logs: string[] = []
  const compact = createConversationSelfCompact({
    sessionOf: (workspaceId, agentId) =>
      state.session && state.session.workspaceId === workspaceId && state.session.agentId === agentId
        ? state.session
        : null,
    messageWaiting: () => state.messageWaiting,
    send: async (sent, commandId) => {
      sends.push({ sessionId: sent.sessionId, commandId })
      return state.refuse ? { ok: false, message: 'refused there' } : { ok: true }
    },
    schedule: (job, ms) => {
      const timer = { job, ms, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    log: (message) => logs.push(message),
  })
  const tool = createConversationTools({
    launch: async () => assert.fail('no chat is started here'),
    resolveAgentPermissionPreset: () => 'bypass',
    lifecycle: {} as never,
    compactOwnChat: compact.request,
  }).find((candidate) => candidate.name === 'conversation.compact')!
  /** The turn ending, as the runtime reports it: the chat is ready again. */
  const turnEnds = (payload: Record<string, unknown> = {}) => {
    state.session = { ...session, status: 'ready', phase: 'completed' }
    event('turn_completed', payload)
  }
  const elapse = async () => {
    for (const timer of timers.splice(0)) if (!timer.cancelled) timer.job()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const event = (type: ConversationEvent['type'], payload: Record<string, unknown> = {}) =>
    compact.onConversationEvent({
      id: `evt-${type}`,
      sessionId: 'conv-1',
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      providerId: 'claude-agent',
      modelId: 'default',
      type,
      createdAt: 1,
      payload,
    })
  return { state, sends, timers, logs, compact, tool, turnEnds, elapse, event }
}

const OWN_AGENT: McpConnectionContext = { metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-1' } }
const structured = (result: { structuredContent?: unknown }) => result.structuredContent as Record<string, unknown>
const errorCode = (result: { structuredContent?: unknown }) =>
  (structured(result).error as { code: string } | undefined)?.code

test('asked mid-turn, the chat is compacted once that turn completes, and not before', async () => {
  const f = fixture()
  const answer = await f.tool.handler({}, OWN_AGENT)
  assert.equal(structured(answer).compactsWhenTurnEnds, true)
  assert.equal(structured(answer).cli, 'claude-code')
  assert.match(String(structured(answer).note), /once your current turn completes/)
  assert.equal(f.sends.length, 0, 'nothing is sent while the turn runs')
  f.turnEnds()
  assert.equal(f.timers[0]?.ms, OWN_SETTLE_GRACE_MS, 'it waits the grace a queued message goes in during')
  await f.elapse()
  assert.equal(f.sends.length, 1)
  assert.equal(f.sends[0]!.sessionId, 'conv-1')
  assert.equal(f.compact.compactsWhenTurnEnds('conv-1'), false)
})

test('a Codex chat compacts too: its adapter runs `/compact` as its own compaction', async () => {
  const f = fixture({ providerId: 'codex-agent' })
  const answer = await f.tool.handler({}, OWN_AGENT)
  assert.equal(structured(answer).cli, 'codex')
  f.turnEnds()
  await f.elapse()
  assert.equal(f.sends.length, 1)
})

test('a CLI with no compaction is refused in words, and nothing is held', async () => {
  const f = fixture({ providerId: 'cursor-agent' })
  const answer = await f.tool.handler({}, OWN_AGENT)
  assert.equal(errorCode(answer), 'cannot_compact')
  assert.equal(f.compact.compactsWhenTurnEnds('conv-1'), false)
})

test('an agent with no chat here, or a caller that is no agent, is refused', async () => {
  const f = fixture()
  f.state.session = null
  assert.equal(errorCode(await f.tool.handler({}, OWN_AGENT)), 'not_a_chat')
  assert.equal(errorCode(await f.tool.handler({}, { metadata: { kind: 'external-local' } })), 'not_an_agent')
})

test('asking twice in one turn holds one compaction', async () => {
  const f = fixture()
  await f.tool.handler({}, OWN_AGENT)
  const again = await f.tool.handler({}, OWN_AGENT)
  assert.equal(structured(again).compactsWhenTurnEnds, true)
  f.turnEnds()
  await f.elapse()
  assert.equal(f.sends.length, 1)
})

test('the chat moving on first lets the compaction go', async () => {
  for (const moveOn of [
    (f: ReturnType<typeof fixture>) => f.event('user_message'),
    (f: ReturnType<typeof fixture>) => f.event('turn_failed'),
    (f: ReturnType<typeof fixture>) => f.event('session_closed'),
  ]) {
    const f = fixture()
    await f.tool.handler({}, OWN_AGENT)
    moveOn(f)
    f.turnEnds()
    await f.elapse()
    assert.equal(f.sends.length, 0)
  }
})

test('a new turn in the grace, or a message waiting to go in, lets it go', async () => {
  const started = fixture()
  await started.tool.handler({}, OWN_AGENT)
  started.turnEnds()
  started.event('turn_started')
  await started.elapse()
  assert.equal(started.sends.length, 0)

  const waiting = fixture()
  await waiting.tool.handler({}, OWN_AGENT)
  waiting.turnEnds()
  waiting.state.messageWaiting = true
  await waiting.elapse()
  assert.equal(waiting.sends.length, 0)
  assert.match(waiting.logs[0] ?? '', /a message waits to go in/)
})

test('a steered turn end is not the end of the asking turn', async () => {
  const f = fixture()
  await f.tool.handler({}, OWN_AGENT)
  f.event('turn_completed', { steered: true })
  assert.equal(f.timers.length, 0)
  assert.equal(f.compact.compactsWhenTurnEnds('conv-1'), true)
})

test('asked between turns, it is sent at once', async () => {
  const f = fixture({ status: 'ready' })
  const answer = await f.tool.handler({}, OWN_AGENT)
  assert.equal(structured(answer).compacting, true)
  assert.equal(f.sends.length, 1)
  f.state.refuse = true
  assert.equal(errorCode(await f.tool.handler({}, OWN_AGENT)), 'send_failed')
})

test('a compaction refused at the turn end is logged, not thrown', async () => {
  const f = fixture()
  f.state.refuse = true
  await f.tool.handler({}, OWN_AGENT)
  f.turnEnds()
  await f.elapse()
  assert.equal(f.sends.length, 1)
  assert.match(f.logs[0] ?? '', /refused there/)
})

test('a paired device is told the tool is an agent’s', () => {
  assert.match(localOnlyGatewayToolReason('conversation.compact') ?? '', /paired device is not an agent/)
})
