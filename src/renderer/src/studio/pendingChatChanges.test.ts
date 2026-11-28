import assert from 'node:assert/strict'

import { afterEach, beforeEach, test, vi } from 'vitest'

import { StudioError } from '../../../../packages/client-runtime/src/public'
import type { RemoteConversation } from '../components/workspace/remoteBand/remoteSessionsModel'
import { createEnvironmentChatSource, followEnvironmentChats } from './environmentChats'
import { fakePairedStudios } from './environmentStudio.double'
import { holdEnvironmentStudio, WINDOW_STUDIO_ROUTE } from './environmentStudio'
import {
  askChatChange,
  askChatRest,
  pendingChatChangeRead,
  pendingChatChanges,
  pendingChatKey,
  resetPendingChatChanges,
  withPendingChatChanges,
} from './pendingChatChanges'

// A change asked of a chat is worn by its row at once, until a list its
// Studio was asked for after it took the change comes back, or at once
// taken off again when the Studio refuses it. This computer's chats are held
// as any other machine's are: by the route of the Studio that lists them.

const api = {}
;(globalThis as { window?: unknown }).window = { api }

const target = { route: WINDOW_STUDIO_ROUTE, name: 'This computer' }
const key = pendingChatKey(WINDOW_STUDIO_ROUTE, 'w1')

/** A Studio whose answers to Settle and Star the test gives out. */
function mount() {
  const answers: Array<{ ok: () => void; no: (error: Error) => void }> = []
  const held = (_params: Record<string, unknown>) =>
    new Promise((resolve, reject) => answers.push({ ok: () => resolve({ settledAt: 9 }), no: reject }))
  const studio = fakePairedStudios(api, {
    'workspaces.list': () => ({ workspaces: [] }),
    'conversation.list': () => ({ conversations: [] }),
    'conversation.settle': held,
    'conversation.highlight': held,
  })
  followEnvironmentChats([target], (given) =>
    createEnvironmentChatSource(given, {
      hold: (asked) => holdEnvironmentStudio(asked, { api: api as never }),
      activity: {
        get: () => ({ visible: true, focused: true }),
        subscribe: () => () => undefined,
        dispose: () => undefined,
      },
      cache: null,
    }),
  )
  const lists = () => studio.calls.filter((call) => call.method === 'conversation.list').length
  return { answers, lists }
}

const row = { route: WINDOW_STUDIO_ROUTE, workspaceId: 'w1', highlight: null, title: 'Alpha' } as RemoteConversation

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  resetPendingChatChanges()
  followEnvironmentChats([])
  vi.useRealTimers()
})

test('a Settle is worn at once, and goes once a list asked after the Studio took it comes back', async () => {
  const mounted = mount()
  await vi.advanceTimersByTimeAsync(0)
  const listed = mounted.lists()
  const asked = askChatRest(target, 'w1', true, {}, { settledAt: 5 })
  assert.equal(withPendingChatChanges([row], pendingChatChanges())[0]!.settledAt, 5, 'worn before any answer')

  // A read made before it is taken says nothing of it yet.
  await vi.advanceTimersByTimeAsync(10)
  assert.equal(pendingChatChanges().get(key)?.takenAt, null)

  mounted.answers[0]!.ok()
  assert.equal((await asked).ok, true)
  assert.ok(pendingChatChanges().get(key)?.takenAt, 'taken, and still worn until a list says it')
  await vi.advanceTimersByTimeAsync(0)
  assert.ok(mounted.lists() > listed, 'the Studio is read again at once')
  assert.equal(pendingChatChanges().has(key), false, 'and the list that came back stands in for it')
})

test('a refusal takes the change off the row at once', async () => {
  const mounted = mount()
  await vi.advanceTimersByTimeAsync(0)
  const asked = askChatChange(
    target,
    'w1',
    { kind: 'highlight', starred: true },
    { highlight: { starred: true, color: null } },
  )
  assert.deepEqual(withPendingChatChanges([row], pendingChatChanges())[0]!.highlight, { starred: true, color: null })
  await vi.advanceTimersByTimeAsync(0)
  mounted.answers[0]!.no(new StudioError('conflict', 'This chat changed since that was decided.'))
  const answer = await asked
  assert.equal(answer.ok, false)
  assert.equal(pendingChatChanges().has(key), false)
  assert.equal(withPendingChatChanges([row], pendingChatChanges())[0]!.highlight, null, 'the row is its list again')
})

test('a second change on the chat holds the row until its own answer; the first one’s answer leaves it alone', async () => {
  const mounted = mount()
  await vi.advanceTimersByTimeAsync(10)
  const star = askChatChange(
    target,
    'w1',
    { kind: 'highlight', starred: true },
    { highlight: { starred: true, color: null } },
  )
  const settle = askChatRest(target, 'w1', true, {}, { settledAt: 5 })
  await vi.advanceTimersByTimeAsync(0)
  mounted.answers[0]!.no(new StudioError('conflict', 'no'))
  await star
  const worn = withPendingChatChanges([row], pendingChatChanges())[0]!
  assert.equal(worn.settledAt, 5, 'the newer change is still worn')
  assert.deepEqual(worn.highlight, { starred: true, color: null })
  mounted.answers[1]!.ok()
  await settle
  await vi.advanceTimersByTimeAsync(0)
  assert.equal(pendingChatChanges().has(key), false)
})

test('a change is read back only by a list asked after it was taken', () => {
  const change = { route: WINDOW_STUDIO_ROUTE, chatId: 'w1', facts: {}, takenAt: null }
  assert.equal(pendingChatChangeRead(change, 10), false, 'not taken yet')
  assert.equal(pendingChatChangeRead({ ...change, takenAt: 5 }, 4), false, 'a list asked before')
  assert.equal(pendingChatChangeRead({ ...change, takenAt: 5 }, undefined), false, 'no list yet')
  assert.equal(pendingChatChangeRead({ ...change, takenAt: 5 }, 5), true, 'asked as the answer came')
  assert.equal(pendingChatChangeRead({ ...change, takenAt: 5 }, 6), true)
})
