// Export chat: a chat tab's whole conversation written out as a file the
// person can send (PDF, Word, Markdown), or put on the clipboard to paste into
// an email. The chat is read where it is kept, by its Studio
// (`conversation.exportPage`, every client the same way); this shell is
// handed what was read, and asks where to save and writes, or copies.

import type { StudioChatExportChat } from '../../packages/studio-protocol/src/public'
import type { ConversationEvent } from './conversation-runtime'

export const CHAT_EXPORT_CHANNEL = 'chat-export:save'

/** The files a chat is exported as. */
export const CHAT_EXPORT_FILE_FORMATS = ['pdf', 'docx', 'markdown'] as const
export type ChatExportFileFormat = (typeof CHAT_EXPORT_FILE_FORMATS)[number]

/**
 * What to make of the chat: one of the files, or the clipboard. `copy` puts
 * the chat on it twice, as Markdown text and as formatted HTML, and the app the
 * paste lands in picks; `copy-markdown` puts the Markdown alone.
 */
export const CHAT_EXPORT_ACTIONS = [...CHAT_EXPORT_FILE_FORMATS, 'copy', 'copy-markdown'] as const
export type ChatExportAction = (typeof CHAT_EXPORT_ACTIONS)[number]

/**
 * A chat as its Studio read it for an export: what its record says of it,
 * its transcript, and the pictures its messages attached, by the reference
 * each message recorded. A chat followed over a paired machine's lane is
 * read from there by its view, with no pictures: they are named, not drawn.
 */
export type ChatExportSource = StudioChatExportChat & {
  events: ConversationEvent[]
  attachments: Record<string, { mediaType: string; dataBase64: string }>
}

/** What the shell is asked: what to make of the chat, and the chat as read. */
export type ChatExportInput = { action: ChatExportAction; source: ChatExportSource }

export type ChatExportResult =
  | { ok: true; kind: 'saved'; path: string; fileName: string }
  /** The person dismissed the save dialog: nothing was written, and nothing needs saying. */
  | { ok: true; kind: 'cancelled' }
  | { ok: true; kind: 'copied' }
  | { ok: false; message: string }

export function isChatExportAction(value: unknown): value is ChatExportAction {
  return typeof value === 'string' && (CHAT_EXPORT_ACTIONS as readonly string[]).includes(value)
}
