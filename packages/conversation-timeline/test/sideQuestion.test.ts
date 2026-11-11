import { expect, test } from 'vitest'
import type { ConversationEvent, ConversationEventType } from '../src/protocol.js'
import { projectConversation } from '../src/conversationProjection.js'
import { deriveConversationTimelineRows } from '../src/conversationTimeline.js'
import { applyEvent, createConversationProjectionState } from '../src/incrementalConversationProjection.js'

// A side question the chat kept, as the projection and the timeline draw it:
// between turns, after the turn it was asked during or after, never inside
// one, and never as a message of the conversation.

function event(type: ConversationEventType, at: number, payload: Record<string, unknown> = {}): ConversationEvent {
  return {
    id: `event-${at}`,
    seq: at,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'claude-agent',
    modelId: 'claude-sonnet-4-5',
    type,
    createdAt: at,
    payload,
  }
}

const asked: ConversationEvent[] = [
  event('user_message', 1, { turnId: 't1', text: 'Fix the test' }),
  event('turn_started', 2, { turnId: 't1' }),
  event('content_delta', 3, { turnId: 't1', text: 'Looking. ' }),
  // Asked while the turn ran: it lands after the turn, not in its reply.
  event('side_question', 4, { question: 'Which test?', answer: 'The parser one.', requestId: 'side-1' }),
  event('content_delta', 5, { turnId: 't1', text: 'Fixed.' }),
  event('turn_completed', 6, { turnId: 't1' }),
  event('side_question', 7, { question: 'Why did it fail?', answer: 'A stale fixture.', truncated: true }),
  event('user_message', 8, { turnId: 't2', text: 'Ship it' }),
  event('turn_started', 9, { turnId: 't2' }),
  event('content_delta', 10, { turnId: 't2', text: 'Shipped.' }),
  event('turn_completed', 11, { turnId: 't2' }),
]

test('a kept side question sits after the turn it was asked in, the reply left whole', () => {
  const projection = projectConversation(asked)
  expect(projection.entries.map((entry) => entry.kind)).toEqual([
    'user',
    'assistant',
    'sideQuestion',
    'sideQuestion',
    'user',
    'assistant',
  ])
  expect(projection.entries[1]).toMatchObject({ kind: 'assistant', text: 'Looking. Fixed.' })
  expect(projection.entries[2]).toEqual({
    kind: 'sideQuestion',
    id: 'event-4',
    question: 'Which test?',
    answer: 'The parser one.',
    createdAt: 4,
  })
  expect(projection.entries[3]).toMatchObject({ question: 'Why did it fail?', truncated: true })
  const rows = deriveConversationTimelineRows(projection.entries, false)
  expect(rows.map((row) => row.kind)).toEqual([
    'user',
    'assistant',
    'sideQuestion',
    'sideQuestion',
    'user',
    'assistant',
  ])
  expect(rows[2]!.id).toBe('sideQuestion:event-4')
})

test('a side question asked before any turn opens the conversation', () => {
  const early = [event('side_question', 1, { question: 'What is this?', answer: 'A new chat.' }), ...asked.slice(0, 1)]
  expect(projectConversation(early).entries.map((entry) => entry.kind)).toEqual(['sideQuestion', 'user', 'assistant'])
})

test('a side question without a question or an answer is not drawn', () => {
  const empty = [
    ...asked.slice(0, 6),
    event('side_question', 20, { question: '  ', answer: 'x' }),
    event('side_question', 21, { question: 'Q?' }),
  ]
  expect(projectConversation(empty).entries.filter((entry) => entry.kind === 'sideQuestion')).toHaveLength(1)
})

test('the incremental projection draws the same side questions', () => {
  let state = createConversationProjectionState()
  for (const each of asked) state = applyEvent(state, each)
  expect(state.projection.entries).toEqual(projectConversation(asked).entries)
})
