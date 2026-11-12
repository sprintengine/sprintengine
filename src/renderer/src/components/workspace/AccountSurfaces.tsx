import React from 'react'

import { PointerPopover } from '../ui'
import type { Tone } from '../ui/tokens'
import { sessionsAttentionTone } from './workspaceManagerHelpers'
import { remoteGlyphState, remoteGlyphToneClass, remoteGlyphTooltip, useOpenRemoteSettings } from './topbar/remoteGlyph'
import { SessionsPopover, type SessionGroup, type SessionItem } from './topbar/SessionsPopover'
import { useTailnetPresence } from './topbar/useTailnetPresence'
import { useEnvironments } from '../../hooks/useEnvironments'
import type { AccountMenuRow, AccountBadge } from './SidebarAccountBar'

// Remote and Sessions, behind the avatar (owner ruling 2026-11-07). The account
// menu closes as a row is pressed, so what the row opens cannot hang off the
// row: it opens at the avatar, from here, and stays up on its own. The avatar
// wears what the two glyphs used to wear in the top row, or it would go quiet
// inside a menu: a pair request waiting, which asks for a person, else how many
// sessions are running.
//
// Popovers rather than anything in the menu, so an OS notification about a pair
// request can open Remote with the account menu shut.

const RemotePopover = React.lazy(() => import('./topbar/RemotePopover').then((m) => ({ default: m.RemotePopover })))

/** Where the surface opens: at the avatar, beside whichever edge of the window it is on. */
function avatarAnchor(): { x: number; y: number; above: number } {
  const avatar = document.querySelector('[data-account-trigger]')?.getBoundingClientRect()
  if (!avatar) return { x: window.innerWidth / 2, y: 44, above: 44 }
  return { x: avatar.left, y: avatar.bottom + 4, above: avatar.top - 4 }
}

export function useAccountSurfaces({
  sessions,
  sessionsOffered,
  setSessionsOpen,
  setNotificationsOpen,
}: {
  sessions: readonly SessionItem[]
  sessionsOffered: boolean
  setSessionsOpen: React.Dispatch<React.SetStateAction<boolean>>
  setNotificationsOpen: React.Dispatch<React.SetStateAction<boolean>>
}) {
  // Remote presence (remote-sessions-ux / remote-glyph-topbar): pushed, never polled.
  const presence = useTailnetPresence()
  const environments = useEnvironments()
  const remoteState = remoteGlyphState(presence, environments)
  const [remoteOpen, setRemoteOpen] = React.useState(false)
  // An OS notification about a pair request or a machine's answer was clicked
  // (pair-from-the-scan-and-stay-paired, phase 3): main brought the window
  // forward; this opens the surface the banner pointed at.
  React.useEffect(() => {
    if (typeof window.api.onRemoteOpenRequested !== 'function') return
    return window.api.onRemoteOpenRequested(() => {
      setSessionsOpen(false)
      setNotificationsOpen(false)
      setRemoteOpen(true)
    })
  }, [setNotificationsOpen, setSessionsOpen])

  const openSessions = React.useCallback(() => {
    setRemoteOpen(false)
    setNotificationsOpen(false)
    setSessionsOpen(true)
  }, [setNotificationsOpen, setSessionsOpen])
  const openRemote = React.useCallback(() => {
    setSessionsOpen(false)
    setNotificationsOpen(false)
    setRemoteOpen(true)
  }, [setNotificationsOpen, setSessionsOpen])

  const sessionsRow: AccountMenuRow | null = sessionsOffered
    ? { meta: sessions.length > 0 ? `${sessions.length} running` : null, onSelect: openSessions }
    : null
  // Absent while the feature is off and no machine is paired, as the glyph was:
  // not present-but-empty.
  const remoteRow: AccountMenuRow | null = remoteState.visible
    ? {
        meta:
          remoteState.requestCount > 0
            ? `${remoteState.requestCount} waiting`
            : remoteState.answering === 1
              ? '1 machine'
              : remoteState.answering > 1
                ? `${remoteState.answering} machines`
                : null,
        tooltip: remoteGlyphTooltip(remoteState),
        toneClass: remoteGlyphToneClass(remoteState),
        onSelect: openRemote,
      }
    : null
  const sessionsTone: Tone = sessionsAttentionTone(sessions as SessionItem[])
  const badge: AccountBadge | null =
    remoteState.requestCount > 0
      ? {
          count: remoteState.requestCount,
          tone: 'warn',
          label: remoteState.requestCount === 1 ? '1 pair request' : `${remoteState.requestCount} pair requests`,
        }
      : sessions.length > 0
        ? {
            count: sessions.length,
            tone: sessionsTone,
            label: sessions.length === 1 ? '1 session running' : `${sessions.length} sessions running`,
          }
        : null

  return { presence, remoteOpen, setRemoteOpen, sessionsRow, remoteRow, badge }
}

export function AccountSurfaces({
  sessionsOpen,
  onCloseSessions,
  sessions,
  workspaceOrder,
  onOpenSession,
  onPauseSession,
  onStopSession,
  onStopSessionGroup,
  remoteOpen,
  onCloseRemote,
  presence,
}: {
  sessionsOpen: boolean
  onCloseSessions: () => void
  sessions: SessionItem[]
  workspaceOrder: Map<string, number>
  onOpenSession: (item: SessionItem) => void | Promise<void>
  onPauseSession: (item: SessionItem) => void
  onStopSession: (item: SessionItem) => void
  onStopSessionGroup: (group: SessionGroup, items: SessionItem[]) => void | Promise<void>
  remoteOpen: boolean
  onCloseRemote: () => void
  presence: ReturnType<typeof useTailnetPresence>
}) {
  const openRemoteSettings = useOpenRemoteSettings()
  const environments = useEnvironments()
  const anchor = sessionsOpen || remoteOpen ? avatarAnchor() : null
  return (
    <>
      {sessionsOpen && anchor ? (
        <PointerPopover {...anchor} ariaLabel="Sessions" popupRole="dialog" onClose={onCloseSessions}>
          <SessionsPopover
            items={sessions}
            workspaceOrder={workspaceOrder}
            onOpen={onOpenSession}
            onPause={onPauseSession}
            onStop={onStopSession}
            onStopGroup={onStopSessionGroup}
          />
        </PointerPopover>
      ) : null}
      {remoteOpen && anchor ? (
        // Rows carry their own buttons (Revoke, Review): a dialog, not a menu.
        <PointerPopover {...anchor} ariaLabel="Remote" popupRole="dialog" onClose={onCloseRemote}>
          <React.Suspense fallback={null}>
            <RemotePopover
              presence={presence}
              environments={environments}
              onOpenRemoteSettings={() => {
                onCloseRemote()
                openRemoteSettings()
              }}
            />
          </React.Suspense>
        </PointerPopover>
      ) : null}
    </>
  )
}
