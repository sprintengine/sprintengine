import assert from 'node:assert/strict'
import { test } from 'vitest'

import { parseConversationServerFrame, readableConversationPhase } from '../src/public'

// How a client reads a desktop newer than itself: what it does not know is
// passed over or dropped, never a reason to refuse what it does.

const key = { workspaceId: 'w', agentId: 'a' }
const row = {
  ...key,
  title: 'Fix the login',
  phase: 'idle',
  updatedAt: 1,
  createdAt: 1,
  providerId: 'claude-code',
  modelId: 'default',
  turnCount: 0,
  lastSeq: 0,
}
const event = (seq: number, type = 'content_delta') => ({
  id: `e${seq}`,
  seq,
  type,
  sessionId: 's',
  ...key,
  providerId: 'claude-code',
  modelId: 'default',
  createdAt: seq,
})
const decode = (value: unknown) => parseConversationServerFrame(value)
const sessions = (rows: unknown[]) => {
  const frame = decode({ type: 'sessions', requestId: 'r', sessions: rows })
  assert.ok(frame && frame.type === 'sessions')
  return frame.sessions
}

test('an event of a type this build does not know is an event: its sequence still moves the cursor', () => {
  const frame = decode({ type: 'event', event: { ...event(7, 'telepathy'), payload: { future: true }, extra: 1 } })
  assert.ok(frame && frame.type === 'event')
  assert.equal(frame.event.type, 'telepathy')
  assert.equal(frame.event.seq, 7)
  assert.equal('extra' in frame.event, false, 'a member this build does not know is dropped')
})

test('a chat in a phase this build does not know is listed, as unknown, and reads as idle', () => {
  const [chat, known] = sessions([
    { ...row, phase: 'dreaming' },
    { ...row, agentId: 'b', phase: 'running' },
  ])
  assert.equal(chat.phase, 'unknown')
  assert.equal(readableConversationPhase(chat.phase), 'idle')
  assert.equal(known.phase, 'running')
  assert.equal(sessions([{ ...row, phase: 'Not A Phase!' }]).length, 0, 'a phase that is no phase name is no row')
})

test('members a listed chat does not define are dropped, and one bad row hides no other', () => {
  const [chat] = sessions([{ ...row, fromTheFuture: true, chatTitle: '  Settle it  ' }, { nope: true }])
  assert.equal('fromTheFuture' in chat, false)
  assert.equal(chat.chatTitle, 'Settle it', 'a title is shown as a line: its spaces at either end go')
  assert.equal(sessions([row, { nope: true }]).length, 1)
})

test('a machine with no name, or a pull request that is not a plain web page, is no mark', () => {
  const [chat] = sessions([
    {
      ...row,
      host: { id: 'wsl:Ubuntu', kind: 'wsl', label: '   ', color: 'teal' },
      pullRequests: [
        { number: 1, state: 'open', url: 'https://github.com@evil.example/x', title: 'x' },
        { number: 2, state: 'open', url: 'https://github.com/acme/app/pull/2', title: 9 },
      ],
    },
  ])
  assert.equal('host' in chat, false)
  assert.deepEqual(chat.pullRequests, [
    { number: 2, state: 'open', url: 'https://github.com/acme/app/pull/2', title: '' },
  ])
})

test('a held message keeps what it carries, and a usage window its length and scope', () => {
  const queued = decode({
    type: 'queued',
    key,
    messages: [
      {
        id: 'q1',
        text: 'look at these',
        createdAt: 5,
        images: ['shot.png'],
        files: ['notes.md'],
        skills: ['review'],
        mentions: [{ path: 'src/a.ts', kind: 'file' }],
      },
    ],
  })
  assert.ok(queued && queued.type === 'queued')
  assert.deepEqual(queued.messages[0].images, ['shot.png'])
  assert.deepEqual(queued.messages[0].files, ['notes.md'])
  assert.deepEqual(queued.messages[0].skills, ['review'])
  assert.deepEqual(queued.messages[0].mentions, [{ path: 'src/a.ts', kind: 'file' }])
  const limits = decode({
    type: 'usageLimits',
    key,
    notice: null,
    autoResume: false,
    limits: [
      {
        provider: 'claude',
        observedAt: 9,
        windows: [
          {
            id: 'opus_week',
            label: 'Weekly Opus',
            usedPercent: 40,
            resetsAt: 99,
            durationMs: 604_800_000,
            scope: 'model',
            status: 'allowed',
            observedAt: 9,
          },
        ],
      },
    ],
  })
  assert.ok(limits && limits.type === 'usageLimits')
  assert.equal(limits.limits[0].windows[0].durationMs, 604_800_000)
  assert.equal(limits.limits[0].windows[0].scope, 'model')
})
