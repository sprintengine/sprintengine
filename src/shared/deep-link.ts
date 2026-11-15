import { parseChatLink, type ChatLink } from '../../packages/studio-protocol/src/chat-link'

// The desktop's side of a `sprintengine://` link. The grammar, what a link may
// ask and how it is read, is the protocol package's (`chat-link.ts`), which the
// phone reads too; here are the channels main hands a chat link to a window
// on, and how a launch's arguments carry one.

export type { ChatLink }

/** Main to a workspace window: open this chat. Carries the link and its generation. */
export const CHAT_LINK_OPEN_CHANNEL = 'chat-link:open'
/** A workspace window to main: it opened the link of this generation, so main can let it go. */
export const CHAT_LINK_ACK_CHANNEL = 'chat-link:ack'
/** A workspace window to main: its registry is loaded and it is listening for chat links. */
export const CHAT_LINK_READY_CHANNEL = 'chat-link:ready'
/** A workspace window to main: it stopped listening. */
export const CHAT_LINK_UNREADY_CHANNEL = 'chat-link:unready'

/** The first chat link among a launch's arguments, the way Windows and Linux hand one over. */
export function chatLinkFromArgv(argv: readonly string[]): ChatLink | null {
  for (const arg of argv) {
    const link = parseChatLink(arg)
    if (link) return link
  }
  return null
}
