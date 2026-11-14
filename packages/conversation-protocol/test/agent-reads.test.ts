// Reads that ask the chat's agent (`conversation-side-questions`,
// `conversation-context-breakdown`): each frame read as the contract says,
// refused where it must be, and its answer read back off a `result`.
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { CONVERSATION_MAX_SIDE_QUESTION_HISTORY } from '../src/agentReads'
import { explainRejectedConversationMessage, parseConversationClientMessage } from '../src/clientFrames'
import {
  CONVERSATION_CAPABILITIES,
  CONVERSATION_CONTEXT_BREAKDOWN_CAPABILITY,
  CONVERSATION_SIDE_QUESTIONS_CAPABILITY,
} from '../src/handshake'
import { CONVERSATION_MAX_MESSAGE_CHARS, parseConversationClientFrame } from '../src/index'
import { parseConversationServerFrame } from '../src/serverFrames'

const ask = (fields: Record<string, unknown>) => ({
  type: 'askSideQuestion',
  requestId: 'r-1',
  questionId: 'q-1',
  question: 'Which file did it change first?',
  ...fields,
})

test('both capabilities are listed', () => {
  assert.equal(CONVERSATION_SIDE_QUESTIONS_CAPABILITY, 'conversation-side-questions')
  assert.equal(CONVERSATION_CONTEXT_BREAKDOWN_CAPABILITY, 'conversation-context-breakdown')
  for (const capability of [CONVERSATION_SIDE_QUESTIONS_CAPABILITY, CONVERSATION_CONTEXT_BREAKDOWN_CAPABILITY])
    assert.ok((CONVERSATION_CAPABILITIES as readonly string[]).includes(capability))
})

test('a side question with nothing to ask, no id of its own, or an aside past the limits is refused under its request', () => {
  const tooMany = Array.from({ length: CONVERSATION_MAX_SIDE_QUESTION_HISTORY + 1 }, () => ({
    question: 'q',
    answer: 'a',
  }))
  for (const frame of [
    ask({ question: '   ' }),
    ask({ question: 7 }),
    ask({ questionId: '' }),
    ask({ history: tooMany }),
    ask({ history: [{ question: 'q' }] }),
    ask({ question: 'x'.repeat(CONVERSATION_MAX_MESSAGE_CHARS + 1) }),
    { type: 'cancelSideQuestion', requestId: 'r-2' },
  ]) {
    assert.equal(parseConversationClientMessage(frame), null)
    const rejection = explainRejectedConversationMessage(frame)
    assert.equal(rejection.code, 'invalid_frame')
    assert.equal(rejection.requestId, frame.requestId, 'answered under its request id')
  }
})

test('a desktop from before them reads neither frame, and refuses each under its request id', () => {
  for (const frame of [
    ask({}),
    { type: 'cancelSideQuestion', requestId: 'r-1', questionId: 'q-1' },
    { type: 'getContextBreakdown', requestId: 'r-1' },
  ])
    assert.equal(parseConversationClientFrame(frame), null)
})

test('a listed chat keeps whether it answers a side question and says what fills its window', () => {
  const frame = parseConversationServerFrame({
    type: 'sessions',
    requestId: 'list-1',
    sessions: [
      {
        workspaceId: 'ws',
        agentId: 'agent',
        title: 'Chat',
        phase: 'completed',
        updatedAt: 2,
        createdAt: 1,
        providerId: 'claude-agent',
        modelId: 'default',
        turnCount: 1,
        lastSeq: 4,
        capabilities: {
          images: true,
          approvals: true,
          questions: true,
          planMode: false,
          interrupt: true,
          checkpoints: false,
          sideQuestion: true,
          contextBreakdown: 'maybe',
        },
      },
    ],
  })
  assert.ok(frame?.type === 'sessions')
  const capabilities = frame.sessions[0]!.capabilities
  assert.equal(capabilities?.sideQuestion, true)
  assert.equal('contextBreakdown' in (capabilities ?? {}), false)
})
