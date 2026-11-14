import { createContext, useContext, useSyncExternalStore } from 'react'

import { negotiateChatCapabilities, type ChatCapabilities } from '../../../../../../packages/client-runtime/src/public'
import { watchWindowStudioWelcome, windowStudioWelcome } from '../../../studio/windowStudioClient'
import { followWindowStudioPush } from '../../../studio/windowStudioPush'
import type { EnvironmentId, StudioWelcomeFrame } from '../../../../../../packages/studio-protocol/src/public'

import type { ChatServices } from './chatServices'
import type { StudioTransportParts } from './studioChat'
import { windowChatServices, windowStudioImplementation as studioImplementation } from './windowChat'
import { studioPullRequestHost, type PullRequestHost } from './pullRequestHost'
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
import type { ConversationCommandCatalog } from '../../../../../shared/conversation/commands'
import type { ConversationAddress } from '../../../../../../packages/studio-protocol/src/public'
import type { UsageLimitProvider } from '../../../../../shared/usage-limits'
import type { ConversationFileSearchEntry } from '../../../../../../packages/conversation-protocol/src/public'
import type { MeshUsageLimitResumeAction } from '../../../../../shared/tailnet-mesh'

// Where a chat view's conversation lives. The view — its transcript, pending
// dock, composer — is the same whether the conversation runs on this machine
// or on another; only the calls behind it differ. Every transport is a client
// of the Studio that holds the chat, over the Studio protocol: the window's
// own, an SSH machine's or a paired desktop's (`pairedChat.ts`), over this
// window's own client of it.
//
// What a transport can do is said by its capabilities, which every transport
// reads from what the chat's server said (`negotiateChatCapabilities`): a
// window's own Studio's welcome, a paired machine's, an embed's.
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
   * The Studio's id (`welcome.environment.id`). Null before its welcome. What
   * the window and its shell reach of the chat's disk is asked of this
   * (`useShellReach`).
   */
  // The one identity type an environment has (env-identity), never a second.
  readonly id: EnvironmentId | null
  /**
   * What the person calls the machine, where it is not the window's own
   * Studio (a paired machine's name); null for the window's own, which the
   * view calls Studio.
   */
  readonly label: string | null
  /**
   * The route this window reaches the environment by (`tailnet:<pairing>`,
   * `ssh:<machine>`, …: `formatEnvironmentRoute`); null for the window's own
   * Studio. What is asked of that environment beside the chat's own calls (a
   * paired desktop's skills and MCP servers, the pane a fork it made opens
   * as) is asked by it.
   */
  readonly route: string | null
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
  followPush: followWindowStudioPush,
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

/** What a transport over one Studio is built from: its chat parts and services, read at each call. */
export type StudioTransportImplementation = {
  parts: () => StudioTransportParts
  services: ChatServices
  /** Stop the Studio watching one of the chat's pull requests. */
  unwatchPullRequest(input: { key: ConversationKey; url: string }): Promise<ConversationTransportResult>
  /** Where Create PR does its work, for a Studio whose checkout this window's shell reaches. */
  pullRequestHost?(key: ConversationKey): PullRequestHost
  /** What the person calls the machine (`ChatEnvironment.label`); absent for the window's own Studio. */
  label?: string
  /** The route this window reaches it by (`ChatEnvironment.route`); absent for the window's own Studio. */
  route?: string
}

/**
 * A chat on one Studio over the protocol, whose capabilities are read off the
 * welcome `welcome` answers when asked (that Studio's latest): read again only
 * when that changes. The window's own Studio by default; an environment's
 * (`environmentChat.ts`) is the same transport over that environment's client.
 */
export function studioConversationTransport(
  welcome: () => Pick<StudioWelcomeFrame, 'capabilities' | 'conversation' | 'grant' | 'environment'> | null,
  implementation: StudioTransportImplementation = windowImplementation,
): ConversationTransport {
  let said: { welcome: object | null; capabilities: ConversationTransportCapabilities } | null = null
  // Held while the id is, as views key memos on it.
  let where: ChatEnvironment | null = null
  return {
    ...studioCalls(implementation),
    get capabilities() {
      const now = welcome()
      if (said?.welcome !== now)
        said = { welcome: now, capabilities: negotiateChatCapabilities(now ? { via: 'studio', welcome: now } : null) }
      return said.capabilities
    },
    get environment() {
      const id = welcome()?.environment.id ?? null
      if (where?.id !== id) where = { id, label: implementation.label ?? null, route: implementation.route ?? null }
      return where
    },
  }
}

function studioCalls(
  implementation: StudioTransportImplementation,
): Omit<ConversationTransport, 'capabilities' | 'environment'> {
  const parts = implementation.parts
  return {
    subscribe: (input, cb) => parts().subscribe(input, cb),
    loadEarlier: (input) => parts().loadEarlier(input),
    toolDetail: (input) => parts().toolDetail(input),
    readEvent: (input) => parts().readEvent(input),
    turnDiff: (input) => parts().turnDiff(input),
    send: (input) => parts().send(input),
    interrupt: (input) => parts().interrupt(input),
    respond: (input) => parts().respond(input),
    setPermissionPreset: (input) => parts().setPermissionPreset(input),
    setModel: (input) => parts().setModel(input),
    attachment: (input) => parts().attachment(input),
    rewind: (input) => parts().rewind(input),
    handoff: (input) => parts().handoff(input),
    fork: (input) => parts().fork(input),
    startSession: (input) => parts().startSession(input),
    revert: (input) => parts().revert(input),
    mcpServerAction: (input) => parts().mcpServerAction(input),
    stopSubagent: (input) => parts().stopSubagent(input),
    messageSubagent: (input) => parts().messageSubagent(input),
    askSideQuestion: (input) => parts().askSideQuestion(input),
    cancelSideQuestion: (input) => parts().cancelSideQuestion(input),
    readContextBreakdown: (input) => parts().readContextBreakdown(input),
    queue: (input) => parts().queue(input),
    restartSession: (input) => parts().restartSession(input),
    unwatchPullRequest: (input) => implementation.unwatchPullRequest(input),
    ...(implementation.pullRequestHost
      ? { pullRequestHost: (key: ConversationKey) => implementation.pullRequestHost!(key) }
      : {}),
    cancelQueued: (input) => parts().cancelQueued(input),
    scheduleSend: (input) => parts().scheduleSend(input),
    sendScheduledNow: (input) => parts().sendScheduledNow(input),
    cancelScheduled: (input) => parts().cancelScheduled(input),
    usageLimitResume: (input) => parts().usageLimitResume(input),
    services: implementation.services,
  }
}

const windowImplementation: StudioTransportImplementation = {
  parts: localParts,
  services: windowServices,
  unwatchPullRequest: async ({ key, url }) => {
    const stopped = await unwatchConversationPullRequest({ workspaceId: key.workspaceId, agentId: key.agentId }, url)
    return stopped.ok ? { ok: true } : { ok: false, message: stopped.message }
  },
  pullRequestHost: (key) => studioPullRequestHost({ workspaceId: key.workspaceId, agentId: key.agentId }),
}

export const localConversationTransport: ConversationTransport = studioConversationTransport(() => readWelcome())

/** Where to fork a chat, and the new chat's id; the Studio that holds it names it. */
export type ChatForkInput = ConversationForkInput extends infer Fork
  ? Fork extends unknown
    ? Omit<Fork, 'title'>
    : never
  : never

/** A fork made: where it is and what it was called, as a Studio answers `conversation.fork`. */
export type ChatForkResult = { ok: true; address: ConversationAddress; name: string } | { ok: false; message: string }

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
