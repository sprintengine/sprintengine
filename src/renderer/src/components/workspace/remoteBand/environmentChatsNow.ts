import { formatEnvironmentRoute } from '../../../../../../packages/studio-protocol/src/environment'
import type { EnvironmentEntry } from '../../../../../shared/environments'
import type { Workspace } from '../../../../../shared/workspace'
import { currentEnvironments } from '../../../hooks/useEnvironments'
import { tailnetScopesOfGrant } from '../../../studio/environmentDiscovery'
import {
  environmentResting,
  followedEnvironmentChats,
  followedEnvironmentTargets,
  type EnvironmentChatsSnapshot,
} from '../../../studio/environmentChats'
import { environmentStudioAvailable, pairedConnectionOf } from '../../../studio/environmentStudio'
import { publishRemoteConversationList } from './remoteConversationFacts'
import {
  chatManageOf,
  chatRecordsByAddress,
  environmentChatRows,
  openSpecOfConversation,
  type EnvironmentChatSourceView,
  type RemoteBrowseEntry,
  type RemoteConversation,
  type RemoteSessionOpenSpec,
} from './remoteSessionsModel'

// Every followed environment's chats, as rows by address, read now from what
// each environment's source holds (`environmentChats.ts`), the environment
// list and this window's records (design-environments PR 3). The sidebar draws
// them; a chat link and the palette find a chat in the same rows, whether or
// not the sidebar is drawn.

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

// Each environment's view for the snapshot it was made of, so a read that
// moved nothing hands the rows the same view, and the tabs the same list.
const made = new WeakMap<EnvironmentChatsSnapshot, EnvironmentChatSourceView>()

/** Each followed environment's rows now, in the order the window follows them. */
export function environmentChatSourceViews(): EnvironmentChatSourceView[] {
  // A host without the bridge (partial test harnesses, narrower preloads)
  // follows no other environment.
  if (!environmentStudioAvailable()) return []
  const targets = followedEnvironmentTargets()
  return followedEnvironmentChats().map((source, index) => {
    const snapshot = source.snapshot()
    const live = !environmentResting(source.route)
    let view = made.get(snapshot)
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
      made.set(snapshot, view)
      // The tabs of panes open on a paired desktop's chats read its list.
      if (connectionId && snapshot.rows.conversations)
        publishRemoteConversationList(connectionId, snapshot.rows.conversations)
    }
    return view
  })
}

/**
 * The environment id a route's rows are keyed by: its own Studio's, once it
 * has said it, else the environment list's.
 */
export function environmentIdOfRoute(
  environments: readonly EnvironmentEntry[],
  sources: readonly Pick<EnvironmentChatSourceView, 'route' | 'environmentId'>[],
): (route: string) => string | null {
  const ids = new Map<string, string>()
  for (const entry of environments)
    if (entry.environmentId)
      for (const route of entry.routes) ids.set(formatEnvironmentRoute(route), entry.environmentId)
  for (const source of sources) if (source.environmentId) ids.set(source.route, source.environmentId)
  return (route: string) => ids.get(route) ?? null
}

/** Every followed environment's chats now, by address, each with the record here that opening it focuses. */
export function environmentChatsNow(
  workspaces: readonly Pick<Workspace, 'id' | 'environment' | 'remoteOrigin'>[],
): RemoteConversation[] {
  const sources = environmentChatSourceViews()
  const environments = currentEnvironments()
  const records = chatRecordsByAddress(workspaces, environmentIdOfRoute(environments, sources))
  return environmentChatRows({ sources, environments, records })
}

/** Another environment's chat a link can open. */
export type EnvironmentChatTarget = {
  environmentId: string | null
  machineName: string
  /** What opening it asks: on the link's agent when it is listed and no record here holds the chat. */
  spec: RemoteSessionOpenSpec
}

/**
 * The chats a link names among other environments' rows: the one at its
 * address, or, for a link that names no environment, each environment's chat
 * of that id (one per environment, however many routes reach it).
 */
export function chatsAtAddress(
  rows: readonly RemoteConversation[],
  link: { environmentId: string | null; chatId: string; agentId: string | null },
): EnvironmentChatTarget[] {
  const found: EnvironmentChatTarget[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.workspaceId !== link.chatId) continue
    if (link.environmentId !== null && row.environmentId !== link.environmentId) continue
    const key = row.environmentId ? `id:${row.environmentId}` : `route:${row.route}`
    if (seen.has(key)) continue
    seen.add(key)
    found.push({
      environmentId: row.environmentId,
      machineName: row.machineName,
      spec: openSpecOfConversation(row, row.attachedWorkspaceId ? null : link.agentId),
    })
  }
  return found
}
