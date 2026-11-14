// What a chat on the Studio protocol says while the Studio that holds it is
// out of reach: the window's own, or, for a chat another environment holds
// (an SSH machine's, a WSL distribution's), that environment, as the
// environment list says it stands. The transcript stays drawn from what the
// window holds, and this row in the composer tray says, in words, that the
// connection is being made again and what becomes of a message sent
// meanwhile, so a quiet chat never reads as a stuck one. A short blip says
// nothing: the row waits a moment before it appears.

import React, { useEffect, useState, useSyncExternalStore } from 'react'

import { Spinner } from '../../ui'
import { watchWindowStudio, windowStudioState, type WindowStudioState } from '../../../studio/windowStudioClient'
import { environmentReachWords, useEnvironmentAway, useEnvironmentReach } from '../../../hooks/useEnvironmentReach'
import { ComposerTrayRow } from './composerTray'

/** How long a dropped connection goes unmentioned, so a blip does not flicker a row. */
export const STUDIO_RECONNECT_GRACE_MS = 1_500

const noWatch = () => () => undefined

/** The window's connection to Studio, or null for a page that reaches no Studio (a test's bare api). */
export function useWindowStudioConnection(): WindowStudioState | null {
  const api =
    typeof window !== 'undefined' && typeof window.api?.studioWindowTicket === 'function'
      ? (window.api as object)
      : null
  return useSyncExternalStore(
    api ? (listener) => watchWindowStudio(api, listener) : noWatch,
    () => (api ? windowStudioState(api) : null),
    () => null,
  )
}

/** The words a state is told in, or null when there is nothing to say. */
export function studioConnectionWords(state: WindowStudioState | null): string | null {
  switch (state) {
    case 'reconnecting':
      return 'Reconnecting to Studio… The chat picks up where it left off.'
    // Neither tries again by itself: the window's next use of the chat does.
    case 'parked':
      return 'This window lost its connection to Studio. It tries again the next time you use the chat.'
    case 'unavailable':
      return 'This window could not reach Studio. It tries again the next time you use the chat.'
    default:
      return null
  }
}

export const StudioConnectionNotice = React.memo(function StudioConnectionNotice({
  graceMs = STUDIO_RECONNECT_GRACE_MS,
  environment = null,
}: {
  graceMs?: number
  /**
   * The environment the chat runs in, where it is not the window's own Studio
   * (`ChatEnvironment`): its route, and what it is called.
   */
  environment?: { route: string | null; label: string | null } | null
}) {
  const state = useWindowStudioConnection()
  const route = environment?.route ?? null
  const label = environment?.label ?? null
  const reach = useEnvironmentReach(route, label)
  const away = useEnvironmentAway(route, label)
  const words = route ? environmentReachWords(reach, away, label ?? route) : studioConnectionWords(state)
  const reconnecting = route
    ? reach === null || reach.kind === 'up' || reach.kind === 'connecting'
    : state === 'reconnecting'
  const down = words !== null
  // Whether the connection has been down for longer than a blip.
  const [lasting, setLasting] = useState(false)
  useEffect(() => {
    if (!down) {
      setLasting(false)
      return
    }
    const timer = window.setTimeout(() => setLasting(true), graceMs)
    return () => window.clearTimeout(timer)
  }, [down, graceMs])
  if (!words || !lasting) return null
  return (
    <ComposerTrayRow tone="warn" glyph={reconnecting ? <Spinner /> : undefined}>
      {words}
    </ComposerTrayRow>
  )
})
