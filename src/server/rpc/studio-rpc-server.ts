import { randomUUID } from 'node:crypto'
import type { DistributionTerminalHost } from '../wsl/distribution-terminal-host'
import type { DistributionMachine } from '../wsl/distribution-machine'
import { arch, platform } from 'node:os'
import type { Duplex } from 'node:stream'
import type { ConversationPullRequests } from '../../main/automation/conversation-pull-request-tools'

import {
  CONVERSATION_CAPABILITIES,
  CONVERSATION_PROTOCOL_MIN_SUPPORTED,
  CONVERSATION_PROTOCOL_VERSION,
  STUDIO_CAPABILITIES,
  STUDIO_CHAT_CAPABILITIES,
  STUDIO_TERMINAL_HANDOFF_CAPABILITY,
  STUDIO_CHAT_EXPORT_CAPABILITY,
  STUDIO_CLIENT_TOOLS_CAPABILITY,
  STUDIO_BOARD_FILES_CAPABILITY,
  STUDIO_FILE_SYSTEM_CAPABILITY,
  STUDIO_GIT_CAPABILITY,
  STUDIO_WORKTREES_CAPABILITY,
  STUDIO_WORKSPACE_SYNC_CAPABILITY,
  STUDIO_EXTENSIONS_CAPABILITY,
  STUDIO_ARTIFACTS_CAPABILITY,
  STUDIO_ACCESS_CAPABILITY,
  STUDIO_WEB_DEVICES_CAPABILITY,
  STUDIO_TAILNET_CAPABILITY,
  STUDIO_EXECUTION_HOSTS_CAPABILITY,
  STUDIO_FILES_CAPABILITY,
  STUDIO_PULL_REQUESTS_CAPABILITY,
  STUDIO_PULL_REQUEST_TOOL_CALLS_CAPABILITY,
  STUDIO_PULL_REQUEST_LINK_CAPABILITY,
  STUDIO_PULL_REQUEST_WATCH_CAPABILITY,
  STUDIO_PULL_REQUEST_CREATE_CAPABILITY,
  STUDIO_LOCAL_SERVERS_CAPABILITY,
  STUDIO_WORKSPACES_CAPABILITY,
  STUDIO_MODULES_CAPABILITY,
  STUDIO_TERMINALS_CAPABILITY,
  STUDIO_AGENT_RUNTIMES_CAPABILITY,
  STUDIO_AGENT_SETTINGS_CAPABILITY,
  STUDIO_AGENT_SETUP_CAPABILITY,
  STUDIO_ENVIRONMENT_READINESS_CAPABILITY,
  STUDIO_WINDOW_TICKETS_CAPABILITY,
  STUDIO_ENVIRONMENT_WORK_CAPABILITY,
  STUDIO_ENVIRONMENT_LAUNCH_TOKENS_CAPABILITY,
  STUDIO_ENVIRONMENT_TERMINAL_HOST_CAPABILITY,
  STUDIO_ENVIRONMENT_MACHINE_CAPABILITY,
  STUDIO_ENVIRONMENT_ADOPT_CAPABILITY,
  STUDIO_PROVIDER_SIGN_IN_FLOW_CAPABILITY,
  STUDIO_CHAT_STORES_CAPABILITY,
  STUDIO_BACKLOG_CAPABILITY,
  STUDIO_SHARES_CAPABILITY,
  STUDIO_PULL_REQUEST_READS_CAPABILITY,
  STUDIO_AGENT_SKILLS_CAPABILITY,
  STUDIO_SCHEDULES_CAPABILITY,
  STUDIO_CHAT_LIFECYCLE_CAPABILITY,
  STUDIO_CANVAS_BOARDS_CAPABILITY,
  STUDIO_PROTOCOL_MIN_SUPPORTED,
  STUDIO_PROTOCOL_VERSION,
  type StudioEnvironment,
  type StudioEnvironmentReadiness,
  type StudioEnvironmentWork,
  type StudioLaunchTokenChange,
  type StudioProtocolWindow,
  type StudioWelcomeFrame,
} from '../../../packages/studio-protocol/src/public'
import { createStudioRpcConnection, type StudioRpcConnection } from './studio-rpc-connection'
import { createStudioRpcListener, type StudioRpcListener } from './studio-rpc-listener'
import { createStudioRpcRouter, type StudioHosts } from './studio-rpc-router'
import type { ClientToolRegistry } from '../tools/client-tool-registry'
import type { StudioFiles } from './studio-files'
import type { StudioFileSystem } from '../files/studio-file-system'
import type { StudioExtensions } from '../extensions/extensions-domain'
import type { StudioArtifacts } from '../artifacts/artifacts-domain'
import type { StudioAccessDomain } from './studio-access'
import type { StudioWebDevicesDomain } from './studio-web-devices'
import type { StudioTailnetDomain } from './studio-tailnet'
import type { SignIns } from '../machine/machine-sign-in'
import type { EnvironmentAdoption } from '../environment/environment-adoption'
import { readDriveMountRoot } from '../wsl/drive-mount-root'
import type { StudioGit } from '../git/studio-git-types'
import type { StudioWorktrees } from '../worktrees/studio-worktrees-types'
import type { StudioWorkspaceSync } from '../workspaces/studio-workspace-sync'
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
import type { StudioChatLifecycleDomain } from '../chat-lifecycle/chat-lifecycle-domain'
import type { StudioCanvasDomain } from '../canvas/canvas-domain'
import type { StudioChatStores } from '../chat-stores/chat-stores-domain'
import type { StudioAgentSkills } from '../core/studio-agent-skills'
import type {
  StudioAuditEntry,
  StudioAuthenticator,
  StudioChatBackend,
  StudioConversationBackend,
  StudioDiscovery,
  StudioFollowedBackend,
  StudioEnvironmentAccess,
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
 * What each per-chat capability needs of the backend's `followed` reads: a
 * Studio whose host cannot serve one does not advertise it.
 */
const FOLLOWED_NEEDS: Readonly<Record<string, ReadonlyArray<keyof StudioFollowedBackend>>> = {
  'conversation-images': ['picture'],
  'conversation-message-images': ['picture', 'stageUploads'],
  'conversation-message-files': ['stageUploads'],
  'conversation-queued-attachments': ['stageUploads', 'watchQueued'],
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

/**
 * The conversation capabilities a socket over this backend advertises: every
 * one the contract defines whose reads the backend's host serves.
 */
export function studioRpcConversationCapabilities(backend: Pick<StudioConversationBackend, 'followed'>): string[] {
  return CONVERSATION_CAPABILITIES.filter((capability) =>
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
  /** Git on this machine. Advertised as `git` only when given; every Studio's core gives it. */
  git?: StudioGit
  /** The worktrees its agents run in, and settled chats. Advertised as `worktrees` only when given; every Studio's core gives it. */
  worktrees?: StudioWorktrees
  /** The desktop's own windows' workspace registry. Advertised as `workspace-sync` only when given; every Studio's core gives it. */
  workspaceSync?: StudioWorkspaceSync
  /** The marketplace, the CLI catalogue, the scaffold and the feeds. Advertised as `extensions` only when given. */
  extensions?: StudioExtensions
  /** Where the Studio publishes its agents' pages. Advertised as `artifacts` only when given. */
  artifacts?: StudioArtifacts
  /** Who may reach the agents from this machine. Advertised as `access` only when given. */
  access?: StudioAccessDomain
  /** The web listener's paired browsers, read when asked. Advertised as `web-devices` only while it gives one. */
  webDevices?: () => StudioWebDevicesDomain | null
  /** The tailnet listener and the machines this one drives. Advertised as `tailnet` only when given. */
  tailnet?: StudioTailnetDomain
  /** The pull requests the conversations opened, for owners. Advertised as `pull-requests` and `pull-request-tool-calls` only when given. */
  pullRequests?: StudioPullRequests
  /** A chat's "Create PR" in its checkout here (`pull-request-create`), for owners. */
  pullRequestCreation?: ConversationPullRequests
  /** The local servers the conversations started, for owners. Advertised as `local-servers` only when given. */
  localServers?: StudioLocalServers
  /** The machines a desktop's computer offers, for owners. Advertised as `execution-hosts` only when given. */
  hosts?: StudioHosts
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
  /** The chats' records beyond their rest. Advertised as `chat-lifecycle` only when given. */
  chatLifecycle?: StudioChatLifecycleDomain
  /** The machine's boards, for another device. Advertised as `canvas-boards` only when given. */
  canvas?: StudioCanvasDomain
  /** How this Studio is updated (`update.*`); by hand when not given. */
  updates?: StudioUpdates
  /** The protocol window this Studio speaks: this build's unless given (a test standing in for an older or newer one). */
  protocol?: StudioProtocolWindow
  /** What this Studio's modules say to clients. Advertised as `modules` only when given. */
  modules?: StudioModules
  /** What this machine has and lacks for its background work. Advertised as `environment-readiness` only when given. */
  readiness?: () => Promise<StudioEnvironmentReadiness>
  /** A ticket for one connection of a window of the desktop that holds this Studio. Advertised as `window-tickets` only when given. */
  environmentAccess?: StudioEnvironmentAccess
  /** Records the desktop that holds this Studio hands over. Advertised as `environment-adopt` only when given. */
  adoption?: EnvironmentAdoption
  work?: () => StudioEnvironmentWork
  /** What a WSL distribution does for the desktop's terminals. Advertised as `environment-terminal-host` only when given. */
  terminalHost?: Pick<DistributionTerminalHost, 'launchFiles' | 'processes' | 'pluginCopy'>
  /** What a WSL distribution does on its machine for the desktop. Advertised as `environment-machine` only when given. */
  machine?: Pick<DistributionMachine, 'git' | 'home' | 'detectClis' | 'run' | 'onPathsChanged'>
  /** The desktop's WSL terminal agents' launch tokens, by digest. Advertised as `environment-launch-tokens` only when given. */
  launchTokens?: (change: { tokens: StudioLaunchTokenChange[]; replace?: boolean }) => number
  /** A CLI's login on this machine with no terminal. Advertised as `provider-sign-in-flow` only when given. */
  signIns?: () => Promise<SignIns>
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
  // A WSL distribution's: read once, the first time a welcome says it.
  let mountRoot: string | null | undefined
  const driveMountRoot = () => (mountRoot === undefined ? (mountRoot = readDriveMountRoot()) : mountRoot)
  const perClient = options.maxConnectionsPerClient ?? 8
  const chat = () => options.chat?.() ?? null
  const conversationCapabilities = studioRpcConversationCapabilities(options.backend)
  // This server's run: its router, and the receipts that router and the
  // services behind it keep in memory, live exactly as long. A client sends
  // a mutation whose receipt is kept only so again after a reconnect only to
  // the boot it sent it to.
  const bootId = randomUUID()
  const welcome = (): Omit<StudioWelcomeFrame, 't' | 'grant' | 'pairing'> => ({
    protocolVersion: options.protocol?.protocolVersion ?? STUDIO_PROTOCOL_VERSION,
    minProtocolVersion: options.protocol?.minProtocolVersion ?? STUDIO_PROTOCOL_MIN_SUPPORTED,
    server: { name: 'SprintEngine Studio', version: options.version },
    bootId,
    environment: {
      id: options.environmentId,
      hostKind: options.hostKind ?? 'local',
      os: platform(),
      arch: arch(),
      ...(options.hostKind === 'wsl' ? { driveMountRoot: driveMountRoot() } : {}),
    },
    capabilities: STUDIO_CAPABILITIES.filter(
      (capability) =>
        (capability !== STUDIO_CLIENT_TOOLS_CAPABILITY || options.tools !== undefined) &&
        (capability !== STUDIO_BOARD_FILES_CAPABILITY || options.files !== undefined) &&
        ((capability !== STUDIO_FILE_SYSTEM_CAPABILITY && capability !== STUDIO_FILES_CAPABILITY) ||
          options.fileSystem !== undefined) &&
        (capability !== STUDIO_GIT_CAPABILITY || options.git !== undefined) &&
        (capability !== STUDIO_WORKTREES_CAPABILITY || options.worktrees !== undefined) &&
        (capability !== STUDIO_WORKSPACE_SYNC_CAPABILITY || options.workspaceSync !== undefined) &&
        ((capability !== STUDIO_PULL_REQUESTS_CAPABILITY &&
          capability !== STUDIO_PULL_REQUEST_TOOL_CALLS_CAPABILITY &&
          capability !== STUDIO_PULL_REQUEST_LINK_CAPABILITY) ||
          options.pullRequests !== undefined) &&
        (capability !== STUDIO_PULL_REQUEST_WATCH_CAPABILITY || options.pullRequests?.unwatch !== undefined) &&
        (capability !== STUDIO_PULL_REQUEST_CREATE_CAPABILITY || options.pullRequestCreation !== undefined) &&
        (capability !== STUDIO_LOCAL_SERVERS_CAPABILITY || options.localServers !== undefined) &&
        (capability !== STUDIO_WORKSPACES_CAPABILITY || options.discovery !== undefined) &&
        (capability !== STUDIO_MODULES_CAPABILITY || options.modules !== undefined) &&
        (capability !== STUDIO_ENVIRONMENT_READINESS_CAPABILITY || options.readiness !== undefined) &&
        (capability !== STUDIO_WINDOW_TICKETS_CAPABILITY || options.environmentAccess !== undefined) &&
        (capability !== STUDIO_ENVIRONMENT_ADOPT_CAPABILITY || options.adoption !== undefined) &&
        (capability !== STUDIO_ENVIRONMENT_WORK_CAPABILITY || options.work !== undefined) &&
        (capability !== STUDIO_ENVIRONMENT_LAUNCH_TOKENS_CAPABILITY || options.launchTokens !== undefined) &&
        (capability !== STUDIO_ENVIRONMENT_TERMINAL_HOST_CAPABILITY || options.terminalHost !== undefined) &&
        (capability !== STUDIO_ENVIRONMENT_MACHINE_CAPABILITY || options.machine !== undefined) &&
        (capability !== STUDIO_PROVIDER_SIGN_IN_FLOW_CAPABILITY || options.signIns !== undefined) &&
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
        (capability !== STUDIO_CHAT_LIFECYCLE_CAPABILITY || options.chatLifecycle !== undefined) &&
        (capability !== STUDIO_CANVAS_BOARDS_CAPABILITY || options.canvas !== undefined) &&
        (capability !== STUDIO_EXTENSIONS_CAPABILITY || options.extensions !== undefined) &&
        (capability !== STUDIO_ARTIFACTS_CAPABILITY || options.artifacts !== undefined) &&
        (capability !== STUDIO_ACCESS_CAPABILITY || options.access !== undefined) &&
        (capability !== STUDIO_WEB_DEVICES_CAPABILITY || (options.webDevices?.() ?? null) !== null) &&
        (capability !== STUDIO_TAILNET_CAPABILITY || options.tailnet !== undefined) &&
        (capability !== STUDIO_EXECUTION_HOSTS_CAPABILITY || options.hosts !== undefined) &&
        (chat() !== null || !(STUDIO_CHAT_CAPABILITIES as readonly string[]).includes(capability)) &&
        // A terminal opens only where the chat surface was given a way to open one.
        (capability !== STUDIO_TERMINAL_HANDOFF_CAPABILITY || chat()?.terminalHandoff !== undefined) &&
        // An export is read only where the chat surface was given a reader.
        (capability !== STUDIO_CHAT_EXPORT_CAPABILITY || chat()?.exportSource !== undefined),
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
    ...(options.git ? { git: options.git } : {}),
    ...(options.worktrees ? { worktrees: options.worktrees } : {}),
    ...(options.workspaceSync ? { workspaceSync: options.workspaceSync } : {}),
    ...(options.extensions ? { extensions: options.extensions } : {}),
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    ...(options.access ? { access: options.access } : {}),
    ...(options.webDevices ? { webDevices: options.webDevices } : {}),
    ...(options.tailnet ? { tailnet: options.tailnet } : {}),
    ...(options.pullRequests ? { pullRequests: options.pullRequests } : {}),
    ...(options.pullRequestCreation ? { pullRequestCreation: options.pullRequestCreation } : {}),
    ...(options.localServers ? { localServers: options.localServers } : {}),
    ...(options.hosts ? { hosts: options.hosts } : {}),
    ...(options.discovery ? { discovery: options.discovery } : {}),
    ...(options.readiness ? { readiness: options.readiness } : {}),
    ...(options.environmentAccess ? { environmentAccess: options.environmentAccess } : {}),
    ...(options.adoption ? { adoption: options.adoption } : {}),
    ...(options.work ? { work: options.work } : {}),
    ...(options.launchTokens ? { launchTokens: options.launchTokens } : {}),
    ...(options.terminalHost ? { terminalHost: options.terminalHost } : {}),
    ...(options.machine ? { machine: options.machine } : {}),
    ...(options.signIns ? { signIns: options.signIns } : {}),
    ...(options.terminals ? { terminals: options.terminals } : {}),
    ...(options.runtimes ? { runtimes: options.runtimes } : {}),
    ...(options.agentSettings ? { agentSettings: options.agentSettings } : {}),
    ...(options.agentSetup ? { agentSetup: options.agentSetup } : {}),
    ...(options.chatStores ? { chatStores: options.chatStores } : {}),
    ...(options.phoneReads ? { phoneReads: options.phoneReads } : {}),
    ...(options.agentSkills ? { agentSkills: options.agentSkills } : {}),
    ...(options.schedules ? { schedules: options.schedules } : {}),
    ...(options.chatLifecycle ? { chatLifecycle: options.chatLifecycle } : {}),
    ...(options.canvas ? { canvas: options.canvas } : {}),
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
        ...(options.pullRequestCreation ? { pullRequestCreation: options.pullRequestCreation } : {}),
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
        ...(options.canvas ? { canvas: options.canvas } : {}),
        ...(options.extensions ? { extensions: options.extensions } : {}),
        ...(options.artifacts ? { artifacts: options.artifacts } : {}),
        ...(options.access ? { access: options.access } : {}),
        ...(options.webDevices ? { webDevices: options.webDevices } : {}),
        ...(options.tailnet ? { tailnet: options.tailnet } : {}),
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
        ...(options.pullRequestCreation ? { pullRequestCreation: options.pullRequestCreation } : {}),
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
        ...(options.canvas ? { canvas: options.canvas } : {}),
        ...(options.extensions ? { extensions: options.extensions } : {}),
        ...(options.artifacts ? { artifacts: options.artifacts } : {}),
        ...(options.access ? { access: options.access } : {}),
        ...(options.webDevices ? { webDevices: options.webDevices } : {}),
        ...(options.tailnet ? { tailnet: options.tailnet } : {}),
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
