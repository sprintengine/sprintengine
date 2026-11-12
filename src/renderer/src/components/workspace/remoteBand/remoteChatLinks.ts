import { environmentOfRoute, type EnvironmentEntry } from '../../../../../shared/environments'
import { environmentRouteOfMeshConnection } from '../../../../../shared/environment-keys'
import {
  conversationsOf,
  openSpecOf,
  openSpecOfConversation,
  type RemoteConversation,
  type RemoteMachineGroup,
  type RemoteSessionOpenSpec,
} from './remoteSessionsModel'

// A `sprintengine://chat/<environmentId>/<chatId>` link to a chat on a paired
// machine names it by its address there (the row menu's Copy link to chat), so
// one link opens the chat there, where it is a chat of that machine's own, and
// on every device that follows it. Only the sidebar reads the paired machines'
// lists, so it says here which chats they hold, under the environment each
// machine is, and the window a link is handed to opens one from that
// (`chatLinkOpener.ts`'s `remoteChats`).

type Listed = {
  /** The machine's environment id; null while it has not said one. */
  environmentId: string | null
  conversation: RemoteConversation
}

let listed: readonly Listed[] = []

/** The chats the paired machines list now, under the environment each machine is. */
export function publishRemoteChatLinkTargets(
  groups: readonly RemoteMachineGroup[],
  environments: readonly EnvironmentEntry[],
): void {
  const next: Listed[] = []
  for (const group of groups) {
    const environmentId = group.connectionId
      ? (environmentOfRoute(environments, environmentRouteOfMeshConnection(group.connectionId))?.environmentId ?? null)
      : null
    for (const conversation of conversationsOf(group)) next.push({ environmentId, conversation })
  }
  listed = next
}

/** A paired machine's chat a link can open. */
export type RemoteChatLinkTarget = {
  environmentId: string | null
  machineName: string
  /** What opening it asks: on the link's agent when it is listed and no window here follows the chat. */
  spec: RemoteSessionOpenSpec
}

/**
 * The paired machines' chats a link names: the one at its address, or, for a
 * link that names no environment, each machine's chat of that id (one per
 * environment, however many pairings reach it).
 */
export function remoteChatLinkTargets(link: {
  environmentId: string | null
  chatId: string
  agentId: string | null
}): RemoteChatLinkTarget[] {
  const found: RemoteChatLinkTarget[] = []
  const seen = new Set<string>()
  for (const entry of listed) {
    const { conversation } = entry
    if (conversation.workspaceId !== link.chatId) continue
    if (link.environmentId !== null && entry.environmentId !== link.environmentId) continue
    const key = entry.environmentId ? `id:${entry.environmentId}` : `connection:${conversation.connectionId}`
    if (seen.has(key)) continue
    seen.add(key)
    found.push({ environmentId: entry.environmentId, machineName: conversation.machineName, spec: specFor(conversation, link.agentId) })
  }
  return found
}

/** What opening a chat a pairing lists asks, by the pairing and its id there; null for one it does not list. */
export function remoteChatOnConnection(connectionId: string, workspaceId: string): RemoteSessionOpenSpec | null {
  const entry = listed.find(
    (candidate) =>
      candidate.conversation.connectionId === connectionId && candidate.conversation.workspaceId === workspaceId,
  )
  return entry ? openSpecOfConversation(entry.conversation) : null
}

function specFor(conversation: RemoteConversation, agentId: string | null): RemoteSessionOpenSpec {
  const lead = openSpecOfConversation(conversation)
  // A chat a window here follows opens in that window, on the agent it
  // follows; otherwise the link's agent comes forward when the machine lists it.
  if (lead.attachedWorkspaceId || !agentId) return lead
  const agent = conversation.agents.find((row) => row.remoteAgentId === agentId)
  return agent ? openSpecOf(agent) : lead
}
