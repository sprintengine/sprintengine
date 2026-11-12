import type { ChatLink } from '../../../../../shared/deep-link'

// What a window does with a `sprintengine://chat/…` link main handed it
// (main/chat-link-router.ts picked the window): select the chat, and bring the
// named agent's tab forward when the chat has that agent. Nothing else: no
// agent starts, nothing is typed or sent.
//
// A link names a chat by its address, the environment that holds it and its
// id there (`packages/studio-protocol/src/chat-link.ts`):
//
//   - this machine's environment: the chat of that id in this window's store;
//   - a paired machine's: the row here that follows that chat, else the chat
//     as that machine lists it, opened as its sidebar row opens it;
//   - none, a link from before links named one: every machine's chat of that
//     id is a candidate. One opens; several are named and none opens, since
//     the link cannot say which; none is said.
//
// A chat not found was closed, or lives on a machine this one does not follow,
// and the person is told so rather than left wondering whether the click
// reached the app. A workspace the rail hides (a module's background host) is
// not a chat anyone links to, and is answered the same way: opening one would
// leave the person somewhere the rail cannot take them back from.
//
// Main sends the link to the window that holds the chat. One filed under a
// window that is not open is moved here, as "Move to Main Window" would.
//
// Store-free, so every path is tested without a window: WorkspaceManager hands
// in the reads and writes.

/** A paired machine's chat a link can open (`remoteChatLinks.ts`). */
export type RemoteChatChoice = {
  environmentId: string | null
  machineName: string
  open: () => void
}

export type ChatLinkOpenerDeps = {
  /** This machine's environment id; null while the environment list has not said it. */
  localEnvironmentId: string | null
  /** The chat, when this window's store has one the rail lists; null otherwise. */
  getChat: (chatId: string) => { agents: Record<string, { name: string }> } | null
  /** The chat here that follows a paired machine's chat at this address, by its id here; null for none. */
  followerOf: (address: { environmentId: string; chatId: string }) => string | null
  /** The paired machines' chats the link names (`remoteChatLinkTargets`). */
  remoteChats: (link: ChatLink) => RemoteChatChoice[]
  /** The window the store files the chat under, if any. */
  holderOf: (chatId: string) => string | null
  /** This window's workspace-window id. */
  windowId: string
  moveHere: (chatId: string, fromWindowId: string | null) => void
  /** What a click on the chat's sidebar row does. */
  select: (chatId: string) => void
  revealAgent: (chatId: string, agentId: string, name: string) => void
  /** An old link that more than one machine has a chat for: where they are, this computer as "this computer". */
  several: (places: string[]) => void
  notOnThisMachine: () => void
}

const THIS_COMPUTER = 'this computer'

/** True when the chat was opened. */
export function openChatLink(link: ChatLink, deps: ChatLinkOpenerDeps): boolean {
  // While this machine's id is not known the link cannot be placed, so it is
  // read as an old one: its chat id among every machine's.
  const environmentId =
    link.environmentId !== null && deps.localEnvironmentId !== null ? link.environmentId : null

  if (environmentId === deps.localEnvironmentId && environmentId !== null) {
    if (openHere(link.chatId, link.agentId, deps)) return true
    deps.notOnThisMachine()
    return false
  }

  if (environmentId !== null) {
    const follower = deps.followerOf({ environmentId, chatId: link.chatId })
    if (follower && openHere(follower, link.agentId, deps)) return true
    const remote = deps.remoteChats(link)[0]
    if (remote) {
      remote.open()
      return true
    }
    deps.notOnThisMachine()
    return false
  }

  const here = deps.getChat(link.chatId) ? [THIS_COMPUTER] : []
  const remote = deps.remoteChats({ ...link, environmentId: null })
  const places = [...here, ...remote.map((choice) => choice.machineName)]
  if (places.length === 0) {
    deps.notOnThisMachine()
    return false
  }
  if (places.length > 1) {
    deps.several(places)
    return false
  }
  if (here.length > 0) return openHere(link.chatId, link.agentId, deps)
  remote[0]!.open()
  return true
}

function openHere(chatId: string, agentId: string | null, deps: ChatLinkOpenerDeps): boolean {
  const chat = deps.getChat(chatId)
  if (!chat) return false
  const holder = deps.holderOf(chatId)
  if (holder !== deps.windowId) deps.moveHere(chatId, holder)
  deps.select(chatId)
  // An agent the chat no longer has (closed since the link was copied) still
  // lands on the chat, as it was left.
  const agent = agentId ? chat.agents[agentId] : undefined
  if (agentId && agent) deps.revealAgent(chatId, agentId, agent.name)
  return true
}
