import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { test } from 'vitest'

import { useRemoteSessions, type RemoteSessions } from './useRemoteSessions'

// The band reads nothing itself: each paired machine's rows are its chat
// source's (`environmentChats.ts`, whose tests hold the reads, the pushes and
// the clock), shaped here by pairing as the band draws them.

test('each followed environment’s rows come from its chat source, shaped as the rows read them', async () => {
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
  ;(dom.window as unknown as { api: unknown }).api = {
    onTailnetEvent: () => () => {},
    onMeshEvent: () => () => {},
    tailnetGetStatus: async () => ({ enabled: true, running: true, tailnetAddress: '100.64.0.5', pairRequests: [] }),
    tailnetGetLiveState: async () => ({ revision: 1, devices: [] }),
    meshListConnections: async () => [connection],
    meshGetLiveState: async () => ({ revision: 1, attachments: [], requests: [], reachability: [] }),
  }
  const { fakePairedStudios } = await import('../../../studio/environmentStudio.double')
  const studio = fakePairedStudios((dom.window as unknown as { api: object }).api, {
    'workspaces.list': () => ({ workspaces: [] }),
    'conversation.list': () => ({
      conversations: [{ workspaceId: 'rw1', agentId: 'ada', title: 'Ada', phase: 'idle', updatedAt: 2, lastSeq: 1 }],
    }),
    'session.list': () => ({ ok: true, sessions: [] }),
  })
  const lists = () => studio.calls.filter((call) => call.method === 'conversation.list').length
  // The window follows every listed environment (`useFollowWindowEnvironments`); this hook shapes what each read.
  const { followEnvironmentChats } = await import('../../../studio/environmentChats')
  followEnvironmentChats([{ route: 'tailnet:c1', name: 'mac-mini' }])

  let latest: RemoteSessions | null = null
  function Probe() {
    latest = useRemoteSessions()
    return null
  }
  const settle = async (ms = 80) => {
    await act(async () => {
      await new Promise((resolve) => dom.window.setTimeout(resolve, ms))
    })
  }
  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(createElement(Probe))
    })
    await settle()
    const [view] = latest!.sources
    assert.ok(view, 'the paired machine has its entry')
    assert.deepEqual(
      [view.route, view.machineName, view.connectionId, view.live],
      ['tailnet:c1', 'mac-mini', 'c1', true],
    )
    const { entry } = view
    assert.ok(entry.browse?.scopes.includes('conversation:operate'), 'its scopes as its grant says them now')
    assert.equal(entry.conversations?.length, 1)
    assert.equal(entry.lifecycle, true)
    assert.equal(entry.manage?.rename, true)
    assert.equal(entry.access, 'operate')
    assert.equal(entry.listFailure, null)
    assert.equal(lists(), 1, 'read once, by its source')

    const before = latest!.sources
    await settle()
    assert.equal(latest!.sources, before, 'nothing moved: the same entries')

    await act(async () => latest!.refresh('tailnet:c1'))
    await settle()
    assert.equal(lists(), 2, 'Refresh reads the machine again')
  } finally {
    act(() => root.unmount())
    followEnvironmentChats([])
  }
})
