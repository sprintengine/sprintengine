import { createContext, useContext, useSyncExternalStore } from 'react'
import { changePairedChat } from '../../../studio/pairedChats'

import {
  negotiateChatCapabilities,
  type ChatCapabilities,
  type ChatServerOffer,
} from '../../../../../../packages/client-runtime/src/public'
import { watchWindowStudioWelcome, windowStudioWelcome } from '../../../studio/windowStudioClient'
import type { StudioWelcomeFrame } from '../../../../../../packages/studio-protocol/src/public'

import type { ChatServices } from './chatServices'
import { windowChatServices, windowStudioImplementation as studioImplementation } from './windowChat'
import { remotePullRequestHost, studioPullRequestHost, type PullRequestHost } from './pullRequestHost'
import { unwatchPullRequest as unwatchConversationPullRequest } from '../../workspace/useConversationPullRequests'
import type {
  ConversationAttachmentInput,
  ConversationAttachmentResult,
  ConversationForkInput,
  ConversationInterruptInput,
  ConversationLoadEarlierInput,
  ConversationPageResult,
  ConversationRespondToRequestInput,
  ConversationRevertInput,
  ConversationRevertResult,
  ConversationRewindInput,
  ConversationHandoffInput,
  ConversationHandoffResult,
  ConversationImageAttachment,
  ConversationKey,
  ConversationMcpServerActionInput,
  ConversationMcpServerActionResult,
  ConversationRewindResult,
  ConversationSendRequest,
  ConversationSendTurnInput,
  ConversationSessionFrame,
  ConversationSessionSummary,
  ConversationSetModelInput,
  ConversationMessageSubagentInput,
  ConversationStopSubagentInput,
  ConversationCancelSideQuestionInput,
  ConversationContextBreakdownInput,
  ConversationContextBreakdownResult,
  ConversationSideQuestionInput,
  ConversationSideQuestionResult,
  ConversationSetPermissionInput,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationSubscribeInput,
  ConversationToolDetailInput,
  ConversationToolDetailResult,
  ConversationEventReadInput,
  ConversationEventReadResult,
  ConversationTurnDiffInput,
  ConversationTurnDiffResult,
} from '../../../../../shared/conversation-runtime'
import {
  conciseConversationSendRequest,
  parseConversationRevertAnswer,
} from '../../../../../../packages/conversation-protocol/src/public'
import type { ConversationCommandCatalog } from '../../../../../shared/conversation/commands'
import type { ConversationAddress } from '../../../../../../packages/studio-protocol/src/public'
import type { UsageLimitProvider } from '../../../../../shared/usage-limits'
import type { ConversationFileSearchEntry } from '../../../../../../packages/conversation-protocol/src/public'
import type {
  MeshConversationCommandResult,
  MeshConversationKey,
  MeshConversationLink,
  MeshQueuedMessage,
  MeshScheduledMessage,
  MeshConversationUsageLimits,
  MeshSubagent,
  MeshUsageLimitResumeAction,
} from '../../../../../shared/tailnet-mesh'

// Where a chat view's conversation lives. The view — its transcript, pending
// dock, composer — is the same whether the conversation runs on this machine
// or on a paired one; only the calls behind it differ. The local transport is
// the window's Studio protocol client; a remote one is the Mesh's, which follows the
// conversation over the tailnet from main.
//
// What a transport can do is said by its capabilities, which every transport
// reads from what the chat's server said (`negotiateChatCapabilities`): a
// window's own Studio's welcome, a paired machine's lane, an embed's welcome.
// None is a constant, and none is inferred from where the chat runs.
//
// A conversation on this machine is reached over the Studio protocol, through
// the window's Studio client, as every other client reaches it.

export type ConversationTransportCapabilities = ChatCapabilities

/** What an action answers: the local session API's result, or a remote command's. */
type ConversationTransportResult =
  | { ok: true; session?: ConversationSessionSummary; notice?: string }
  // `code` as the runtime names a refusal (`session_not_found`: the session is gone there).
  | { ok: false; message: string; code?: string }

/**
 * The environment a chat runs in, as its server names it: what a chat view
 * says of where it runs, in place of a kind. Every transport answers one.
 */
export type ChatEnvironment = {
  /**
   * The Studio's id (`welcome.environment.id`); for a paired desktop over the
   * tailnet lane, the id that machine said of itself (`MeshConnection.environmentId`).
   * Null where its server has not said one: before a welcome, or a paired
   * build that does not say it. What the window and its shell reach of the
   * chat's disk is asked of this (`useShellReach`).
   */
  readonly id: string | null
  /**
   * What the person calls the machine, where it is not the window's own
   * Studio (a paired machine's name); null for the window's own, which the
   * view calls Studio.
   */
  readonly label: string | null
  /**
   * How a paired desktop still on the tailnet lane is reached for what the
   * lane serves beside the chat's own calls: its skills and MCP servers
   * (`useRemoteExtensions`), the key its `/` list is kept under here (no
   * folder of this disk names it), and the pane a fork it made opens as
   * (`openPairedFork`). Null for every Studio on the protocol. Goes with the
   * lane (design-lane-on-protocol).
   */
  readonly lane: { connectionId: string; workspaceId: string; commandsKey: string } | null
}

export type ConversationTransport = {
  /**
   * Where the chat's Create PR does its work: the server it runs on, in its
   * own checkout there. Used where `capabilities.hostPullRequests` is.
   */
  pullRequestHost?(key: ConversationKey): PullRequestHost
  capabilities: ConversationTransportCapabilities
  readonly environment: ChatEnvironment
  subscribe(input: ConversationSubscribeInput, cb: (frame: ConversationSessionFrame) => void): () => void
  loadEarlier(input: ConversationLoadEarlierInput): Promise<ConversationPageResult>
  toolDetail(input: ConversationToolDetailInput): Promise<ConversationToolDetailResult>
  /** The whole of an event that crossed cut to fit (`wireClipped`), by the `seq` and `id` it came under. */
  readEvent(input: ConversationEventReadInput): Promise<ConversationEventReadResult>
  turnDiff(input: ConversationTurnDiffInput): Promise<ConversationTurnDiffResult>
  send(input: ConversationSendTurnInput): Promise<ConversationTransportResult>
  interrupt(input: ConversationInterruptInput): Promise<ConversationTransportResult>
  respond(input: ConversationRespondToRequestInput): Promise<ConversationTransportResult>
  setPermissionPreset(input: ConversationSetPermissionInput): Promise<ConversationTransportResult>
  /** Switch a running session's model; absent where the transport cannot. */
  setModel?(input: ConversationSetModelInput): Promise<ConversationTransportResult>
  /**
   * Set the reasoning effort the chat runs at from its next turn, on the
   * machine that keeps it; none is its provider's own default. Absent for a
   * chat here, whose record is the one the view writes and the runtime reads.
   * A paired machine's chat has it, offered where its session lists efforts,
   * which it does only where that machine takes the command
   * (`conversation-reasoning-effort`).
   */
  setReasoningEffort?(input: { sessionId: string; effort?: string }): Promise<ConversationTransportResult>
  // The chat's server holds its queue, keeps its scheduled messages and sends
  // the resume after a usage limit. Each call names the chat (`key`), as the
  // view keys every call; a paired machine's transport names it by its own key.
  /**
   * Hand a message to the server the chat runs on, to hold until the turn
   * ends and send then; answered once it holds it. Used where
   * `capabilities.hostQueue` is, with what it carries beside its words only
   * where `capabilities.hostQueueAttachments` is.
   */
  queue?(
    input: { key: ConversationKey } & Pick<
      ConversationSendRequest<ConversationImageAttachment>,
      'message' | 'attachments' | 'skills' | 'mentions' | 'files'
    >,
  ): Promise<ConversationTransportResult>
  /** Take back a message that server holds, by its id there. */
  cancelQueued?(input: { key: ConversationKey; queuedId: string }): Promise<ConversationTransportResult>
  /**
   * Stop the server the chat runs on watching one of its pull requests
   * (`pullRequests.unwatch` on its Studio). A server whose Studio does not
   * take it is refused in words.
   */
  unwatchPullRequest?(input: { key: ConversationKey; url: string }): Promise<ConversationTransportResult>
  /**
   * Have the server the chat runs on keep a message and send it at `sendAt`
   * (epoch ms), or when `untilLimitReset`'s usage limit resets; answered once
   * it keeps it. Used where `capabilities.hostSchedule` is.
   */
  scheduleSend?(input: {
    key: ConversationKey
    message: string
    sendAt: number
    untilLimitReset?: UsageLimitProvider
  }): Promise<ConversationTransportResult>
  /** Send a message that server keeps now (a refused one again), by its id there. */
  sendScheduledNow?(input: { key: ConversationKey; scheduledId: string }): Promise<ConversationTransportResult>
  /** Delete a message that server keeps, by its id there: Delete, and Edit's taking it back. */
  cancelScheduled?(input: { key: ConversationKey; scheduledId: string }): Promise<ConversationTransportResult>
  /**
   * Act on the notice a usage limit left on the chat's turn, on the machine
   * that sends its resume: schedule it (`always`: for every chat a limit
   * stops there), cancel, dismiss or retry it. Used where
   * `capabilities.hostUsageLimits` is.
   */
  usageLimitResume?(input: {
    key: ConversationKey
    action: MeshUsageLimitResumeAction
    always?: boolean
  }): Promise<ConversationTransportResult>
  /**
   * The files and folders in the chat's folder on the machine it runs on whose
   * names match `query`, by their paths relative to that folder. Present for a
   * paired machine's chat, used where `capabilities.mentions` is; a chat here
   * is searched through `services.files`.
   */
  searchMentions?(input: {
    query: string
  }): Promise<{ ok: true; entries: ConversationFileSearchEntry[] } | { ok: false; message: string }>
  /**
   * The slash commands the chat's CLI runs in its folder on the machine it
   * runs on, as that machine lists them; rejects with that machine's words
   * when it cannot. Present for a paired machine's chat, used where
   * `capabilities.commandList` is; a chat here reads `services.commands`.
   */
  listCommands?(input: { refresh?: boolean }): Promise<ConversationCommandCatalog>
  /**
   * A sent image by the reference its `user_message` recorded. A remote
   * conversation's are in the other machine's store, and are asked of it
   * (`conversation-message-images`); a machine that does not serve them
   * answers that it cannot, and the bubble says the image is over there.
   */
  attachment?(input: ConversationAttachmentInput): Promise<ConversationAttachmentResult>
  /**
   * Take the conversation back to before one of its user messages ("Edit
   * from here"). A paired machine's chat has it too, and its session declares
   * `rewind` only where that machine takes the command (`conversation-rewind`).
   * Offered only where the session declares `rewind` as well.
   */
  rewind?(input: ConversationRewindInput): Promise<ConversationRewindResult>
  /**
   * Hand the chat off to a fresh session pointed at a file of its messages,
   * instead of compacting it. A paired machine's chat has it too, and its
   * session declares `handoff` only where that machine takes the command
   * (`conversation-handoff`). Offered only where the session declares
   * `handoff` as well.
   */
  handoff?(input: ConversationHandoffInput): Promise<ConversationHandoffResult>
  /**
   * Start a new chat beside this one holding it up to an earlier message
   * ("Fork from here"). Absent where the transport cannot. A paired machine's
   * chat has it: the fork is made over there, beside the chat, and opens
   * here as a pane of its own onto that machine (`openPairedFork`); its
   * session declares `fork` only where that machine takes the command
   * (`conversation-fork`). The key a remote fork is handed is not the one it
   * forks: it names the chat by its ids over there. Offered only where the
   * session declares `fork` as well. The chat's Studio names the fork beside
   * the workspace's other chats and answers where it is (`conversation.fork`).
   */
  fork?(input: ChatForkInput): Promise<ChatForkResult>
  /**
   * A step's picture as a data URL, asked of the machine the conversation runs
   * on by the step's id. Absent for a local chat, which reads it off this disk.
   * `unsupported` is a machine that does not serve pictures: the picture stays
   * over there.
   */
  toolImage?(input: { toolUseId: string }): Promise<ConversationToolImageResult>
  /** Start the chat's provider session here. Present where `capabilities.startSession` is. */
  startSession?(input: ConversationStartSessionInput): Promise<ConversationStartSessionResult>
  /** Revert a turn's files from its checkpoint, or preview that. Used where `capabilities.checkpointRevert` is. */
  revert?(input: ConversationRevertInput): Promise<ConversationRevertResult>
  /**
   * Stop one running agent the chat spawned, by its lane, leaving the chat and
   * its turn running. Absent where the transport cannot: a window on the
   * Studio protocol, which has no method for it yet. A paired machine's chat
   * has it, and its session declares `stopSubagent` only where that machine
   * takes the command (`conversation-stop-subagent`). Offered only where the
   * session declares `stopSubagent` as well.
   */
  stopSubagent?(input: ConversationStopSubagentInput): Promise<ConversationTransportResult>
  /**
   * Pass the person's words to one agent the chat spawned, through the chat's
   * model. Absent where the transport cannot, as `stopSubagent` is. A paired
   * machine's chat has it, and its session declares `messageSubagent` only
   * where that machine takes the command (`conversation-agent-message`).
   * Offered only where the session declares `messageSubagent` as well.
   */
  messageSubagent?(input: ConversationMessageSubagentInput): Promise<ConversationTransportResult>
  /**
   * End the chat's agent session on the server it runs on, keeping the
   * conversation, so the next message starts it again
   * (`conversation.restartSession`): answered with a `notice` where it had
   * none running, and nothing was done. Used where
   * `capabilities.restartSession` is.
   */
  restartSession?(input: { key: ConversationKey }): Promise<ConversationTransportResult>
  /**
   * Reconnect, switch or sign in to one of a live chat's MCP servers, where
   * the session lists the action (`capabilities.mcpServerActions`). A paired
   * machine's chat has it too, its session listing an action only where that
   * machine takes the command (`conversation-mcp-server-actions`), and never
   * a sign-in, whose callback that machine's CLI waits for there.
   */
  mcpServerAction?(input: ConversationMcpServerActionInput): Promise<ConversationMcpServerActionResult>
  /**
   * Ask a side question about the chat: answered from its context, added to
   * nothing, a running turn left as it was. Absent where the transport
   * cannot, as `stopSubagent` is. A paired machine's chat has it, asked of
   * its agent over there, and its session declares `sideQuestion` only where
   * that machine answers one (`conversation-side-questions`). Offered only
   * where the session declares `sideQuestion` as well.
   */
  askSideQuestion?(input: ConversationSideQuestionInput): Promise<ConversationSideQuestionResult>
  /** Call off a side question still being answered. Present wherever `askSideQuestion` is. */
  cancelSideQuestion?(
    input: ConversationCancelSideQuestionInput,
  ): Promise<{ ok: true } | { ok: false; message: string }>
  /**
   * What fills the chat's context window, as its agent measures it. Absent
   * where the transport cannot ask, as `stopSubagent` is; the ring then opens
   * on the total alone. A paired machine's chat has it, read from its agent
   * over there, and its session declares `contextBreakdown` only where that
   * machine says (`conversation-context-breakdown`). Asked only where the
   * session declares `contextBreakdown` as well.
   */
  readContextBreakdown?(input: ConversationContextBreakdownInput): Promise<ConversationContextBreakdownResult>
  /**
   * The Studio this window belongs to: providers, files, plans and command
   * lists. The same for every chat in the window, whichever machine it runs on.
   */
  services: ChatServices
}

export type ConversationToolImageResult =
  { ok: true; src: string } | { ok: false; unsupported: boolean; message: string }

/** This window's Studio implementation's parts, read at call time so a replaced client is the one used. */
const localParts = () => studioImplementation().parts

// Each call is answered by this window's Studio implementation, read when it
// is made; the object itself never changes, so what is keyed by it (a shared
// subscription, a picture cache) stays put.
const windowServices: ChatServices = {
  providers: {
    list: (input) => windowChatServices().providers.list(input),
    models: (input) => windowChatServices().providers.models(input),
    secretStatus: (input) => windowChatServices().providers.secretStatus(input),
    signIn: (input) => windowChatServices().providers.signIn(input),
    setSecret: (input) => windowChatServices().providers.setSecret(input),
    clearSecret: (input) => windowChatServices().providers.clearSecret(input),
  },
  files: {
    get canStat() {
      return windowChatServices().files.canStat
    },
    search: (rootPath, query, options) => windowChatServices().files.search(rootPath, query, options),
    cancelSearch: (channel) => windowChatServices().files.cancelSearch(channel),
    stat: (path) => windowChatServices().files.stat(path),
    readImage: (path) => windowChatServices().files.readImage(path),
    repoRoot: (folderPath, hostId) => windowChatServices().files.repoRoot(folderPath, hostId),
  },
  planDocument: (input) => windowChatServices().planDocument(input),
  commands: {
    get list() {
      return windowChatServices().commands.list
    },
    get onChanged() {
      return windowChatServices().commands.onChanged
    },
  },
  sessions: {
    list: (input) => windowChatServices().sessions.list(input),
    stop: (input) => windowChatServices().sessions.stop(input),
    suspend: (input) => windowChatServices().sessions.suspend(input),
    terminalHandoff: (input) => windowChatServices().sessions.terminalHandoff(input),
    onLifecycleEvent: (listener, onReconnected) =>
      windowChatServices().sessions.onLifecycleEvent(listener, onReconnected),
  },
  history: {
    threads: (input) => windowChatServices().history.threads(input),
    search: (input) => windowChatServices().history.search(input),
    cancelSearch: (requestId) => windowChatServices().history.cancelSearch(requestId),
  },
  approvalRules: {
    list: () => windowChatServices().approvalRules.list(),
    revoke: (ruleId) => windowChatServices().approvalRules.revoke(ruleId),
  },
}

/**
 * A chat on this window's Studio, whose capabilities are read off the welcome
 * `welcome` answers when asked (the window's latest): read again only when
 * that changes.
 */
export function studioConversationTransport(
  welcome: () => Pick<StudioWelcomeFrame, 'capabilities' | 'conversation' | 'grant' | 'environment'> | null,
): ConversationTransport {
  let said: { welcome: object | null; capabilities: ConversationTransportCapabilities } | null = null
  // Held while the id is, as views key memos on it.
  let where: ChatEnvironment | null = null
  return {
    ...windowConversationCalls,
    get capabilities() {
      const now = welcome()
      if (said?.welcome !== now)
        said = { welcome: now, capabilities: negotiateChatCapabilities(now ? { via: 'studio', welcome: now } : null) }
      return said.capabilities
    },
    get environment() {
      const id = welcome()?.environment.id ?? null
      if (where?.id !== id) where = { id, label: null, lane: null }
      return where
    },
  }
}

const windowConversationCalls: Omit<ConversationTransport, 'capabilities' | 'environment'> = {
  subscribe: (input, cb) => localParts().subscribe(input, cb),
  loadEarlier: (input) => localParts().loadEarlier(input),
  toolDetail: (input) => localParts().toolDetail(input),
  readEvent: (input) => localParts().readEvent(input),
  turnDiff: (input) => localParts().turnDiff(input),
  send: (input) => localParts().send(input),
  interrupt: (input) => localParts().interrupt(input),
  respond: (input) => localParts().respond(input),
  setPermissionPreset: (input) => localParts().setPermissionPreset(input),
  setModel: (input) => localParts().setModel(input),
  attachment: (input) => localParts().attachment(input),
  rewind: (input) => localParts().rewind(input),
  handoff: (input) => localParts().handoff(input),
  fork: (input) => localParts().fork(input),
  startSession: (input) => localParts().startSession(input),
  revert: (input) => localParts().revert(input),
  mcpServerAction: (input) => localParts().mcpServerAction(input),
  stopSubagent: (input) => localParts().stopSubagent(input),
  messageSubagent: (input) => localParts().messageSubagent(input),
  askSideQuestion: (input) => localParts().askSideQuestion(input),
  cancelSideQuestion: (input) => localParts().cancelSideQuestion(input),
  readContextBreakdown: (input) => localParts().readContextBreakdown(input),
  queue: (input) => localParts().queue(input),
  restartSession: (input) => localParts().restartSession(input),
  unwatchPullRequest: async ({ key, url }) => {
    const stopped = await unwatchConversationPullRequest({ workspaceId: key.workspaceId, agentId: key.agentId }, url)
    return stopped.ok ? { ok: true } : { ok: false, message: stopped.message }
  },
  pullRequestHost: (key) => studioPullRequestHost({ workspaceId: key.workspaceId, agentId: key.agentId }),
  cancelQueued: (input) => localParts().cancelQueued(input),
  scheduleSend: (input) => localParts().scheduleSend(input),
  sendScheduledNow: (input) => localParts().sendScheduledNow(input),
  cancelScheduled: (input) => localParts().cancelScheduled(input),
  usageLimitResume: (input) => localParts().usageLimitResume(input),
  services: windowServices,
}

export const localConversationTransport: ConversationTransport = studioConversationTransport(() => readWelcome())

/** Where to fork a chat, and the new chat's id; the Studio that holds it names it. */
export type ChatForkInput = ConversationForkInput extends infer Fork
  ? Fork extends unknown
    ? Omit<Fork, 'title'>
    : never
  : never

/**
 * A fork made: where it is and what it was called, as a Studio answers
 * `conversation.fork`. A paired machine's lane says neither, so a fork made
 * there is found by its id in that machine's list (`openPairedFork`).
 */
export type ChatForkResult = { ok: true; address?: ConversationAddress; name?: string } | { ok: false; message: string }

const ConversationTransportContext = createContext<ConversationTransport>(localConversationTransport)

export const ConversationTransportProvider = ConversationTransportContext.Provider

const windowApi = (): object | null =>
  typeof window === 'undefined' ? null : ((window.api as object | undefined) ?? null)
const watchWelcome = (listener: () => void) => {
  const api = windowApi()
  return api ? watchWindowStudioWelcome(api, listener) : () => undefined
}
const readWelcome = () => {
  const api = windowApi()
  return api ? windowStudioWelcome(api) : null
}

/**
 * The chat's transport, and a render whenever the window's Studio welcomes it
 * again: what a chat here may do is read off that welcome.
 */
export function useConversationTransport(): ConversationTransport {
  useSyncExternalStore(watchWelcome, readWelcome, readWelcome)
  return useContext(ConversationTransportContext)
}

/**
 * What a paired machine's chat's command list is kept under in this window:
 * the chat itself, as no folder of this disk names it, so two of that
 * machine's chats in different folders never share a list.
 */
export function remoteCommandsFolder(key: MeshConversationKey): string {
  return `mesh:${key.connectionId}/${key.workspaceId}/${key.agentId}`
}

const commandResult = (result: MeshConversationCommandResult): ConversationTransportResult =>
  result.ok ? { ok: true, ...(result.notice ? { notice: result.notice } : {}) } : { ok: false, message: result.message }

/**
 * A conversation on a paired machine, over the Mesh. The key it was made for
 * is the one every call names: the local key a view passes carries this
 * machine's idea of a workspace root, which means nothing over there.
 * `onLink` receives the connection state main narrates beside the frames, and
 * `onQueued` what the machine holds for the conversation's turn to end, and
 * `onScheduled` what it keeps for a time, `onUsageLimits` what it knows of
 * its usage limits for it, and `onSubagents` which sub-agents the chat has.
 */
export function createRemoteConversationTransport(input: {
  key: MeshConversationKey
  machineName: string
  /**
   * The id that machine's Studio said it is, read whenever the environment
   * is; null until it has said one.
   */
  environmentId?: () => string | null
  /**
   * What the machine last said of itself and what this pairing may do there,
   * read whenever the capabilities are; null before it has said anything.
   */
  offer?: () => Extract<ChatServerOffer, { via: 'paired-lane' }> | null
  onLink?: (link: MeshConversationLink) => void
  onQueued?: (messages: MeshQueuedMessage[]) => void
  onScheduled?: (messages: MeshScheduledMessage[]) => void
  onUsageLimits?: (said: MeshConversationUsageLimits) => void
  onSubagents?: (subagents: MeshSubagent[]) => void
  /** The machine recorded a pull request Create PR opened there as the chat's. */
  onPullRequestRecorded?: () => void
}): ConversationTransport {
  const { key } = input
  let said: { offer: ChatServerOffer | null; capabilities: ConversationTransportCapabilities } | null = null
  const pullRequests = remotePullRequestHost(key, () => input.onPullRequestRecorded?.())
  const lane = { connectionId: key.connectionId, workspaceId: key.workspaceId, commandsKey: remoteCommandsFolder(key) }
  let where: ChatEnvironment | null = null
  return {
    // Read off what the machine last said of itself, each time asked: the
    // pane hears its list again on a grant change or a reconnect.
    get capabilities() {
      const offer = input.offer?.() ?? null
      if (said?.offer !== offer) said = { offer, capabilities: negotiateChatCapabilities(offer) }
      return said.capabilities
    },
    // Named by what the person calls the machine, and by the id its Studio
    // said, once it has: held while that id is, as views key memos on it.
    get environment() {
      const id = input.environmentId?.() ?? null
      if (where?.id !== id) where = { id, label: input.machineName, lane }
      return where
    },
    // Every step over there, under the chat's key there, whatever the view names.
    pullRequestHost: () => pullRequests,
    subscribe: (subscription, cb) =>
      window.api.onMeshConversationSession({ key, turnLimit: subscription.turnLimit }, (frame) => {
        if (frame.type === 'link') input.onLink?.(frame)
        else if (frame.type === 'queued') input.onQueued?.(frame.messages)
        else if (frame.type === 'scheduled') input.onScheduled?.(frame.messages)
        else if (frame.type === 'usageLimits') input.onUsageLimits?.(frame)
        else if (frame.type === 'subagents') input.onSubagents?.(frame.subagents)
        // A chat's changes are read by the Diff tab, which follows for itself.
        else if (frame.type === 'changes') return
        else cb(frame)
      }),
    loadEarlier: (page) =>
      window.api.meshConversationLoadEarlier({ key, beforeCursor: page.beforeCursor, turnLimit: page.turnLimit }),
    toolDetail: (detail) => window.api.meshConversationToolDetail({ key, toolUseId: detail.toolUseId }),
    readEvent: (read) => window.api.meshConversationEvent({ key, seq: read.seq, id: read.id }),
    turnDiff: (diff) => window.api.meshConversationTurnDiff({ key, turnSeq: diff.turnSeq, path: diff.path }),
    // The request goes as a chat here sends it: main puts its pictures and
    // files in that machine's upload store first, names its skills by id and
    // refuses in words a part the machine would drop. What only this
    // machine's runtime reads stays here, and the bubble's id and the effort
    // the lane says its own way (`ConversationLaneNotCarried`).
    send: async (turn) => {
      const {
        sessionId: _sessionId,
        commandId: _commandId,
        commandFingerprint: _fingerprint,
        origin: _origin,
        subagentMessage: _subagentMessage,
        localTurnId: _localTurnId,
        reasoningEffort: _reasoningEffort,
        ...request
      } = turn
      return commandResult(await window.api.meshConversationSend({ key, ...conciseConversationSendRequest(request) }))
    },
    // What it carries goes up first, as a send's does, and the machine keeps
    // it with the message; main refuses it in words for one that would not.
    queue: async ({ key: _viewKey, ...turn }) =>
      commandResult(
        await window.api.meshConversationSend({ key, ...conciseConversationSendRequest(turn), queue: true }),
      ),
    cancelQueued: async (held) =>
      commandResult(await window.api.meshConversationCancelQueued({ key, queuedId: held.queuedId })),
    searchMentions: async ({ query }) => {
      const result = await window.api.meshConversationSearchFiles({ key, query })
      return result.ok ? { ok: true, entries: result.entries } : { ok: false, message: result.message }
    },
    // Kept as this window keeps a list read here: under the chat's own key,
    // never a folder of this disk's (`remoteCommandsFolder`).
    listCommands: async ({ refresh }) => {
      const result = await window.api.meshConversationCommands({ key, ...(refresh ? { refresh: true } : {}) })
      if (!result.ok) throw new Error(result.message)
      return {
        cli: result.cli,
        cwd: remoteCommandsFolder(key),
        commands: result.commands,
        fetchedAt: result.fetchedAt,
        ...(result.error ? { error: result.error } : {}),
      }
    },
    scheduleSend: async (scheduled) =>
      commandResult(
        await window.api.meshConversationScheduleSend({
          key,
          message: scheduled.message,
          sendAt: scheduled.sendAt,
          ...(scheduled.untilLimitReset ? { untilLimitReset: scheduled.untilLimitReset } : {}),
        }),
      ),
    sendScheduledNow: async (scheduled) =>
      commandResult(await window.api.meshConversationSendScheduledNow({ key, scheduledId: scheduled.scheduledId })),
    cancelScheduled: async (scheduled) =>
      commandResult(await window.api.meshConversationCancelScheduled({ key, scheduledId: scheduled.scheduledId })),
    usageLimitResume: async (resume) =>
      commandResult(
        await window.api.meshConversationUsageLimitResume({
          key,
          action: resume.action,
          ...(resume.always ? { always: true } : {}),
        }),
      ),
    unwatchPullRequest: async (asked) => {
      // The pull request's, on that machine's Studio, asked by this window itself.
      const answer = await changePairedChat({ id: key.connectionId, machineName: input.machineName }, key.workspaceId, {
        kind: 'unwatch-pull-request',
        agentId: key.agentId,
        url: asked.url,
      })
      return answer.ok ? { ok: true } : { ok: false, message: answer.message }
    },
    interrupt: async () => commandResult(await window.api.meshConversationInterrupt({ key })),
    restartSession: async () => commandResult(await window.api.meshConversationRestartSession({ key })),
    // Offered only for an action the pane's session lists, which it does
    // where the machine takes the command; a sign-in never is.
    mcpServerAction: async (asked) => {
      if (asked.action === 'sign-in')
        return {
          ok: false,
          message: `Sign in to ${asked.serverId} on ${input.machineName}: its agent waits for the sign-in there.`,
        }
      const done = await window.api.meshConversationMcpServerAction({
        key,
        serverId: asked.serverId,
        action: asked.action,
      })
      return done.ok ? { ok: true } : { ok: false, message: done.message }
    },
    // Offered only where the machine takes it and lists the chat's provider
    // as able (the pane's session says `stopSubagent`).
    stopSubagent: async (input) =>
      commandResult(await window.api.meshConversationStopSubagent({ key, toolUseId: input.toolUseId })),
    // Offered only where the machine takes it and lists the chat's provider
    // as able (the pane's session says `messageSubagent`).
    messageSubagent: async (input) =>
      commandResult(
        await window.api.meshConversationMessageSubagent({
          key,
          toolUseId: input.toolUseId,
          message: input.message,
        }),
      ),
    // Offered only where the machine takes it and lists the chat's provider as
    // able (the pane's session says `handoff`). The file is written over
    // there, so its path means nothing here.
    handoff: async () => {
      const handed = await window.api.meshConversationHandoff({ key })
      return handed.ok ? { ok: true, path: '' } : { ok: false, message: handed.message }
    },
    // Offered only where the machine takes it and lists the chat's provider
    // as able (the pane's session says `rewind`).
    rewind: async (turn) => {
      const rewound = await window.api.meshConversationRewind({ key, turnSeq: turn.turnSeq })
      return rewound.ok ? { ok: true } : { ok: false, message: rewound.message }
    },
    // Used only where the machine reverts files itself (the pane turns
    // `checkpointRevert` on). The paths are that machine's checkout's, shown
    // in the dialog and sent back as they came, never looked for here.
    revert: async (turn) => {
      const result = await window.api.meshConversationRevert({
        key,
        turnSeq: turn.turnSeq,
        ...(turn.undo ? { undo: true } : {}),
        ...(turn.confirmed ? { confirmed: true, files: turn.files ?? [] } : {}),
      })
      const answer = parseConversationRevertAnswer(result.data)
      if (!result.ok)
        return { ok: false, message: result.message, ...(answer && 'changed' in answer ? { changed: true } : {}) }
      if (!answer || 'changed' in answer)
        return { ok: false, message: `${input.machineName} answered with files this build cannot read.` }
      return { ok: true, ...answer }
    },
    // Each of these offered only where the machine takes it and lists the
    // chat's provider as able (the pane's session says `fork`, `sideQuestion`,
    // `contextBreakdown`). Every one names the chat by its ids over there; the
    // session id a view passes is the list's, which means nothing to them.
    fork: async (fork) => {
      const forked = await window.api.meshConversationFork({
        key,
        fork:
          fork.side === 'user'
            ? { kind: 'fork', newAgentId: fork.newAgentId, side: 'user', turnSeq: fork.turnSeq }
            : { kind: 'fork', newAgentId: fork.newAgentId, side: 'assistant', turnId: fork.turnId },
      })
      return forked.ok ? { ok: true } : { ok: false, message: forked.message }
    },
    askSideQuestion: (question) =>
      window.api.meshConversationSideQuestion({
        key,
        requestId: question.requestId,
        question: question.question,
        ...(question.history?.length ? { history: question.history } : {}),
      }),
    cancelSideQuestion: (question) =>
      window.api.meshConversationCancelSideQuestion({ key, requestId: question.requestId }),
    readContextBreakdown: () => window.api.meshConversationContextBreakdown({ key }),
    respond: async (response) => {
      if (response.answers && response.approved)
        return commandResult(
          await window.api.meshConversationAnswerQuestion({
            key,
            requestId: response.requestId,
            answers: response.answers,
          }),
        )
      // "Always" is offered only where the machine saves the rule
      // (`permanentApprovals`); main refuses it in words for one that would not.
      const decision = !response.approved
        ? 'deny'
        : response.decision === 'always' || response.decision === 'conversation'
          ? response.decision
          : 'once'
      return commandResult(
        await window.api.meshConversationResolveApproval({ key, requestId: response.requestId, decision }),
      )
    },
    // The CLI's own mode rides beside its preset where the chat's session
    // lists any, which the pane does only for a machine that runs them.
    setPermissionPreset: async (change) =>
      commandResult(
        await window.api.meshConversationSetPermissionPreset({
          key,
          preset: change.permissionPreset,
          ...(change.permissionMode ? { permissionMode: change.permissionMode } : {}),
        }),
      ),
    // Offered only while the machine advertises model switching; the pane turns
    // `modelSwitch` on from its list, and the chip stays locked without it.
    setModel: async (change) =>
      commandResult(await window.api.meshConversationSetModel({ key, modelId: change.modelId })),
    // That machine keeps the chat's effort and sends each turn at it, so the
    // send leaves it out.
    setReasoningEffort: async (change) =>
      commandResult(
        await window.api.meshConversationSetReasoningEffort({
          key,
          ...(change.effort ? { effort: change.effort } : {}),
        }),
      ),
    toolImage: async (image) => {
      const result = await window.api.meshConversationToolImage({ key, toolUseId: image.toolUseId })
      return result.ok
        ? { ok: true, src: result.dataUrl }
        : { ok: false, unsupported: result.code === 'images_unsupported', message: result.message }
    },
    attachment: async (stored) => {
      const result = await window.api.meshConversationAttachment({ key, ref: stored.ref })
      const picture = result.ok ? /^data:([^;,]+);base64,(.*)$/su.exec(result.dataUrl) : null
      return picture
        ? { ok: true, mediaType: picture[1]!, dataBase64: picture[2]! }
        : { ok: false, message: result.ok ? 'The picture could not be read.' : result.message }
    },
    // A chat followed from a paired machine still reads this window's Studio
    // for providers, files, plans and command lists, as it always has.
    services: windowServices,
  }
}
