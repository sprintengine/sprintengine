import assert from 'node:assert/strict'

import { afterEach, beforeEach, test, vi } from 'vitest'

import { StudioError } from '../../../../packages/client-runtime/src/public'
import type { WindowActivity, WindowActivityState } from '../utils/windowActivity'
import { createEnvironmentChatSource, followEnvironmentChats, type EnvironmentChatSource } from './environmentChats'
import { FOCUS_REREAD_GAP_MS, REREAD_MS } from './environmentChatsFreshness'
import { fakePairedStudios } from './environmentStudio.double'
import { holdEnvironmentStudio, pairedTarget } from './environmentStudio'

// An environment's rows as its chat source keeps them: what it holds and its
// chats, re-read for what its pushes name, held while nobody can see the
// window, read whole when it is reached again, on a slow clock that backs off
// while reads fail, and when a person comes back to the window. Nothing in it
// asks what kind of machine the route reaches; a paired desktop's double
// stands in for any.

const chat = {
  workspaceId: 'rw1',
  agentId: 'ada',
  title: 'Ada',
  phase: 'idle',
  updatedAt: 2_000,
  createdAt: 1_000,
  providerId: 'claude-agent',
  modelId: 'opus',
  turnCount: 1,
  lastSeq: 4,
}

/** The window's activity, moved by the test. */
function fakeActivity() {
  let state: WindowActivityState = { visible: true, focused: true }
  const listeners = new Set<(state: WindowActivityState) => void>()
  const activity: WindowActivity = {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: () => undefined,
  }
  return {
    activity,
    set(next: Partial<WindowActivityState>) {
      state = { ...state, ...next }
      for (const listener of [...listeners]) listener(state)
    },
  }
}

const target = pairedTarget({ id: 'c1', machineName: 'mac-mini' })

function mount(answers: { list?: () => unknown } = {}) {
  const api = {}
  const studio = fakePairedStudios(api, {
    'workspaces.list': () => ({ workspaces: [] }),
    'conversation.list': answers.list ?? (() => ({ conversations: [chat] })),
    'session.list': () => ({ ok: true, sessions: [] }),
  })
  const window = fakeActivity()
  const source: EnvironmentChatSource = createEnvironmentChatSource(target, {
    hold: (given) => holdEnvironmentStudio(given, { api }),
    activity: window.activity,
  })
  source.subscribe(() => undefined)
  const count = (method: string) => studio.calls.filter((call) => call.method === method).length
  return {
    studio,
    source,
    window,
    rows: () => source.snapshot().rows,
    calls: () => ({ browse: count('workspaces.list'), list: count('conversation.list') }),
    /** A person leaves the window and comes back to it. */
    async refocus() {
      window.set({ focused: false })
      window.set({ focused: true })
      await vi.advanceTimersByTimeAsync(0)
    },
  }
}

const settle = (ms = 300) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  followEnvironmentChats([])
  vi.useRealTimers()
})

test('a push re-reads what it names, a hidden window holds them, and a reconnect reads it whole', async () => {
  const mounted = mount()
  try {
    await settle(0)
    assert.deepEqual(mounted.calls(), { browse: 1, list: 1 }, 'the first read is the whole environment')
    assert.equal(mounted.rows().conversations?.length, 1)
    assert.equal(mounted.rows().listFailure, null)
    assert.equal(mounted.rows().browse?.reachable, true)
    assert.deepEqual(mounted.rows().chatRecord, { lifecycle: true, unwatchPullRequest: true })

    mounted.studio.push('conversations.changed', { what: 'conversations' })
    await settle()
    assert.deepEqual(mounted.calls(), { browse: 1, list: 2 }, 'a conversation push lists the chats, and only them')

    mounted.studio.push('conversations.changed', { what: 'workspaces' })
    mounted.studio.push('conversations.changed', { what: 'workspaces' })
    await settle()
    assert.deepEqual(mounted.calls(), { browse: 2, list: 2 }, 'workspace pushes in one burst are one browse')

    // Out of sight: pushes are remembered, not read.
    mounted.window.set({ visible: false, focused: false })
    mounted.studio.push('conversations.changed', { what: 'conversations' })
    mounted.studio.push('conversations.changed', { what: 'workspaces' })
    mounted.studio.push('conversations.changed', { what: 'conversations' })
    await settle()
    assert.deepEqual(mounted.calls(), { browse: 2, list: 2 }, 'a hidden window reads nothing')

    mounted.window.set({ visible: true })
    await settle()
    assert.deepEqual(mounted.calls(), { browse: 3, list: 3 }, 'seen again, it reads what changed, once')

    // The connection drops and comes back: it may have missed a push, so both are read.
    mounted.studio.setState('c1', 'reconnecting')
    await settle(REREAD_MS * 2)
    assert.deepEqual(mounted.calls(), { browse: 3, list: 3 }, 'nothing is asked of an environment while it is away')
    assert.equal(mounted.source.snapshot().stale, true)
    assert.equal(mounted.rows().conversations?.length, 1, 'its rows stay where they are')
    mounted.studio.setState('c1', 'open')
    await settle()
    assert.deepEqual(mounted.calls(), { browse: 4, list: 4 }, 'reached again, it is read whole, once')
  } finally {
    mounted.source.close()
  }
})

test('a refused read keeps the rows and says why, and the clock backs off while it fails', async () => {
  let refuse = false
  const mounted = mount({
    list: () => {
      if (refuse) throw new StudioError('revoked', 'This device was revoked.')
      return { conversations: [chat] }
    },
  })
  try {
    await settle(0)
    const firstListed = mounted.rows().listedAt
    assert.equal(mounted.calls().list, 1)

    // Nothing is due before the interval: the clock asks nothing.
    await settle(REREAD_MS - 1)
    assert.equal(mounted.calls().list, 1, 'no request before the interval')

    // The device is dropped over there; the next read on the clock is refused.
    refuse = true
    await settle(1)
    assert.equal(mounted.calls().list, 2, 'the clock reads it again after a few minutes')
    assert.deepEqual(
      mounted.rows().conversations?.map((conversation) => conversation.title),
      ['Ada'],
      'the rows it had are kept',
    )
    assert.equal(mounted.rows().listFailure?.kind, 'unauthorized', 'and they say it refused this device')
    assert.equal(mounted.rows().listedAt, firstListed, 'from the last read that listed them')

    // One failure doubles the wait.
    await settle(REREAD_MS)
    assert.equal(mounted.calls().list, 2, 'a failing environment is not asked again on the usual interval')
    await settle(REREAD_MS)
    assert.equal(mounted.calls().list, 3, 'it is once the backed-off wait has passed')

    // Taken again over there: the next read stands, and the list is current.
    refuse = false
    await settle(FOCUS_REREAD_GAP_MS)
    await mounted.refocus()
    assert.equal(mounted.calls().list, 4, 'coming back to the window reads it')
    assert.equal(mounted.rows().listFailure, null)
    assert.equal(mounted.rows().listedAt, Date.now())

    // Leaving and coming back at once asks nothing more.
    await mounted.refocus()
    assert.equal(mounted.calls().list, 4, 'focus flapping is not a request storm')
  } finally {
    mounted.source.close()
  }
})

test('an environment that refused the connection is asked again when a person comes back, never on the clock', async () => {
  const api = {}
  const studio = fakePairedStudios(api, {
    'workspaces.list': () => ({ workspaces: [] }),
    'conversation.list': () => ({ conversations: [chat] }),
    'session.list': () => ({ ok: true, sessions: [] }),
  })
  studio.refuse = () => new StudioError('revoked', 'This device was revoked.')
  const window = fakeActivity()
  const source = createEnvironmentChatSource(target, {
    hold: (given) => holdEnvironmentStudio(given, { api }),
    activity: window.activity,
  })
  source.subscribe(() => undefined)
  const lists = () => studio.calls.filter((call) => call.method === 'conversation.list').length
  try {
    await settle(0)
    assert.equal(source.snapshot().rows.listFailure?.kind, 'unauthorized', 'its rows say it refused this device')
    assert.equal(source.snapshot().rows.browse, null)

    await settle(REREAD_MS * 10)
    assert.equal(lists(), 0, 'the clock leaves a refused environment alone')

    // Taken again over there.
    studio.refuse = () => null
    window.set({ focused: false })
    window.set({ focused: true })
    await settle(0)
    assert.equal(lists(), 1, 'coming back to the window asks it again')
    assert.equal(source.snapshot().rows.conversations?.length, 1, 'and it lists its chats')
    assert.equal(source.snapshot().rows.listFailure, null)
  } finally {
    source.close()
  }
})

test('chats that did not answer are listed again as soon as the environment answers a browse', async () => {
  let down = false
  const mounted = mount({
    list: () => {
      if (down) throw new StudioError('unavailable', 'The connection dropped.')
      return { conversations: [chat] }
    },
  })
  try {
    await settle(0)
    down = true
    await settle(REREAD_MS)
    assert.equal(mounted.rows().listFailure?.kind, 'unavailable')
    const lists = mounted.calls().list

    // It comes back, and says its projects moved: the browse that answers
    // reads its chats too, so the rows stop saying it is not answering.
    down = false
    mounted.studio.push('conversations.changed', { what: 'workspaces' })
    await settle(400)
    assert.equal(mounted.calls().list, lists + 1, 'its chats are read after the browse')
    assert.equal(mounted.rows().listFailure, null)
  } finally {
    mounted.source.close()
  }
})

test('a read that hangs says the environment is not answering, and its rows stay', async () => {
  let hang = false
  const mounted = mount({
    list: () => (hang ? new Promise(() => undefined) : { conversations: [chat] }),
  })
  try {
    await settle(0)
    hang = true
    mounted.source.refresh()
    await settle(14_000)
    assert.equal(mounted.rows().listFailure, null, 'not yet')
    await settle(2_000)
    assert.equal(mounted.rows().listFailure?.kind, 'unavailable', 'given up on, it says why')
    assert.equal(mounted.rows().conversations?.length, 1, 'and keeps the rows it had')
    hang = false
    mounted.source.refresh()
    await settle(0)
    assert.equal(mounted.rows().listFailure, null, 'a later read is not held behind it')
  } finally {
    mounted.source.close()
  }
})
