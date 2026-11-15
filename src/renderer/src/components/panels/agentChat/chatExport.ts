import type { StudioClient } from '../../../../../../packages/client-runtime/src/public'
import {
  STUDIO_CHAT_EXPORT_CAPABILITY,
  type StudioChatExportPage,
} from '../../../../../../packages/studio-protocol/src/public'
import type { ChatExportAction, ChatExportSource } from '../../../../../shared/chat-export'
import { randomId } from '../../../../../shared/random-id'
import { windowStudioClient } from '../../../studio/windowStudioClient'
import type { ConversationSessionSummary } from '../../../../../shared/conversation-runtime'
import { clientSupports, hostPlatform } from '../../../clientCapabilities'
import { showToast } from '../../../store/toastStore'
import { revealLabel } from '../../../utils/revealLabel'
import { mountedChatViewFor } from './mountedChatViews'

// Export chat, the window's half: offered on a chat tab's menu and in the
// palette. The chat is read from the Studio that holds it, page by page
// (`conversation.exportPage`), and handed to this shell
// (`window.api.saveChatExport`), which asks where to save and writes, or
// copies. This says how it went: the shared toast, with a way to the file
// when there is one.

/** The rows of the menu's flyout, in order: the two copies, then the files. */
export const CHAT_EXPORT_MENU: readonly { action: ChatExportAction; label: string }[] = [
  { action: 'copy', label: 'Copy chat' },
  { action: 'copy-markdown', label: 'Copy chat as Markdown' },
  { action: 'pdf', label: 'PDF…' },
  { action: 'docx', label: 'Word document…' },
  { action: 'markdown', label: 'Markdown…' },
]

/** Why the export rows are off for a chat with nothing in it. */
export const CHAT_EXPORT_EMPTY_REASON = 'No messages yet'

/**
 * Whether a shell can export at all: the save dialog is the OS's, and the
 * clipboard written is the machine's the app runs on, so a browser tab has
 * neither.
 */
export function chatExportSupported(): boolean {
  return clientSupports('native-dialogs')
}

/**
 * Whether the chat has a message to export, as far as the window can tell
 * without reading the transcript: its view when one is drawn, else the
 * session main lists for it. Null when neither knows — a chat not opened since
 * the app started — and the export is offered; main says so if it is empty.
 */
export function chatHasMessages(
  workspaceId: string,
  agentId: string,
  sessions: readonly ConversationSessionSummary[],
): boolean | null {
  const view = mountedChatViewFor(workspaceId, agentId)?.hasMessages?.()
  if (view !== undefined) return view
  const session = sessions.find((candidate) => candidate.workspaceId === workspaceId && candidate.agentId === agentId)
  if (!session) return null
  return Boolean(
    session.firstUserText ||
    session.lastUserText ||
    session.lastTurnEndedAt !== undefined ||
    session.turnStartedAt !== undefined,
  )
}

/** The most pages one export is read in: far past any chat, and a Studio that never ends one is stopped. */
const MAX_EXPORT_PAGES = 10_000

/**
 * A chat's whole export, read from its Studio page by page under one export
 * id. A Studio from before exports were read over the protocol does not
 * serve `conversation-export`, and is not asked.
 */
export async function readStudioChatExport(
  client: Pick<StudioClient, 'request' | 'supports'>,
  chat: { workspaceId: string; agentId: string },
): Promise<ChatExportSource> {
  if (!client.supports(STUDIO_CHAT_EXPORT_CAPABILITY))
    throw new Error('This Studio is older than this window and cannot export a chat. Update it, then try again.')
  const exportId = randomId()
  const events: ChatExportSource['events'] = []
  const attachments: ChatExportSource['attachments'] = {}
  let offset: number | null = 0
  let chatRead: Omit<ChatExportSource, 'events' | 'attachments'> | null = null
  for (let pages = 0; offset !== null; pages++) {
    if (pages === MAX_EXPORT_PAGES) throw new Error('The chat did not finish reading.')
    const page: StudioChatExportPage = await client.request('conversation.exportPage', {
      key: { workspaceId: chat.workspaceId, agentId: chat.agentId },
      exportId,
      offset,
    })
    chatRead ??= page.chat
    for (const event of page.events) events.push(event)
    Object.assign(attachments, page.attachments)
    // A page that moves nowhere would be asked for again forever.
    if (page.nextOffset !== null && page.nextOffset <= offset) throw new Error('The chat could not be read.')
    offset = page.nextOffset
  }
  if (!chatRead) throw new Error('The chat could not be read.')
  return { ...chatRead, events, attachments }
}

/**
 * Export one chat, and say how it went. Never throws: a menu has nowhere of its
 * own to show an error. The chat is read from this window's Studio; a chat
 * followed over a paired machine's lane names `remote`, which reads its whole
 * transcript from that machine instead.
 */
export async function exportChatOrToast(input: {
  workspaceId: string
  agentId: string
  action: ChatExportAction
  remote?: () => Promise<ChatExportSource>
}): Promise<void> {
  const { remote, action, ...chat } = input
  const copying = action === 'copy' || action === 'copy-markdown'
  const failed = (error: unknown) => ({
    ok: false as const,
    message: error instanceof Error ? error.message : 'The chat could not be exported.',
  })
  const read = remote ? remote() : windowStudioClient().then((client) => readStudioChatExport(client, chat))
  const result = await read.then((source) => window.api.saveChatExport({ action, source })).catch(failed)
  if (!result.ok) {
    showToast({
      tone: 'error',
      title: copying ? 'Could not copy the chat' : 'Could not export the chat',
      description: result.message,
    })
    return
  }
  if (result.kind === 'cancelled') return
  if (result.kind === 'copied') {
    showToast({ tone: 'good', title: 'Chat copied' })
    return
  }
  const { path } = result
  showToast({
    tone: 'good',
    title: 'Chat exported',
    description: result.fileName,
    ...(clientSupports('reveal-in-folder')
      ? {
          actions: [
            {
              id: 'reveal',
              label: revealLabel(hostPlatform()),
              run: () => void window.api.showItemInFolder(path),
            },
          ],
        }
      : {}),
  })
}
