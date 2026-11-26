// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { webShellIpc } from './webShellIpc'

// The tab's IPC is the browser's stand-ins alone: no IPC leaves a web tab.
vi.mock('./webIpcRouter', () => ({ ipc: webShellIpc }))
vi.mock('../../../preload/ipc-router', () => ({ ipc: webShellIpc }))

const { createWebApi } = await import('./createWebApi')
const { apiModules } = await import('../../../preload/api-surface')
const { isUnsupportedOnThisClient, refusedChannels } = await import('./unsupported')
const { currentEnvironments, resetEnvironmentsForTests, useEnvironments } = await import('../hooks/useEnvironments')

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

test('every member the preload builds is present, with the four computed values', () => {
  const api = createWebApi()
  for (const key of Object.keys(apiModules)) expect(key in api, key).toBe(true)
  expect(typeof api.platform).toBe('string')
  expect(typeof api.isDevelopment).toBe('boolean')
  expect(api.isDiagnosticsEnabled).toBe(false)
  expect(api.diagnosticsGetIpcStats().channels).toEqual([])
})

test('a member a browser cannot do is a rejected promise, never a throw or undefined, and is reported once', async () => {
  const api = createWebApi()
  let thrown: unknown = null
  let pending: Promise<unknown> | null = null
  expect(() => {
    pending = api.panePopOutOpen({ popOutId: 'pop-1', tabs: [] } as never)
  }).not.toThrow()
  try {
    await pending
  } catch (error) {
    thrown = error
  }
  expect(isUnsupportedOnThisClient(thrown)).toBe(true)
  expect(refusedChannels()).toContain('pane-popout:open')
})

// The machines a desktop knows are its own state, as its window geometry is
// (shared/environments.ts), not a server method: a tab's Studio is the one
// that served it. Its read is refused here and never asked of the server, and
// the list every surface draws from reads that as no other machines, quietly.
test('the list of machines is the desktop’s: a tab is refused it, and draws none', async () => {
  const api = createWebApi()
  let refusal: unknown = null
  await api.environmentsList().catch((error: unknown) => (refusal = error))
  expect(isUnsupportedOnThisClient(refusal)).toBe(true)

  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const previous = (window as { api?: unknown }).api
  ;(window as { api?: unknown }).api = api
  const host = document.createElement('div')
  const root = createRoot(host)
  const drawn: number[] = []
  function Machines() {
    drawn.push(useEnvironments().length)
    return null
  }
  try {
    await act(async () => root.render(React.createElement(Machines)))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(refusedChannels()).toContain('environments:list')
    expect(currentEnvironments()).toEqual([])
    expect(drawn.every((count) => count === 0)).toBe(true)
  } finally {
    act(() => root.unmount())
    resetEnvironmentsForTests()
    ;(window as { api?: unknown }).api = previous
  }
})

test('a subscription to a shell push is a working no-op', () => {
  const api = createWebApi()
  const stop = api.onWindowStateChanged(() => undefined)
  expect(typeof stop).toBe('function')
  expect(() => stop()).not.toThrow()
})

test('the clipboard and links act in the browser, never on the server', async () => {
  const api = createWebApi()
  const opened = vi.spyOn(window, 'open').mockImplementation(() => null)
  expect(await api.openExternal('https://example.com/docs')).toEqual({ ok: true })
  expect(opened).toHaveBeenCalledWith('https://example.com/docs', '_blank', 'noopener,noreferrer')
  expect((await api.openExternal('file:///Users/dev/secret')).ok).toBe(false)
})

test('boot reads find empty states', async () => {
  const api = createWebApi()
  expect((await api.authGetState()).status).toBe('signed_out')
})
