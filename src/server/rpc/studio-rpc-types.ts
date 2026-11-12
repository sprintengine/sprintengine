import type {
  ConversationChangedFileSides,
  ConversationChangesDiff,
  ConversationChangesFrame,
  ConversationChangesSelection,
  ConversationCommandsAnswer,
  ConversationFileSearchAnswer,
  ConversationQueuedMessage,
  ConversationScheduledMessage,
  ConversationSideQuestionExchange,
  ConversationSubagent,
  ConversationUsageLimitsFrame,
  ConversationCommand,
  ConversationCreateRequest,
  ConversationThread,
  ConversationWirePermissionPreset,
  StudioAuth,
  StudioClientInfo,
  StudioCreatedConversation,
  StudioGrant,
  StudioChatMethod,
  StudioMethodParams,
  StudioWorkspace,
} from '../../../packages/studio-protocol/src/public'
import type {
  ConversationApprovalRuleRevokeResult,
  ConversationApprovalRulesResult,
  ConversationAttachmentResult,
  ConversationContextBreakdownResult,
  ConversationEvent,
  ConversationListSessionsResult,
  ConversationMcpServerActionResult,
  ConversationProviderSignInResult,
  ConversationSideQuestionResult,
  ConversationTerminalHandoffResult,
  ConversationForkInput,
  ConversationForkResult,
  ConversationKey,
  ConversationPageResult,
  ConversationPlanDocumentInput,
  ConversationPlanDocumentResult,
  ConversationRevertInput,
  ConversationRevertResult,
  ConversationRewindInput,
  ConversationRewindResult,
  ConversationHandoffInput,
  ConversationHandoffResult,
  ConversationImageAttachment,
  ConversationSessionActionResult,
  ConversationSessionFrame,
  ConversationStartSessionResult,
  ConversationToolDetailResult,
  ConversationEventReadResult,
  ConversationTurnDiffResult,
} from '../../shared/conversation-runtime'
import type { ConversationCommandCatalog } from '../../shared/conversation/commands'
import type {
  ConversationProviderListResult,
  ConversationProviderModelsResult,
  ConversationSecretStatusResult,
} from '../../shared/ipc/conversations'
import type { ConversationSearchResult, ConversationThreadsResult } from '../../shared/conversation-index'
import type { FileSearchResult, FileSystemStat } from '../../shared/ipc/filesystem'

// What the Studio RPC needs from the rest of Studio, as interfaces, so the
// router and the connection import nothing from Electron or from main: the
// conversations it serves, and who may connect.

/** How a command ended, as the conversation host words it. */
export type StudioCommandOutcome = {
  ok: boolean
  code?: string
  message?: string
  /** With `busy`: when trying again can succeed. */
  retryAfterMs?: number
  notice?: string
}

/**
 * The conversations the RPC serves. Main implements it over the same
 * conversation host the tailnet lane wraps, the launch service and the
 * runtime, so a chat behaves the same whichever way it is reached.
 */
export type StudioConversationBackend = {
  list(): Promise<ConversationThread[]>
  /** The conversation's place on disk, or null when its workspace is not here. */
  resolveKey(workspaceId: string, agentId: string): ConversationKey | null
  /** Follow one conversation from a cursor: snapshot or catch-up, a fence, then live events. */
  follow(
    key: ConversationKey,
    cursor: { afterSeq?: number; generation?: string; turnLimit?: number },
    listener: (frame: ConversationSessionFrame) => void,
  ): { dispose(): void; ready: Promise<void> }
  loadEarlier(key: ConversationKey, beforeCursor: number, turnLimit?: number): Promise<ConversationPageResult>
  toolDetail(key: ConversationKey, toolUseId: string): Promise<ConversationToolDetailResult>
  /** One event as stored, by the sequence and id it was sent under. */
  event(key: ConversationKey, seq: number, id: string): Promise<ConversationEventReadResult>
  turnDiff(key: ConversationKey, turnSeq: number, path?: string): Promise<ConversationTurnDiffResult>
  /**
   * Carry out one command under an id already namespaced to its client. The
   * runtime's durable receipts answer a retry of the same id with the first
   * attempt's result.
   */
  command(
    key: ConversationKey,
    clientId: string,
    commandId: string,
    command: ConversationCommand,
    /** What the command was, kept with its receipt: the id for another command is then refused. */
    fingerprint?: string,
  ): Promise<StudioCommandOutcome>
  /**
   * End the conversation's live session, if it has one, under the command id
   * already namespaced to its client: the receipt answers a resend with the
   * first result rather than stopping a session started since.
   */
  stop(
    key: ConversationKey,
    commandId: string,
    fingerprint?: string,
  ): Promise<{ ok: true } | { ok: false; message: string; code?: string }>
  /** The preset the conversation runs on now, or resumes on. */
  permissionOf(key: ConversationKey): ConversationWirePermissionPreset
  /** The conversation an earlier create under this namespaced id started, if it still exists. */
  findCreated(launchCommandId: string): StudioCreatedConversation | null
  /** Start a conversation. `request` has already been held to the client's ceiling. */
  create(
    request: ConversationCreateRequest,
    launchCommandId: string,
  ): Promise<{ ok: true; conversation: StudioCreatedConversation } | { ok: false; code: string; message: string }>
  /**
   * What a client is shown of anything read from a conversation — an event, a
   * page, a tool's detail, a turn's diff: secret-shaped members redacted, as
   * the tailnet lane redacts them. Returns a copy.
   */
  redact<T>(value: T): T
  /**
   * What a follower of one chat reads and does beside its stream
   * (`followed.ts` in the protocol): the conversation host's own, as the
   * tailnet lane serves them, so a chat offers the same wherever it is
   * followed from. Each is absent on a Studio that cannot serve it, and its
   * method or topic is then answered `unavailable`.
   */
  followed?: StudioFollowedBackend
}

/** A chat by its workspace and agent: what the per-chat reads and watches are keyed by. */
export type StudioChatRef = Pick<ConversationKey, 'workspaceId' | 'agentId'>

/** A read for a follower's composer, or why there is none. */
export type StudioComposerRead<T> =
  { ok: true; answer: T } | { ok: false; code: 'unknown_conversation' | 'unavailable'; message: string }

/** A changes read, or why there is none: `not_found` for a step or file the chat's changes do not hold. */
export type StudioChangesRead<T> = ({ ok: true } & T) | { ok: false; code?: 'not_found'; message: string }

/** How a lifecycle write ended: the record's new state, or why it was refused. */
export type StudioLifecycleOutcome<T> = ({ ok: true } & T) | { ok: false; code: string; message: string }

export type StudioFollowedBackend = {
  /** Each watch is told what stands now, and again whenever it reads differently; it returns what stops it. */
  watchQueued?(chat: StudioChatRef, listener: (messages: ConversationQueuedMessage[]) => void): () => void
  watchScheduled?(chat: StudioChatRef, listener: (messages: ConversationScheduledMessage[]) => void): () => void
  watchUsageLimits?(
    chat: StudioChatRef,
    listener: (state: Omit<ConversationUsageLimitsFrame, 'type' | 'key'>) => void,
  ): () => void
  watchSubagents?(chat: StudioChatRef, listener: (subagents: ConversationSubagent[]) => void): () => void
  watchChanges?(chat: StudioChatRef, listener: (said: Omit<ConversationChangesFrame, 'type' | 'key'>) => void): () => void
  changesDiff?(
    chat: StudioChatRef,
    selection: ConversationChangesSelection,
  ): Promise<StudioChangesRead<ConversationChangesDiff>>
  changedFile?(
    chat: StudioChatRef,
    selection: ConversationChangesSelection,
    path: string,
  ): Promise<StudioChangesRead<ConversationChangedFileSides>>
  /** Asked under the client's own id for the question, which only that client may call off. */
  askSideQuestion?(
    key: ConversationKey,
    clientId: string,
    questionId: string,
    question: string,
    history: ConversationSideQuestionExchange[],
  ): Promise<ConversationSideQuestionResult>
  cancelSideQuestion?(clientId: string, questionId: string): Promise<{ ok: true } | { ok: false; message: string }>
  contextBreakdown?(key: ConversationKey): Promise<ConversationContextBreakdownResult>
  /** In the chat's own folder only; a client's next search supersedes its last. */
  searchFiles?(
    key: ConversationKey,
    clientId: string,
    query: string,
    limit?: number,
  ): Promise<StudioComposerRead<ConversationFileSearchAnswer>>
  listCommands?(key: ConversationKey, refresh: boolean): Promise<StudioComposerRead<ConversationCommandsAnswer>>
  /** The chat's rest, written to Studio's own record of it as its row menu writes it; `byOwner` says whose write it is. */
  settle?(chat: StudioChatRef, settled: boolean, byOwner: boolean): StudioLifecycleOutcome<{ settledAt: number | null }>
  visit?(
    chat: StudioChatRef,
    visitedAt: number | undefined,
    byOwner: boolean,
  ): StudioLifecycleOutcome<{ lastVisitedAt: number }>
}

/** A chat method's params as the router hands them on: its command id is the router's to namespace. */
type ChatInput<M extends StudioChatMethod> = Omit<StudioMethodParams<M>, 'commandId'>

/** A session command's input: the client's command id, namespaced, and what the command was. */
type SessionCommand<T> = T & { commandId: string; commandFingerprint?: string }

/**
 * What a chat view needs beside the conversation lane (`chat.ts` in the
 * protocol), as main serves its own windows: the same handlers, so a chat over
 * the RPC and a chat over IPC are one chat. Inputs arrive shape-checked; each
 * implementation checks what they mean by the rules its IPC applies. A session
 * command carries a command id already namespaced to its client.
 */
export type StudioChatBackend = {
  startSession(input: ChatInput<'session.start'>): Promise<ConversationStartSessionResult>
  sendTurn(
    input: SessionCommand<Omit<ChatInput<'session.send'>, 'attachments'>> & {
      attachments?: ConversationImageAttachment[]
    },
  ): Promise<ConversationSessionActionResult>
  /** Whether a session command's id has a receipt (or is being carried out): a repeat is answered from it. */
  hasReceipt(input: { sessionId: string; commandId: string }): Promise<boolean>
  interrupt(input: SessionCommand<ChatInput<'session.interrupt'>>): Promise<ConversationSessionActionResult>
  respond(input: SessionCommand<ChatInput<'session.respond'>>): Promise<ConversationSessionActionResult>
  setPermission(input: SessionCommand<ChatInput<'session.setPermission'>>): Promise<ConversationSessionActionResult>
  setModel(input: SessionCommand<ChatInput<'session.setModel'>>): Promise<ConversationSessionActionResult>
  revert(input: ConversationRevertInput): Promise<ConversationRevertResult>
  rewind(input: ConversationRewindInput): Promise<ConversationRewindResult>
  handoff(input: ConversationHandoffInput): Promise<ConversationHandoffResult>
  fork(input: ConversationForkInput): Promise<ConversationForkResult>
  attachment(ref: string): Promise<ConversationAttachmentResult>
  planDocument(input: ConversationPlanDocumentInput): Promise<ConversationPlanDocumentResult>
  commands(input: ChatInput<'conversation.commands'>): Promise<ConversationCommandCatalog>
  /** Every `/` command list published from now on, for whichever (CLI, folder). */
  onCommandsChanged(listener: (catalog: ConversationCommandCatalog) => void): () => void
  providers(input: ChatInput<'providers.list'>): Promise<ConversationProviderListResult>
  providerModels(input: ChatInput<'providers.models'>): Promise<ConversationProviderModelsResult>
  secretStatus(input: ChatInput<'providers.secretStatus'>): Promise<ConversationSecretStatusResult>
  /**
   * File search, in the slot of the connection asking: a newer search on the
   * same channel ends the older one, and a closed connection's are ended.
   */
  searchFiles(slot: number, input: ChatInput<'files.search'>): Promise<FileSearchResult>
  cancelFileSearch(slot: number, channel?: string): void
  releaseFileSearches(slot: number): void
  /**
   * A path's stat and a picture's bytes. Held to the folders a chat can read
   * (`isKnownFolder`) unless `anyPath`: an owner's connection that is not held
   * to known folders (Studio's own window) reads any path, as it always has.
   */
  stat(path: string, reading?: { anyPath?: boolean }): Promise<FileSystemStat>
  readImage(path: string, reading?: { anyPath?: boolean }): Promise<string>
  repoRoot(folderPath: string, hostId?: string): Promise<string | null>
  /** Whether a folder is inside one a chat can be about: a workspace's, or Studio's own stores. */
  isKnownFolder?(path: string): Promise<boolean>
  workspaces(): StudioWorkspace[]
  listSessions(input: ChatInput<'session.list'>): Promise<ConversationListSessionsResult>
  /** Through the runtime's receipts, as the other session commands. */
  stopSession(input: SessionCommand<ChatInput<'session.stop'>>): Promise<ConversationSessionActionResult>
  suspendSession(input: ChatInput<'session.suspend'>): Promise<ConversationSessionActionResult>
  mcpServerAction(input: ChatInput<'session.mcpServerAction'>): Promise<ConversationMcpServerActionResult>
  stopSubagent(input: ChatInput<'session.stopSubagent'>): Promise<ConversationSessionActionResult>
  messageSubagent(input: ChatInput<'session.messageSubagent'>): Promise<ConversationSessionActionResult>
  askSideQuestion(input: ChatInput<'session.askSideQuestion'>): Promise<ConversationSideQuestionResult>
  cancelSideQuestion(
    input: ChatInput<'session.cancelSideQuestion'>,
  ): Promise<{ ok: true } | { ok: false; message: string }>
  contextBreakdown(input: ChatInput<'session.contextBreakdown'>): Promise<ConversationContextBreakdownResult>
  /** A terminal agent on this machine carrying the chat on; absent where Studio opens no terminals. */
  terminalHandoff?(
    input: { sessionId: string } | { workspaceId: string; agentId: string },
  ): Promise<ConversationTerminalHandoffResult>
  threads(input: { workspaceId: string; workspaceRoot: string }): Promise<ConversationThreadsResult>
  /**
   * Search a workspace's history in the slot of the connection asking: a
   * newer search under the same request id ends the older one, as does
   * `cancelSearch`, and a closed connection's are ended.
   */
  searchHistory(
    slot: number,
    input: { workspaceId: string; workspaceRoot: string; query: string; requestId?: string },
  ): Promise<ConversationSearchResult>
  cancelHistorySearch(slot: number, requestId: string): void
  releaseHistorySearches(slot: number): void
  approvalRules(): Promise<ConversationApprovalRulesResult>
  revokeApprovalRule(ruleId: string): Promise<ConversationApprovalRuleRevokeResult>
  signIn(input: ChatInput<'providers.signIn'>): Promise<ConversationProviderSignInResult>
  setSecret(input: ChatInput<'providers.setSecret'>): Promise<ConversationSecretStatusResult>
  clearSecret(input: ChatInput<'providers.clearSecret'>): Promise<ConversationSecretStatusResult>
  /**
   * Every chat's lifecycle events as the all-chats broadcast carries them:
   * lifecycle and status kinds only, each without its payload.
   */
  onLifecycleEvent(listener: (event: ConversationEvent) => void): () => void
}

/** Who a request came from, beyond its grant. */
export type StudioRequestContext = {
  connectionId: string
  /** A number this connection alone holds, for the file search slots main keys by number. */
  slot: number
  /**
   * The connection is one of Studio's own windows, admitted by a ticket main
   * asked for on its behalf: the app's own chat view, which reads conversations over IPC as they
   * are. Its replies are not redacted, its mutations are not audited, and a
   * failure below is told in its own words, as the IPC tells it.
   */
  ownWindow: boolean
  /**
   * Whether its mutations are audited. Unset, a client's are and a window's
   * are not; an owner's web tab is Studio's own view but a client of the
   * server all the same, and is audited (phase 9 spec, 14.8).
   */
  audited?: boolean
  /**
   * The connection reached this server over the tailnet: a folder it searches
   * or asks about must be one Studio already knows.
   */
  knownFoldersOnly?: boolean
  /** The window this connection is one of Studio's own for, as main names it; absent for any other client. */
  windowKey?: string
}

export type StudioAuthOutcome = { ok: true; grant: StudioGrant; pairingToken?: string } | { ok: false; message: string }

/** Who may connect, and what each may do now. */
export type StudioAuthenticator = {
  /** Check a hello's credential; a pairing code is redeemed here, once. */
  authenticate(auth: StudioAuth, client: StudioClientInfo): StudioAuthOutcome
  /** The client's grant as it stands now, or null once it is revoked. Read on every request. */
  grantFor(clientId: string): StudioGrant | null
  onRevoked(listener: (clientId: string) => void): () => void
  onGrantChanged(listener: (clientId: string) => void): () => void
  recordSeen?(clientId: string): void
}

/** One mutation, or one refusal at the door, as the audit records it. Never a message's text. */
export type StudioAuditEntry = {
  clientId: string | null
  clientName: string
  /** The method (`conversation.send`), or `studio.auth_refused` / `studio.paired`. */
  tool: string
  workspaceId?: string
  agentId?: string
  commandId?: string
  /** An offer or a withdrawal: the toolset's name and how many tools it holds. Never a tool's input or result. */
  toolset?: string
  tools?: number
  ok: boolean
  code?: string
  durationMs: number
}
