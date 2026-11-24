import React from 'react'

import { PointerPopover } from '../ui'
import type { Tone } from '../ui/tokens'
import { sessionCounts, sessionsAttentionTone } from './workspaceManagerHelpers'
import { remoteGlyphState, remoteGlyphToneClass, remoteGlyphTooltip, useOpenRemoteSettings } from './topbar/remoteGlyph'
import { SessionsPopover, type SessionGroup, type SessionItem } from './topbar/SessionsPopover'
import { useTailnetPresence } from './topbar/useTailnetPresence'
import { useEnvironments } from '../../hooks/useEnvironments'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { ProcessesPopover } from './topbar/ProcessesPopover'
import type { KnownChat } from './topbar/processesModel'
import { processesRowCounts, useProcesses } from './topbar/useProcesses'
import type { AccountMenuRow, AccountBadge } from './SidebarAccountBar'
import { copy } from '../../../../shared/copy'

// Remote, Sessions and Processes, behind the avatar (owner ruling 2026-11-07).
// Processes is what agents started on this machine and left running, and the
// built-in browser's tabs, beside Sessions, the agents themselves. The account
// menu closes as a row is pressed, so what the row opens cannot hang off the
// row: it opens at the avatar, from here, and stays up on its own. The avatar
// wears what the two glyphs used to wear in the top row, or it would go quiet
// inside a menu: a pair request waiting, which asks for a person, else how many
// sessions are running or failed, its tone saying which.
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
  const [processesOpen, setProcessesOpen] = React.useState(false)
  const processes = useProcesses(processesOpen)
  // An OS notification about a pair request or a machine's answer was clicked
  // (pair-from-the-scan-and-stay-paired, phase 3): main brought the window
  // forward; this opens the surface the banner pointed at.
  React.useEffect(() => {
    if (typeof window.api.onRemoteOpenRequested !== 'function') return
    return window.api.onRemoteOpenRequested(() => {
      setSessionsOpen(false)
      setNotificationsOpen(false)
      setProcessesOpen(false)
      setRemoteOpen(true)
    })
  }, [setNotificationsOpen, setSessionsOpen])

  const openSessions = React.useCallback(() => {
    setRemoteOpen(false)
    setProcessesOpen(false)
    setNotificationsOpen(false)
    setSessionsOpen(true)
  }, [setNotificationsOpen, setSessionsOpen])
  const openRemote = React.useCallback(() => {
    setSessionsOpen(false)
    setProcessesOpen(false)
    setNotificationsOpen(false)
    setRemoteOpen(true)
  }, [setNotificationsOpen, setSessionsOpen])
  const openProcesses = React.useCallback(() => {
    setSessionsOpen(false)
    setRemoteOpen(false)
    setNotificationsOpen(false)
    setProcessesOpen(true)
  }, [setNotificationsOpen, setSessionsOpen])

  // Counted apart: a failed session wants looking at, but it is not running.
  const sessionCount = sessionCounts(sessions)
  const sessionsListed = sessionCount.running + sessionCount.failed
  const sessionsRow: AccountMenuRow | null = sessionsOffered
    ? {
        meta:
          sessionsListed > 0
            ? copy.workspace.accountSurfaces.sessionsMeta(sessionCount.running, sessionCount.failed)
            : null,
        onSelect: openSessions,
      }
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
  // Offered where the window's Studio serves either list, whichever machine it
  // is. The count leads with what was left behind, then with what is playing
  // sound, the two things nobody can see from anywhere else.
  const counts = processesRowCounts(processes.view)
  const processesRow: AccountMenuRow | null = processes.view.offered
    ? {
        meta:
          counts.leftBehind > 0
            ? copy.workspace.accountSurfaces.leftBehind(counts.leftBehind)
            : counts.playing > 0
              ? copy.workspace.accountSurfaces.playingSound(counts.playing)
              : counts.total > 0
                ? String(counts.total)
                : null,
        onSelect: openProcesses,
      }
    : null
  const sessionsTone: Tone = sessionsAttentionTone(sessions as SessionItem[])
  const badge: AccountBadge | null =
    remoteState.requestCount > 0
      ? {
          count: remoteState.requestCount,
          tone: 'warn',
          label:
            remoteState.requestCount === 1
              ? copy.workspace.accountSurfaces.n1PairRequest
              : copy.workspace.accountSurfaces.pairRequests(remoteState.requestCount),
        }
      : sessionsListed > 0
        ? {
            count: sessionsListed,
            tone: sessionsTone,
            label: copy.workspace.accountSurfaces.sessionsBadge(sessionCount.running, sessionCount.failed),
          }
        : null

  return {
    presence,
    remoteOpen,
    setRemoteOpen,
    processesOpen,
    setProcessesOpen,
    processes,
    sessionsRow,
    remoteRow,
    processesRow,
    badge,
  }
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
  processesOpen = false,
  onCloseProcesses = () => {},
  processes,
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
  processesOpen?: boolean
  onCloseProcesses?: () => void
  processes?: ReturnType<typeof useProcesses>
}) {
  const openRemoteSettings = useOpenRemoteSettings()
  const environments = useEnvironments()
  const workspaces = useWorkspaceStore((state) => state.workspaces)
  const chats = React.useMemo(
    () => new Map<string, KnownChat>(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces],
  )
  const anchor = sessionsOpen || remoteOpen || processesOpen ? avatarAnchor() : null
  return (
    <>
      {sessionsOpen && anchor ? (
        <PointerPopover
          {...anchor}
          ariaLabel={copy.workspace.accountSurfaces.sessions}
          popupRole="dialog"
          onClose={onCloseSessions}
        >
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
      {processesOpen && processes && anchor ? (
        // Rows carry their own Stop and Close buttons: a dialog, not a menu.
        <PointerPopover
          {...anchor}
          ariaLabel={copy.workspace.accountSurfaces.processes}
          popupRole="dialog"
          onClose={onCloseProcesses}
        >
          <ProcessesPopover
            view={processes.view}
            chats={chats}
            onStop={processes.stop}
            onCloseTab={processes.closeTab}
          />
        </PointerPopover>
      ) : null}
      {remoteOpen && anchor ? (
        // Rows carry their own buttons (Revoke, Review): a dialog, not a menu.
        <PointerPopover
          {...anchor}
          ariaLabel={copy.workspace.accountSurfaces.remote}
          popupRole="dialog"
          onClose={onCloseRemote}
        >
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
