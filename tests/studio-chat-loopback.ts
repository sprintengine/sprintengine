import { createStudioChatBackend } from '../src/main/studio-rpc/studio-chat-backend'
import { createTicketAuthenticator, framePortStream, mintStudioTicket } from '../src/server/rpc/studio-frame-port'
import { createStudioRpcServer, type StudioRpcServer } from '../src/server/rpc/studio-rpc-server'
import type { StudioPullRequests } from '../src/server/pull-requests/pull-request-domain'
import type { StudioConversationBackend } from '../src/server/rpc/studio-rpc-types'
import type { StudioFileSystem } from '../src/server/files/studio-file-system'
import type { ConversationSessionFrame } from '../src/shared/conversation-runtime'
import { configureWindowStudio, windowStudioClient } from '../src/renderer/src/studio/windowStudioClient'
import { createMemoryChannel, type MemoryChannelEnd } from './memory-channel'
import { memoryWebSocketClass } from './memory-websocket'

// The chat view's tests on the Studio protocol, which is the only way the
// window reaches its chats. The window's client and transport, a socket, the
// real connection and router, and main's chat backend with its input checks
// run between the view and a fake conversation service. A test writes that
// fake's members on `window.api` under the names the window's IPC once had
// (`conversationSessionStart`, `onConversationSession`, ...): no preload has
// them, and nothing in the window calls them; they are this harness's names
// for the service the router reaches.

type Api = Record<string, unknown>

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
  /**
   * Connect the window now, and resolve once its Studio has welcomed it: what
   * a chat here may do is read off that welcome, as the app's window has it
   * before it draws a chat.
   */
  welcomed(): Promise<void>
}

/**
 * The files by path over the same stubs, under the names the window's IPC
 * once had (`searchFiles`, `statPath`, `readfile`, ...). The suites name files
 * on a stubbed disk, so nothing here is confined but by the stubs.
 */
function fileSystemOver(api: Api): StudioFileSystem {
  const quiet = (name: string, ...args: unknown[]) => {
    if (has(api, name)) void call(api, name, ...args).catch(() => undefined)
  }
  return {
    readableRoots: async () => ['/'],
    writableRoots: async () => ['/'],
    listDirectory: (path) => call(api, 'readdir', path),
    readText: (path) => call(api, 'readfile', path),
    readImage: (path) => call(api, 'readImageDataUrl', path),
    exists: (path) => call(api, 'pathExists', path),
    stat: (path) => call(api, 'statPath', path),
    checkWorkspaceFolder: (path) => call(api, 'checkWorkspaceFolder', path),
    projectLogo: (folderPath) =>
      has(api, 'detectProjectLogo') ? call(api, 'detectProjectLogo', folderPath) : Promise.resolve(null),
    projectIcon: (path) => call(api, 'readProjectIconFile', path),
    repoRoot: (folderPath, hostId) =>
      hostId === undefined ? call(api, 'getGitRepoRoot', folderPath) : call(api, 'getGitRepoRoot', folderPath, hostId),
    searchFiles: (_slot, input) =>
      call(api, 'searchFiles', input.rootPath, input.query, {
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
        ...(input.channel === undefined ? {} : { channel: input.channel }),
        ...(input.recentAt === undefined ? {} : { recentAt: input.recentAt }),
      }),
    cancelFileSearch: (_slot, channel) => quiet('cancelFileSearch', channel),
    searchContent: (_slot, input) =>
      call(api, 'searchContent', input.rootPath, input.query, input.limit === undefined ? {} : { limit: input.limit }),
    cancelContentSearch: () => quiet('cancelContentSearch'),
    releaseSlot: () => undefined,
    defaultWorkspaceParent: () => null,
    writeText: (path, text, roots) => call(api, 'writefile', path, text, { roots }),
    saveDroppedImage: (input) => call(api, 'saveDroppedImage', input),
    createFile: (parentPath, name) => call(api, 'createFile', parentPath, name),
    createDirectory: (parentPath, name, existing) =>
      call(api, existing === 'keep' ? 'ensureDir' : 'createDir', parentPath, name),
    rename: (path, name) => call(api, 'renamePath', path, name),
    copy: (path, toFolder, onConflict) =>
      onConflict === 'rename'
        ? call(api, 'copyPath', path, toFolder)
        : call(api, 'copyPathInto', path, toFolder, { overwrite: onConflict === 'overwrite' }),
    move: (path, toFolder) => call(api, 'movePath', path, toFolder),
    trash: (path) => call(api, 'deletePath', path),
    watch: async () => ({ ok: true, dispose: () => undefined }),
  }
}

/**
 * Put a stubbed window on a Studio over the protocol: its chat view and its
 * chat services. Call it after `window.api` is stubbed; members the test
 * changes later are read when they are called.
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
    fileSystem: fileSystemOver(api),
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
    welcomed: async () => {
      await windowStudioClient(api as Parameters<typeof windowStudioClient>[0])
    },
  }
}

/**
 * Let a call the view just made cross the loopback and its answer come back
 * and be drawn: a protocol call takes a few turns of the event loop where the
 * window's IPC took one.
 */
export async function settleStudio(act: (work: () => Promise<void>) => Promise<void>): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
