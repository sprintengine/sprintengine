import { parseStoredAttachments } from '../../../packages/conversation-timeline/src/conversationProjection'
import { parseConversationWireEvent } from '../../../packages/conversation-protocol/src/public'
import type { StudioChatExportChat } from '../../../packages/studio-protocol/src/public'
import { conversationWorkingRoot, type AgentState } from '../../shared/agent-state'
import type { ChatExportSource } from '../../shared/chat-export'
import type {
  ConversationAttachmentResult,
  ConversationTranscriptInput,
  ConversationTranscriptResult,
} from '../../shared/conversation-runtime'

// What an export is read from, both ends of it.
//
// Where the chats are (a Studio's core): the chat as its workspace records it,
// its whole transcript through the reader the chat view's own pages come from,
// and the pictures its messages attached through the attachment store the view
// reads them back from (`readChatExport`). The Studio protocol pages it to any
// client (`conversation.exportPage`).
//
// Where the file is written (this shell): the same, handed over by the window
// that read it, checked before it is trusted (`parseChatExportSource`).

export type ChatExportReader = {
  readTranscript(input: ConversationTranscriptInput, options: { all: true }): Promise<ConversationTranscriptResult>
  readAttachment(ref: unknown): Promise<ConversationAttachmentResult>
}

type ExportWorkspace = { id: string; name?: string; folderPath?: string | null; agents?: Record<string, AgentState> }

/** The chat as its workspace records it: a conversation with a folder to read its transcript under. */
export function chatExportChatOf(
  workspaces: readonly ExportWorkspace[],
  workspaceId: string,
  agentId: string,
): StudioChatExportChat | null {
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId)
  const agent = workspace?.agents?.[agentId]
  if (!workspace || !agent || agent.runtimeKind !== 'conversation') return null
  const workspaceRoot = conversationWorkingRoot(agent, workspace.folderPath)
  if (!workspaceRoot) return null
  return {
    title: agent.name,
    project: workspace.name?.trim() || null,
    providerId: agent.conversation?.providerId ?? null,
    modelId: agent.conversation?.modelId ?? null,
    workspaceRoot,
  }
}

/** More pictures than any chat a person would send is a transcript gone wrong; the rest are named, not drawn. */
const MAX_ATTACHMENTS = 200

/** A chat's whole export, read where it is kept. `not_found`: no such chat, or not a conversation. */
export async function readChatExport(
  reader: ChatExportReader,
  workspaces: readonly ExportWorkspace[],
  chat: { workspaceId: string; agentId: string },
): Promise<
  | {
      ok: true
      chat: StudioChatExportChat
      events: ChatExportSource['events']
      attachments: ChatExportSource['attachments']
    }
  | { ok: false; code?: 'not_found'; message: string }
> {
  const meta = chatExportChatOf(workspaces, chat.workspaceId, chat.agentId)
  if (!meta) return { ok: false, code: 'not_found', message: 'This chat could not be found.' }
  const transcript = await reader.readTranscript(
    { workspaceRoot: meta.workspaceRoot, workspaceId: chat.workspaceId, agentId: chat.agentId },
    { all: true },
  )
  if (!transcript.ok) return transcript
  const refs = new Set<string>()
  for (const event of transcript.events) {
    if (event.type !== 'user_message') continue
    for (const attachment of parseStoredAttachments(event.payload?.attachments) ?? []) {
      if (refs.size < MAX_ATTACHMENTS) refs.add(attachment.ref)
    }
  }
  const attachments: ChatExportSource['attachments'] = {}
  for (const ref of refs) {
    const read = await reader.readAttachment(ref).catch(() => null)
    if (read?.ok) attachments[ref] = { mediaType: read.mediaType, dataBase64: read.dataBase64 }
  }
  return { ok: true, chat: meta, events: transcript.events, attachments }
}

/** Far more events than a person's chat runs to is a transcript gone wrong. */
const MAX_EVENTS = 500_000

const shortText = (value: unknown, max = 1_000): value is string => typeof value === 'string' && value.length <= max
const shortTextOrNull = (value: unknown): value is string | null => value === null || shortText(value)

/**
 * A chat as the window that read it hands it over, checked before it is
 * trusted: every event as the protocol reads one off the wire, and every
 * picture a media type and its bytes.
 */
export function parseChatExportSource(value: unknown): ChatExportSource | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { events, attachments, title, project, providerId, modelId, workspaceRoot } = value as Record<string, unknown>
  if (!Array.isArray(events) || events.length > MAX_EVENTS) return null
  if (!shortText(title) || !shortText(workspaceRoot, 4_096)) return null
  if (!shortTextOrNull(project) || !shortTextOrNull(providerId) || !shortTextOrNull(modelId)) return null
  if (attachments !== undefined && (!attachments || typeof attachments !== 'object' || Array.isArray(attachments)))
    return null
  const parsed: ChatExportSource['events'] = []
  for (const event of events) {
    const read = parseConversationWireEvent(event)
    if (!read) return null
    parsed.push(read as ChatExportSource['events'][number])
  }
  const pictures: ChatExportSource['attachments'] = {}
  for (const [ref, picture] of Object.entries((attachments ?? {}) as Record<string, unknown>).slice(
    0,
    MAX_ATTACHMENTS,
  )) {
    const { mediaType, dataBase64 } = (picture ?? {}) as Record<string, unknown>
    if (shortText(mediaType, 200) && typeof dataBase64 === 'string') pictures[ref] = { mediaType, dataBase64 }
  }
  return { events: parsed, attachments: pictures, title, project, providerId, modelId, workspaceRoot }
}
