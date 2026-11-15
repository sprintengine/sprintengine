import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'

import {
  CHAT_EXPORT_CHANNEL,
  isChatExportAction,
  type ChatExportInput,
  type ChatExportResult,
} from '../../shared/chat-export'
import { assertAppSender } from './ipc-sender'

// Export chat's channel: the shell's half. The window hands over the chat as
// its Studio read it (`conversation.exportPage`) and what to make of it, and
// nothing more: no path. The chat is checked as the protocol checks one off
// the wire; main shows the save dialog itself and writes where the person
// chose, or puts the chat on this computer's clipboard, so a page that
// reached the preload cannot make this write anything anywhere. Only the
// app's own window is answered. Main reads no transcript here.

export function registerChatExportIpc(
  ipcMain: Pick<IpcMain, 'handle'>,
  deps: {
    /** The export itself, loaded when first asked for: it brings the Word writer and the typesetter. */
    run(input: ChatExportInput, sender: WebContents): Promise<ChatExportResult>
    /** Test seam; the real check refuses anything but the app's own window. */
    assertSender?: (event: IpcMainInvokeEvent) => void
  },
): void {
  const assertSender = deps.assertSender ?? assertAppSender
  ipcMain.handle(CHAT_EXPORT_CHANNEL, async (event: IpcMainInvokeEvent, raw: unknown): Promise<ChatExportResult> => {
    assertSender(event)
    const { action, source: unread } = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    if (!isChatExportAction(action)) return { ok: false, message: 'That is not a format a chat exports as.' }
    const { parseChatExportSource } = await import('../chat-export/chat-export-source')
    const source = parseChatExportSource(unread)
    if (!source) return { ok: false, message: "That chat's transcript could not be read." }
    try {
      return await deps.run({ action, source }, event.sender)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'The chat could not be exported.' }
    }
  })
}
