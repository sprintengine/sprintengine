import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { test } from 'vitest'

import { useRemoteSessions, type RemoteSessions } from './useRemoteSessions'

// What a change push costs the band: a push from the machine
// (`conversations.changed`) re-reads only what it names, a window nobody can
// see re-reads nothing until it is shown, then once, and the machine reached
// again after a drop is read whole.

test('useRemoteSessions re-reads what a push names, and holds pushes while the window is hidden', async () => {
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

  const connection = {
    id: 'c1',
    machineName: 'mac-mini',
    endpoint: 'mac-mini.tail1234.ts.net:8471',
    deviceId: 'tnd_1',
    deviceName: 'dev-macbook-air',
    scopes: ['workspace:read', 'conversation:read'],
    pairedAt: '2026-09-13T00:00:00.000Z',
    lastConnectedAt: null,
    pairedVia: 'link',
  }
  const calls = { browse: 0, list: 0 }
  let hiddenListener: ((hidden: boolean) => void) | null = null
  ;(dom.window as unknown as { api: unknown }).api = {
    onTailnetEvent: () => () => {},
    onMeshEvent: () => () => {},
    onWindowHiddenChanged: (listener: (hidden: boolean) => void) => {
      hiddenListener = listener
      return () => {
        hiddenListener = null
      }
    },
    tailnetGetStatus: async () => ({ enabled: true, running: true, tailnetAddress: '100.64.0.5', pairRequests: [] }),
    tailnetGetLiveState: async () => ({ revision: 1, devices: [] }),
    meshListConnections: async () => [connection],
    meshGetLiveState: async () => ({ revision: 1, attachments: [], requests: [], reachability: [] }),
  }
  // That machine's Studio, as this window's own client of it reaches it: a
  // browse is its project list, and its chats are its `conversation.list`.
  const { fakePairedStudios } = await import('../../../studio/environmentStudio.double')
  const studio = fakePairedStudios((dom.window as unknown as { api: object }).api, {
    'workspaces.list': () => {
      calls.browse += 1
      return { workspaces: [] }
    },
    'conversation.list': () => {
      calls.list += 1
      return { conversations: [] }
    },
    'session.list': () => ({ ok: true, sessions: [] }),
  })

  let latest: RemoteSessions | null = null
  function Probe() {
    latest = useRemoteSessions({ enabled: true })
    return null
  }
  const settle = async (ms = 300) => {
    await act(async () => {
      await new Promise((resolve) => dom.window.setTimeout(resolve, ms))
    })
  }
  // What that machine says moved, on its push topic.
  const push = async (what: 'workspaces' | 'conversations') => {
    await act(async () => {
      studio.push('conversations.changed', { what })
    })
  }

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(createElement(Probe))
    })
    await settle(50)
    assert.ok(latest, 'the probe rendered')
    assert.deepEqual(calls, { browse: 1, list: 1 }, 'the first read is the whole machine')

    await push('conversations')
    await settle()
    assert.deepEqual(calls, { browse: 1, list: 2 }, 'a conversation push lists the chats, and only them')

    await push('workspaces')
    await push('workspaces')
    await settle()
    assert.deepEqual(calls, { browse: 2, list: 2 }, 'workspace pushes in one burst are one browse')

    // Out of sight: pushes are remembered, not read.
    await act(async () => {
      hiddenListener!(true)
    })
    await push('conversations')
    await push('workspaces')
    await push('conversations')
    await settle()
    assert.deepEqual(calls, { browse: 2, list: 2 }, 'a hidden window reads nothing')

    await act(async () => {
      hiddenListener!(false)
    })
    await settle()
    assert.deepEqual(calls, { browse: 3, list: 3 }, 'shown again, it reads what changed, once')

    // The window's connection to it drops and comes back: it may have missed a push, so both are read.
    await act(async () => studio.setState('c1', 'reconnecting'))
    await settle()
    assert.deepEqual(calls, { browse: 3, list: 3 }, 'nothing is asked of a machine while it is away')
    await act(async () => studio.setState('c1', 'open'))
    await settle()
    assert.deepEqual(calls, { browse: 4, list: 4 }, 'reached again, it is read whole, once')
  } finally {
    act(() => root.unmount())
  }
})
