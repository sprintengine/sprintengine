import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { ConversationEvent, ConversationSideQuestionResult } from '../shared/conversation-runtime'
import { CONVERSATION_SIDE_QUESTION_MAX_ANSWER } from '../../packages/conversation-protocol/src/public'
import { ConversationRuntime } from './conversation-runtime'
import type { ConversationProviderSideQuestionInput } from './providers/conversation-provider-adapter'
import { createMockConversationProvider } from './providers/mock-conversation-provider'

// A side question goes to the chat's provider and comes back to the asker.
// Once answered it is kept in the transcript as a `side_question` event, so
// the chat can show it again, but nothing of it reaches the agent's turns: the
// chat's own clock does not move, a turn running beside it is left alone, and
// closing the aside calls it off, keeping nothing.

type Answering = {
  input: ConversationProviderSideQuestionInput
  answer: (result: ConversationSideQuestionResult) => void
}

async function fixture(options: { capability?: boolean } = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'side-question-'))
  let clock = 1_000_000
  const answering: Answering[] = []
  const disposed: string[] = []
  const mock = createMockConversationProvider(options.capability === false ? {} : { sideQuestion: true })
  const runtime = new ConversationRuntime({
    adapters: [
      {
        ...mock,
        sessions: 'stateful',
        disposeChildProcess: (sessionId) => {
          disposed.push(sessionId)
          return true
        },
        askSideQuestion: (_sessionId, input) =>
          new Promise<ConversationSideQuestionResult>((answer) => {
            answering.push({ input, answer })
            input.signal.addEventListener('abort', () => answer({ ok: false, message: 'aborted' }))
          }),
      },
    ],
    getProviderById: () => undefined,
    now: () => clock,
  })
  const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
  const started = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
  assert.ok(started.ok)
  const published: ConversationEvent[] = []
  runtime.onEvent((event) => published.push(event))
  const transcript = async () => {
    const read = await runtime.readTranscript(key)
    assert.ok(read.ok)
    return read.events
  }
  const summary = () => {
    const listed = runtime.listSessions()
    assert.ok(listed.ok)
    return listed.sessions[0]!
  }
  return {
    runtime,
    sessionId: started.session.sessionId,
    answering,
    disposed,
    published,
    transcript,
    summary,
    tick: (ms: number) => (clock += ms),
    now: () => clock,
    cleanup: async () => {
      await runtime.shutdown()
      await rm(workspaceRoot, { recursive: true, force: true })
    },
  }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !predicate(); attempt++) await new Promise((r) => setTimeout(r, 5))
  assert.ok(predicate())
}

test('an answered side question is kept in the transcript as one event, and the chat’s clock stays', async () => {
  const f = await fixture()
  try {
    const before = await f.transcript()
    const updatedAt = f.summary().updatedAt
    f.tick(5_000)
    const asking = f.runtime.askSideQuestion({
      sessionId: f.sessionId,
      requestId: 'side-1',
      question: '  Which file is the parser in?  ',
      history: [{ question: 'What are we doing?', answer: 'Refactoring.' }],
    })
    await until(() => f.answering.length === 1)
    assert.equal(f.answering[0]!.input.question, '  Which file is the parser in?  ')
    assert.deepEqual(f.answering[0]!.input.history, [{ question: 'What are we doing?', answer: 'Refactoring.' }])
    f.answering[0]!.answer({ ok: true, answer: 'src/parse.ts' })
    assert.deepEqual(await asking, { ok: true, answer: 'src/parse.ts' })
    assert.deepEqual(
      f.published.map((event) => [event.type, event.payload]),
      [['side_question', { question: 'Which file is the parser in?', answer: 'src/parse.ts', requestId: 'side-1' }]],
    )
    const after = await f.transcript()
    assert.equal(after.length, before.length + 1)
    assert.deepEqual(after.slice(0, before.length), before)
    assert.equal(after.at(-1)!.type, 'side_question')
    assert.equal(after.at(-1)!.payload?.turnId, undefined)
    // Only what the person asked is kept, never the follow-ups it leaned on.
    assert.ok(!JSON.stringify(after).includes('Refactoring.'))
    assert.equal(f.summary().updatedAt, updatedAt)
  } finally {
    await f.cleanup()
  }
})

test('a turn sent while a side question is out runs to its end, and the question is kept after it', async () => {
  const f = await fixture()
  try {
    const asking = f.runtime.askSideQuestion({ sessionId: f.sessionId, requestId: 'side-1', question: 'Why?' })
    await until(() => f.answering.length === 1)
    assert.ok((await f.runtime.sendTurn({ sessionId: f.sessionId, message: 'carry on' })).ok)
    // The mock's turn waits on an approval, which the side question leaves to the person.
    await until(() => f.published.some((event) => event.type === 'approval_requested'))
    const requestId = f.published.find((event) => event.type === 'approval_requested')!.payload!.requestId as string
    assert.ok((await f.runtime.respondToRequest({ sessionId: f.sessionId, requestId, approved: true })).ok)
    await until(() => f.published.some((event) => event.type === 'turn_completed'))
    f.answering[0]!.answer({ ok: true, answer: 'Because.' })
    assert.deepEqual(await asking, { ok: true, answer: 'Because.' })
    const events = await f.transcript()
    const completed = events.findIndex((event) => event.type === 'turn_completed')
    const kept = events.findIndex((event) => event.type === 'side_question')
    assert.ok(completed >= 0 && kept > completed)
    assert.deepEqual(events[kept]!.payload, { question: 'Why?', answer: 'Because.', requestId: 'side-1' })
    // Nothing the agent's turn said or was sent carries it.
    for (const event of events)
      if (event.type !== 'side_question') assert.ok(!JSON.stringify(event).includes('Because.'), event.type)
  } finally {
    await f.cleanup()
  }
})

test('a side question called off or failed keeps nothing, and a long answer is kept cut short', async () => {
  const f = await fixture()
  try {
    const before = await f.transcript()
    const calledOff = f.runtime.askSideQuestion({ sessionId: f.sessionId, requestId: 'off', question: 'Why?' })
    await until(() => f.answering.length === 1)
    await f.runtime.cancelSideQuestion({ sessionId: f.sessionId, requestId: 'off' })
    assert.equal((await calledOff).ok, false)
    const failing = f.runtime.askSideQuestion({ sessionId: f.sessionId, requestId: 'fail', question: 'How?' })
    await until(() => f.answering.length === 2)
    f.answering[1]!.answer({ ok: false, message: 'No.' })
    assert.equal((await failing).ok, false)
    assert.deepEqual(await f.transcript(), before)
    const long = 'a'.repeat(CONVERSATION_SIDE_QUESTION_MAX_ANSWER + 10)
    const asking = f.runtime.askSideQuestion({ sessionId: f.sessionId, requestId: 'long', question: 'All of it?' })
    await until(() => f.answering.length === 3)
    f.answering[2]!.answer({ ok: true, answer: long })
    // The asker reads the whole answer; the transcript keeps its beginning.
    assert.deepEqual(await asking, { ok: true, answer: long })
    const kept = (await f.transcript()).at(-1)!
    assert.equal(kept.type, 'side_question')
    assert.equal((kept.payload?.answer as string).length, CONVERSATION_SIDE_QUESTION_MAX_ANSWER)
    assert.equal(kept.payload?.truncated, true)
  } finally {
    await f.cleanup()
  }
})

test('closing the aside calls the question off in the provider, and it answers as called off', async () => {
  const f = await fixture()
  try {
    const asking = f.runtime.askSideQuestion({ sessionId: f.sessionId, requestId: 'side-1', question: 'Why?' })
    await until(() => f.answering.length === 1)
    assert.deepEqual(await f.runtime.cancelSideQuestion({ sessionId: f.sessionId, requestId: 'side-1' }), { ok: true })
    assert.equal(f.answering[0]!.input.signal.aborted, true)
    assert.deepEqual(await asking, { ok: false, cancelled: true, message: 'The side question was called off.' })
    // Settled, there is nothing left to call off.
    assert.equal((await f.runtime.cancelSideQuestion({ sessionId: f.sessionId, requestId: 'side-1' })).ok, false)
  } finally {
    await f.cleanup()
  }
})

test('the idle sweep leaves the child a side question is using, and counts from when it was answered', async () => {
  const f = await fixture()
  try {
    f.runtime.setIdleThresholdMs(60_000)
    f.tick(10 * 60_000)
    const asking = f.runtime.askSideQuestion({ sessionId: f.sessionId, requestId: 'side-1', question: 'Why?' })
    await until(() => f.answering.length === 1)
    assert.deepEqual(f.runtime.sweepIdleSessions(f.now()), [])
    f.answering[0]!.answer({ ok: true, answer: 'Because.' })
    await asking
    assert.deepEqual(f.runtime.sweepIdleSessions(f.now() + 30_000), [])
    assert.deepEqual(f.runtime.sweepIdleSessions(f.now() + 61_000), [f.sessionId])
    assert.deepEqual(f.disposed, [f.sessionId])
  } finally {
    await f.cleanup()
  }
})

test('a side question is refused where the provider cannot answer one, for a missing chat, and twice under one id', async () => {
  const without = await fixture({ capability: false })
  const f = await fixture()
  try {
    const refused = await without.runtime.askSideQuestion({
      sessionId: without.sessionId,
      requestId: 'a',
      question: 'Q',
    })
    assert.equal(refused.ok, false)
    assert.equal(without.answering.length, 0)
    assert.equal((await f.runtime.askSideQuestion({ sessionId: 'nope', requestId: 'a', question: 'Q' })).ok, false)
    const first = f.runtime.askSideQuestion({ sessionId: f.sessionId, requestId: 'a', question: 'Q' })
    await until(() => f.answering.length === 1)
    assert.deepEqual(await f.runtime.askSideQuestion({ sessionId: f.sessionId, requestId: 'a', question: 'Q' }), {
      ok: false,
      message: 'That side question is already being answered.',
    })
    f.answering[0]!.answer({ ok: true, answer: 'A' })
    assert.equal((await first).ok, true)
  } finally {
    await without.cleanup()
    await f.cleanup()
  }
})
