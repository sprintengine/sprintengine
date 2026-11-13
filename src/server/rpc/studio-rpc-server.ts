import { arch, platform } from 'node:os'
import type { Duplex } from 'node:stream'

import {
  CONVERSATION_CAPABILITIES,
  CONVERSATION_PROTOCOL_MIN_SUPPORTED,
  CONVERSATION_PROTOCOL_VERSION,
  STUDIO_CAPABILITIES,
  STUDIO_CHAT_CAPABILITIES,
  STUDIO_TERMINAL_HANDOFF_CAPABILITY,
  STUDIO_CLIENT_TOOLS_CAPABILITY,
  STUDIO_BOARD_FILES_CAPABILITY,
  STUDIO_FILE_SYSTEM_CAPABILITY,
  STUDIO_GIT_CAPABILITY,
  STUDIO_WORKTREES_CAPABILITY,
  STUDIO_FILES_CAPABILITY,
  STUDIO_PULL_REQUESTS_CAPABILITY,
  STUDIO_PULL_REQUEST_TOOL_CALLS_CAPABILITY,
  STUDIO_PULL_REQUEST_LINK_CAPABILITY,
  STUDIO_PULL_REQUEST_WATCH_CAPABILITY,
  STUDIO_LOCAL_SERVERS_CAPABILITY,
  STUDIO_WORKSPACES_CAPABILITY,
  STUDIO_MODULES_CAPABILITY,
  STUDIO_TERMINALS_CAPABILITY,
  STUDIO_AGENT_RUNTIMES_CAPABILITY,
  STUDIO_AGENT_SETTINGS_CAPABILITY,
  STUDIO_AGENT_SETUP_CAPABILITY,
  STUDIO_ENVIRONMENT_READINESS_CAPABILITY,
  STUDIO_CHAT_STORES_CAPABILITY,
  STUDIO_BACKLOG_CAPABILITY,
  STUDIO_SHARES_CAPABILITY,
  STUDIO_PULL_REQUEST_READS_CAPABILITY,
  STUDIO_AGENT_SKILLS_CAPABILITY,
  STUDIO_SCHEDULES_CAPABILITY,
  STUDIO_PROTOCOL_MIN_SUPPORTED,
  STUDIO_PROTOCOL_VERSION,
  type StudioEnvironment,
  type StudioEnvironmentReadiness,
  type StudioProtocolWindow,
  type StudioWelcomeFrame,
} from '../../../packages/studio-protocol/src/public'
import { createStudioRpcConnection, type StudioRpcConnection } from './studio-rpc-connection'
import { createStudioRpcListener, type StudioRpcListener } from './studio-rpc-listener'
import { createStudioRpcRouter } from './studio-rpc-router'
import type { ClientToolRegistry } from '../tools/client-tool-registry'
import type { StudioFiles } from './studio-files'
import type { StudioFileSystem } from '../files/studio-file-system'
import type { StudioMachineCall } from './studio-file-system'
import type { StudioGit } from '../git/studio-git-types'
import type { StudioWorktrees } from '../worktrees/studio-worktrees-types'
import type { StudioPullRequests } from '../pull-requests/pull-request-domain'
import type { StudioUpdates } from '../update/studio-updates'
import type { StudioLocalServers } from '../local-servers/local-server-domain'
import type { StudioModules } from './studio-modules'
import type { StudioTerminals } from '../terminals/studio-terminals'
import type { CliRuntimes } from '../../main/cli-runtimes'
import type { StudioAgentSettings } from '../agent-settings/agent-settings-domain'
import type { StudioAgentSetup } from '../agent-setup/agent-setup-domain'
import type { StudioSchedulesDomain } from '../schedules/schedules-domain'
import type { StudioPhoneReads } from '../backlog/backlog-domain'
import type { StudioChatStores } from '../chat-stores/chat-stores-domain'
import type { StudioAgentSkills } from '../core/studio-agent-skills'
import type {
  StudioAuditEntry,
  StudioAuthenticator,
  StudioChatBackend,
  StudioConversationBackend,
  StudioDiscovery,
  StudioFollowedBackend,
} from './studio-rpc-types'

// The Studio RPC as one piece: the owner socket, a connection per client, and
// the router behind them. Main constructs it with the conversations it serves
// and who may connect; nothing here knows it is inside Electron.
//
// Two ways in share the one router. The listener accepts clients on the owner
// socket; `attach` takes a connection that came another way (a window's
// WebSocket from the window listener, the shell's port), with that connection's
// own authenticator. The receipts and
// uploads the router keeps are the same for both, so a window that reconnects
// finds what it left.

/**
 * The conversation capabilities the socket serves: every one the contract
 * defines, but those that describe the tailnet lane's own transport or that
 * this socket does not carry yet.
 *
 * - `conversation-hello`: the lane's `hello` frame, which here is the
 *   connection's own handshake (its welcome carries these capabilities).
 * - `conversation-image-downscale`: the lane's upload route shrinks a picture
 *   on receipt; this socket keeps an upload as it came.
 * - `conversation-images`, `conversation-message-images`,
 *   `conversation-message-files` and `conversation-queued-attachments`: a
 *   step's and a message's pictures read by a URL, and files and pictures on
 *   a keyed send, held or not. `conversation.send` refuses `uploadIds` until
 *   the one upload path every client uses (a streamed PUT to a URL from
 *   `uploads.begin`) carries them.
 * - `conversation-fork`: the lane's fork joins the new chat to the desktop's
 *   records; this socket's `conversation.fork` leaves the record to the
 *   window that asked.
 *
 * Every other one is served by a method or topic of the protocol over the
 * same conversation host the lane uses (`followed.ts`): the per-chat topics,
 * side questions and their records, context breakdown, the composer's file
 * search and command list, settle and visit (with the list in the sidebar's
 * order, settled chats left out), and `always` approvals. So is
 * `conversation-quote-tokens`: a send's quote token is expanded for the agent
 * where the chat runs, whichever way the send came, and this socket sends
 * every client a chat as it is kept, tokens included (the lane alone turns
 * them to words for a client that did not say it reads them).
 */
export const STUDIO_RPC_WITHHELD_CONVERSATION_CAPABILITIES: ReadonlySet<string> = new Set([
  'conversation-hello',
  'conversation-image-downscale',
  'conversation-images',
  'conversation-message-images',
  'conversation-message-files',
  'conversation-queued-attachments',
  'conversation-fork',
])

/**
 * What each per-chat capability needs of the backend's `followed` reads: a
 * Studio whose host cannot serve one does not advertise it.
 */
const FOLLOWED_NEEDS: Readonly<Record<string, ReadonlyArray<keyof StudioFollowedBackend>>> = {
  'conversation-lifecycle': ['settle', 'visit'],
  'conversation-queued-sends': ['watchQueued'],
  'conversation-scheduled-sends': ['watchScheduled'],
  'conversation-usage-limits': ['watchUsageLimits'],
  'conversation-subagents': ['watchSubagents'],
  'conversation-changes': ['watchChanges', 'changesDiff', 'changedFile'],
  'conversation-side-questions': ['askSideQuestion', 'cancelSideQuestion'],
  'conversation-side-question-records': ['askSideQuestion'],
  'conversation-context-breakdown': ['contextBreakdown'],
  'conversation-file-search': ['searchFiles'],
  'conversation-commands': ['listCommands'],
}

/** The conversation capabilities a socket over this backend advertises. */
export function studioRpcConversationCapabilities(backend: Pick<StudioConversationBackend, 'followed'>): string[] {
  return CONVERSATION_CAPABILITIES.filter(
    (capability) =>
      !STUDIO_RPC_WITHHELD_CONVERSATION_CAPABILITIES.has(capability) &&
      (FOLLOWED_NEEDS[capability] ?? []).every((member) => backend.followed?.[member] !== undefined),
  )
}

export type StudioRpcServerOptions = {
  dataDir: string
  version: string
  /** Minted once per data directory; see `StudioEnvironment.id`. */
  environmentId: string
  /** Where this Studio runs, from how its server was started; `local` when not said. */
  hostKind?: StudioEnvironment['hostKind']
  backend: StudioConversationBackend
  /** The chat surface, when main has given one; its capabilities are advertised only then. */
  chat?: () => StudioChatBackend | null
  authenticator: StudioAuthenticator
  audit?: (entry: StudioAuditEntry) => void
  /** Client toolsets: offered here, listed to agents by the gateway. Advertised as `client-tools` only when given. */
  tools?: ClientToolRegistry
  /** Files under a workspace's roots, for owners. Advertised as `files-write` only when given. */
  files?: StudioFiles
  /** The files on this machine by path. Advertised as `file-system` and `files-mention` only when given; every Studio's core gives them. */
  fileSystem?: StudioFileSystem
  /** An SSH machine's server, for an owner's `ssh://` path. */
  machine?: StudioMachineCall
  /** Git on this machine. Advertised as `git` only when given; every Studio's core gives it. */
  git?: StudioGit
  /** The worktrees its agents run in, and settled chats. Advertised as `worktrees` only when given; every Studio's core gives it. */
  worktrees?: StudioWorktrees
  /** The pull requests the conversations opened, for owners. Advertised as `pull-requests` and `pull-request-tool-calls` only when given. */
  pullRequests?: StudioPullRequests
  /** The local servers the conversations started, for owners. Advertised as `local-servers` only when given. */
  localServers?: StudioLocalServers
  /** What a client reads before it starts a chat. Advertised as `workspaces` only when given. */
  discovery?: StudioDiscovery
  /** The terminals on this machine. Advertised as `terminals` only when given: where the server holds a terminal runtime. */
  terminals?: StudioTerminals
  /** The CLIs on this machine. Advertised as `agent-runtimes` only when given; every Studio's core gives them. */
  runtimes?: CliRuntimes
  /** The launch settings and the CLIs' texts. Advertised as `agent-settings` only when given. */
  agentSettings?: StudioAgentSettings
  /** What the agents are set up with beyond their CLIs. Advertised as `agent-setup` only when given; every Studio's core gives it. */
  agentSetup?: StudioAgentSetup
  /** What the Studio keeps beside its chats. Advertised as `chat-stores` only when given. */
  chatStores?: StudioChatStores
  /** The projects' backlogs, the machine's shares and the pull request reads. Advertised as `backlog`, `shares` and `pull-request-reads` only when given. */
  phoneReads?: StudioPhoneReads
  /** The skills, design systems and cards the agents are given. Advertised as `agent-skills` only when given; every Studio's core gives them. */
  agentSkills?: StudioAgentSkills
  /** The scheduled agents this Studio runs. Advertised as `schedules` only when given. */
  schedules?: StudioSchedulesDomain
  /** How this Studio is updated (`update.*`); by hand when not given. */
  updates?: StudioUpdates
  /** The protocol window this Studio speaks: this build's unless given (a test standing in for an older or newer one). */
  protocol?: StudioProtocolWindow
  /** What this Studio's modules say to clients. Advertised as `modules` only when given. */
  modules?: StudioModules
  /** What this machine has and lacks for its background work. Advertised as `environment-readiness` only when given. */
  readiness?: () => Promise<StudioEnvironmentReadiness>
  resyncRetryAfterMs?: (clientId: string) => number
  socketPath?: string
  helloTimeoutMs?: number
  maxConnections?: number
  /** The most connections one client may hold at once; 8 unless set. */
  maxConnectionsPerClient?: number
  onConnectionsChanged?: () => void
  log?: (message: string) => void
}

/** A connection that did not come through the listener, and who may say hello on it. */
export type StudioRpcAttachOptions = {
  /** A window's connection answers to the one ticket main minted for it. */
  authenticator: StudioAuthenticator
  /** One of Studio's own windows: shown conversations as its IPC shows them, and not audited. */
  ownWindow: boolean
  /**
   * The desktop's own shell, over a port main holds both ends of: it may
   * offer the built-in toolsets (`browser`, `canvas`), whatever its hello says.
   */
  shell?: boolean
  /** Audit its mutations although it is Studio's own view: an owner's web tab. */
  audited?: boolean
  /** Hold the folders it names to the ones Studio knows: a browser on the tailnet. */
  knownFoldersOnly?: boolean
  /** A browser's connection, an owner's tab included: never the terminals. */
  browser?: boolean
  /** The window it is one of Studio's own for, as main names it: what a pop-out may attach to is asked by it. */
  windowKey?: string
}

export type StudioRpcServer = StudioRpcListener & {
  /** Serve a connection main holds the other end of. It ends when its stream does, or on `stop`. */
  attach(stream: Duplex, options: StudioRpcAttachOptions): StudioRpcConnection
}

export function createStudioRpcServer(options: StudioRpcServerOptions): StudioRpcServer {
  const perClient = options.maxConnectionsPerClient ?? 8
  const chat = () => options.chat?.() ?? null
  const conversationCapabilities = studioRpcConversationCapabilities(options.backend)
  const welcome = (): Omit<StudioWelcomeFrame, 't' | 'grant' | 'pairing'> => ({
    protocolVersion: options.protocol?.protocolVersion ?? STUDIO_PROTOCOL_VERSION,
    minProtocolVersion: options.protocol?.minProtocolVersion ?? STUDIO_PROTOCOL_MIN_SUPPORTED,
    server: { name: 'SprintEngine Studio', version: options.version },
    environment: { id: options.environmentId, hostKind: options.hostKind ?? 'local', os: platform(), arch: arch() },
    capabilities: STUDIO_CAPABILITIES.filter(
      (capability) =>
        (capability !== STUDIO_CLIENT_TOOLS_CAPABILITY || options.tools !== undefined) &&
        (capability !== STUDIO_BOARD_FILES_CAPABILITY || options.files !== undefined) &&
        ((capability !== STUDIO_FILE_SYSTEM_CAPABILITY && capability !== STUDIO_FILES_CAPABILITY) ||
          options.fileSystem !== undefined) &&
        (capability !== STUDIO_GIT_CAPABILITY || options.git !== undefined) &&
        (capability !== STUDIO_WORKTREES_CAPABILITY || options.worktrees !== undefined) &&
        ((capability !== STUDIO_PULL_REQUESTS_CAPABILITY &&
          capability !== STUDIO_PULL_REQUEST_TOOL_CALLS_CAPABILITY &&
          capability !== STUDIO_PULL_REQUEST_LINK_CAPABILITY) ||
          options.pullRequests !== undefined) &&
        (capability !== STUDIO_PULL_REQUEST_WATCH_CAPABILITY || options.pullRequests?.unwatch !== undefined) &&
        (capability !== STUDIO_LOCAL_SERVERS_CAPABILITY || options.localServers !== undefined) &&
        (capability !== STUDIO_WORKSPACES_CAPABILITY || options.discovery !== undefined) &&
        (capability !== STUDIO_MODULES_CAPABILITY || options.modules !== undefined) &&
        (capability !== STUDIO_ENVIRONMENT_READINESS_CAPABILITY || options.readiness !== undefined) &&
        (capability !== STUDIO_TERMINALS_CAPABILITY || options.terminals !== undefined) &&
        (capability !== STUDIO_AGENT_RUNTIMES_CAPABILITY || options.runtimes !== undefined) &&
        (capability !== STUDIO_AGENT_SETTINGS_CAPABILITY || options.agentSettings !== undefined) &&
        (capability !== STUDIO_AGENT_SETUP_CAPABILITY || options.agentSetup !== undefined) &&
        (capability !== STUDIO_CHAT_STORES_CAPABILITY || options.chatStores !== undefined) &&
        ((capability !== STUDIO_BACKLOG_CAPABILITY &&
          capability !== STUDIO_SHARES_CAPABILITY &&
          capability !== STUDIO_PULL_REQUEST_READS_CAPABILITY) ||
          options.phoneReads !== undefined) &&
        (capability !== STUDIO_AGENT_SKILLS_CAPABILITY || options.agentSkills !== undefined) &&
        (capability !== STUDIO_SCHEDULES_CAPABILITY || options.schedules !== undefined) &&
        (chat() !== null || !(STUDIO_CHAT_CAPABILITIES as readonly string[]).includes(capability)) &&
        // A terminal opens only where the chat surface was given a way to open one.
        (capability !== STUDIO_TERMINAL_HANDOFF_CAPABILITY || chat()?.terminalHandoff !== undefined),
    ),
    conversation: {
      protocolVersion: CONVERSATION_PROTOCOL_VERSION,
      minProtocolVersion: CONVERSATION_PROTOCOL_MIN_SUPPORTED,
      capabilities: conversationCapabilities,
    },
  })
  const router = createStudioRpcRouter({
    backend: options.backend,
    chat,
    info: welcome,
    audit: options.audit,
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.files ? { files: options.files } : {}),
    ...(options.fileSystem ? { fileSystem: options.fileSystem } : {}),
    ...(options.machine ? { machine: options.machine } : {}),
    ...(options.git ? { git: options.git } : {}),
    ...(options.worktrees ? { worktrees: options.worktrees } : {}),
    ...(options.pullRequests ? { pullRequests: options.pullRequests } : {}),
    ...(options.localServers ? { localServers: options.localServers } : {}),
    ...(options.discovery ? { discovery: options.discovery } : {}),
    ...(options.readiness ? { readiness: options.readiness } : {}),
    ...(options.terminals ? { terminals: options.terminals } : {}),
    ...(options.runtimes ? { runtimes: options.runtimes } : {}),
    ...(options.agentSettings ? { agentSettings: options.agentSettings } : {}),
    ...(options.agentSetup ? { agentSetup: options.agentSetup } : {}),
    ...(options.chatStores ? { chatStores: options.chatStores } : {}),
    ...(options.phoneReads ? { phoneReads: options.phoneReads } : {}),
    ...(options.agentSkills ? { agentSkills: options.agentSkills } : {}),
    ...(options.schedules ? { schedules: options.schedules } : {}),
    ...(options.updates ? { updates: options.updates } : {}),
    ...(options.modules ? { modules: options.modules } : {}),
    log: options.log,
  })
  // A revoked app's offers go at once, with its names: a later app that takes
  // one inherits nothing.
  const forgetRevoked = options.tools
    ? options.authenticator.onRevoked((clientId) => options.tools?.forgetClient(clientId))
    : null
  const attached = new Set<StudioRpcConnection>()
  let attachSequence = 0
  const listener: StudioRpcListener = createStudioRpcListener({
    dataDir: options.dataDir,
    version: options.version,
    ...(options.socketPath ? { socketPath: options.socketPath } : {}),
    ...(options.maxConnections ? { maxConnections: options.maxConnections } : {}),
    log: options.log,
    onConnectionsChanged: options.onConnectionsChanged,
    createConnection: (socket, connectionId, onClosed) =>
      createStudioRpcConnection({
        socket,
        connectionId,
        authenticator: options.authenticator,
        router,
        backend: options.backend,
        chat,
        welcome,
        audit: options.audit,
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.files ? { files: options.files } : {}),
        ...(options.pullRequests ? { pullRequests: options.pullRequests } : {}),
        ...(options.localServers ? { localServers: options.localServers } : {}),
        ...(options.modules ? { modules: options.modules } : {}),
        ...(options.terminals ? { terminals: options.terminals } : {}),
        ...(options.runtimes ? { runtimes: options.runtimes } : {}),
        ...(options.agentSettings ? { agentSettings: options.agentSettings } : {}),
        ...(options.agentSetup ? { agentSetup: options.agentSetup } : {}),
        ...(options.chatStores ? { chatStores: options.chatStores } : {}),
        ...(options.phoneReads ? { phoneReads: options.phoneReads } : {}),
        ...(options.agentSkills ? { agentSkills: options.agentSkills } : {}),
        ...(options.schedules ? { schedules: options.schedules } : {}),
        resyncRetryAfterMs: options.resyncRetryAfterMs,
        helloTimeoutMs: options.helloTimeoutMs,
        log: options.log,
        // Counted among the connections already authenticated as it; this one
        // has no client yet, so it is not among them.
        admitClient: (clientId) =>
          listener.connections().filter((connection) => connection.clientId() === clientId).length < perClient,
        onClosed,
      }),
  })
  return {
    ...listener,
    async stop(retryAfterMs = 1_000) {
      for (const connection of [...attached]) connection.bye('shutting_down', 'Studio is closing.', retryAfterMs)
      attached.clear()
      await listener.stop(retryAfterMs)
      router.close()
      forgetRevoked?.()
    },
    attach(stream, attachOptions) {
      const connection = createStudioRpcConnection({
        socket: stream,
        connectionId: `w${++attachSequence}`,
        authenticator: attachOptions.authenticator,
        router,
        backend: options.backend,
        chat,
        ownWindow: attachOptions.ownWindow,
        shell: attachOptions.shell === true,
        ...(attachOptions.audited === undefined ? {} : { audited: attachOptions.audited }),
        ...(attachOptions.knownFoldersOnly ? { knownFoldersOnly: true } : {}),
        ...(attachOptions.browser ? { browser: true } : {}),
        ...(attachOptions.windowKey === undefined ? {} : { windowKey: attachOptions.windowKey }),
        welcome,
        audit: options.audit,
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.files ? { files: options.files } : {}),
        ...(options.pullRequests ? { pullRequests: options.pullRequests } : {}),
        ...(options.localServers ? { localServers: options.localServers } : {}),
        ...(options.modules ? { modules: options.modules } : {}),
        ...(options.terminals ? { terminals: options.terminals } : {}),
        ...(options.runtimes ? { runtimes: options.runtimes } : {}),
        ...(options.agentSettings ? { agentSettings: options.agentSettings } : {}),
        ...(options.agentSetup ? { agentSetup: options.agentSetup } : {}),
        ...(options.chatStores ? { chatStores: options.chatStores } : {}),
        ...(options.phoneReads ? { phoneReads: options.phoneReads } : {}),
        ...(options.agentSkills ? { agentSkills: options.agentSkills } : {}),
        ...(options.schedules ? { schedules: options.schedules } : {}),
        resyncRetryAfterMs: options.resyncRetryAfterMs,
        helloTimeoutMs: options.helloTimeoutMs,
        log: options.log,
        onClosed: (closed) => {
          attached.delete(closed)
        },
      })
      if (!connection.isClosed()) attached.add(connection)
      return connection
    },
  }
}
