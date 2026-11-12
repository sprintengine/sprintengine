import type { AgentLaunchSettings, AgentLaunchSettingsRecord } from '../../shared/launch-settings'
import type { WorkspaceSyncSnapshot, WorkspaceSyncState } from '../../shared/workspace-sync'
import type { MeshConnection, MeshMachineReachability } from '../../shared/tailnet-mesh'

// What the shell and its out-of-process server say to each other on the
// control channel beyond the bootstrap frames and the ShellBridge (phase 6
// spec, 6.3 and 6.4): the state the shell mirrors, the writes and reads it
// makes on server-owned stores, the hints it sends, and the two reads the
// server asks of the shell's own caches. Method names are the contract; both
// ends import them from here.

export const SERVER_METHODS = {
  /** → `ServerMirrorState`: what the shell's mirror starts from. */
  mirrorSnapshot: 'mirror.snapshot',
  /** `{ workspaceId, agentId, patch, actor, stamp? }` → the sync service's result. */
  updateWorkspaceAgent: 'workspace.update-agent',
  /** `{ op, token? }` → the GitHub token store's answer. */
  githubToken: 'github.token',
  /** `{ sessionId }` → the peek card's events, or null for a session the server does not have. */
  conversationPeekEvents: 'conversations.peek-events',
  /**
   * `{ workspaceRoot, workspaceId, agentId }` → `{ ok, source }` (`ChatExportSourceWire`) or
   * `{ ok: false, message }`: a chat's whole transcript and its pictures, for Export chat.
   */
  conversationExportSource: 'conversations.export-source',
  /** → the folders the chats live in, for diagnostics. */
  conversationRoots: 'conversations.live-roots',
  /**
   * → `Array<{ path, lease: { workspaceId, agentId } | null }>`: the worktree
   * pool's slots and who holds each, for the folders an agent may publish
   * artifacts from (the shell serves `artifacts.*`; the pool is the server's).
   */
  worktreeLeases: 'worktree-pool.leases',
  /**
   * `{ workspaceRoot, name, baseRef? }` → `{ worktreePath, branch, dependencyInstall? }` or
   * `{ error }`: an agent-at-launch worktree for the shell's `agent.launch`, cut
   * from the server's pool, with its install's view as it started.
   */
  createAgentWorktree: 'worktree-pool.create-agent-worktree',
  /** `{ id }` → the install's view once it ended, or null when quitting: answered when it ends. */
  dependencyInstallSettled: 'worktree-install.settled',
  /**
   * → `QuitStopping` without the shell's terminals: how many chats have a
   * turn in progress, and by name the schedules and pull request watches this
   * server and its WSL servers run, all of which a quit would stop.
   */
  quitStops: 'quit.stops',
  /** `{ overrides }` → the module enablement result: the shell wrote the file, the server applies it live. */
  applyModuleEnablement: 'modules.apply-enablement',
  /** → `ThirdPartyLaunchSessionWire`: which third-party main halves loaded here, and what they registered. */
  thirdPartyLaunchSession: 'modules.third-party-launch-session',
  /**
   * `{ windowKey, origin }` → `StudioWindowTicket`: a ticket for one connection
   * of one of the app's windows to the window listener, which starts on the first.
   */
  windowTicket: 'studio.window-ticket',
  /** `{ windowKey }`: that window has gone; its tickets are void and its connections end. */
  windowRevoke: 'studio.window-revoke',
  /**
   * `{ clientId }` → `{ connectionId, ticket }`: the shell's own Studio
   * connection, with the shell role, over which it offers its toolsets (6.3).
   */
  shellConnect: 'studio.connect-shell',
  /** → `ServerInfo`. */
  info: 'server.info',
  /**
   * `AgentLaunchRequest` → `AgentLaunchResult`: a terminal agent the shell
   * starts (a tour's new author), through the server's launch service. The
   * ptys are the server's (studio-agent-terminals.ts).
   */
  agentLaunch: 'agents.launch',
  /** `{ sessionId, data }` → nothing: typed into one of the server's terminals (a tour's question). */
  terminalWrite: 'terminals.write',
  /** `{ sessionId }` → `AgentCompactResult`: Compact on an agent tab, typed through the server's control plane. */
  agentCompact: 'agents.compact',
  /** `{ sessionId }` → `ConversationPeekSessionState | null`: what the peek card reads of a terminal agent. */
  terminalPeekState: 'terminals.peek-state',
  /** `{ sessionId }` → whether a fresh read of the session's pull requests was asked for (a hover). */
  terminalPullRequestsRefresh: 'terminals.pull-requests-refresh',
  /** `{ connectionId }` → nothing, once the check is done: ask a paired desktop now whether it answers (the mesh is this process's). */
  meshCheckReachability: 'mesh.check-reachability',
  /**
   * `{ which: 'local' | 'wsl' }` → how many machines were asked: the boot's
   * detection of the agent CLIs, which the shell times and the server runs
   * (the CLIs and their version check are the core's).
   */
  cliDetect: 'cli.detect',
  /** → the advisories: the hourly comparison of the installed CLI versions against the registry. */
  cliVersionsRefresh: 'cli-versions.refresh',
} as const

/** Server → shell requests: the shell's own caches the gateway's tools read. */
export const SHELL_METHODS = {
  /** `MarketplaceRegistryReadInput` → its result. */
  marketplaceRead: 'shell.marketplace.read',
  /** → the installed third-party modules with trust and launch readiness. */
  thirdPartyModules: 'shell.modules.third-party-list',
  /**
   * → every live launch token the shell issued (its WSL helper's channels), by digest
   * (`LaunchTokenChange[]`, decision R87). Asked before the gateway listens,
   * so a bridge that reconnects the moment the socket is back is proven.
   */
  liveLaunchTokens: 'shell.launch-tokens.live',
  /**
   * `{ key, purpose }` → `{ clientId, label }`: a stream on an SSH machine's
   * relay (phase 8), which main holds; its port follows on the control
   * channel as an `ssh-stream` attach with that client id.
   */
  sshOpen: 'shell.ssh.open',
  /**
   * `{ targetVersion? }` → `StudioUpdateStart`: a client asked this desktop to
   * update itself (`update.start`); the app updater is the shell's.
   */
  updateStart: 'shell.update.start',
} as const

/** One-way, either direction. */
export const SERVER_EVENTS = {
  /** Server → shell: the registry changed. `ServerMirrorRegistry`. */
  mirrorRegistry: 'mirror.registry',
  /** Server → shell: an accepted workspace event, for the shell's subscribers. */
  mirrorWorkspaceEvent: 'mirror.workspace-event',
  /** Server → shell: the launch settings changed. `{ settings, record }`. */
  mirrorLaunchSettings: 'mirror.launch-settings',
  /**
   * Server → shell: the desktops this one is paired with changed (paired,
   * forgotten, or one answered and said its environment id). `MeshConnection[]`,
   * whole, without credentials: the shell's environment registry lists them.
   */
  mirrorMeshConnections: 'mirror.mesh-connections',
  /**
   * Server → shell: whether each paired desktop answers changed.
   * `MeshMachineReachability[]`, whole: the shell's environment registry
   * reads each one's connection from it.
   */
  mirrorMeshReachability: 'mirror.mesh-reachability',
  /** Server → shell: a chat's or a terminal agent's phase moved; the dock badge, banners, keep-awake and tours follow it. */
  attentionPhase: 'attention.agent-phase',
  /** Shell → server: the renderer's module registry, mirrored. */
  moduleRegistrySnapshot: 'modules.registry-snapshot',
  /** Shell → server: the idle threshold shared with terminals. */
  conversationIdleThreshold: 'conversations.idle-threshold',
  /**
   * Server → shell: the server's terminal sessions (`TerminalSessionSnapshot[]`),
   * whole, on every change and once the shell is linked: what the shell's
   * own readers see (tours, keep-awake, the tray, the quit's count).
   */
  terminalSessions: 'terminals.sessions',
  /**
   * Shell → server: one agent-state frame line a WSL distribution's helper
   * relayed (the helper is the shell's); the server's reporter listener
   * holds it to the socket's validation.
   */
  agentStateLine: 'terminals.agent-state-line',
  /**
   * Shell → server: `{ hostId }`, a WSL distribution's PATH changed, as its
   * helper (the shell's) saw it; what the server knows of its CLIs is stale.
   */
  cliPathsChanged: 'cli.paths-changed',
  /**
   * Server → shell: the area skills the person opted into
   * (`StudioAreaSkillChoices`), on every change: the shell's plugin copies
   * and workspace installs read them.
   */
  mirrorAreaSkills: 'mirror.area-skills',
  /**
   * Shell → server: the gateway launch tokens the shell issued, by digest
   * (decision R87). `{ reset, changes }`: `reset` says
   * the list is every live one, sent to a server that has just started.
   */
  launchTokens: 'gateway.launch-tokens',
  /**
   * Shell → server: where the app's own update stands (`StudioUpdateSide`),
   * whole, on every change and to a server that has just started; what
   * `update.status` answers.
   */
  updateState: 'update.state',
  /** Shell → server: an SSH machine connected or reconnected `{ key }`; the server follows its chats (phase 8). */
  sshConnected: 'ssh.connected',
  /** Shell → server hints (6.3). */
  hintPower: 'hint.power',
  hintVisibility: 'hint.visibility',
  hintFocus: 'hint.focus',
  hintOnline: 'hint.online',
} as const

/** What `shellConnect` answers: the shell's connection, and the ticket its hello presents. */
export type ShellConnectResult = { connectionId: string; ticket: string }

/** One slot of the server's worktree pool, as `worktree-pool.leases` answers it. */
export type ServerWorktreeLease = { path: string; lease: { workspaceId: string | null; agentId: string | null } | null }

export type ServerMirrorRegistry = {
  state: WorkspaceSyncState
  snapshot: WorkspaceSyncSnapshot
  needsHydration: boolean
}

export type ServerMirrorLaunchSettings = { settings: AgentLaunchSettings; record: AgentLaunchSettingsRecord | null }

export type ServerMirrorState = ServerMirrorRegistry & {
  launchSettings: ServerMirrorLaunchSettings
  /** The paired desktops (`mirrorMeshConnections`); absent from a server with no mesh. */
  meshConnections?: MeshConnection[]
  /** Whether each answers (`mirrorMeshReachability`); absent from a server with no mesh. */
  meshReachability?: MeshMachineReachability[]
}

export type PowerHint = 'suspend' | 'resume' | 'lock' | 'unlock' | 'battery' | 'ac'

export type ServerInfo = {
  pid: number
  uptimeMs: number
  version: string
  gatewaySocket: string | null
  tailnetBound: string | null
  /** Which cipher seals the server's secrets. */
  cipher: 'desktop keychain (through the shell)' | 'key file'
  rssMb: number
}
