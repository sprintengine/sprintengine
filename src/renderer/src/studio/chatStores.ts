import {
  STUDIO_CHAT_STORES_CAPABILITY,
  type ConversationImportInput,
  type ConversationImportResult,
  type ConversationImportScanResult,
  type ScheduledMessageHoldAnswer,
  type ScheduledMessageHoldRequest,
  type ScheduledMessagesState,
  type ScheduledMessageUpdate,
  type StudioMethod,
  type StudioMethodParams,
  type StudioMethodResult,
  type StudioPushTopic,
  type StudioTopicPayload,
  type UsageLimitResumeState,
  type UsageLimitResumeUpdate,
  type UsageLimitsState,
  type UsageReportRequest,
  type UsageReportResult,
} from '../../../../packages/studio-protocol/src/public'
import { followWindowStudioPush } from './windowStudioPush'
import { watchWindowStudio, windowStudioClient, windowStudioState } from './windowStudioClient'

// The window's way to what its Studio keeps beside its chats: the Studio
// protocol's `usageLimits.*`, `usageLimitResumes.*`, `scheduledMessages.*`,
// `usage.report` and `conversationImport.*`, over the window's own
// connection, as every other client reaches them. The members keep the names
// the window has always called them by.
//
// A follow (`on…Changed`) hears every change, and the whole state again each
// time the window's connection opens: a change made while it was down is
// never pushed, so it is read. Returns its unsubscriber.

export type ChatStoresApi = {
  usageLimits(): Promise<UsageLimitsState>
  onUsageLimitsChanged(listener: (state: UsageLimitsState) => void): () => void
  usageLimitResumes(): Promise<UsageLimitResumeState>
  /** One chat's action, or the setting (`kind: 'auto'`). Answered with the state after it. */
  updateUsageLimitResume(update: UsageLimitResumeUpdate): Promise<UsageLimitResumeState>
  onUsageLimitResumesChanged(listener: (state: UsageLimitResumeState) => void): () => void
  scheduledMessages(): Promise<ScheduledMessagesState>
  updateScheduledMessage(update: ScheduledMessageUpdate): Promise<ScheduledMessagesState>
  /** Hold a message this window's chat queued, to go when the chat's turn ends. Never rejects. */
  holdQueuedMessage(request: ScheduledMessageHoldRequest): Promise<ScheduledMessageHoldAnswer>
  onScheduledMessagesChanged(listener: (state: ScheduledMessagesState) => void): () => void
  /** The usage dashboard's report. Never rejects: a failure is `{ ok: false, message }`. */
  usageReport(request: UsageReportRequest): Promise<UsageReportResult>
  /** Never rejects. */
  scanImportableConversations(): Promise<ConversationImportScanResult>
  /** Never rejects. */
  importConversations(input: ConversationImportInput): Promise<ConversationImportResult>
}

const UNSERVED = 'This Studio does not keep usage limits, scheduled messages or imports.'

function randomId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function words(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function call<M extends StudioMethod>(method: M, params: StudioMethodParams<M>): Promise<StudioMethodResult<M>> {
  const client = await windowStudioClient()
  if (!client.supports(STUDIO_CHAT_STORES_CAPABILITY)) throw new Error(UNSERVED)
  return client.request(method, params)
}

/** A topic's pushes, and its state read again whenever the window's connection opens. */
function followState<T extends StudioPushTopic>(
  topic: T,
  read: () => Promise<StudioTopicPayload<T>>,
  listener: (state: StudioTopicPayload<T>) => void,
): () => void {
  const api = typeof window === 'undefined' ? undefined : window.api
  if (typeof api?.studioWindowTicket !== 'function') return () => undefined
  let alive = true
  const stopPush = followWindowStudioPush({
    topic,
    params: {} as never,
    capability: STUDIO_CHAT_STORES_CAPABILITY,
    onPayload: (state) => {
      if (alive) listener(state)
    },
  })
  let wasOpen = windowStudioState(api) === 'open'
  const unwatch = watchWindowStudio(api, () => {
    const open = windowStudioState(api) === 'open'
    if (open && !wasOpen)
      void read().then(
        (state) => {
          if (alive) listener(state)
        },
        () => undefined,
      )
    wasOpen = open
  })
  return () => {
    alive = false
    stopPush()
    unwatch()
  }
}

export const chatStoresApi: ChatStoresApi = {
  usageLimits: () => call('usageLimits.get', {}),
  onUsageLimitsChanged: (listener) => followState('usageLimits.changed', () => call('usageLimits.get', {}), listener),
  usageLimitResumes: () => call('usageLimitResumes.get', {}),
  updateUsageLimitResume: (update) =>
    update.kind === 'auto'
      ? call('usageLimitResumes.setAuto', { commandId: randomId(), enabled: update.enabled })
      : call('usageLimitResumes.update', {
          commandId: randomId(),
          workspaceId: update.workspaceId,
          agentId: update.agentId,
          action: update.kind,
        }),
  onUsageLimitResumesChanged: (listener) =>
    followState('usageLimitResumes.changed', () => call('usageLimitResumes.get', {}), listener),
  scheduledMessages: () => call('scheduledMessages.get', {}),
  updateScheduledMessage: (update) => call('scheduledMessages.update', { commandId: randomId(), update }),
  holdQueuedMessage: async (request) => {
    try {
      return await call('scheduledMessages.hold', {
        commandId: randomId(),
        workspaceId: request.workspaceId,
        agentId: request.agentId,
        text: request.text,
      })
    } catch (error) {
      return { ok: false, reason: words(error) }
    }
  },
  onScheduledMessagesChanged: (listener) =>
    followState('scheduledMessages.changed', () => call('scheduledMessages.get', {}), listener),
  usageReport: async (request) => {
    try {
      return await call('usage.report', request)
    } catch (error) {
      return { ok: false, message: words(error) }
    }
  },
  scanImportableConversations: async () => {
    try {
      return await call('conversationImport.scan', {})
    } catch (error) {
      return { ok: false, message: words(error) }
    }
  },
  importConversations: async (input) => {
    try {
      return await call('conversationImport.import', { commandId: randomId(), sessions: input.sessions })
    } catch (error) {
      return { ok: false, message: words(error) }
    }
  },
}

/** The stores' api where this page reaches a Studio (a desktop window, a web tab), else null. */
export function windowChatStores(): ChatStoresApi | null {
  return typeof window !== 'undefined' && typeof window.api?.studioWindowTicket === 'function' ? chatStoresApi : null
}
