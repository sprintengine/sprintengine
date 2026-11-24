import { EventEmitter } from 'node:events'
import { expect, test, vi } from 'vitest'

// Every tab the built-in browser holds, as the Processes list reads it: its
// clocks, whether it is making sound, whether the person is looking at it;
// and a close asked of the windows, answered once the tab has gone.

const browserSession = Object.assign(new EventEmitter(), {
  getUserAgent: () => 'Mozilla/5.0 Chrome/140.0',
  setUserAgent: () => {},
  setPermissionRequestHandler: () => {},
  setPermissionCheckHandler: () => {},
})
const host = { id: 1, isDestroyed: () => false, send: () => {} }
let audible = true
const guest = Object.assign(new EventEmitter(), {
  id: 9,
  session: browserSession,
  hostWebContents: host,
  getType: () => 'webview',
  isDestroyed: () => false,
  isLoading: () => false,
  isDevToolsOpened: () => false,
  isCurrentlyAudible: () => audible,
  getURL: () => 'http://localhost:5173/game',
  getTitle: () => 'Game',
  navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  setWindowOpenHandler: () => {},
  setZoomFactor: () => {},
  setIgnoreMenuShortcuts: () => {},
  debugger: Object.assign(new EventEmitter(), { isAttached: () => false }),
})

vi.mock('electron', () => ({
  session: { fromPartition: () => browserSession },
  webContents: { fromId: (id: number) => (id === guest.id ? guest : undefined) },
}))

const { createBrowserManager } = await import('./browser-manager')

test('every tab is listed with its clocks, its sound and whether it is in view; a close waits for the tab to go', async () => {
  let clock = 1_000
  const broadcasts: Array<{ channel: string; payload: unknown }> = []
  let showing = true
  const manager = createBrowserManager({
    listTerminalRoots: () => [],
    isHostWindow: () => true,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    resolveWorkspaceRoot: () => null,
    isHostShowing: () => showing,
    now: () => clock,
  })
  expect(manager.register({ tabId: 't1', workspaceId: 'w1', webContentsId: guest.id }, host as never).ok).toBe(true)
  clock = 5_000
  guest.emit('did-navigate')
  manager.noteActive('w1', 't1')

  expect(manager.listAllTabs()).toEqual([
    {
      tabId: 't1',
      workspaceId: 'w1',
      title: 'Game',
      url: 'http://localhost:5173/game',
      openedAt: 1_000,
      lastUsedAt: 5_000,
      audible: true,
      agentIds: [],
      inView: true,
    },
  ])
  // The active tab of a window nobody sees is not in view; a silent page is silent.
  showing = false
  audible = false
  expect(manager.listAllTabs()[0]).toMatchObject({ inView: false, audible: false })

  // The windows are asked; the answer comes once the pane's close unregisters the guest.
  const closing = manager.requestClose('t1')
  expect(broadcasts).toEqual([{ channel: 'browser:close-request', payload: { workspaceId: 'w1', tabId: 't1' } }])
  manager.unregister('t1')
  expect(await closing).toBe(true)
  expect(manager.listAllTabs()).toEqual([])
  expect(await manager.requestClose('t1')).toBe(false)
})
