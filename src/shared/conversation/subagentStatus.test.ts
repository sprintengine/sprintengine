import { expect, test } from 'vitest'
import type { ConversationSessionSummary } from '../conversation-runtime'
import { subagentLiveStatusOf, subagentStatusOf } from './subagentStatus'

// A sub-agent's end stays on its record, which its parent's tools read. A person
// reading a row is told what it is doing now, or a follow-up would read as Done.

const ended = { subagentEnd: { at: 5, status: 'completed' as const } }
const session = (over: Partial<ConversationSessionSummary>): ConversationSessionSummary =>
  ({
    sessionId: 's',
    workspaceId: 'w',
    agentId: 'a',
    providerId: 'p',
    modelId: 'm',
    status: 'ready',
    createdAt: 1,
    updatedAt: 2,
    ...over,
  }) as ConversationSessionSummary

test('a follow-up running over an ended task reads as working, and its parent still reads the end', () => {
  const running = session({ status: 'active', phase: 'running', turnStartedAt: 9 } as never)
  expect(subagentLiveStatusOf(ended, running)).toBe('working')
  expect(subagentStatusOf(ended, running)).toBe('completed')
})

test('a follow-up waiting on the person says so', () => {
  expect(subagentLiveStatusOf(ended, session({ phase: 'waiting_for_approval' } as never))).toBe('needs_input')
})

test('at rest, an ended sub-agent reads as how it ended', () => {
  expect(subagentLiveStatusOf(ended, session({ lastTurnEndedAt: 6 }))).toBe('completed')
  expect(subagentLiveStatusOf(ended, undefined)).toBe('completed')
})

test('a round its parent just sent reads as starting until the session takes it, then as the session says', () => {
  const resumed = { subagentRound: { n: 2, startedAt: 100 } }
  // The session the last round left at rest, or none listed after a restart.
  expect(subagentStatusOf(resumed, session({ status: 'stopped', lastTurnEndedAt: 50 }))).toBe('starting')
  expect(subagentStatusOf(resumed, undefined)).toBe('starting')
  expect(subagentStatusOf(resumed, session({ status: 'active', phase: 'running', turnStartedAt: 120 } as never))).toBe(
    'working',
  )
  expect(subagentStatusOf(resumed, session({ phase: 'waiting_for_input' } as never))).toBe('needs_input')
  expect(subagentStatusOf(resumed, session({ lastTurnEndedAt: 150 }))).toBe('completed')
  // Its end, once written, is the round's.
  expect(subagentStatusOf({ ...resumed, subagentEnd: { at: 150, status: 'failed' } }, undefined)).toBe('failed')
})
