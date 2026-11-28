import { openSpecOfConversation, type RemoteConversation, type RemoteSessionOpenSpec } from './remoteSessionsModel'

// A `sprintengine://chat/<environmentId>/<chatId>` link to a chat on another
// environment names it by its address there (the row menu's Copy link to
// chat), so one link opens the chat there, where it is a chat of that
// machine's own, and on every device that follows it. Only the sidebar reads
// the environments' lists, so it says here which chats they hold, under the
// environment each is, and the window a link is handed to opens one from that
// (`chatLinkOpener.ts`'s `remoteChats`).

type Listed = {
  /** The machine's environment id; null while it has not said one. */
  environmentId: string | null
  conversation: RemoteConversation
}

let listed: readonly Listed[] = []

/** The chats every followed environment lists now, each under its environment's id. */
export function publishRemoteChatLinkTargets(conversations: readonly RemoteConversation[]): void {
  listed = conversations.map((conversation) => ({ environmentId: conversation.environmentId, conversation }))
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
    const key = entry.environmentId ? `id:${entry.environmentId}` : `route:${conversation.route}`
    if (seen.has(key)) continue
    seen.add(key)
    found.push({
      environmentId: entry.environmentId,
      machineName: conversation.machineName,
      spec: openSpecOfConversation(conversation, conversation.attachedWorkspaceId ? null : link.agentId),
    })
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
