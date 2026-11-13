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
  ConversationThread,
  ConversationWirePermissionPreset,
  StudioAuth,
  StudioClientInfo,
  StudioCreatedConversation,
  StudioGrant,
  StudioChatMethod,
  StudioMethodParams,
  StudioCliRuntime,
  StudioConversationCreate,
  StudioWorkspace,
  StudioWorkspaceCheckout,
  StudioWorkspaceExtensions,
  StudioChatExportPage,
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
  /** What a command that answers more than yes or no says: a fork's `name`. */
  data?: Record<string, unknown>
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
    request: StudioConversationCreate,
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

/** A chat's export as its Studio reads it: the whole of it, paged out by the router. */
export type StudioChatExportRead =
  ({ ok: true } & Omit<StudioChatExportPage, 'nextOffset'>) | { ok: false; code?: 'not_found'; message: string }

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
  watchChanges?(
    chat: StudioChatRef,
    listener: (said: Omit<ConversationChangesFrame, 'type' | 'key'>) => void,
  ): () => void
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
  /**
   * One picture of the chat as it is kept: a step's by its call, or one the
   * person sent by the ref its message recorded. The chat's record names the
   * file; nothing the client says is read as a path.
   */
  picture?(key: ConversationKey, ref: StudioPictureRef): Promise<StudioPictureRead>
  /**
   * Make a client's finished uploads the chat's, for the keyed send that names
   * them: each picture staged and each file kept where the conversation host
   * keeps a device's, under ids only that client may spend on that chat.
   * Answered with those ids, in the order given.
   */
  stageUploads?(
    key: ConversationKey,
    clientId: string,
    uploads: StudioStagedUpload[],
  ): Promise<{ ok: true; ids: string[] } | { ok: false; code: 'not_found' | 'invalid_params'; message: string }>
  /** The chat's rest, written to its workspace's record as its row menu writes it; `byOwner` says whose write it is. */
  settle?(workspaceId: string, settled: boolean, byOwner: boolean): StudioLifecycleOutcome<{ settledAt: number | null }>
  visit?(
    workspaceId: string,
    visitedAt: number | undefined,
    byOwner: boolean,
  ): StudioLifecycleOutcome<{ lastVisitedAt: number }>
}

/** Which picture of a chat: a step's, or one the person sent. */
export type StudioPictureRef = { toolUseId: string } | { attachment: string }

/** A chat's picture, or why there is none to read. */
export type StudioPictureRead =
  { ok: true; mediaType: string; bytes: Buffer } | { ok: false; code: 'not_found' | 'too_large'; message: string }

/** One finished upload a keyed send carries: a picture, or a file of any type attached by its path. */
export type StudioStagedUpload = { purpose: 'picture' | 'attachment'; mediaType: string; name?: string; bytes: Buffer }

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
  attachment(ref: string): Promise<ConversationAttachmentResult>
  planDocument(input: ConversationPlanDocumentInput): Promise<ConversationPlanDocumentResult>
  commands(input: ChatInput<'conversation.commands'>): Promise<ConversationCommandCatalog>
  /** Every `/` command list published from now on, for whichever (CLI, folder). */
  onCommandsChanged(listener: (catalog: ConversationCommandCatalog) => void): () => void
  providers(input: ChatInput<'providers.list'>): Promise<ConversationProviderListResult>
  providerModels(input: ChatInput<'providers.models'>): Promise<ConversationProviderModelsResult>
  secretStatus(input: ChatInput<'providers.secretStatus'>): Promise<ConversationSecretStatusResult>
  /** Whether a folder is inside one a chat can be about: a workspace's, or Studio's own stores. */
  isKnownFolder?(path: string): Promise<boolean>
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
  /**
   * A chat's whole export, read where it is kept: what its record says of it,
   * its transcript and the pictures its messages attached. Absent where
   * Studio reads no exports (`conversation-export` is then not advertised).
   */
  exportSource?(chat: { workspaceId: string; agentId: string }): Promise<StudioChatExportRead>
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
  /** The connection is a browser's, an owner's tab included: it never reaches the terminals (`studio-browser-reach.ts`). */
  browser?: boolean
  /** The window this connection is one of Studio's own for, as main names it; absent for any other client. */
  windowKey?: string
}

export type StudioAuthOutcome = { ok: true; grant: StudioGrant; pairingToken?: string } | { ok: false; message: string }

/** A discovery read's answer: the value, or why it has none. */
export type StudioDiscoveryAnswer<T> =
  { ok: true; value: T } | { ok: false; code: 'not_found' | 'unavailable'; message: string }

/**
 * What a client reads before it starts a chat (`workspaces.*`,
 * `cliRuntimes.list`), answered by the same services as the gateway's tools
 * of the same purpose, so a client on the protocol and an agent on MCP read
 * one thing.
 */
export type StudioDiscovery = {
  workspaces(): Promise<StudioWorkspace[]>
  runtimes(cli?: string): Promise<StudioDiscoveryAnswer<{ clis: StudioCliRuntime[] }>>
  checkout(workspaceId: string): Promise<StudioDiscoveryAnswer<StudioWorkspaceCheckout>>
  extensions(workspaceId: string, cli?: string): Promise<StudioDiscoveryAnswer<StudioWorkspaceExtensions>>
}

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
  /** A module method's call: the module and the method it named. Never its params or answer. */
  moduleId?: string
  moduleMethod?: string
  ok: boolean
  code?: string
  durationMs: number
}
