import React from 'react'

import { Badge, ChangePulse, IconButton, Popover, Tooltip, type PopoverPlacement } from '../ui'
import { clientSupports } from '../../clientCapabilities'
import type { AppNotification } from '../../types/workspace'
import type { NotificationRowAction } from './topbar/NotificationsPopover'

// The bell: reports worth reading, at the rail's foot above the account (owner
// ruling 2026-11-07), and in the window's band when the rail is hidden. It is
// mounted in exactly one of those places, and always in one: the app opens the
// list itself when something fails, so the control it anchors to has to be on
// screen.
//
// The list hangs off the glyph and is not rendered until it opens, so it is
// fetched at open time rather than evaluated before the first paint.
const NotificationsPopover = React.lazy(() =>
  import('./topbar/NotificationsPopover').then((m) => ({ default: m.NotificationsPopover })),
)

function NotificationBellIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M18.25 10.75V9.5a6.25 6.25 0 0 0-12.5 0v1.25c0 2.3-.8 3.6-1.55 4.38a1.24 1.24 0 0 0 .88 2.12h13.84a1.24 1.24 0 0 0 .88-2.12c-.75-.78-1.55-2.08-1.55-4.38Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9.75 19.25a2.35 2.35 0 0 0 4.5 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

export type NotificationBellProps = {
  notifications: AppNotification[]
  /** The unread reports the bell wears, and how loud they are; null when there are none. */
  badge: { count: number; tone: 'error' | 'warn' } | null
  open: boolean
  onOpenChange: (open: boolean) => void
  markNotificationRead: (id: string) => void
  markAllNotificationsRead: () => void
  clearNotifications: () => void
  /** Resolve a notification's Open action(s); empty when no deep-link or reveal is possible. */
  resolveNotificationActions: (notification: AppNotification) => NotificationRowAction[]
  /** The rail's square and its sideways tooltip, or the band's smaller step. */
  onRail: boolean
  placement: PopoverPlacement
}

export function NotificationBell({
  notifications,
  badge,
  open,
  onOpenChange,
  markNotificationRead,
  markAllNotificationsRead,
  clearNotifications,
  resolveNotificationActions,
  onRail,
  placement,
}: NotificationBellProps) {
  return (
    <div className="app-no-drag relative inline-flex">
      <Popover
        open={open}
        onOpenChange={onOpenChange}
        ariaLabel="Notifications"
        // A list of reports, each with its own buttons — not a menu. It
        // carried `role="menu"` with `role="menuitem"` on the report blocks,
        // which announced rows that could not be activated.
        popupRole="dialog"
        placement={placement}
        renderTrigger={({ ref, triggerProps, togglePopover }) => (
          <Tooltip content="Notifications" placement={onRail ? 'right' : 'bottom'}>
            <IconButton
              ref={ref}
              size={onRail ? 'lg' : 'md'}
              onClick={togglePopover}
              pressed={open}
              className="relative"
              aria-label="Notifications"
              {...triggerProps}
            >
              <ChangePulse
                value={badge?.count ?? 0}
                mode="increase"
                tint={badge?.tone === 'warn' ? 'var(--tone-warn)' : 'var(--tone-error)'}
                className="inline-flex"
              >
                <NotificationBellIcon className={onRail ? 'size-icon-lg' : 'size-icon-md'} />
              </ChangePulse>
              {badge ? (
                <Badge
                  corner
                  decorative
                  tone={badge.tone}
                  count={badge.count}
                  max={99}
                  className={onRail ? 'border-[color:var(--bg-canvas)]' : undefined}
                />
              ) : null}
            </IconButton>
          </Tooltip>
        )}
      >
        <React.Suspense fallback={null}>
          <NotificationsPopover
            notifications={notifications}
            onMarkRead={markNotificationRead}
            onMarkAllRead={markAllNotificationsRead}
            onClear={clearNotifications}
            // The log folder is on the machine the desktop app runs on; a browser
            // tab has none to open, and a button that refuses is worse than none.
            onOpenLogs={
              clientSupports('reveal-in-folder') ? () => void window.api.openDiagnosticsLogsFolder() : undefined
            }
            resolveActions={resolveNotificationActions}
          />
        </React.Suspense>
      </Popover>
    </div>
  )
}
