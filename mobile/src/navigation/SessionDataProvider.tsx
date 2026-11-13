import * as Haptics from 'expo-haptics'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppState, type AppStateStatus } from 'react-native'

import {
  readDesktopSnapshot,
  updateDesktopBacklogItem,
  watchDesktopBacklog,
  type DesktopSnapshot,
} from '../api/desktopReads'
import type { ApiResult, DesktopSessionStatus, MobileSession } from '../api/types'
import type { BacklogCommandCapabilities, BacklogUpdateInput } from '../features/backlog/BacklogScreen'
import { summarizeSnapshotForFleet, type FleetRowState } from '../features/fleet/fleetLogic'
import {
  buildProjectList,
  resolveCurrentProject,
  toggleStarredProjectKey,
  type ProjectSummary,
} from '../features/projects/projectContext'
import { useToast, type ToastApi } from '../components/Toast'
import { shouldShowSignedInNavigation } from './sessionFlow'

export type SnapshotState = 'idle' | 'loading' | 'ready' | 'error'

interface SessionDataValue {
  /** The active desktop with its live status folded in. */
  session: MobileSession | null
  sessions: MobileSession[]
  /**
   * Every session a chat can be on: the paired desktops, and the machines
   * they relay this phone to (never stored; `relayedMachines.ts`).
   */
  chatSessions: MobileSession[]
  activeDeviceId: string | null

  /** Every project in the snapshot, joined across the wire's workspace collections. */
  projects: ProjectSummary[]
  /** The one project the whole app is in. Null only when the desktop reports none. */
  currentProject: ProjectSummary | null
  selectProject: (key: string) => void
  starredProjectKeys: string[]
  toggleProjectStar: (key: string) => void

  snapshot: DesktopSnapshot | null
  snapshotState: SnapshotState
  snapshotError: string | null
  /** True only while a pull-to-refresh is in flight, so the spinner never self-starts. */
  isRefreshing: boolean
  refreshSnapshot: () => void
  /** Epoch ms of the last successful read, for the "updated Xm ago" indicator. */
  lastUpdatedAt: number | null
  /**
   * Keep the snapshot read while the caller is mounted; returns the release.
   * Nothing on the chat list draws from the snapshot, so it is read, and
   * polled, only while a screen that does is open (`useSnapshot`).
   */
  watchSnapshot: () => () => void

  fleetRowStates: Record<string, FleetRowState>
  isFleetRefreshing: boolean
  refreshFleet: () => void

  backlogCapabilities: BacklogCommandCapabilities

  /** Null unless the paired desktop advertises the capability, so the control hides rather than lying. */
  sendBacklogUpdate: ((input: BacklogUpdateInput) => Promise<void>) | null

  selectSession: (deviceId: string) => void
  removeSession: (deviceId: string) => void
  /**
   * Rename a paired desktop on this phone.
   *
   * Local only. A tailnet pairing carries an endpoint and nothing else, so the
   * phone's default name is "Desktop on <address>" — a placeholder, not a name
   * (`createMobileSessionFromTailnetPairing`). The desktop's own hostname is
   * not on the wire and `tailnet.status` is local-socket only, so the honest
   * fix is to let the person name it. Nothing is sent anywhere.
   */
  renameSession: (deviceId: string, name: string) => void
  connectSession: (session: MobileSession) => void
  markCurrentDeviceRevoked: () => void
  /** Record that a paired desktop revoked this phone, whichever desktop is active. */
  markDeviceRevoked: (deviceId: string) => void
  disconnect: () => void
}

// Exported for the screenshot harness (src/__verify__), which feeds fixture data
// to the real navigators. Nothing in the app reads it directly.
export const SessionDataContext = createContext<SessionDataValue | null>(null)
export type { SessionDataValue }

export interface SessionDataProviderProps {
  session: MobileSession | null
  sessions: MobileSession[]
  /** The machines the paired desktops relay this phone to. */
  relayed?: MobileSession[]
  activeDeviceId: string | null
  /** The project the user last chose, from storage. Null on a cold start. */
  selectedProjectKey: string | null
  starredProjectKeys: string[]
  onSelectProject: (key: string) => void | Promise<void>
  onStarredProjectKeysChange: (keys: string[]) => void | Promise<void>
  onSelectSession: (deviceId: string) => void | Promise<void>
  onRemoveSession: (deviceId: string) => void | Promise<void>
  onRenameSession: (deviceId: string, name: string) => void | Promise<void>
  onSessionConnected: (session: MobileSession) => void | Promise<void>
  onSessionRevoked: (session: MobileSession) => void | Promise<void>
  onDisconnect: () => void
  children: ReactNode
}

/**
 * Everything the tabs read from the desktop. Extracted from the old
 * `AppNavigator`, which mixed this data layer with the drawer chrome; the
 * behavior of the snapshot load, the capability gate, and the command senders is
 * carried over unchanged apart from the haptic on each command's outcome.
 */
export function SessionDataProvider({
  session,
  sessions,
  relayed,
  activeDeviceId,
  selectedProjectKey,
  starredProjectKeys,
  onSelectProject,
  onStarredProjectKeysChange,
  onSelectSession,
  onRemoveSession,
  onRenameSession,
  onSessionConnected,
  onSessionRevoked,
  onDisconnect,
  children,
}: SessionDataProviderProps) {
  const toast = useToast()
  const [sessionStatusOverride, setSessionStatusOverride] = useState<DesktopSessionStatus | null>(null)
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null)
  const [snapshotState, setSnapshotState] = useState<SnapshotState>('idle')
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null)
  const [fleetRowStates, setFleetRowStates] = useState<Record<string, FleetRowState>>({})
  const [isFleetRefreshing, setIsFleetRefreshing] = useState(false)
  // Session-only, never persisted — see `resolveCurrentProject`.
  const [fallenBackProjectKey, setFallenBackProjectKey] = useState<string | null>(null)
  // How many open screens draw from the snapshot. The read and the watch
  // below run only while one does.
  const [snapshotWatchers, setSnapshotWatchers] = useState(0)
  const snapshotWanted = snapshotWatchers > 0
  const watchSnapshot = useCallback(() => {
    setSnapshotWatchers((count) => count + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      setSnapshotWatchers((count) => count - 1)
    }
  }, [])

  // The desktop a snapshot read must belong to. A read issued for desktop A can
  // resolve *after* the user has switched to B; without this identity check the
  // late result would write A's rows into B's state (and the next command would
  // send A's paths to B). Every `applySnapshotResult` call passes the deviceId it
  // was issued for and is dropped if it no longer matches this ref.
  const activeDeviceIdRef = useRef<string | null>(session?.deviceId ?? null)

  const effectiveSession = useMemo(
    () =>
      session
        ? {
            ...session,
            lastSeenAt: session.lastSeenAt ?? session.pairedAt,
            status: sessionStatusOverride ?? session.status ?? 'online',
          }
        : null,
    [session, sessionStatusOverride],
  )

  // Switching desktops drops the outgoing desktop's rows before the incoming
  // desktop's read lands. Keeping them would draw desktop A's items under desktop
  // B's name — and worse, send A's paths and `expectedSnapshotVersion` to B on
  // the first command.
  useEffect(() => {
    activeDeviceIdRef.current = session?.deviceId ?? null
    setSessionStatusOverride(null)
    setSnapshot(null)
    setSnapshotState('idle')
    setSnapshotError(null)
    // A refresh in flight for the outgoing desktop is about to be dropped by the
    // identity guard, so clear the spinner here or it would spin forever.
    setIsRefreshing(false)
    // A fallback is a fact about the *outgoing* desktop's snapshot. Carrying it
    // into the new desktop would let a project the user never picked there outrank
    // the one they did.
    setFallenBackProjectKey(null)
  }, [session?.deviceId])

  /**
   * A failed read is a failed *read*, not a desktop with nothing on it. The last
   * good snapshot stays on screen under an error banner, because pull-to-refresh
   * is the only refresh affordance and blanking the list would strand the user
   * with an empty panel and no way back to the rows they were reading.
   */
  const applySnapshotResult = useCallback((result: ApiResult<DesktopSnapshot>, issuingDeviceId: string | null) => {
    // Drop a read that belongs to a desktop the user has already left.
    if (issuingDeviceId !== activeDeviceIdRef.current) {
      return
    }
    if (result.ok && result.data) {
      setLastUpdatedAt(Date.now())
      setSnapshotState('ready')
      setSnapshotError(null)
      setSnapshot(result.data)
      return
    }
    setSnapshotState('error')
    setSnapshotError(result.message ?? 'The desktop did not answer.')
  }, [])

  useEffect(() => {
    let isMounted = true

    const loadSnapshot = async () => {
      if (!effectiveSession || !shouldShowSignedInNavigation(effectiveSession)) {
        setSnapshot(null)
        setSnapshotState('idle')
        setSnapshotError(null)
        return
      }
      // Read when a screen that draws it opens; what was read last stays.
      if (!snapshotWanted) return

      setSnapshotState('loading')
      setSnapshotError(null)

      const issuingDeviceId = effectiveSession.deviceId
      const result = await readDesktopSnapshot(effectiveSession)
      if (isMounted) {
        applySnapshotResult(result, issuingDeviceId)
      }
    }

    void loadSnapshot()

    return () => {
      isMounted = false
    }
    // The client factory is keyed by the endpoint and token below; the session object
    // itself is rebuilt on every status change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    effectiveSession?.deviceId,
    effectiveSession?.baseUrl,
    effectiveSession?.deviceToken,
    effectiveSession?.status,
    applySnapshotResult,
    snapshotWanted,
  ])

  /** Pull-to-refresh: owns the spinner, never blanks the list while it reads. */
  const refreshSnapshot = useCallback(() => {
    if (!effectiveSession || !shouldShowSignedInNavigation(effectiveSession)) {
      setSnapshot(null)
      setSnapshotState('idle')
      return
    }

    const issuingDeviceId = effectiveSession.deviceId
    setIsRefreshing(true)
    void readDesktopSnapshot(effectiveSession).then((result) => {
      applySnapshotResult(result, issuingDeviceId)
      // Only the read that still owns the active desktop may clear the spinner;
      // a stale read landing after a switch must not touch the new desktop's state.
      if (issuingDeviceId === activeDeviceIdRef.current) {
        setIsRefreshing(false)
      }
    })
  }, [applySnapshotResult, effectiveSession])

  /** Re-read after a command lands, without the pull-to-refresh spinner. */
  const reloadAfterCommand = useCallback(
    (activeSession: MobileSession) => {
      void readDesktopSnapshot(activeSession).then((result) => applySnapshotResult(result, activeSession.deviceId))
    },
    [applySnapshotResult],
  )

  // Foreground freshness: while a screen draws from the snapshot, the desktop
  // says when a backlog moves (`backlog.changed`) and the phone reads it again.
  // A backgrounded phone's socket drops, so coming back to the foreground reads
  // once more for what moved while it was away.
  useEffect(() => {
    if (!effectiveSession || !shouldShowSignedInNavigation(effectiveSession) || !snapshotWanted) {
      return
    }
    const stopWatching = watchDesktopBacklog(effectiveSession, () => reloadAfterCommand(effectiveSession))
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') reloadAfterCommand(effectiveSession)
    })
    return () => {
      stopWatching()
      subscription.remove()
    }
  }, [effectiveSession, reloadAfterCommand, snapshotWanted])

  const refreshFleet = useCallback(() => {
    const online = sessions.filter((candidate) => (candidate.status ?? 'online') === 'online')

    if (online.length === 0) {
      setFleetRowStates({})
      return
    }

    setIsFleetRefreshing(true)
    setFleetRowStates((current) => {
      const next: Record<string, FleetRowState> = { ...current }
      for (const candidate of online) {
        next[candidate.deviceId] = { kind: 'loading' }
      }
      return next
    })

    void Promise.all(
      online.map(async (candidate) => {
        const result = await readDesktopSnapshot(candidate)
        setFleetRowStates((current) => ({
          ...current,
          [candidate.deviceId]:
            result.ok && result.data
              ? { kind: 'ready', summary: summarizeSnapshotForFleet(result.data) }
              : { kind: 'error', message: result.message ?? 'The desktop did not answer.' },
        }))
      }),
    ).then(() => setIsFleetRefreshing(false))
  }, [sessions])

  // The app's current project. `projects` is the join of the wire's two
  // unreconciled workspace collections; `currentProject` is the user's stored
  // pick resolved against it, falling back when that project is not in this
  // snapshot — which is exactly what happens when the phone switches desktops, so
  // it is a normal path, not an error one.
  const projects = useMemo(() => buildProjectList(snapshot), [snapshot])
  const currentProject = useMemo(
    () => resolveCurrentProject(projects, selectedProjectKey, fallenBackProjectKey),
    [projects, selectedProjectKey, fallenBackProjectKey],
  )

  // Remember a fallback the moment we take one, so it survives the next poll.
  //
  // Without this, a stored project that drops out of the snapshot and later
  // returns would silently pull the user out of the project they have been
  // working in — mid-session, with no action of theirs, changing the header and
  // the Backlog list at once. The fallback is deliberately *not* persisted: the
  // user's real choice stays on disk, so a relaunch (or the other paired desktop)
  // still restores what they picked.
  useEffect(() => {
    if (currentProject && currentProject.key !== selectedProjectKey && currentProject.key !== fallenBackProjectKey) {
      setFallenBackProjectKey(currentProject.key)
    }
  }, [currentProject, fallenBackProjectKey, selectedProjectKey])

  const selectProject = useCallback(
    (key: string) => {
      // An explicit pick outranks — and retires — any fallback we had taken.
      setFallenBackProjectKey(null)
      void onSelectProject(key)
    },
    [onSelectProject],
  )

  const toggleProjectStar = useCallback(
    (key: string) => {
      void onStarredProjectKeysChange(toggleStarredProjectKey(starredProjectKeys, key))
    },
    [onStarredProjectKeysChange, starredProjectKeys],
  )

  // What this pairing may change there is the desktop's answer, read with the
  // snapshot: it serves the method, and the grant it holds now allows it.
  const canUpdateBacklog = snapshot?.canUpdateBacklog === true

  const sendBacklogUpdate = useCallback(
    async (input: BacklogUpdateInput) => {
      const activeSession = effectiveSession
      if (!activeSession) throw new Error('Reconnect to a desktop session before submitting commands.')
      if (!canUpdateBacklog) throw new Error(REPAIR_REQUIRED_MESSAGE)

      await withCommandHaptics(
        { toast, label: 'Backlog update', successMessage: 'Backlog item updated on desktop.' },
        async () => {
          const result = await updateDesktopBacklogItem(activeSession, {
            // The rows carry the project's token; the desktop names the project by it, prefixed.
            workspaceId: `backlog:${input.workspacePath}`,
            relativePath: input.relativePath,
            // Every axis is optional, and an omitted one means "leave it alone":
            // only the axis the user touched is sent.
            ...(input.status ? { status: input.status } : {}),
            ...(input.type ? { type: input.type } : {}),
            ...(input.difficulty ? { difficulty: input.difficulty } : {}),
            ...(input.criticality ? { criticality: input.criticality } : {}),
          })
          if (!result.ok) {
            throw new Error(
              formatCommandError(result.errorCode, result.message, 'Desktop rejected the backlog update.'),
            )
          }
        },
      )

      reloadAfterCommand(activeSession)
    },
    [canUpdateBacklog, effectiveSession, reloadAfterCommand, toast],
  )

  const markCurrentDeviceRevoked = useCallback(() => {
    if (effectiveSession) {
      void onSessionRevoked({
        ...effectiveSession,
        status: 'revoked',
        revokedAt: new Date().toISOString(),
      })
    }
    setSessionStatusOverride('revoked')
  }, [effectiveSession, onSessionRevoked])

  const markDeviceRevoked = useCallback(
    (deviceId: string) => {
      if (effectiveSession?.deviceId === deviceId) {
        markCurrentDeviceRevoked()
        return
      }
      const target = sessions.find((candidate) => candidate.deviceId === deviceId)
      if (target && target.status !== 'revoked') {
        void onSessionRevoked({ ...target, status: 'revoked', revokedAt: new Date().toISOString() })
      }
    },
    [effectiveSession, markCurrentDeviceRevoked, onSessionRevoked, sessions],
  )

  const connectSession = useCallback(
    (nextSession: MobileSession) => {
      setSessionStatusOverride(null)
      void onSessionConnected({
        ...nextSession,
        lastSeenAt: nextSession.lastSeenAt ?? new Date().toISOString(),
        status: 'online',
      })
    },
    [onSessionConnected],
  )

  const value = useMemo<SessionDataValue>(() => {
    const backlogCapabilities: BacklogCommandCapabilities = { canUpdate: canUpdateBacklog }

    return {
      session: effectiveSession,
      sessions,
      chatSessions: relayed?.length ? [...sessions, ...relayed] : sessions,
      activeDeviceId,
      projects,
      currentProject,
      selectProject,
      starredProjectKeys,
      toggleProjectStar,
      snapshot,
      snapshotState,
      snapshotError,
      isRefreshing,
      refreshSnapshot,
      lastUpdatedAt,
      watchSnapshot,
      fleetRowStates,
      isFleetRefreshing,
      refreshFleet,
      backlogCapabilities,
      sendBacklogUpdate: backlogCapabilities.canUpdate ? sendBacklogUpdate : null,
      selectSession: (deviceId) => void onSelectSession(deviceId),
      removeSession: (deviceId) => void onRemoveSession(deviceId),
      renameSession: (deviceId, name) => void onRenameSession(deviceId, name),
      connectSession,
      markCurrentDeviceRevoked,
      markDeviceRevoked,
      disconnect: onDisconnect,
    }
  }, [
    activeDeviceId,
    connectSession,
    currentProject,
    onDisconnect,
    effectiveSession,
    fleetRowStates,
    isFleetRefreshing,
    isRefreshing,
    lastUpdatedAt,
    markCurrentDeviceRevoked,
    markDeviceRevoked,
    onRemoveSession,
    onRenameSession,
    onSelectSession,
    projects,
    refreshFleet,
    refreshSnapshot,
    selectProject,
    canUpdateBacklog,
    sendBacklogUpdate,
    sessions,
    relayed,
    snapshot,
    snapshotError,
    snapshotState,
    starredProjectKeys,
    toggleProjectStar,
    watchSnapshot,
  ])

  return <SessionDataContext.Provider value={value}>{children}</SessionDataContext.Provider>
}

/**
 * The session data, with the desktop snapshot kept read and polled for as
 * long as the calling screen is mounted. For the screens that draw from it:
 * Settings' web count, the web targets, a desktop's revoke button, the
 * backlog.
 */
export function useSnapshot(): SessionDataValue {
  const value = useSessionData()
  const { watchSnapshot } = value
  useEffect(() => watchSnapshot(), [watchSnapshot])
  return value
}

/** Holds the snapshot read while mounted, for a screen drawn from a render callback. */
export function SnapshotWatch(): null {
  useSnapshot()
  return null
}

export function useSessionData(): SessionDataValue {
  const value = useContext(SessionDataContext)
  if (!value) {
    throw new Error('useSessionData must be called inside a SessionDataProvider.')
  }
  return value
}

/**
 * A command either landed on the desktop or it did not, and the phone is often in
 * a pocket or a hand that is not watching. The haptic says which; the on-screen
 * message still says why. Haptics are unsupported on web, so a rejected promise
 * there must not surface as an unhandled rejection.
 */
async function withCommandHaptics<T>(feedback: CommandFeedback, run: () => Promise<T>): Promise<T> {
  try {
    const result = await run()
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
    feedback.toast.show(feedback.successMessage, 'success')
    return result
  } catch (error) {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined)
    feedback.toast.show(error instanceof Error ? error.message : `${feedback.label} failed.`, 'error')
    throw error
  }
}

interface CommandFeedback {
  toast: ToastApi
  label: string
  successMessage: string
}

// Shown when this device's grant does not reach an action the desktop offers. The
// grant widens on the desktop (Settings) or by pairing again, so the copy points
// there instead of surfacing the desktop's raw scope refusal.
const REPAIR_REQUIRED_MESSAGE = "This device isn't paired for that action. Re-pair it with your desktop to enable it."

function formatCommandError(code: string | undefined, message: string | undefined, fallback: string): string {
  // `unauthorized` means the device's grant does not cover this change. The
  // desktop's own message names the missing scope — jargon to the user — so
  // replace it with the re-pair guidance regardless of what it said.
  if (code === 'unauthorized') {
    return REPAIR_REQUIRED_MESSAGE
  }
  const trimmedMessage = message?.trim()
  if (trimmedMessage && code) {
    return `${trimmedMessage} (${code})`
  }
  if (trimmedMessage) {
    return trimmedMessage
  }
  if (code) {
    return `${fallback} Code: ${code}.`
  }
  return fallback
}
