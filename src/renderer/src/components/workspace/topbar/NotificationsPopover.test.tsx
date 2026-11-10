// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'

import type { AppNotification } from '../../../types/workspace'
import { OverlaySurfaceContext } from '../../ui'
import { NotificationsPopover, type NotificationRowAction } from './NotificationsPopover'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const row = (over: Partial<AppNotification> = {}): AppNotification => ({
  id: 'n1',
  level: 'error',
  source: 'workspace',
  title: 'Could not start',
  message: 'The agent exited.',
  timestamp: '2026-11-09T10:00:00.000Z',
  read: false,
  ...over,
})

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  document.body.innerHTML = ''
  root = null
  host = null
})

function render(
  notifications: AppNotification[],
  options: { onOpenLogs?: () => void; actions?: NotificationRowAction[] } = {},
): HTMLElement {
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  act(() =>
    root!.render(
      // The bell hosts it in a Popover, which says it is an overlay.
      <OverlaySurfaceContext.Provider value={true}>
        <NotificationsPopover
          notifications={notifications}
          onMarkRead={() => undefined}
          onMarkAllRead={() => undefined}
          onClear={() => undefined}
          onOpenLogs={options.onOpenLogs}
          resolveActions={() => options.actions ?? []}
        />
      </OverlaySurfaceContext.Provider>,
    ),
  )
  return host
}

function button(name: string | RegExp): HTMLButtonElement | null {
  const all = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
  return (
    all.find((b) => {
      const label = b.getAttribute('aria-label') ?? b.textContent?.trim() ?? ''
      return typeof name === 'string' ? label === name : name.test(label)
    }) ?? null
  )
}

function openMenu(name: string | RegExp): string[] {
  const trigger = button(name)
  expect(trigger, `a trigger named ${String(name)}`).not.toBeNull()
  act(() => trigger!.click())
  return Array.from(document.querySelectorAll('[role="menu"] [role^="menuitem"]')).map(
    (item) => item.textContent?.trim() ?? '',
  )
}

test('the header has no severity chips: the filter is one menu, with All as its default', () => {
  render([row(), row({ id: 'n2', level: 'warning', title: 'Push rejected' })])
  expect(button(/^Show only/)).toBeNull()
  expect(openMenu('Filter notifications')).toEqual(['All', 'Errors', 'Warnings'])
})

test('choosing Warnings leaves only the warnings', () => {
  const view = render([row(), row({ id: 'n2', level: 'warning', title: 'Push rejected' })])
  openMenu('Filter notifications')
  const warnings = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find(
    (item) => item.textContent?.trim() === 'Warnings',
  )
  act(() => warnings!.click())
  expect(view.textContent).toContain('Push rejected')
  expect(view.textContent).not.toContain('Could not start')
})

test('Logs and Clear ride the header kebab, not a word each', () => {
  render([row()], { onOpenLogs: () => undefined })
  expect(button('Logs')).toBeNull()
  expect(button('Clear')).toBeNull()
  expect(openMenu('More notification actions')).toEqual(['Open logs folder', 'Clear all'])
})

test('a shell with no log folder offers no logs entry anywhere', () => {
  render([row({ logPath: '/Users/dev/logs/diagnostics.log' })])
  expect(openMenu('More notification actions')).toEqual(['Clear all'])
  // Nothing to open and no logs to show: the row leads with Copy, and has no
  // menu left to draw.
  expect(button('More actions for Could not start')).toBeNull()
})

test('Mark all read is offered only while something is unread', () => {
  render([row()])
  expect(button('Mark all read')).not.toBeNull()
  act(() => root!.unmount())
  root = null
  document.body.innerHTML = ''
  render([row({ read: true })])
  expect(button('Mark all read')).toBeNull()
})

test('a row leads with Open when something resolves it, and keeps Copy and logs in its menu', () => {
  const open: NotificationRowAction = { id: 'open', label: 'Open', run: () => undefined }
  render([row({ logPath: '/Users/dev/logs/diagnostics.log' })], { onOpenLogs: () => undefined, actions: [open] })
  expect(button('Open')).not.toBeNull()
  expect(button('Copy details')).toBeNull()
  expect(openMenu('More actions for Could not start')).toEqual(['Copy details', 'Open logs'])
})

test('a row with nothing to open leads with Copy, and draws no menu when nothing else is left', () => {
  render([row()])
  expect(button('Open')).toBeNull()
  expect(button('Copy details')).not.toBeNull()
  expect(button('More actions for Could not start')).toBeNull()
})

test('row actions are revealed on keyboard focus as well as hover, over the timestamp', () => {
  const view = render([row()])
  const cluster = view.querySelector('[data-unread] .opacity-0')
  expect(cluster?.className).toContain('group-hover:opacity-100')
  expect(cluster?.className).toContain('group-focus-within:opacity-100')
})

test('an unread row is tinted with the unread token, which shows on a light popover too', () => {
  const view = render([row(), row({ id: 'n2', read: true, title: 'Seen' })])
  const unread = view.querySelector('[data-unread="true"]')
  expect(unread?.className).toContain('bg-[color:var(--bg-unread)]')
  expect(view.querySelectorAll('[data-unread="true"]').length).toBe(1)
})

test('a single day draws no section label; two days draw a quiet label each and no rule', () => {
  const now = new Date()
  const today = now.toISOString()
  const view = render([row({ timestamp: today })])
  expect(view.querySelector('[role="group"] > [aria-hidden="true"]')).toBeNull()
  act(() => root!.unmount())
  root = null
  document.body.innerHTML = ''
  const earlier = new Date(now.getTime() - 10 * 86_400_000).toISOString()
  const two = render([row({ timestamp: today }), row({ id: 'n2', timestamp: earlier, title: 'Old' })])
  const labels = Array.from(two.querySelectorAll('[role="group"] > [aria-hidden="true"]'))
  expect(labels.map((label) => label.textContent)).toEqual(['Today', 'Earlier'])
  for (const label of labels) expect(label.className).not.toMatch(/border-/)
  expect(two.innerHTML).not.toMatch(/border-[bt] /)
})
