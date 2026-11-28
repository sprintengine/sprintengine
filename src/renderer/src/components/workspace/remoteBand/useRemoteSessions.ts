import { useCallback, useEffect, useState } from 'react'

import { environmentStudioAvailable } from '../../../studio/environmentStudio'
import { followedEnvironmentChats, onFollowedEnvironmentChats } from '../../../studio/environmentChats'
import { useTailnetPresence, type TailnetPresence } from '../topbar/useTailnetPresence'
import { environmentChatSourceViews } from './environmentChatsNow'
import { remoteLinkStateOf, type EnvironmentChatSourceView, type RemoteLinkState } from './remoteSessionsModel'

// Every followed environment's rows behind the sidebar (design-environments
// PR 3), as the window's chat source of each reads them
// (`environmentChats.ts`): what it holds and its chats, kept fresh there by
// its pushes, its reconnects, a slow clock and focus, and kept as a
// last-known list when a read fails or the environment rests. This hook only
// re-reads them when a source moves (`environmentChatsNow.ts` shapes them).

export type RemoteSessions = {
  presence: TailnetPresence
  /** Each followed environment's rows, in the order the window follows them. */
  sources: readonly EnvironmentChatSourceView[]
  /**
   * Whether this device is on the tailnet at all — up, down, or not yet known.
   * A chat on a paired desktop is not openable, typable, or readable from a
   * device with no tailnet, so its row goes with the link and comes back with
   * it (owner, 2026-09-13).
   */
  link: RemoteLinkState
  /** Read one environment again now. */
  refresh: (route: string) => void
}

export function useRemoteSessions(): RemoteSessions {
  const presence = useTailnetPresence()
  const link = remoteLinkStateOf(presence.status)
  const [sources, setSources] = useState<readonly EnvironmentChatSourceView[]>([])

  useEffect(() => {
    // A host without the bridge (partial test harnesses, narrower preloads)
    // draws nothing of other environments and asks nothing.
    if (!environmentStudioAvailable()) return
    const sync = () => {
      const next = environmentChatSourceViews()
      setSources((current) =>
        current.length === next.length && next.every((view, index) => current[index] === view) ? current : next,
      )
    }
    sync()
    return onFollowedEnvironmentChats(sync)
  }, [])

  const refresh = useCallback((route: string) => {
    if (!environmentStudioAvailable()) return
    followedEnvironmentChats()
      .find((source) => source.route === route)
      ?.refresh()
  }, [])

  return { presence, sources, link, refresh }
}
