import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, test, vi } from 'vitest'

import { StudioError } from '../../../../../../packages/client-runtime/src/public'
import { REMOTE_FOCUS_REREAD_GAP_MS, REMOTE_REREAD_MS } from './remoteListFreshness'
import { useRemoteSessions, type RemoteSessions } from './useRemoteSessions'

// A paired machine's chats kept fresh by the window itself: read with this
// device on the tailnet whatever its own listener does, kept and said to be
// last-known when a read fails, read again on a slow clock that backs off,
// and read again when a person comes back to the window, a machine that
// refused this pairing included.

// One page for the file: the window's activity is read off the first one.
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window
anyGlobal.document = dom.window.document
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.Node = dom.window.Node
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

// The slow clock's tick, run by the test rather than waited for.
let clockTick: (() => void) | null = null
const realSetInterval = dom.window.setInterval.bind(dom.window)
;(dom.window as unknown as { setInterval: unknown }).setInterval = (handler: () => void, ms: number) => {
  if (ms !== 60_000) return realSetInterval(handler, ms)
  clockTick = handler
  return 0
}
let windowFocused = true
dom.window.document.hasFocus = () => windowFocused

const pairing = {
  id: 'c1',
  machineName: 'mac-mini',
  endpoint: 'mac-mini.tail1234.ts.net:8471',
  deviceId: 'tnd_1',
  deviceName: 'dev-macbook-air',
  scopes: ['workspace:read', 'conversation:read'],
  pairedAt: '2026-11-01T00:00:00.000Z',
  lastConnectedAt: null,
  pairedVia: 'link',
}

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

let clock = 1_000_000
const settle = async (ms = 80) => {
  await act(async () => {
    await new Promise((resolve) => dom.window.setTimeout(resolve, ms))
  })
}

async function mount(input: {
  /** This device's own listener; the reads must not care. */
  running: boolean
  reachability?: Array<Record<string, unknown>>
  list: () => unknown
}) {
  const calls = { browse: 0, list: 0 }
  ;(dom.window as unknown as { api: unknown }).api = {
    onTailnetEvent: () => () => {},
    onMeshEvent: () => () => {},
    tailnetGetStatus: async () => ({
      enabled: true,
      running: input.running,
      tailnetAddress: '100.64.0.5',
      pairRequests: [],
    }),
    tailnetGetLiveState: async () => ({ revision: 1, devices: [] }),
    meshListConnections: async () => [pairing],
    meshGetLiveState: async () => ({
      revision: 1,
      attachments: [],
      requests: [],
      reachability: input.reachability ?? [],
    }),
  }
  const { fakePairedStudios } = await import('../../../studio/environmentStudio.double')
  const studio = fakePairedStudios((dom.window as unknown as { api: object }).api, {
    'workspaces.list': () => {
      calls.browse += 1
      return { workspaces: [] }
    },
    'conversation.list': () => {
      calls.list += 1
      return input.list()
    },
    'session.list': () => ({ ok: true, sessions: [] }),
  })
  const seen: { latest: RemoteSessions | null } = { latest: null }
  function Probe() {
    seen.latest = useRemoteSessions({ enabled: true })
    return null
  }
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(Probe))
  })
  await settle()
  return {
    calls,
    studio,
    entry: () => seen.latest!.browses.get('c1'),
    unmount: () => act(() => root.unmount()),
  }
}

// A person leaves the window and comes back to it.
async function refocus() {
  windowFocused = false
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.Event('blur'))
  })
  await settle(10)
  windowFocused = true
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.Event('focus'))
  })
  await settle()
}

afterEach(() => {
  vi.restoreAllMocks()
  clockTick = null
})

test('a machine is read with this device on the tailnet, whatever its own listener does', async () => {
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  const mounted = await mount({ running: false, list: () => ({ conversations: [chat] }) })
  try {
    assert.deepEqual(mounted.calls, { browse: 1, list: 1 }, 'the listener is for machines driving this one')
    assert.equal(mounted.entry()?.conversations?.length, 1)
    assert.equal(mounted.entry()?.listFailure, null)
    assert.equal(mounted.entry()?.listedAt, clock)
  } finally {
    mounted.unmount()
  }
})

test('a refused read keeps the rows and says why, and the clock backs off while it fails', async () => {
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  let refuse = false
  const mounted = await mount({
    running: true,
    list: () => {
      if (refuse) throw new StudioError('revoked', 'This device was revoked.')
      return { conversations: [chat] }
    },
  })
  try {
    const firstListed = mounted.entry()?.listedAt
    assert.equal(mounted.calls.list, 1)
    assert.ok(clockTick, 'a window someone can see keeps a slow clock')

    // Nothing is due before the interval: the clock asks nothing.
    clock += REMOTE_REREAD_MS - 1
    await act(async () => clockTick!())
    await settle()
    assert.equal(mounted.calls.list, 1, 'no request before the interval')

    // The pairing is dropped over there; the next read on the clock is refused.
    refuse = true
    clock += 1
    await act(async () => clockTick!())
    await settle()
    assert.equal(mounted.calls.list, 2, 'the clock reads it again after a few minutes')
    assert.deepEqual(
      mounted.entry()?.conversations?.map((conversation) => conversation.title),
      ['Ada'],
      'the rows it had are kept',
    )
    assert.equal(mounted.entry()?.listFailure?.kind, 'unauthorized', 'and they say the machine refused this device')
    assert.equal(mounted.entry()?.listedAt, firstListed, 'from the last read that listed them')

    // One failure doubles the wait.
    clock += REMOTE_REREAD_MS
    await act(async () => clockTick!())
    await settle()
    assert.equal(mounted.calls.list, 2, 'a failing machine is not asked again on the usual interval')
    clock += REMOTE_REREAD_MS
    await act(async () => clockTick!())
    await settle()
    assert.equal(mounted.calls.list, 3, 'it is once the backed-off wait has passed')

    // Paired again over there: the next read stands, and the list is current.
    refuse = false
    clock += REMOTE_FOCUS_REREAD_GAP_MS
    await refocus()
    assert.equal(mounted.calls.list, 4, 'coming back to the window reads it')
    assert.equal(mounted.entry()?.listFailure, null)
    assert.equal(mounted.entry()?.listedAt, clock)

    // Leaving and coming back at once asks nothing more.
    await refocus()
    assert.equal(mounted.calls.list, 4, 'focus flapping is not a request storm')
  } finally {
    mounted.unmount()
  }
})

test('a machine that refused this pairing is asked again when a person comes back to the window', async () => {
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  const mounted = await mount({
    running: true,
    reachability: [
      {
        connectionId: 'c1',
        machineName: 'mac-mini',
        checking: false,
        reachable: false,
        unauthorized: true,
        checkedAt: clock - 10,
        lastReachedAt: null,
        detail: 'Revoked',
      },
    ],
    list: () => ({ conversations: [chat] }),
  })
  try {
    // Mount reads race the check, so the first read may or may not go out;
    // what matters is that the clock never asks a refused machine and focus does.
    const before = mounted.calls.list
    clock += REMOTE_REREAD_MS * 10
    await act(async () => clockTick?.())
    await settle()
    assert.equal(mounted.calls.list, before, 'the clock leaves a refused machine alone')
    await refocus()
    assert.equal(mounted.calls.list, before + 1, 'coming back to the window asks it again')
    assert.equal(mounted.entry()?.conversations?.length, 1, 'and a pairing made again over there lists its chats')
  } finally {
    mounted.unmount()
  }
})

test('a machine whose chats did not answer is listed again as soon as it answers a browse', async () => {
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  let down = false
  const mounted = await mount({
    running: true,
    list: () => {
      if (down) throw new StudioError('unavailable', 'The connection dropped.')
      return { conversations: [chat] }
    },
  })
  try {
    down = true
    clock += REMOTE_REREAD_MS
    await act(async () => clockTick!())
    await settle()
    assert.equal(mounted.entry()?.listFailure?.kind, 'unavailable')
    const lists = mounted.calls.list

    // It comes back, and says its projects moved: the browse that answers
    // reads its chats too, so the rows stop saying it is not answering.
    down = false
    await act(async () => {
      mounted.studio.push('conversations.changed', { what: 'workspaces' })
    })
    await settle(400)
    assert.equal(mounted.calls.list, lists + 1, 'its chats are read after the browse')
    assert.equal(mounted.entry()?.listFailure, null)
  } finally {
    mounted.unmount()
  }
})
