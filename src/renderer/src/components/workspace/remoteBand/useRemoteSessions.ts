import { useCallback, useEffect, useRef, useState } from 'react'

import type { MeshConnection } from '../../../../../shared/tailnet-mesh'
import { tailnetScopesOfGrant } from '../../../studio/environmentDiscovery'
import { environmentStudioAvailable, pairedTarget } from '../../../studio/environmentStudio'
import {
  environmentChatSourceFor,
  onFollowedEnvironmentChats,
  type EnvironmentRows,
} from '../../../studio/environmentChats'
import { useTailnetPresence, type TailnetPresence } from '../topbar/useTailnetPresence'
import { publishRemoteConversationList } from './remoteConversationFacts'
import { chatManageOf, remoteLinkStateOf, type RemoteBrowseEntry, type RemoteLinkState } from './remoteSessionsModel'

// The paired machines' rows behind the sidebar's Remote band, as the window's
// chat source of each machine reads them (`environmentChats.ts`): what it
// holds and its chats, kept fresh there by its pushes, its reconnects, a slow
// clock and focus, and kept as a last-known list when a read fails. This hook
// only shapes them by pairing, as the band draws them, and hands the chats'
// list to the tabs of panes open on them (`remoteConversationFacts.ts`).

export type RemoteSessions = {
  presence: TailnetPresence
  browses: ReadonlyMap<string, RemoteBrowseEntry>
  /**
   * Whether this device is on the tailnet at all — up, down, or not yet known.
   * What the rows that are WINDOWS here are gated on: a chat on another machine
   * is not openable, typable, or readable from a device with no tailnet, so its
   * row goes with the link and comes back with it (owner, 2026-09-13).
   */
  link: RemoteLinkState
  /** Read one machine again now. */
  refresh: (connectionId: string) => void
}

/** One machine's rows, as the band reads them. */
function browseEntryOf(connection: MeshConnection, rows: EnvironmentRows): RemoteBrowseEntry {
  const { browse, chatRecord } = rows
  return {
    browse: browse
      ? {
          connectionId: connection.id,
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
  const { mesh } = presence
  const [browses, setBrowses] = useState<ReadonlyMap<string, RemoteBrowseEntry>>(() => new Map())
  // Each machine's entry for the rows it was made of, so a read that moved
  // nothing hands the band the same entry, and the tabs the same list.
  const made = useRef(new WeakMap<EnvironmentRows, RemoteBrowseEntry>())

  useEffect(() => {
    // A host without the bridge (partial test harnesses, narrower preloads)
    // draws what the rows already know and asks nothing.
    if (!environmentStudioAvailable()) return
    const sync = () => {
      const next = new Map<string, RemoteBrowseEntry>()
      for (const connection of mesh) {
        // Followed for as long as it is paired, whoever else follows it.
        const rows = environmentChatSourceFor(pairedTarget(connection)).snapshot().rows
        let entry = made.current.get(rows)
        if (!entry) {
          entry = browseEntryOf(connection, rows)
          made.current.set(rows, entry)
          if (rows.conversations) publishRemoteConversationList(connection.id, rows.conversations)
        }
        next.set(connection.id, entry)
      }
      setBrowses((current) =>
        current.size === next.size && [...next].every(([id, entry]) => current.get(id) === entry) ? current : next,
      )
    }
    sync()
    return onFollowedEnvironmentChats(sync)
  }, [mesh])

  const refresh = useCallback(
    (connectionId: string) => {
      const connection = mesh.find((known) => known.id === connectionId)
      if (connection && environmentStudioAvailable()) environmentChatSourceFor(pairedTarget(connection)).refresh()
    },
    [mesh],
  )

  return { presence, browses, link, refresh }
}
