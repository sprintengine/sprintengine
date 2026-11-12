import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import type { PullRequestWake } from './pull-request-watch'
import { createPullRequestUntoldWakes, type PullRequestUntoldWakes } from './pull-request-untold'
import { createPullRequestWakes, type PullRequestWakesDeps } from './pull-request-wakes'

const CHAT = { workspaceId: 'ws-1', agentId: 'agent-1' }
const NOW = Date.parse('2026-10-11T10:00:00Z')

const session = (overrides: Partial<ConversationSessionSummary> = {}): ConversationSessionSummary => ({
  sessionId: 'session-1',
  workspaceId: CHAT.workspaceId,
  agentId: CHAT.agentId,
  providerId: 'claude-agent',
  modelId: 'claude-opus',
  status: 'ready',
  createdAt: NOW - 1000,
  updatedAt: NOW - 1000,
  phase: 'completed',
  ...overrides,
})

const wake = (
  number: number,
  news: PullRequestWake['news'],
  stop: PullRequestWake['stop'] = null,
): PullRequestWake => ({
  url: `https://github.com/acme/app/pull/${number}`,
  number,
  repo: 'acme/app',
  base: 'main',
  headSha: null,
  autoMerge: false,
  checksGreen: false,
  news,
  stop,
})

/** What the record keeps of untold news, in memory, its ids counted. */
function untoldSource(untold: PullRequestUntoldWakes): PullRequestWakesDeps['untold'] {
  let ids = 0
  return {
    chats: async () => untold.chats(),
    next: async (key) => {
      const message = untold.next(key, () => `pull-request-watch:${++ids}`)
      return message && { commandId: message.commandId, wakes: message.wakes }
    },
    told: (key, commandId) => void untold.told(key, commandId),
    forget: (key) => void untold.forget(key),
  }
}

function setUp(overrides: Partial<PullRequestWakesDeps> = {}, untold = createPullRequestUntoldWakes()) {
  let nowMs = NOW
  let seq = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  const sent: Array<{ text: string; commandId: string }> = []
  const gone: string[] = []
  let listener: ((event: ConversationEvent) => void) | null = null
  let sessions = [session()]
  let chat: { settled: boolean } | null = { settled: false }
  let answer: { ok: boolean; code?: string; message?: string } = { ok: true }
  const wakes = createPullRequestWakes({
    listSessions: () => sessions,
    onConversationEvent: (next) => {
      listener = next
      return () => {
        listener = null
      }
    },
    chat: () => chat,
    send: async (_key, text, commandId) => {
      sent.push({ text, commandId })
      return answer
    },
    onChatGone: (key) => gone.push(key.agentId),
    now: () => nowMs,
    setTimer: (run, ms) => {
      seq += 1
      timers.set(seq, { at: nowMs + ms, run })
      return seq
    },
    clearTimer: (handle) => void timers.delete(handle as number),
    untold: untoldSource(untold),
    ...overrides,
  })
  return {
    wakes,
    untold,
    /** News the record found: kept as untold, then the wakes hear of it. */
    tell(news: PullRequestWake) {
      untold.add(CHAT, news)
      wakes.deliver({ conversation: CHAT, wake: news })
    },
    sent,
    gone,
    setSessions: (next: ConversationSessionSummary[]) => void (sessions = next),
    setChat: (next: { settled: boolean } | null) => void (chat = next),
    setAnswer: (next: typeof answer) => void (answer = next),
    emit: (event: Partial<ConversationEvent>) =>
      listener?.({
        sessionId: 'session-1',
        workspaceId: CHAT.workspaceId,
        agentId: CHAT.agentId,
        ...event,
      } as ConversationEvent),
    async advance(ms: number) {
      nowMs += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at > nowMs) continue
        timers.delete(id)
        timer.run()
      }
      await new Promise((resolve) => setImmediate(resolve))
    },
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('news for an idle chat goes at once, as one Studio message', async () => {
  const { tell, untold, sent } = setUp()
  tell(wake(234, [{ kind: 'behind' }]))
  await settle()
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /^\[SprintEngine Studio\] Pull request #234 is behind main/)
  assert.match(sent[0].commandId, /^pull-request-watch:/)
  assert.deepEqual(untold.chats(), [], 'told, nothing is left to tell')
})

test('a running turn is waited out, and everything learned meanwhile goes as one message when it ends', async () => {
  const { tell, untold, sent, setSessions, emit, advance } = setUp()
  setSessions([session({ status: 'active', phase: 'running' })])
  tell(wake(234, [{ kind: 'checks-failed', checks: [{ name: 'Build', outcome: 'FAILURE', url: null }] }]))
  tell(wake(234, [{ kind: 'behind' }]))
  tell(wake(240, [{ kind: 'conflicting' }]))
  await settle()
  assert.equal(sent.length, 0, 'never into a running turn')
  assert.deepEqual(
    [234, 240].map((number) => untold.of(`https://github.com/acme/app/pull/${number}`).length),
    [1, 1],
    'kept, one entry a pull request',
  )
  setSessions([session()])
  emit({ type: 'turn_completed' })
  await advance(1_500)
  assert.equal(sent.length, 1)
  assert.match(sent[0].text, /News on 2 pull requests/)
  assert.match(
    sent[0].text,
    /Pull request #234:\n- 1 check failed — Build\. Fix it, push, and end your turn\.\n- It is behind main/,
  )
  assert.match(sent[0].text, /Pull request #240:\n- It conflicts with main/)
})

test('a chat waiting on the person is not woken over the question', async () => {
  const { tell, sent, setSessions, advance } = setUp()
  setSessions([session({ status: 'awaiting_approval', phase: 'waiting_for_approval' })])
  tell(wake(234, [{ kind: 'behind' }]))
  await advance(60_000)
  assert.equal(sent.length, 0)
  setSessions([session()])
  await advance(60_000)
  assert.equal(sent.length, 1, 'looked at again on its own, if no turn end is heard')
})

test('a settled or deleted chat is never woken: its watches stop instead', async () => {
  const settled = setUp()
  settled.setChat({ settled: true })
  settled.tell(wake(234, [{ kind: 'merged' }], 'merged'))
  await settle()
  assert.deepEqual(settled.sent, [])
  assert.deepEqual(settled.gone, ['agent-1'])
  const deleted = setUp()
  deleted.setChat(null)
  deleted.tell(wake(234, [{ kind: 'behind' }]))
  await settle()
  assert.deepEqual(deleted.sent, [])
  assert.deepEqual(deleted.gone, ['agent-1'])
})

test('a usage limit holds the wake until a little after it resets', async () => {
  let limited = true
  const { tell, sent, advance } = setUp({
    usageLimit: () => ({ limited, resetsAt: limited ? NOW + 10 * 60_000 : null }),
  })
  tell(wake(234, [{ kind: 'behind' }]))
  await settle()
  assert.equal(sent.length, 0)
  await advance(10 * 60_000)
  assert.equal(sent.length, 0, 'not on the stroke of the reset')
  limited = false
  await advance(2 * 60_000)
  assert.equal(sent.length, 1)
})

test('a send refused as busy goes again, as it was and under the same id, when the turn ends; news that came meanwhile follows', async () => {
  const { tell, sent, setAnswer, setSessions, emit, advance } = setUp()
  // A turn that started between the look and the send.
  setAnswer({ ok: false, code: 'busy' })
  tell(wake(234, [{ kind: 'behind' }]))
  await settle()
  assert.equal(sent.length, 1)
  setSessions([session({ status: 'active', phase: 'running' })])
  tell(wake(234, [{ kind: 'conflicting' }]))
  await settle()
  assert.equal(sent.length, 1)
  setSessions([session()])
  setAnswer({ ok: true })
  emit({ type: 'turn_completed' })
  await advance(1_500)
  assert.equal(sent.length, 3)
  assert.equal(sent[1].commandId, sent[0].commandId, 'the same message, so the chat takes it once')
  assert.equal(sent[1].text, sent[0].text)
  assert.match(sent[2].text, /conflicts with main/)
  assert.doesNotMatch(sent[2].text, /behind main/)
  assert.notEqual(sent[2].commandId, sent[1].commandId, 'the news after it is a command of its own')
})

test('news the last run did not get to tell goes at the next start, a message already sent under its id', async () => {
  const untold = createPullRequestUntoldWakes()
  // The first run sends, and stops before the chat answers.
  const first = setUp({ send: () => new Promise(() => undefined) }, untold)
  first.tell(wake(234, [{ kind: 'behind' }]))
  await settle()
  untold.add(CHAT, wake(240, [{ kind: 'conflicting' }]))
  first.wakes.dispose()

  const next = setUp({}, untold)
  await next.wakes.resume()
  await settle()
  await settle()
  assert.equal(next.sent.length, 2)
  assert.match(next.sent[0].commandId, /^pull-request-watch:/)
  assert.match(next.sent[0].text, /behind main/)
  assert.doesNotMatch(next.sent[0].text, /conflicts/, 'the message as the first run sent it, which its id names')
  assert.match(next.sent[1].text, /conflicts with main/)
  assert.deepEqual(untold.chats(), [])
})
