// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { useWorkspaceStore } from '../../../store/workspaceStore'
import { RemoteLastKnownMark } from './rowParts'

// A row from a paired machine's last-known list says so in words, with no
// dot, and where a pairing is the remedy its "pair again" opens Settings →
// Remote without opening the row.

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const DAY = 24 * 60 * 60_000
const NOW = 30 * DAY

test('a machine not answering says so, and how old its list is', () => {
  act(() =>
    root.render(
      <RemoteLastKnownMark
        lastKnown={{ reason: 'not-answering', since: NOW - 2 * DAY }}
        machineName="mac-mini.tail1234.ts.net"
        now={NOW}
      />,
    ),
  )
  const mark = host.querySelector('[data-remote-last-known]')!
  expect(mark.getAttribute('data-remote-last-known')).toBe('not-answering')
  expect(mark.textContent).toContain('Not answering · 2d')
  expect(host.querySelector('button')).toBeNull()
  expect(host.querySelector('.rounded-full')).toBeNull()
  expect(mark.textContent).not.toContain('mac-mini')
})

test('a machine that refused this device offers Pair again, which opens Settings → Remote and not the row', () => {
  const openSettingsOverlay = vi.fn()
  useWorkspaceStore.setState({ openSettingsOverlay } as never)
  const openRow = vi.fn()
  act(() =>
    root.render(
      <div onClick={openRow}>
        <RemoteLastKnownMark lastKnown={{ reason: 'signed-out', since: NOW - DAY }} machineName="mac-mini" now={NOW} />
      </div>,
    ),
  )
  const mark = host.querySelector('[data-remote-last-known]')!
  expect(mark.textContent).toContain('Signed out')
  const pairAgain = host.querySelector('button')!
  expect(pairAgain.textContent).toBe('pair again')
  expect(pairAgain.getAttribute('aria-label')).toBe('Pair again with mac-mini in Settings')
  act(() => pairAgain.click())
  expect(openSettingsOverlay).toHaveBeenCalledWith({ initialTab: 'remote' })
  expect(openRow).not.toHaveBeenCalled()
})
