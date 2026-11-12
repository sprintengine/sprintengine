import { chatLinkFor } from '../../packages/studio-protocol/src/chat-link'
import type { ChatAddress } from '../../packages/studio-protocol/src/environment'

// A chat dragged from the sidebar into a composer lands as a reference to it:
// a Markdown link whose text is the chat's title and whose address is the
// chat's link (`chatLinkFor`), by its address. The composer's live preview
// draws it as a link, the person's message shows it as one, and the agent
// reading the message finds the chat's id in the link's last segment, which
// `conversation.read` takes as its `workspaceId`. It is words in the message, so it needs nothing of the
// protocol, and a client that has never heard of it shows a link.

/** The MIME type a sidebar chat's drag carries its reference under, beside `text/plain`. */
export const CHAT_REFERENCE_MIME = 'application/x-sprintengine-chat-reference'

const MAX_TITLE = 80

/** The Markdown reference to a chat, by its address, or null when an id cannot be linked. */
export function chatReferenceMarkdown(title: string, address: ChatAddress): string | null {
  const link = chatLinkFor(address)
  if (!link) return null
  const words = title.replace(/\s+/gu, ' ').trim() || 'Untitled chat'
  const cut = words.length > MAX_TITLE ? `${words.slice(0, MAX_TITLE - 1)}…` : words
  // Brackets and backslashes in a title would end the link's text early.
  return `[${cut.replace(/[\\[\]]/gu, '\\$&')}](${link})`
}

/**
 * Puts a chat's reference on a drag, so a composer the drag is dropped on
 * types it where it lands. A chat on a paired machine is not one this
 * machine's agents can read, so it carries none; nor does a chat with no
 * address yet (`address` null: this machine's id not read).
 */
export function setChatReferenceDragData(
  transfer: Pick<DataTransfer, 'setData'>,
  chat: { id: string; name: string; remote: boolean; address: ChatAddress | null },
): boolean {
  if (chat.remote || !chat.address) return false
  const reference = chatReferenceMarkdown(chat.name, chat.address)
  if (!reference) return false
  transfer.setData(CHAT_REFERENCE_MIME, chat.id)
  transfer.setData('text/plain', reference)
  return true
}
