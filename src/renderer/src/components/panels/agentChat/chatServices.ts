import type {
  StudioCapability,
  StudioPushTopic,
  StudioTopicParams,
  StudioTopicPayload,
} from '../../../../../../packages/studio-protocol/src/public'
import type { ConversationCommandCatalog } from '../../../../../shared/conversation/commands'
import type {
  ConversationSearchInput,
  ConversationSearchResult,
  ConversationThreadsResult,
  ConversationWorkspaceKey,
} from '../../../../../shared/conversation-index'
import type {
  ConversationApprovalRuleRevokeResult,
  ConversationApprovalRulesResult,
  ConversationEvent,
  ConversationListSessionsInput,
  ConversationListSessionsResult,
  ConversationPlanDocumentInput,
  ConversationPlanDocumentResult,
  ConversationProviderSignInInput,
  ConversationProviderSignInResult,
  ConversationProvidersListInput,
  ConversationSessionActionResult,
  ConversationTerminalHandoffInput,
  ConversationTerminalHandoffResult,
} from '../../../../../shared/conversation-runtime'
import type {
  ConversationProviderListResult,
  ConversationProviderModelsInput,
  ConversationProviderModelsResult,
  ConversationSecretClearInput,
  ConversationSecretSetInput,
  ConversationSecretStatusInput,
  ConversationSecretStatusResult,
} from '../../../../../shared/ipc/conversations'
import type { FileSearchResult, FileSystemStat } from '../../../../../shared/ipc/filesystem'
import type { ConversationCommandsRequest } from '../../../../../shared/ipc/conversation-commands'

// What a chat view asks of the Studio its window belongs to, whichever machine
// the chat itself runs on: the providers and models it can pick, the files its
// mentions, links and pictures name, a plan opened as a document, and the `/`
// command lists its CLI reports. A chat followed from a paired machine still
// reads these here, as it always has. And what the rest of the window asks of
// that Studio's chats: their live sessions (the sidebar, Stop, Suspend, Resume
// in terminal), their history (the palette's search, a history link), the
// approval rules, and a provider's sign-in and key (Settings).
//
// Every window answers them over the Studio protocol (`studioChat.ts`), as a
// paired desktop, the phone and a browser tab do: there is no IPC for them.

export type ChatProviderSource = {
  list(input?: ConversationProvidersListInput): Promise<ConversationProviderListResult>
  models(input: ConversationProviderModelsInput): Promise<ConversationProviderModelsResult>
  secretStatus(input: ConversationSecretStatusInput): Promise<ConversationSecretStatusResult>
  /** The line a terminal runs to sign the provider's CLI back in. */
  signIn(input: ConversationProviderSignInInput): Promise<ConversationProviderSignInResult>
  /** Keep a provider's key in the Studio's credential store; answered with its status, never the key. */
  setSecret(input: ConversationSecretSetInput): Promise<ConversationSecretStatusResult>
  clearSecret(input: ConversationSecretClearInput): Promise<ConversationSecretStatusResult>
}

/** The live sessions of the Studio's chats, by their ids. */
export type ChatSessionSource = {
  list(input?: ConversationListSessionsInput): Promise<ConversationListSessionsResult>
  stop(input: { sessionId: string }): Promise<ConversationSessionActionResult>
  /** End the session's process and keep its place: the next message resumes it. */
  suspend(input: { sessionId: string }): Promise<ConversationSessionActionResult>
  terminalHandoff(input: ConversationTerminalHandoffInput): Promise<ConversationTerminalHandoffResult>
  /**
   * Every chat's lifecycle events as they happen, each without its payload,
   * followed across reconnects. Nothing is replayed, so what happened while
   * the window was not connected is never heard: `onReconnected` is called
   * each time it is connected again, for the reader to read `list` anew.
   */
  onLifecycleEvent(listener: (event: ConversationEvent) => void, onReconnected?: () => void): () => void
}

/** A workspace's history, and a search of it. */
export type ChatHistorySource = {
  threads(input: ConversationWorkspaceKey): Promise<ConversationThreadsResult>
  /** Answered with every hit at once; a newer search under the same `requestId` ends this one. */
  search(input: ConversationSearchInput): Promise<ConversationSearchResult>
  cancelSearch(requestId: string): Promise<void>
}

/** The rules that answer an approval by themselves. */
export type ChatApprovalRuleSource = {
  list(): Promise<ConversationApprovalRulesResult>
  revoke(ruleId: string): Promise<ConversationApprovalRuleRevokeResult>
}

export type ChatFileSearchOptions = {
  limit?: number
  purpose?: 'mention'
  channel?: string
  recentAt?: Record<string, number>
}

export type ChatFileSource = {
  /** Whether this window can ask about a path at all; a preload too old to say leaves links as they read. */
  readonly canStat: boolean
  search(rootPath: string, query: string, options?: ChatFileSearchOptions): Promise<FileSearchResult>
  cancelSearch(channel?: string): Promise<void>
  /** Rejects as the IPC does when the path cannot be read. */
  stat(path: string): Promise<FileSystemStat>
  readImage(path: string): Promise<string>
  repoRoot(folderPath: string, hostId?: string): Promise<string | null>
}

/** Absent members are a build that does not list a CLI's commands: the menu keeps Studio's own. */
export type ChatCommandSource = {
  list?: (input: ConversationCommandsRequest) => Promise<ConversationCommandCatalog>
  /** Every list published from now on, for whichever (CLI, folder). */
  onChanged?: (listener: (catalog: ConversationCommandCatalog) => void) => () => void
}

/**
 * Follow one of a chat's push topics on the Studio that holds it: every
 * payload, followed again on each new connection. Returns the unsubscriber.
 */
export type ChatPushFollower = <T extends StudioPushTopic>(input: {
  topic: T
  params: StudioTopicParams<T>
  capability: StudioCapability
  onPayload: (payload: StudioTopicPayload<T>) => void
}) => () => void

export type ChatServices = {
  /** The chat's own Studio's push topics (held and scheduled messages, usage limits); absent where it serves none. */
  followPush?: ChatPushFollower
  providers: ChatProviderSource
  files: ChatFileSource
  planDocument(input: ConversationPlanDocumentInput): Promise<ConversationPlanDocumentResult>
  commands: ChatCommandSource
  sessions: ChatSessionSource
  history: ChatHistorySource
  approvalRules: ChatApprovalRuleSource
}
