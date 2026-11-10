// Notifications popover rendered inside the WorkspaceTopBar's
// `account-and-settings` control group. Extracted from WorkspaceTopBar.tsx so
// the shell file keeps its at-rest control-group inventory visible and the
// popover body stays composable. Pure presentation — list and intent
// callbacks in, IPC and store mutations stay in the parent.

import React, { useMemo, useState } from 'react'
import type { AppNotification, DiagnosticLevel } from '../../../types/workspace'
import {
  CopyGlyphButton,
  EmptyState,
  FilterMenu,
  GhostButton,
  LifecycleGlyph,
  OverflowMenu,
  PanelHeader,
  ScrollArea,
  SECTION_LABEL_CLASS,
  TruncatedText,
  type LifecycleState,
  type OverflowMenuItem,
} from '../../ui'
import { formatTimeOfDay } from '../../../utils/clockFormat'
import { copyToClipboardWithToast } from '../../../utils/copyToClipboardWithToast'

// Severity reads by shape, not a colored dot (StatusDot is deprecated). Error
// maps to the `failed` glyph (ring + "×", error tone) and warning to the
// `needs_input` glyph (ring + "!", warn tone) — the same shape-coded vocabulary
// the rest of the app shell uses.
const LEVEL_GLYPH: Partial<Record<DiagnosticLevel, LifecycleState>> = {
  error: 'failed',
  warning: 'needs_input',
}

// The severity filter, one choice in the header's filter menu: the bell holds
// errors and warnings and nothing else (`reachesBell`), so "both" is simply
// "all". It was two toggle chips beside the title, which spent the header's
// width on a control most visits never touch.
type LevelFilter = 'all' | 'error' | 'warning'
const LEVEL_FILTER_ITEMS: ReadonlyArray<{ value: LevelFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'error', label: 'Errors' },
  { value: 'warning', label: 'Warnings' },
]

const LEVEL_NOUN: Record<DiagnosticLevel, string> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
}

const LEVEL_NAME: Record<DiagnosticLevel, string> = {
  error: 'Error',
  warning: 'Warning',
  info: 'Info',
}

// Recency buckets so the list reads like an inbox instead of one undivided wall
// at scale. Headings are spacing + a quiet label, never a card.
type DayBucket = 'today' | 'yesterday' | 'earlier'
const DAY_BUCKET_ORDER: DayBucket[] = ['today', 'yesterday', 'earlier']
const DAY_BUCKET_LABEL: Record<DayBucket, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  earlier: 'Earlier',
}

const DAY_MS = 24 * 60 * 60 * 1000

function notificationDayBucket(value: string, now: Date): DayBucket {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'earlier'
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const ts = date.getTime()
  if (ts >= startOfToday) return 'today'
  if (ts >= startOfToday - DAY_MS) return 'yesterday'
  return 'earlier'
}

function formatNotificationTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return formatTimeOfDay(date, { hour: '2-digit', minute: '2-digit' })
}

// A fixed-width leading slot keeps every title on one optical baseline whether
// or not the row carries a severity glyph. Reserving the slot is alignment, not
// decoration.
function NotificationSeverityGlyph({ level }: { level: DiagnosticLevel }) {
  const glyph = LEVEL_GLYPH[level]
  return (
    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden={glyph ? undefined : true}>
      {glyph ? <LifecycleGlyph state={glyph} live={false} label={LEVEL_NAME[level]} /> : null}
    </span>
  )
}

// A resolved, ready-to-run Open action for one notification. The shell builds
// these (workspace reveal + any module deep-focus); the popover stays pure and
// only renders + triggers them.
export type NotificationRowAction = {
  id: string
  label: string
  run: () => void | Promise<void>
}

export function NotificationsPopover({
  notifications,
  onMarkRead,
  onMarkAllRead,
  onClear,
  onOpenLogs,
  resolveActions,
}: {
  notifications: AppNotification[]
  onMarkRead: (id: string) => void
  onMarkAllRead: () => void
  onClear: () => void
  /** Open the diagnostics log folder. Absent where the shell has none to open. */
  onOpenLogs?: () => void
  /** Resolve a notification's Open action(s); empty when none is possible. */
  resolveActions?: (notification: AppNotification) => NotificationRowAction[]
}) {
  // View-only severity filter. Resets when the popover unmounts on close.
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all')

  const visibleNotifications =
    levelFilter === 'all' ? notifications : notifications.filter((notification) => notification.level === levelFilter)

  // Bucket by recency after filtering, preserving the incoming (newest-first)
  // order within each group.
  const groups = useMemo(() => {
    const now = new Date()
    const byBucket: Record<DayBucket, AppNotification[]> = { today: [], yesterday: [], earlier: [] }
    for (const notification of visibleNotifications) {
      byBucket[notificationDayBucket(notification.timestamp, now)].push(notification)
    }
    return DAY_BUCKET_ORDER.map((bucket) => ({ bucket, items: byBucket[bucket] })).filter(
      (group) => group.items.length > 0,
    )
  }, [visibleNotifications])

  const emptyMessage =
    notifications.length === 0 ? 'No notifications' : `No ${LEVEL_NOUN[levelFilter as DiagnosticLevel]} notifications`
  const hasUnread = notifications.some((notification) => !notification.read)

  // The header's secondary verbs, behind one kebab: opening the log folder and
  // clearing the list are visits of their own, not the reason the popover was
  // opened, so they do not each take a word in the header.
  const overflowItems: OverflowMenuItem[] = [
    ...(onOpenLogs ? [{ id: 'logs', label: 'Open logs folder', onSelect: onOpenLogs }] : []),
    ...(notifications.length > 0 ? [{ id: 'clear', label: 'Clear all', onSelect: onClear, destructive: true }] : []),
  ]

  return (
    <div className="flex max-h-[520px] w-[480px] flex-col overflow-hidden">
      {/* The identity row (2112), inside an overlay, so it draws no rule: space
          separates it from the list, and the list's top edge fades once rows
          scroll beneath it. One action — Mark all read, while anything is
          unread — then the filter glyph and the kebab. */}
      <PanelHeader
        title="Notifications"
        count={visibleNotifications.length > 0 ? visibleNotifications.length : undefined}
        primaryAction={
          hasUnread ? (
            <GhostButton size="xs" onClick={onMarkAllRead}>
              Mark all read
            </GhostButton>
          ) : undefined
        }
        overflow={
          notifications.length > 0 || overflowItems.length > 0 ? (
            <>
              {notifications.length > 0 ? (
                <FilterMenu
                  ariaLabel="Filter notifications"
                  groups={[
                    {
                      label: 'Show',
                      items: LEVEL_FILTER_ITEMS,
                      value: levelFilter,
                      defaultValue: 'all',
                      onChange: (value) => setLevelFilter(value as LevelFilter),
                    },
                  ]}
                />
              ) : null}
              {overflowItems.length > 0 ? (
                <OverflowMenu ariaLabel="More notification actions" triggerTooltip="More" items={overflowItems} />
              ) : null}
            </>
          ) : undefined
        }
      />

      {visibleNotifications.length === 0 ? (
        <EmptyState density="list" title={emptyMessage} />
      ) : (
        <ScrollArea className="px-1 pb-1" content={[visibleNotifications]}>
          {groups.map((group, index) => (
            // A recency bucket, named for assistive tech. The surface is a
            // `dialog` popover, not a menu: a notification carries its own
            // actions, so it was never activatable as one row and
            // `role="menuitem"` on it announced a control that does not exist
            // (ripple review, 2026-08-05).
            <div key={group.bucket} role="group" aria-label={DAY_BUCKET_LABEL[group.bucket]}>
              {/* The section label: a quiet word with space above it, never a
                  rule (design-system/components/section, "The section
                  label"). Only when there is more than one group to tell
                  apart — "Today" over every row groups nothing. */}
              {groups.length > 1 ? (
                <div
                  aria-hidden="true"
                  className={`${SECTION_LABEL_CLASS} px-2.5 pb-0.5 ${index === 0 ? 'pt-1' : 'pt-3'}`}
                >
                  {DAY_BUCKET_LABEL[group.bucket]}
                </div>
              ) : null}
              {group.items.map((notification) => (
                <NotificationRow
                  key={notification.id}
                  notification={notification}
                  actions={resolveActions?.(notification) ?? []}
                  onMarkRead={onMarkRead}
                  onOpenLogs={onOpenLogs}
                />
              ))}
            </div>
          ))}
        </ScrollArea>
      )}
    </div>
  )
}

function notificationCopyText(notification: AppNotification): string {
  return [
    `[${notification.level.toUpperCase()}] ${notification.title}`,
    notification.message,
    notification.details,
    notification.workspaceName ? `Workspace: ${notification.workspaceName}` : null,
    notification.agentId ? `Agent: ${notification.agentId}` : null,
    notification.sessionId ? `Session: ${notification.sessionId}` : null,
    notification.logPath ? `Log: ${notification.logPath}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

// One notification. Its actions are revealed on hover AND on keyboard focus,
// over the timestamp they replace, so revealing them never reflows the row
// (principles.md, "Progressive disclosure"). At most two: the most useful
// action first — Open, where the shell can resolve one, else Copy — and a
// kebab holding the rest. The kebab is also the non-hover path to every one
// of them.
function NotificationRow({
  notification,
  actions,
  onMarkRead,
  onOpenLogs,
}: {
  notification: AppNotification
  actions: NotificationRowAction[]
  onMarkRead: (id: string) => void
  onOpenLogs?: () => void
}) {
  const [primary, ...more] = actions
  const run = (action: NotificationRowAction) => {
    onMarkRead(notification.id)
    void action.run()
  }
  const copyItem: OverflowMenuItem = {
    id: 'copy',
    label: 'Copy details',
    onSelect: () => {
      void copyToClipboardWithToast(() => notificationCopyText(notification)).then((copied) => {
        if (copied) onMarkRead(notification.id)
      })
    },
  }
  const menuItems: OverflowMenuItem[] = [
    ...(primary ? [copyItem] : []),
    ...more.map((action) => ({ id: action.id, label: action.label, onSelect: () => run(action) })),
    ...(notification.logPath && onOpenLogs
      ? [
          {
            id: 'open-logs',
            label: 'Open logs',
            onSelect: () => {
              onMarkRead(notification.id)
              onOpenLogs()
            },
          },
        ]
      : []),
  ]
  const source = [
    notification.sourceModule?.name,
    notification.workspaceName,
    notification.agentId,
    notification.sessionId,
  ].filter(Boolean)
  return (
    <div
      data-unread={notification.read ? undefined : 'true'}
      className={`group relative rounded-sm px-2.5 py-2.5 hover:bg-[color:var(--bg-hover)] focus-within:bg-[color:var(--bg-hover)] ${
        notification.read
          ? 'text-[color:var(--text-muted)]'
          : 'bg-[color:var(--bg-unread)] text-[color:var(--text-default)]'
      }`}
    >
      <div className="flex items-start gap-2">
        <NotificationSeverityGlyph level={notification.level} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <TruncatedText
              as="div"
              text={notification.title}
              className={`text-body font-semibold ${
                notification.read ? 'text-[color:var(--text-default)]' : 'text-[color:var(--text-strong)]'
              }`}
            />
            <div className="shrink-0 tabular-nums text-micro text-[color:var(--text-disabled)] group-hover:invisible group-focus-within:invisible">
              {formatNotificationTime(notification.timestamp)}
            </div>
          </div>
          <div className="mt-1 text-meta leading-5 text-[color:var(--text-muted)]">{notification.message}</div>
          {/* Who it is from: a module's row names the extension that sent it
              (stamped by the host, never by the module), ahead of any
              workspace it concerns. */}
          {source.length > 0 ? (
            <TruncatedText
              as="div"
              text={source.join(' / ')}
              className="mt-1 font-mono text-micro text-[color:var(--text-disabled)]"
            />
          ) : null}
        </div>
      </div>
      <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        {primary ? (
          <GhostButton size="xs" onClick={() => run(primary)}>
            {primary.label}
          </GhostButton>
        ) : (
          <CopyGlyphButton
            size="xs"
            label="Copy details"
            text={() => notificationCopyText(notification)}
            onCopied={() => onMarkRead(notification.id)}
          />
        )}
        {menuItems.length > 0 ? (
          <OverflowMenu ariaLabel={`More actions for ${notification.title}`} triggerTooltip="More" items={menuItems} />
        ) : null}
      </div>
    </div>
  )
}
