import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'vitest'

import type { AppNotification } from '../../../types/workspace'
import { NotificationsPopover, type NotificationRowAction } from './NotificationsPopover'

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

function render(
  notification: AppNotification,
  options: { onOpenLogs?: () => void; actions?: NotificationRowAction[] } = {},
): string {
  return renderToStaticMarkup(
    <NotificationsPopover
      notifications={[notification]}
      onMarkRead={() => undefined}
      onMarkAllRead={() => undefined}
      onClear={() => undefined}
      onOpenLogs={options.onOpenLogs}
      resolveActions={() => options.actions ?? []}
    />,
  )
}

test('Open logs shows on a logged row where the shell can open the folder', () => {
  const html = render(row({ logPath: '/Users/dev/logs/diagnostics.log' }), { onOpenLogs: () => undefined })
  assert.match(html, />Open logs</)
  assert.match(html, />Logs</)
})

test('a row that was never logged has no Open logs', () => {
  const html = render(row(), { onOpenLogs: () => undefined })
  assert.doesNotMatch(html, /Open logs/)
})

test('a shell with no log folder offers neither logs button', () => {
  const html = render(row({ logPath: '/Users/dev/logs/diagnostics.log' }))
  assert.doesNotMatch(html, /Open logs/)
  assert.doesNotMatch(html, />Logs</)
})

test('a row is offered Open only when something resolves it', () => {
  assert.doesNotMatch(render(row()), />Open</)
  const open: NotificationRowAction = { id: 'open', label: 'Open', run: () => undefined }
  assert.match(render(row(), { actions: [open] }), />Open</)
})
