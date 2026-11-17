import { expect, test } from 'vitest'

import { CLAUDE_AGENT_PROVIDER_ID, mapSdkMessage } from './claude-agent-provider'

// The main chain's reply text reaches the chat from its stream. When a
// request stalls, Claude Code retries it without streaming, and that reply
// arrives only as the finished assistant message: the chat must show it, and
// must still not show a streamed reply twice.

function mapperState() {
  return {
    sessionId: 'conv_1',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: CLAUDE_AGENT_PROVIDER_ID,
    modelId: 'sonnet',
    providerSessionId: 'native' as string | null,
    turn: { turnId: 'turn_1' } as { turnId: string } | null,
    queryCostUsd: 0,
  }
}

const messageStart = (id: string) => ({
  type: 'stream_event',
  session_id: 'native',
  parent_tool_use_id: null,
  event: { type: 'message_start', message: { id, usage: {} } },
})
const textDelta = (text: string) => ({
  type: 'stream_event',
  session_id: 'native',
  parent_tool_use_id: null,
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
})
const assistant = (id: string, content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  session_id: 'native',
  parent_tool_use_id: null,
  message: { id, model: 'claude-opus-5-5', role: 'assistant', content },
  ...extra,
})
const texts = (events: ReturnType<typeof mapSdkMessage>) =>
  events.filter((event) => event.type === 'content_delta').map((event) => event.payload?.text)

test('a reply fetched without streaming shows its text from the finished message', () => {
  const state = mapperState()
  const events = mapSdkMessage(
    state,
    assistant('msg_retry', [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: 'The full report.' },
    ]),
  )
  expect(texts(events)).toEqual(['The full report.'])
})

test('a streamed reply is not shown again when its finished message arrives', () => {
  const state = mapperState()
  mapSdkMessage(state, messageStart('msg_1'))
  expect(texts(mapSdkMessage(state, textDelta('Hello')))).toEqual(['Hello'])
  expect(texts(mapSdkMessage(state, assistant('msg_1', [{ type: 'text', text: 'Hello' }])))).toEqual([])
  // The same request's tool call, its own assistant message, adds no text.
  const tool = mapSdkMessage(state, assistant('msg_1', [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }]))
  expect(texts(tool)).toEqual([])
  expect(tool.map((event) => event.type)).toContain('tool_started')
})

test('text an earlier attempt streamed does not hide the retry that never streamed', () => {
  const state = mapperState()
  mapSdkMessage(state, messageStart('msg_stalled'))
  mapSdkMessage(state, textDelta('Partial'))
  const retried = mapSdkMessage(state, assistant('msg_retry', [{ type: 'text', text: 'Partial and the rest.' }]))
  expect(texts(retried)).toEqual(['Partial and the rest.'])
})

test('after a streamed request, a later unstreamed one still shows its text', () => {
  const state = mapperState()
  mapSdkMessage(state, messageStart('msg_1'))
  mapSdkMessage(state, textDelta('Looking.'))
  mapSdkMessage(state, assistant('msg_1', [{ type: 'text', text: 'Looking.' }]))
  const later = mapSdkMessage(state, assistant('msg_2', [{ type: 'text', text: 'Done.' }]))
  expect(texts(later)).toEqual(['Done.'])
})

test('a message the CLI made up for an error is not shown as the reply', () => {
  const state = mapperState()
  const synthetic = mapSdkMessage(state, {
    ...assistant('msg_err', [{ type: 'text', text: 'API Error: overloaded' }]),
    message: { id: 'msg_err', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error' }] },
  })
  expect(texts(synthetic)).toEqual([])
  const limited = mapSdkMessage(
    state,
    assistant('msg_limit', [{ type: 'text', text: 'You have hit your limit' }], { error: 'rate_limit' }),
  )
  expect(texts(limited)).toEqual([])
})
