import { useCallback, useEffect, useRef, useState } from 'react'

import { tailnetScopesOfGrant } from '../../../studio/environmentDiscovery'
import { environmentStudioAvailable, pairedConnectionOf } from '../../../studio/environmentStudio'
import {
  environmentResting,
  followedEnvironmentChats,
  followedEnvironmentTargets,
  onFollowedEnvironmentChats,
  type EnvironmentChatsSnapshot,
} from '../../../studio/environmentChats'
import { useTailnetPresence, type TailnetPresence } from '../topbar/useTailnetPresence'
import { publishRemoteConversationList } from './remoteConversationFacts'
import {
  chatManageOf,
  remoteLinkStateOf,
  type EnvironmentChatSourceView,
  type RemoteBrowseEntry,
  type RemoteLinkState,
} from './remoteSessionsModel'

// Every followed environment's rows behind the sidebar (design-environments
// PR 3), as the window's chat source of each reads them
// (`environmentChats.ts`): what it holds and its chats, kept fresh there by
// its pushes, its reconnects, a slow clock and focus, and kept as a
// last-known list when a read fails or the environment rests. This hook only
// shapes them as the rows read them, and hands a paired desktop's chats'
// list to the tabs of panes open on them (`remoteConversationFacts.ts`).

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

/** One environment's rows, as the sidebar reads them. */
function browseEntryOf(snapshot: EnvironmentChatsSnapshot): RemoteBrowseEntry {
  const { rows } = snapshot
  const { browse, chatRecord } = rows
  return {
    browse: browse
      ? {
          connectionId: snapshot.route,
          reachable: browse.reachable,
          unreachableReason: browse.unreachableReason,
          unauthorized: browse.unauthorized,
          scopes: tailnetScopesOfGrant(browse.grantScopes),
          workspaces: browse.workspaces,
          gaps: browse.gaps,
          ...(browse.chatRecord ? { chatRecord: browse.chatRecord } : {}),
        }
      : null,
    loading: rows.loading,
    error: rows.error,
    at: rows.at,
    ...(rows.conversations ? { conversations: rows.conversations } : {}),
    ...(chatRecord ? { lifecycle: chatRecord.lifecycle, manage: chatManageOf(chatRecord) } : {}),
    ...(rows.access !== undefined ? { access: rows.access } : {}),
    ...(rows.listedAt !== undefined ? { listedAt: rows.listedAt } : {}),
    ...(rows.listFailure !== undefined ? { listFailure: rows.listFailure } : {}),
  }
}

export function useRemoteSessions(): RemoteSessions {
  const presence = useTailnetPresence()
  const link = remoteLinkStateOf(presence.status)
  const [sources, setSources] = useState<readonly EnvironmentChatSourceView[]>([])
  // Each environment's view for the snapshot it was made of, so a read that
  // moved nothing hands the rows the same view, and the tabs the same list.
  const made = useRef(new WeakMap<EnvironmentChatsSnapshot, EnvironmentChatSourceView>())

  useEffect(() => {
    // A host without the bridge (partial test harnesses, narrower preloads)
    // draws nothing of other environments and asks nothing.
    if (!environmentStudioAvailable()) return
    const sync = () => {
      const targets = followedEnvironmentTargets()
      const next = followedEnvironmentChats().map((source, index) => {
        const snapshot = source.snapshot()
        const live = !environmentResting(source.route)
        let view = made.current.get(snapshot)
        if (!view || view.live !== live) {
          const connectionId = pairedConnectionOf(source.route)
          view = {
            route: source.route,
            machineName: targets[index]?.name ?? source.route,
            environmentId: snapshot.environmentId,
            connectionId,
            live,
            entry: browseEntryOf(snapshot),
          }
          made.current.set(snapshot, view)
          if (connectionId && snapshot.rows.conversations)
            publishRemoteConversationList(connectionId, snapshot.rows.conversations)
        }
        return view
      })
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
