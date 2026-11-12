import { createStudioChatBackend } from '../src/main/studio-rpc/studio-chat-backend'
import { createTicketAuthenticator, framePortStream, mintStudioTicket } from '../src/server/rpc/studio-frame-port'
import { createStudioRpcServer, type StudioRpcServer } from '../src/server/rpc/studio-rpc-server'
import type { StudioPullRequests } from '../src/server/pull-requests/pull-request-domain'
import type { StudioConversationBackend } from '../src/server/rpc/studio-rpc-types'
import type { ConversationSessionFrame } from '../src/shared/conversation-runtime'
import { configureWindowStudio } from '../src/renderer/src/studio/windowStudioClient'
import { createMemoryChannel, type MemoryChannelEnd } from './memory-channel'
import { memoryWebSocketClass } from './memory-websocket'

// The chat view's own tests, run a second time with the window on the Studio
// protocol. A test stubs `window.api` with the conversation IPC it means to
// script, as it always has; this puts a real Studio RPC between the view and
// that stub: the window's client and transport, a socket, the connection and
// router, and main's chat backend with its input checks, all answered in the
// end by the same stubbed members. A test that passes both ways shows the
// protocol path changes nothing the view does.
//
// What the window reaches only over the protocol (its chat services: session
// list, stop, suspend, history, approval rules, providers and keys, plans, the
// `/` lists) is served here in every run. The stubs keep the names the IPC
// members had (`conversationSessionsList`, `onConversationEvent`, ...), which
// no preload has any more: they are this harness's names for the backend.
//
// The `chat-over-studio` Vitest project sets STUDIO_CHAT_TRANSPORT_UNDER_TEST;
// in every other run this does nothing.

type Api = Record<string, unknown>

export function chatOverStudioUnderTest(): boolean {
  return process.env.STUDIO_CHAT_TRANSPORT_UNDER_TEST === 'studio'
}

/** A stubbed IPC member, read when it is called so a test may swap it mid-way. */
function call(api: Api, name: string, ...args: unknown[]): Promise<never> {
  const member = api[name]
  if (typeof member !== 'function') return Promise.reject(new Error(`window.api.${name} is not stubbed`))
  return Promise.resolve((member as (...values: unknown[]) => unknown)(...args)) as Promise<never>
}
const has = (api: Api, name: string) => typeof api[name] === 'function'
/** A stubbed IPC member taking one input, or undefined where the test stubs none. */
const optional = (api: Api, name: string) =>
  has(api, name) ? (input: unknown): Promise<never> => call(api, name, input) : undefined
/** A stubbed IPC subscription, or one that hears nothing where the test stubs none. */
function subscribeTo<T>(api: Api, name: string, listener: (value: T) => void): () => void {
  const subscribe = api[name] as ((cb: (value: T) => void) => unknown) | undefined
  const stop = typeof subscribe === 'function' ? subscribe(listener) : undefined
  return () => (typeof stop === 'function' ? stop() : undefined)
}

function conversationsOver(api: Api): StudioConversationBackend {
  return {
    list: async () => [],
    // A window names every conversation by its folder; nothing is resolved by workspace here.
    resolveKey: () => null,
    follow(key, cursor, listener) {
      const stop = (
        api.onConversationSession as (input: unknown, cb: (frame: ConversationSessionFrame) => void) => unknown
      )({ key, ...cursor }, listener)
      return { dispose: () => (typeof stop === 'function' ? stop() : undefined), ready: Promise.resolve() }
    },
    loadEarlier: (key, beforeCursor, turnLimit) =>
      call(api, 'conversationLoadEarlier', { key, beforeCursor, turnLimit }),
    toolDetail: (key, toolUseId) => call(api, 'conversationToolDetail', { ...key, toolUseId }),
    event: (key, seq, id) => call(api, 'conversationEvent', { ...key, seq, id }),
    turnDiff: (key, turnSeq, path) => call(api, 'conversationTurnDiff', { key, turnSeq, path }),
    command: async () => ({ ok: false, code: 'unavailable', message: 'A window drives a chat by its session.' }),
    stop: async () => ({ ok: true }),
    permissionOf: () => 'bypass',
    findCreated: () => null,
    create: async () => ({ ok: false, code: 'unavailable', message: 'A window starts a chat by its session.' }),
    redact: (value) => value,
  }
}

type Commanded = { sessionId: string; commandId?: string; commandFingerprint?: string }

/**
 * The runtime's command receipts, as it keeps them: a session command's id is
 * answered with its first result for every repeat (a request resent after a
 * dropped connection), and the same id for a different command is refused.
 * The stubs stand in for the IPC, whose runtime never sees an id, so they are
 * called once per command and without its id or fingerprint, as over IPC.
 */
function receiptsKeeper() {
  const kept = new Map<string, { fingerprint: string | undefined; result: Promise<never> }>()
  const keyOf = (sessionId: string, commandId: string) => `${sessionId}:${commandId}`
  return {
    run<T extends Commanded>(input: T, carry: (input: Omit<T, 'commandId' | 'commandFingerprint'>) => Promise<never>) {
      const { commandId, commandFingerprint, ...rest } = input
      if (commandId === undefined) return carry(rest)
      const key = keyOf(input.sessionId, commandId)
      const known = kept.get(key)
      if (known) {
        if (commandFingerprint && known.fingerprint && known.fingerprint !== commandFingerprint)
          return Promise.resolve({
            ok: false,
            code: 'command_id_conflict',
            message: 'That command id was already used for a different command.',
          } as never)
        return known.result
      }
      const result = carry(rest)
      kept.set(key, { fingerprint: commandFingerprint, result })
      return result
    },
    has: async (sessionId: string, commandId: string) => kept.has(keyOf(sessionId, commandId)),
  }
}

function chatOver(api: Api) {
  const receipts = receiptsKeeper()
  return createStudioChatBackend({
    conversation: {
      startSession: (input) => call(api, 'conversationSessionStart', input),
      sendTurn: (input) => receipts.run(input, (rest) => call(api, 'conversationSessionSendTurn', rest)),
      interrupt: (input) => receipts.run(input, (rest) => call(api, 'conversationSessionInterrupt', rest)),
      respondToRequest: (input) =>
        receipts.run(input, (rest) => call(api, 'conversationSessionRespondToRequest', rest)),
      setPermission: (input) => receipts.run(input, (rest) => call(api, 'conversationSessionSetPermission', rest)),
      get setModel() {
        return has(api, 'conversationSessionSetModel')
          ? (input: Commanded) => receipts.run(input, (rest) => call(api, 'conversationSessionSetModel', rest))
          : undefined
      },
      get revertToTurn() {
        return has(api, 'conversationRevertToTurn')
          ? (input: unknown) => call(api, 'conversationRevertToTurn', input)
          : undefined
      },
      get rewindToTurn() {
        return has(api, 'conversationRewindToTurn')
          ? (input: unknown) => call(api, 'conversationRewindToTurn', input)
          : undefined
      },
      get handoffConversation() {
        return has(api, 'conversationHandoff') ? (input: unknown) => call(api, 'conversationHandoff', input) : undefined
      },
      get forkAtTurn() {
        return has(api, 'conversationForkAtTurn')
          ? (input: unknown) => call(api, 'conversationForkAtTurn', input)
          : undefined
      },
      get readAttachment() {
        return has(api, 'conversationAttachment')
          ? (ref: string) => call(api, 'conversationAttachment', { ref })
          : undefined
      },
      get planDocument() {
        return has(api, 'conversationPlanDocument')
          ? (input: unknown) => call(api, 'conversationPlanDocument', input)
          : undefined
      },
      listProviders: (input) => call(api, 'conversationProvidersList', input),
      listProviderModels: (input) => call(api, 'conversationProviderModels', input),
      getSecretStatus: (input) => call(api, 'conversationSecretStatus', input),
      setSecret: (input) => call(api, 'conversationSecretSet', input),
      clearSecret: (input) => call(api, 'conversationSecretClear', input),
      get resolveSignIn() {
        return optional(api, 'conversationProviderSignIn')
      },
      stopSession: (input) => receipts.run(input, (rest) => call(api, 'conversationSessionStop', rest)),
      // The IPC answers it as a promise; the runtime's own is synchronous.
      listSessions: (input) => call(api, 'conversationSessionsList', input) as never,
      get suspendSession() {
        return optional(api, 'conversationSessionSuspend')
      },
      get mcpServerAction() {
        return optional(api, 'conversationSessionMcpAction')
      },
      get stopSubagent() {
        return optional(api, 'conversationSessionStopSubagent')
      },
      get messageSubagent() {
        return optional(api, 'conversationSessionMessageSubagent')
      },
      get askSideQuestion() {
        return optional(api, 'conversationSessionAskSideQuestion')
      },
      get cancelSideQuestion() {
        return optional(api, 'conversationSessionCancelSideQuestion')
      },
      get readContextBreakdown() {
        return optional(api, 'conversationSessionContextBreakdown')
      },
      get terminalHandoff() {
        return optional(api, 'conversationSessionTerminalHandoff')
      },
      get listThreads() {
        return optional(api, 'conversationThreads')
      },
      // The stub hears the search's abort signal, as the runtime does.
      get searchThreads() {
        return has(api, 'conversationSearch')
          ? (input: unknown, options: unknown) => call(api, 'conversationSearch', input, options)
          : undefined
      },
      get listApprovalRules() {
        return has(api, 'conversationApprovalRules') ? () => call(api, 'conversationApprovalRules') : undefined
      },
      get revokeApprovalRule() {
        return has(api, 'conversationRevokeApprovalRule')
          ? (ruleId: string) => call(api, 'conversationRevokeApprovalRule', { ruleId })
          : undefined
      },
      // The window's all-chats stream is already its lifecycle, each event an envelope.
      onEvent: (listener) => subscribeTo(api, 'onConversationEvent', listener),
      onLifecycleEvent: (listener) => subscribeTo(api, 'onConversationEvent', listener),
    },
    files: {
      searchFiles: (_slot, input) =>
        call(api, 'searchFiles', input.rootPath, input.query, {
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
          ...(input.channel === undefined ? {} : { channel: input.channel }),
          ...(input.recentAt === undefined ? {} : { recentAt: input.recentAt }),
        }),
      cancelActiveFileSearch: (_slot, channel) => {
        if (has(api, 'cancelFileSearch')) void call(api, 'cancelFileSearch', channel).catch(() => undefined)
      },
      cancelAllFileSearches: () => undefined,
      statPath: (path) => call(api, 'statPath', path),
      readImageDataUrl: (path) => call(api, 'readImageDataUrl', path),
    },
    repoRoot: (folderPath, hostId) =>
      hostId === undefined ? call(api, 'getGitRepoRoot', folderPath) : call(api, 'getGitRepoRoot', folderPath, hostId),
    hasReceipt: receipts.has,
    // The chat suites name files on a stubbed disk; nothing here is confined but by the stubs.
    readableRoots: () => ['/'],
    commands: (input) => call(api, 'conversationCommands', input),
    onCommandsChanged: (listener) => {
      const subscribe = api.onConversationCommandsChanged as ((cb: typeof listener) => () => void) | undefined
      return typeof subscribe === 'function' ? subscribe(listener) : () => undefined
    },
  })
}

export type StudioLoopback = {
  server: StudioRpcServer
  /** Drop every connection the window holds, as a restarted server would; its client reconnects. */
  drop(): void
  /** How many connections the window has opened so far. */
  connections(): number
}

/**
 * Put a stubbed window on a Studio over the protocol: its chat services in
 * every run, as the window has no other way to them, and its chat view too
 * when this run is the `chat-over-studio` one. Call it after `window.api` is
 * stubbed; members the test changes later are read when they are called.
 */
export function installStudioLoopback(
  win: { api?: Api },
  options: { environmentId?: string; pullRequests?: StudioPullRequests } = {},
): StudioLoopback {
  const api = (win.api ??= {})
  // One chat surface for the window's life, as main provides one: its receipts
  // outlive a dropped connection. Its members still read the stubs when called.
  const chat = chatOver(api)
  const server = createStudioRpcServer({
    dataDir: '/nonexistent/studio-loopback',
    version: 'test',
    environmentId: options.environmentId ?? 'studio-loopback',
    backend: conversationsOver(api),
    chat: () => chat,
    ...(options.pullRequests ? { pullRequests: options.pullRequests } : {}),
    // The socket is never started; windows say hello with their tickets.
    authenticator: createTicketAuthenticator(mintStudioTicket()),
  })
  // The window's sockets, each admitted as the window listener admits one: by
  // the ticket its URL names, which its hello must then present.
  const windowEnds = new Set<MemoryChannelEnd>()
  let opened = 0
  configureWindowStudio(api, {
    WebSocket: memoryWebSocketClass((url) => {
      const ticket = new URL(url).searchParams.get('ticket')
      if (!ticket) return null
      const [mainEnd, windowEnd] = createMemoryChannel()
      server.attach(framePortStream(mainEnd), { authenticator: createTicketAuthenticator(ticket), ownWindow: true })
      windowEnds.add(windowEnd)
      windowEnd.onClose(() => windowEnds.delete(windowEnd))
      opened++
      return windowEnd
    }),
  })
  // Pull requests are served only over the protocol, so a test of them puts
  // the chat view on it in every run.
  if (chatOverStudioUnderTest() || options.pullRequests) Object.assign(api, { studioChatTransport: 'studio' })
  Object.assign(api, {
    studioWindowTicket: async () => {
      const ticket = mintStudioTicket()
      return { url: `ws://127.0.0.1:1/ws?ticket=${encodeURIComponent(ticket)}`, token: ticket }
    },
  })
  return {
    server,
    drop: () => {
      for (const end of [...windowEnds.values()]) end.close()
    },
    connections: () => opened,
  }
}
