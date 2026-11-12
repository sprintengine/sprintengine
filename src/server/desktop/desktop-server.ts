import { homedir } from 'node:os'
import { backgroundWorkOf, quitStopsOf } from '../core/background-work'

import { SHELL_TOOLSETS, serverAutomationTools } from './shell-toolsets'
import type { AgentLaunchRequest, AgentLaunchResult } from '../../shared/agent-launch'
import { isRecord } from '../../shared/records'
import { applyGatewayLaunchTokenChange, type LaunchTokenChange } from '../core/gateway-launch-tokens'
import { compactDeps, type StudioAgentTerminals } from '../core/studio-agent-terminals'
import type { StudioAgents } from '../core/studio-agent-services'
import { compactTerminalAgent } from '../../main/ipc/agent-compact-ipc'
import { createTerminalPullRequests, type TerminalPullRequests } from '../../main/terminal-pull-requests'
import {
  getTerminalSessionById,
  listLiveTerminalSessions,
  notePullRequestRecordChanged,
} from '../../main/terminal-runtime'
import { setSessionPullRequestReader } from '../../main/terminal-session'
import type { ShellAnalyticsEvent } from '../shell-bridge/shell-bridge'
import { createTailnetTools, type TailnetToolsFrontDoor } from '../../main/automation/tailnet/tailnet-tools'
import { readChatExportSource } from '../../main/chat-export/chat-export-source'
import { parseTranscriptInput } from '../../main/conversation-ipc-inputs'
import { createConversationAttentionListener } from '../../main/conversation-attention'
import { setDiagnosticsLogName, writeDiagnosticLog } from '../../main/diagnostics-service'
import { createFilesystemReadHandlers } from '../../main/filesystem-read'
import { createFilesystemWatchSearchHandlers } from '../../main/filesystem-watch-search-handlers'
import { GitHubTokenStore } from '../../main/github-token-store'
import { buildLauncherMcpServer, usableLocalLauncherRef } from '../../main/integrations/launcher'
import { discoverAndBroadcastCliModels } from '../../main/model-discovery/discovery-pass'
import { invalidateCliAvailabilityOnHost } from '../../main/cli-availability'
import { detectCliMachines, readCliVersionAdvisories } from '../../main/cli-version-advisory-service'
import { powerActivity } from '../../main/power-activity'
import { readStudioEnvironmentId } from '../environment/environment-id'
import { createTailnetNotifier } from '../../main/tailnet-notifications'
import { agentBrowserToolGate, agentBrowserToolsEnabledOnDisk } from '../../main/agent-browser-tools-store'
import { createWorkspaceBackupService } from '../../main/workspace-backup'
import { conversationTurnInProgress } from '../../shared/conversation/phase'
import { isWslHostId } from '../../shared/execution-host'
import { STUDIO_MCP_SERVER_ID, STUDIO_MCP_SERVER_NAME } from '../../shared/product-identity'
import { TAILNET_EVENT_CHANNEL } from '../../shared/tailnet'
import {
  MESH_EVENT_CHANNEL,
  meshListChanged,
  type MeshConnection,
  type MeshMachineReachability,
} from '../../shared/tailnet-mesh'
import type { ModuleRegistrySnapshot } from '../../shared/modules/registry-snapshot'
import { SERVER_EXIT } from '../bootstrap/envelope'
import type { RunningServer, ServerStart } from '../bootstrap/serve'
import { runShutdownLegs } from '../bootstrap/serve'
import { ControlRpcError } from '../bootstrap/control-rpc'
import {
  createStudioCore,
  StudioDataDirBusyError,
  StudioDataDirUnusableError,
  studioBridgeScriptPath,
} from '../core/studio-core'
import { createStudioGateway, type StudioGateway } from '../core/studio-gateway'
import { WORKTREE_QUIT_WAIT_MS } from '../core/studio-worktree-pool'
import { createStudioRpc } from '../core/studio-rpc'
import { mirroredStudioUpdates, type StudioUpdateStart } from '../update/studio-updates'
import { createIpcTunnel, type TunnelPort } from '../ipc/ipc-tunnel'
import { createStaticAppIdentity } from '../platform/app-identity'
import { installStudioPlatform, type StudioPlatform } from '../platform/platform'
import { createNodeStudioPaths } from '../platform/studio-paths'
import { createRemoteShellBridge } from '../shell-bridge/remote'
import { createShellSecretCipher, meshSealedTokens } from '../shell-bridge/shell-cipher'
import { createServerGatewayBackends, launchSettingsGatewayDeps } from './gateway-backends'
import { registerServerDomainIpc } from './server-ipc'
import {
  SERVER_EVENTS,
  SERVER_METHODS,
  SHELL_METHODS,
  type PowerHint,
  type ServerInfo,
  type ServerMirrorLaunchSettings,
  type ServerMirrorRegistry,
  type ServerMirrorState,
  type ServerWorktreeLease,
} from './server-methods'
import { createServerModules } from './server-modules'
import { serveAgentWorktrees } from './agent-worktree-rpc'
import { createDesktopWslServers } from '../wsl/desktop-wsl-servers'
import { relayShellToolsets, SSH_RELAYED_TOOLSETS } from '../wsl/wsl-tool-relay'
import { createShellSshServers } from './shell-ssh-servers'
import { readStudioEnv } from '../../shared/studio-env'

// The desktop's own Studio server, out of process (phase 6 spec): the core,
// its gateway and owner socket, the tunnelled window.api domains, and the
// module kernel with every module's server half, composed in a utility
// process the shell forked, and the terminals with their ptys and reporter
// (studio-agent-terminals.ts). What it asks of the shell (the keychain, a
// notification, the shell's part of a terminal agent's launch) goes over the
// control channel; what the shell needs of it (the workspace registry and
// launch settings it mirrors, the terminal list, the GitHub token) is
// answered there too.
//
// It takes the data directory's run lock with the desktop role, as main does
// in process: it is the app's own process tree, and a predecessor's lock is
// its to replace (the supervisor never forks while that predecessor lives).
//
// The gateway lists the core's tools and every automation tool, the terminal
// and agent families included; what acts on a screen is the shell's, offered
// as its toolsets (spec 6.3). Every terminal launch (`agent.launch`,
// `backlog.work`, a scheduled run, Resume in terminal, a tour's author) goes
// through the core's launch service, here.

export const startDesktopServer: ServerStart = async ({ envelope, rpc, log, requestExit }) => {
  // Its own diagnostics file, so two processes never append to one.
  setDiagnosticsLogName('diagnostics-server')
  const bridge = createRemoteShellBridge(rpc)
  const cipher = createShellSecretCipher(bridge, {
    available: envelope.secrets.kind === 'shell' ? envelope.secrets.available : false,
  })
  // The mesh store opens its tokens as it is built; they are opened ahead.
  await cipher.prime(meshSealedTokens(envelope.dataDir))

  const tunnel = createIpcTunnel({ log })
  const platform: StudioPlatform = {
    paths: createNodeStudioPaths({
      dataDir: envelope.dataDir,
      logsDir: envelope.logsDir,
      packaged: envelope.paths.isPackaged,
      resourcesDir: envelope.paths.resourcesDir,
      appRoot: envelope.paths.appPath,
    }),
    secrets: cipher,
    clients: tunnel.bus,
    // A click on a notice goes where the notice names, which the shell
    // carries out: no closure crosses the channel.
    notifier: {
      notify: (notice) =>
        bridge.notify({
          key: notice.key,
          title: notice.title,
          ...(notice.body ? { body: notice.body } : {}),
          ...(notice.silent !== undefined ? { silent: notice.silent } : {}),
          ...(notice.activate ? { activate: notice.activate } : {}),
        }),
    },
    identity: createStaticAppIdentity({ version: envelope.app.version }),
  }
  installStudioPlatform(platform)

  // Hints from the shell (6.3): what windows show and whether one has focus.
  let anyWindowVisible = true
  let appFocused = false
  rpc.on(SERVER_EVENTS.hintVisibility, (payload) => {
    anyWindowVisible = (payload as { anyWindowVisible?: unknown })?.anyWindowVisible !== false
  })
  rpc.on(SERVER_EVENTS.hintFocus, (payload) => {
    appFocused = (payload as { appFocused?: unknown })?.appFocused === true
    powerActivity.noteFocus(appFocused)
  })

  // The launch tokens the shell issued (its WSL helper's channels).
  rpc.on(SERVER_EVENTS.launchTokens, (payload) => {
    const update = payload as { reset?: boolean; changes?: LaunchTokenChange[] } | null
    for (const change of update?.changes ?? []) applyGatewayLaunchTokenChange(change)
  })

  let gateway: StudioGateway | null = null
  // The paired desktops, for the shell's environment registry (the mesh is this process's).
  const meshConnectionsView = (): MeshConnection[] => gateway?.mesh().listConnections() ?? []
  const meshReachabilityView = (): MeshMachineReachability[] => gateway?.mesh().getLiveState().reachability ?? []
  const whenAgentLaunchReady = async (): Promise<void> => {
    await Promise.all([gateway?.whenGatewayReady(), bridge.integrationsReady()])
  }

  // SSH machines (phase 8), when the preview is on: main holds their sessions
  // and hands this process a port per relay stream it needs.
  const sshPorts = new Map<string, TunnelPort>()
  const shellSsh = envelope.flags.sshMachines
    ? createShellSshServers({
        // Main may connect, install and start the machine's server first:
        // as long as a first install takes, not the control channel's default.
        open: (key, purpose) =>
          rpc
            .call<{ clientId: string; label: string }>(
              SHELL_METHODS.sshOpen,
              { key, purpose },
              { timeoutMs: SSH_OPEN_TIMEOUT_MS },
            )
            .catch((error: unknown) => {
              if (error instanceof ControlRpcError && error.code === 'timeout')
                throw new Error('The SSH machine did not connect in time. Check it in Settings › Machines.')
              throw error
            }),
        takePort: (clientId) => {
          const port = sshPorts.get(clientId) ?? null
          sshPorts.delete(clientId)
          return port
        },
        log: (message) => {
          void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'SSH machine', message })
        },
      })
    : null
  if (shellSsh)
    rpc.on(SERVER_EVENTS.sshConnected, (payload) => {
      const key = (payload as { key?: unknown } | null)?.key
      if (typeof key === 'string' && /^ssh:[A-Za-z0-9_-]+$/u.test(key)) shellSsh.machineConnected(key)
    })

  // The terminal agents' pull request marks (below), bound once the Studio
  // socket they are read over exists.
  let terminalPullRequests: TerminalPullRequests | null = null
  // The GitHub token the skills and the shell's own readers use: sealed by the shell's keychain.
  const githubTokenStore = new GitHubTokenStore()
  let core: ReturnType<typeof createStudioCore>
  try {
    core = createStudioCore(platform, {
      // What the shell adds to the agents' skills and cards: its Trash, and
      // the marketplace and module trust store a card's `install.module`
      // goes through. The GitHub token is this process's own store's.
      agentSkills: {
        resolveGitHubToken: () => githubTokenStore.resolveToken(),
        trash: async (path) => {
          await rpc.call(SHELL_METHODS.trash, { path })
        },
        marketplace: {
          readMarketplaceRegistry: () => rpc.call(SHELL_METHODS.marketplaceRead, {}),
          listMarketplaceReceipts: () => rpc.call(SHELL_METHODS.marketplaceReceipts),
          installMarketplaceEntry: (input) => rpc.call(SHELL_METHODS.marketplaceInstall, input),
        },
      },
      ...(shellSsh
        ? { sshServers: { servers: shellSsh.servers, onConnected: (listener) => shellSsh.onConnected(listener) } }
        : {}),
      role: 'desktop',
      // The person's Scheduled agents switch turns the scheduler on and off,
      // through the module kernel (modules/scheduled-agents-switch.ts).
      scheduledAgentsSwitch: 'modules',
      // The terminals run here; the shell prepares each agent's launch (its
      // plugin copy, MCP sync, skills, hook) over the bridge, and hears of
      // each launch for its analytics.
      terminalHost: {
        launchPreparation: bridge.launches,
        isAppFocused: () => appFocused,
        onLaunched: (request, result) => bridge.analytics(agentLaunchedEvent(request, result)),
        // Where each agent works and the tool calls that may have opened a
        // pull request, for its marks: read below, once the socket exists.
        observers: {
          onObservedCheckoutResolved: (session, resolution) =>
            terminalPullRequests?.noteCheckoutResolved(session, resolution),
          onAgentToolCall: (session, toolCall) => terminalPullRequests?.noteToolCall(session, toolCall),
        },
      },
      // A WSL distribution's chats run on a Studio server inside it (phase
      // 7) when the person turned that on for it, as in process. With the
      // switch off they take the per-process path, which out of process
      // fails in words (the WSL helper is the shell's): the server is not
      // started for anyone who did not ask for it while its migration, model
      // discovery and command catalog are unbuilt (spec section 14).
      wslServers: ({ readHostSettings }) =>
        createDesktopWslServers({
          readHostSettings,
          userDataDir: envelope.dataDir,
          app: { version: envelope.app.version, channel: envelope.app.channel },
          packaged: envelope.paths.isPackaged,
          resourcesDir: envelope.paths.resourcesDir,
          appRoot: envelope.paths.appPath,
          isDefaultProfile: envelope.paths.isPackaged && !readStudioEnv('SPRINTENGINE_USER_DATA_DIR')?.trim(),
          log: (message) => {
            void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'WSL server', message })
          },
        }),
      // A Claude chat's child is handed the gateway itself, through the
      // launcher the shell writes (decision R63), or this build's binary run
      // as Node when the launcher could not be written. A chat on a WSL
      // machine with its server on runs there, with that server's gateway.
      resolveStudioMcpServer: async ({ hostId }) => {
        if (isWslHostId(hostId ?? null)) return null
        await whenAgentLaunchReady()
        const launcher = usableLocalLauncherRef(homedir())
        const entry: { command: string; args: string[]; env: Record<string, string> } = launcher
          ? { ...buildLauncherMcpServer(launcher), env: { SPRINTENGINE_USER_DATA_DIR: envelope.dataDir } }
          : {
              command: envelope.paths.appExecPath,
              args: [studioBridgeScriptPath(platform.paths)],
              env: { ELECTRON_RUN_AS_NODE: '1', SPRINTENGINE_USER_DATA_DIR: envelope.dataDir },
            }
        return { id: STUDIO_MCP_SERVER_ID, name: STUDIO_MCP_SERVER_NAME, transport: 'stdio', ...entry }
      },
    })
  } catch (error) {
    if (error instanceof StudioDataDirBusyError) throw Object.assign(error, { exitCode: SERVER_EXIT.dataDirBusy })
    if (error instanceof StudioDataDirUnusableError) {
      throw Object.assign(error, { exitCode: SERVER_EXIT.dataDirUnusable })
    }
    throw error
  }
  const { agentLaunchSettings, workspaceRegistry, workspaceSyncService, conversations } = core
  // The terminals and their agents: null only where no pty can start.
  const terminals = core.agentTerminals
  const launchAgent = (request: AgentLaunchRequest): Promise<AgentLaunchResult> =>
    terminals
      ? terminals.launchService.launch(request)
      : Promise.resolve({ ok: false, code: 'terminals_unavailable', message: TERMINALS_UNAVAILABLE })
  // The renderer's module registry, which the shell mirrors and passes on.
  let moduleRegistry: ModuleRegistrySnapshot | null = null
  rpc.on(SERVER_EVENTS.moduleRegistrySnapshot, (payload) => {
    if (payload && typeof payload === 'object') moduleRegistry = payload as ModuleRegistrySnapshot
  })

  // OS notifications for pairing and reachability, only while no window has
  // focus; a click opens the Remote popover, which the shell does.
  let tailnetFrontDoor: TailnetToolsFrontDoor | null = null
  const tailnetNotifier = createTailnetNotifier({
    isAnyWindowFocused: () => appFocused,
    isEnabled: () => gateway?.getTailnetStatus().notifications ?? false,
    openRemote: () => void bridge.reveal.tab({ kind: 'remote' }),
    show: (notice) => bridge.notify({ ...notice, activate: { kind: 'remote' } }),
  })

  const modules = createServerModules({
    platform,
    core,
    log,
    // The windows are the shell's: it tells them to load their extensions again.
    modulesChanged: () => rpc.emit(SERVER_EVENTS.modulesChanged, null),
  })
  gateway = createStudioGateway(core, {
    // An agent that starts a chat hears back from it, as one that launches a
    // terminal agent does.
    ...(terminals
      ? {
          linkLaunchedAgent: (link) => terminals.launchNotices.link(link),
          dismissLaunchNotice: (sessionId) => terminals.launchNotices.dismiss(sessionId),
        }
      : {}),
    onTailnetEvent: (payload) => {
      tunnel.publish(TAILNET_EVENT_CHANNEL, payload)
      tailnetNotifier.onTailnetEvent(payload)
    },
    onMeshEvent: (event) => {
      tunnel.publish(MESH_EVENT_CHANNEL, event)
      tailnetNotifier.onMeshEvent(event)
      if (meshListChanged(event)) rpc.emit(SERVER_EVENTS.mirrorMeshConnections, meshConnectionsView())
      if (meshListChanged(event) || event.kind === 'machine-reachability')
        rpc.emit(SERVER_EVENTS.mirrorMeshReachability, meshReachabilityView())
    },
    hasWindow: () => anyWindowVisible,
    // A paired device's picture is shrunk by the shell, which has the image
    // codec this process lacks.
    downscaleUpload: (bytes, mediaType) => bridge.images.downscale(bytes, mediaType),
    resolveModuleTools: () => modules.mcpTools(),
    isModuleEnabled: (moduleId) => modules.isEnabled(moduleId),
    // The shell offers what acts on a screen or a terminal (6.3): an agent's
    // first list waits for them, as in process it waits for the browser and
    // the canvas.
    // Not the browser while the person has it switched off: the shell does not
    // offer it then, and the setting is read from the profile when the first
    // list comes, since the shell's copy is in another process.
    expectShellToolsets: agentBrowserToolGate(() => agentBrowserToolsEnabledOnDisk(envelope.dataDir)).expectedToolsets(
      SHELL_TOOLSETS,
    ),
    appTools: (coreTools) => [
      ...coreTools,
      ...serverAutomationTools(
        createServerGatewayBackends({
          getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
          // The terminals are this process's: `terminal.*`, `agent.*` and
          // `backlog.work` launch and read them here.
          listTerminalSessions: () => terminals?.runtime.sessions.listTerminals() ?? [],
          ...(terminals
            ? {
                readTerminalOutputTail: (sessionId: string, options: { maxBytes: number; since?: string }) =>
                  terminals.runtime.readTerminalOutputTail(sessionId, options),
                linkLaunchedAgent: (link: Parameters<typeof terminals.launchNotices.link>[0]) =>
                  terminals.launchNotices.link(link),
              }
            : {}),
          launchAgent: (request) => launchAgent(request),
          resolveAgentPermissionPreset: core.resolveAgentPermissionPreset,
          createWorkspace: (input, actor) => workspaceSyncService.createWorkspace(input, actor),
          studioDataDirs: () => [envelope.dataDir],
          getScheduledAgents: () => modules.scheduledAgents(),
          ...launchSettingsGatewayDeps(agentLaunchSettings),
          getModuleRegistrySnapshot: () => moduleRegistry,
          // The marketplace and the module trust store are the shell's caches.
          listInstalledThirdPartyModules: () => rpc.call(SHELL_METHODS.thirdPartyModules),
          listModuleContributedTools: () =>
            modules.mcpTools().map((tool) => ({ moduleId: tool.moduleId, toolName: tool.registration.name })),
          readMarketplaceRegistry: (input) => rpc.call(SHELL_METHODS.marketplaceRead, input ?? {}),
        }),
      ),
      ...createTailnetTools({ resolveTailnet: () => tailnetFrontDoor }),
    ],
  })
  tailnetFrontDoor = gateway
  // A chat agent in WSL reaches its own server's gateway: the shell's six
  // toolsets are offered there too, and run through this registry, and so
  // are this server's own tools of the families the WSL server cannot serve
  // (phase 7).
  const wslServers = core.wslServers
  if (wslServers)
    relayShellToolsets({
      onConnected: (listener) => wslServers.onConnected(listener),
      registry: gateway.clientTools,
      gatewayTools: gateway.ownTools,
      log: (message) => {
        void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'WSL server', message })
      },
    })
  // An SSH machine's agents get the desktop's browser and canvas (phase 8).
  if (shellSsh)
    relayShellToolsets({
      onConnected: (listener) =>
        shellSsh.onConnected((connection) =>
          listener({
            key: connection.key,
            name: connection.label,
            backend: connection.backend,
            open: (purpose: 'studio') => connection.open(purpose),
            toolsets: SSH_RELAYED_TOOLSETS,
            args: (_toolset, args) => args,
          }),
        ),
      registry: gateway.clientTools,
      log: (message) => {
        void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'SSH machine', message })
      },
    })
  // This desktop updates itself through the app updater, which is the
  // shell's: its state is mirrored here, and an update is begun there.
  const desktopUpdates = mirroredStudioUpdates(async (input) => {
    const started = await rpc.call<StudioUpdateStart>(SHELL_METHODS.updateStart, input).catch((error: unknown) => ({
      ok: false as const,
      message: `The update could not be started: ${error instanceof Error ? error.message : String(error)}`,
    }))
    return started && typeof started === 'object' && 'ok' in started
      ? started
      : { ok: false, message: 'The update could not be started.' }
  })
  rpc.on(SERVER_EVENTS.updateState, (payload) => desktopUpdates.mirror(payload))
  const studioRpc = createStudioRpc(core, gateway, { updates: desktopUpdates.updates, modules: modules.hub })
  const workspaceBackup = createWorkspaceBackupService({
    resolveUserDataDir: () => envelope.dataDir,
    readRegistry: () => workspaceRegistry.getState(),
    minRegistryIntervalMs: 10_000,
  })
  const files = { ...createFilesystemWatchSearchHandlers(), ...createFilesystemReadHandlers() }
  const domains = registerServerDomainIpc(tunnel.registry as unknown as Parameters<typeof registerServerDomainIpc>[0], {
    core,
    gateway,
    studioRpc,
    githubTokenStore,
    workspaceBackup,
    // Resume in terminal: the core's, launched here.
    terminalHandoff: (input) =>
      terminals ? terminals.handoff.handoff(input) : Promise.resolve({ ok: false, message: TERMINALS_UNAVAILABLE }),
    files,
    // The window's port is the check: main brokers one only to an app window.
    assertAppSender: () => undefined,
    scheduledAgents: () => modules.scheduledAgents(),
  })
  modules.load(gateway)

  // A chat's or a terminal agent's phase, for the shell's dock badge,
  // banners, keep-awake and tours.
  conversations.onEvent(
    createConversationAttentionListener({
      onAgentPhase: (event) => rpc.emit(SERVER_EVENTS.attentionPhase, event),
    }),
  )
  terminals?.runtime.registerAgentPhaseListener((event) => rpc.emit(SERVER_EVENTS.attentionPhase, event))
  // The shell's own readers of the terminals (tours, keep-awake, the tray, a
  // quit's count) read this list, sent whole on every change.
  const sendTerminalSessions = () =>
    rpc.emit(SERVER_EVENTS.terminalSessions, terminals?.runtime.sessions.listTerminals() ?? [])
  terminals?.runtime.subscribeSessionsChanged(sendTerminalSessions)
  // A WSL distribution's reporter frames come through the shell's helper.
  rpc.on(SERVER_EVENTS.agentStateLine, (payload) => {
    if (typeof payload === 'string') terminals?.agentState.ingestLine(payload)
  })
  serveShellTerminalRequests(rpc, terminals, launchAgent)
  serveShellAgentRequests(rpc, core.agents)
  // The terminal agents' pull request marks, read from this process's record
  // over a connection of its own, as every client reads them.
  terminalPullRequests = terminals
    ? createTerminalPullRequests({
        transport: studioRpc.shellTransport(),
        version: envelope.app.version,
        sessions: { list: () => listLiveTerminalSessions(), get: (sessionId) => getTerminalSessionById(sessionId) },
        onListsChanged: (affects) => notePullRequestRecordChanged(affects),
        log: (message) => {
          void writeDiagnosticLog({ level: 'warning', source: 'workspace', title: 'Terminal pull requests', message })
        },
      })
    : null
  if (terminalPullRequests) {
    const marks = terminalPullRequests
    setSessionPullRequestReader((session) => marks.listForSession(session))
    rpc.handle(SERVER_METHODS.terminalPullRequestsRefresh, (params) => {
      const sessionId = (params as { sessionId?: unknown } | null)?.sessionId
      return typeof sessionId === 'string' ? marks.refreshForSession(sessionId) : false
    })
  }

  // What the shell mirrors (6.3, ServerStateMirror), pushed as it changes.
  const registryView = (): ServerMirrorRegistry => ({
    state: workspaceRegistry.getState(),
    snapshot: workspaceSyncService.getSnapshot(),
    needsHydration: workspaceRegistry.needsHydration(),
  })
  const launchSettingsView = (): ServerMirrorLaunchSettings => ({
    settings: agentLaunchSettings.get(),
    record: agentLaunchSettings.getRecord(),
  })
  workspaceRegistry.subscribe(() => rpc.emit(SERVER_EVENTS.mirrorRegistry, registryView()))
  workspaceSyncService.subscribeEvents((event) => rpc.emit(SERVER_EVENTS.mirrorWorkspaceEvent, event))
  agentLaunchSettings.subscribe(() => rpc.emit(SERVER_EVENTS.mirrorLaunchSettings, launchSettingsView()))
  const handlers = serveShellRequests({
    rpc,
    mirror: (): ServerMirrorState => ({
      ...registryView(),
      launchSettings: launchSettingsView(),
      meshConnections: meshConnectionsView(),
      meshReachability: meshReachabilityView(),
    }),
    core,
    githubTokenStore,
    modules,
    studioRpc,
    gateway,
    envelope,
    cipherKind: envelope.secrets.kind,
  })

  // Power: the idle sweep and the scheduler read this process's activity, so
  // the shell's power and focus events are replayed into it; waking also
  // re-checks every paired machine, as in process.
  rpc.on(SERVER_EVENTS.hintPower, (payload) => {
    const hint = (payload as { event?: PowerHint } | null)?.event
    if (hint === 'suspend') powerActivity.noteSuspend()
    if (hint === 'resume') powerActivity.noteResume()
    if (hint === 'lock' || hint === 'unlock') powerActivity.noteScreenLocked(hint === 'lock')
    if (hint === 'battery' || hint === 'ac') powerActivity.noteBattery(hint === 'battery')
    if (hint === 'resume' || hint === 'unlock') gateway?.mesh().onWake()
  })
  rpc.on(SERVER_EVENTS.conversationIdleThreshold, (payload) => core.conversationOwner.setIdleThresholdMs(payload))

  // The launch tokens the shell issued (its WSL helper's channels), before the
  // socket their bridges reconnect to is back: a bridge that connects first
  // is proven, not left unattributed until the shell's push after ready.
  const liveTokens = await rpc.call<LaunchTokenChange[]>(SHELL_METHODS.liveLaunchTokens).catch(() => [])
  for (const change of Array.isArray(liveTokens) ? liveTokens : []) applyGatewayLaunchTokenChange(change)

  // Listening: the gateway, the owner socket, the module startup hooks.
  const status = await gateway.initialize()
  void studioRpc
    .start()
    .then(() => terminalPullRequests?.start())
    .catch(() => undefined)
  sendTerminalSessions()
  modules.startup()
  // The boot pass of model discovery runs where its cache lives, a little
  // after start, so its probes do not compete with the window's first paint.
  const discoveryTimer = setTimeout(() => {
    void discoverAndBroadcastCliModels().catch(() => undefined)
  }, BOOT_MODEL_DISCOVERY_DELAY_MS)
  discoveryTimer.unref()

  const running: RunningServer = {
    environmentId: readStudioEnvironmentId(envelope.dataDir),
    gatewaySocket: status.running ? status.socketPath : null,
    tailnetBound: null,
    attachClient(attach, port) {
      if (!port) return
      if (attach.kind === 'desktop-window') {
        tunnel.attach(
          {
            clientId: attach.clientId,
            windowId: attach.windowId,
            kind: attach.kind,
            workspaceWindow: attach.workspaceWindow === true,
          },
          port as TunnelPort,
        )
        return
      }
      if (attach.kind === 'ssh-stream') {
        // Taken by the `shell.ssh.open` answer that names this client id; one
        // nobody takes (its call gave up, or no SSH machines this session) is
        // closed, so the machine's stream does not stay open behind it.
        const sshPort = port as TunnelPort
        if (!shellSsh) {
          sshPort.close()
          return
        }
        sshPorts.set(attach.clientId, sshPort)
        setTimeout(() => {
          if (sshPorts.get(attach.clientId) !== sshPort) return
          sshPorts.delete(attach.clientId)
          sshPort.close()
        }, SSH_PORT_UNCLAIMED_MS).unref?.()
        return
      }
      if (attach.kind === 'shell') {
        // The shell's own protocol connection: answered with its ticket by the
        // `studio.connect-shell` request that follows on the same channel.
        handlers.pendingConnections.set(attach.clientId, port as TunnelPort)
      }
    },
    detachClient(clientId) {
      tunnel.detach(clientId)
    },
    async stop({ drain, onLeg }) {
      clearTimeout(discoveryTimer)
      const legs: Array<readonly [string, () => unknown]> = [
        ['modules (begin)', () => modules.shutdownBegin()],
        // A child's notices are kept for the next run.
        ['launch notices', () => terminals?.launchNotices.freeze()],
        ['terminal pull requests', () => terminalPullRequests?.stop()],
        ['local app socket', () => studioRpc.stop()],
        ['automations', () => gateway?.shutdown()],
        // With the new work: an install the quit cuts short is not recorded,
        // so its worktree installs again at its next lease, and an agent
        // waiting on it is not started on the way out. Each runs as a process
        // group of its own, which nothing else would end.
        ['dependency installs', () => core.worktrees.installer.shutdown({ waitMs: WORKTREE_QUIT_WAIT_MS })],
        ['workspace registry', () => workspaceSyncService.flush()],
        // What a person would miss most: every chat's buffered transcript.
        ['chat transcripts', () => core.conversationOwner.flushTranscripts()],
        // The reporter stops hearing frames, and every pty ends with its
        // painted screen kept for the next run.
        ['agent state', () => terminals?.stopAgentState()],
        ['terminals', () => terminals?.shutdown()],
        ['chats', () => core.conversationOwner.shutdown()],
        // After the chats: a pull request a turn opened on the way out is
        // written down, and the watch's timers stop.
        [
          'pull requests',
          async () => {
            await core.pullRequests.flush()
            core.pullRequests.dispose()
          },
        ],
        // The servers the Studio started (Run again) stop with it: left
        // running, nothing would be left to stop them from.
        [
          'local servers',
          async () => {
            await core.localServers.flush()
            await core.localServers.dispose()
          },
        ],
        // A lease or return in flight finishes its write, and each pool's
        // container lock is given up so another Studio can take it over.
        // Within the shell's drain budget, so the legs after it still run.
        ['worktree pool', () => core.worktrees.pool.shutdown({ waitMs: WORKTREE_QUIT_WAIT_MS })],
        ['command lists', () => domains.conversationCommands.dispose()],
        ['workspace registry (final)', () => workspaceSyncService.flush()],
        ['modules', () => modules.shutdown()],
        ['data directory', () => core.dataDirLock?.release()],
      ]
      // A lost parent: nothing can be shown, so only what cannot be lost runs.
      const urgent = new Set([
        'dependency installs',
        'chat transcripts',
        'terminals',
        'pull requests',
        'local servers',
        'workspace registry (final)',
        'data directory',
      ])
      await runShutdownLegs(drain ? legs : legs.filter(([name]) => urgent.has(name)), onLeg)
    },
  }
  // The desktop that owns this directory wins it back only by restarting this
  // server; a lock taken by anyone else means leave now (a second writer).
  const lockWatch = setInterval(() => {
    if (core.dataDirLock?.isHeld() !== false) return
    clearInterval(lockWatch)
    requestExit(SERVER_EXIT.dataDirBusy, 'Another Studio took this data directory; stopping.')
  }, 1_000)
  lockWatch.unref()
  void writeDiagnosticLog({
    level: 'info',
    source: 'workspace',
    title: 'Studio server started',
    message: `Studio server ${envelope.app.version} serving ${envelope.dataDir} (pid ${process.pid}).`,
  }).catch(() => undefined)
  return running
}

const BOOT_MODEL_DISCOVERY_DELAY_MS = 10_000

const TERMINALS_UNAVAILABLE = 'Terminals cannot start on this machine: its terminal module did not load.'

/** What the shell's analytics hear of a launch: its CLI and shape, never its words or its folders. */
function agentLaunchedEvent(
  request: AgentLaunchRequest,
  result: Extract<AgentLaunchResult, { ok: true }>,
): ShellAnalyticsEvent {
  return {
    name: 'agent.launched',
    properties: {
      cli: result.cli,
      worktree: request.worktreePath !== undefined,
      connector: request.connectorId !== undefined,
      withPrompt: Boolean(request.prompt),
      ...(request.permissionPreset ? { permissionPreset: request.permissionPreset } : {}),
    },
  }
}

/**
 * What the shell asks of the terminals, which are this process's: a terminal
 * agent it starts (a tour's new author), a question typed into one, Compact on
 * an agent tab, and what the peek card reads.
 */
function serveShellTerminalRequests(
  rpc: Parameters<ServerStart>[0]['rpc'],
  terminals: StudioAgentTerminals | null,
  launchAgent: (request: AgentLaunchRequest) => Promise<AgentLaunchResult>,
): void {
  rpc.handle(SERVER_METHODS.agentLaunch, (params) => {
    if (!isRecord(params) || typeof params.workspaceId !== 'string') throw new Error('A launch names its workspace.')
    return launchAgent(params as AgentLaunchRequest)
  })
  rpc.handle(SERVER_METHODS.terminalWrite, (params) => {
    const input = params as { sessionId?: unknown; data?: unknown } | null
    if (typeof input?.sessionId === 'string' && typeof input.data === 'string')
      terminals?.runtime.sessions.writeTerminal(input.sessionId, input.data)
  })
  rpc.handle(SERVER_METHODS.agentCompact, (params) => {
    if (!terminals) return { ok: false, message: TERMINALS_UNAVAILABLE }
    return compactTerminalAgent(compactDeps(terminals), (params as { sessionId?: unknown } | null)?.sessionId)
  })
  rpc.handle(SERVER_METHODS.terminalPeekState, (params) => {
    const sessionId = (params as { sessionId?: unknown } | null)?.sessionId
    return typeof sessionId === 'string' && terminals
      ? terminals.runtime.readConversationPeekSessionState(sessionId)
      : null
  })
}

/**
 * The agent CLIs are the core's: the shell times the boot's detection and the
 * hourly version comparison, which run here; it relays a WSL distribution's
 * PATH change its helper saw; and it hears the area skills its plugin copies
 * carry.
 */
function serveShellAgentRequests(rpc: Parameters<ServerStart>[0]['rpc'], agents: StudioAgents): void {
  rpc.handle(SERVER_METHODS.cliDetect, (params) => {
    const which = (params as { which?: unknown } | null)?.which
    return detectCliMachines({ which: which === 'wsl' ? 'wsl' : 'local' })
  })
  rpc.handle(SERVER_METHODS.cliVersionsRefresh, () => readCliVersionAdvisories())
  rpc.handle(SERVER_METHODS.skillSourcesCheck, () => agents.skills.skills.checkSourceUpdates())
  rpc.on(SERVER_EVENTS.cliPathsChanged, (payload) => {
    const hostId = (payload as { hostId?: unknown } | null)?.hostId
    if (typeof hostId === 'string' && isWslHostId(hostId)) invalidateCliAvailabilityOnHost(hostId)
  })
  agents.services.areaSkills.onChange((choices) => rpc.emit(SERVER_EVENTS.mirrorAreaSkills, choices))
  // Sent once as it serves too, so a shell whose server restarted takes any
  // change it missed while the server was down (adopting the same is a no-op).
  rpc.emit(SERVER_EVENTS.mirrorAreaSkills, agents.services.areaSkills.read())
}

/** How long main may take to open an SSH machine's stream: a first connect may install and start its server. */
const SSH_OPEN_TIMEOUT_MS = 20 * 60_000
/** An SSH stream's port that no `shell.ssh.open` answer claims within this is closed. */
const SSH_PORT_UNCLAIMED_MS = 10_000

function serveShellRequests(deps: {
  rpc: Parameters<ServerStart>[0]['rpc']
  mirror: () => ServerMirrorState
  core: ReturnType<typeof createStudioCore>
  githubTokenStore: GitHubTokenStore
  modules: ReturnType<typeof createServerModules>
  studioRpc: ReturnType<typeof createStudioRpc>
  gateway: StudioGateway
  envelope: Parameters<ServerStart>[0]['envelope']
  cipherKind: 'shell' | 'key-file'
}): { pendingConnections: Map<string, TunnelPort> } {
  const { rpc, core } = deps
  // A port that arrived for a connection, until its request takes it: a chat
  // view's, or the shell's, which only `studio.connect-shell` may take.
  const pendingConnections = new Map<string, TunnelPort>()
  const startedAt = Date.now()
  rpc.handle(SERVER_METHODS.mirrorSnapshot, () => deps.mirror())
  rpc.handle(SERVER_METHODS.updateWorkspaceAgent, (params) => {
    const input = params as { workspaceId: string; agentId: string; patch: unknown; actor?: string; stamp?: number }
    return core.workspaceSyncService.updateWorkspaceAgent(
      input.workspaceId,
      input.agentId,
      input.patch as never,
      (input.actor ?? 'system') as never,
      ...(typeof input.stamp === 'number' ? [input.stamp] : []),
    )
  })
  rpc.handle(SERVER_METHODS.githubToken, (params) => {
    const input = params as { op?: string; token?: unknown; explicit?: unknown } | null
    switch (input?.op) {
      case 'status':
        return deps.githubTokenStore.getStatus()
      case 'resolve':
        return deps.githubTokenStore.resolveToken(typeof input.explicit === 'string' ? input.explicit : null)
      case 'read':
        return deps.githubTokenStore.readToken()
      case 'write':
        return deps.githubTokenStore.writeToken(typeof input.token === 'string' ? input.token : '')
      case 'clear':
        return deps.githubTokenStore.clearToken()
      default:
        throw new Error('Unknown GitHub token operation.')
    }
  })
  rpc.handle(SERVER_METHODS.conversationPeekEvents, async (params) => {
    const sessionId = (params as { sessionId?: unknown } | null)?.sessionId
    if (typeof sessionId !== 'string') return null
    const listed = core.conversations.listSessions()
    const summary = listed.ok ? listed.sessions.find((session) => session.sessionId === sessionId) : undefined
    if (!summary) return null
    const workspaceRoot = core.workspaceRegistry.getRecord(summary.workspaceId)?.folderPath
    if (!workspaceRoot) return []
    // The first message and the newest turn, never the whole transcript.
    return core.conversations
      .readPeekTranscript({ workspaceRoot, workspaceId: summary.workspaceId, agentId: summary.agentId })
      .catch(() => [])
  })
  // Export chat: the shell writes the file, the chats are here.
  rpc.handle(SERVER_METHODS.conversationExportSource, async (params) => {
    const parsed = parseTranscriptInput(params)
    if (!parsed.ok) return parsed
    return readChatExportSource(core.conversations, parsed.input)
  })
  rpc.handle(SERVER_METHODS.conversationRoots, () => core.conversations.listLiveConversationRoots())
  // The shell's `agent.launch` cuts its worktree here, from this process's pool.
  serveAgentWorktrees(rpc, core.worktrees.installer)
  rpc.handle(SERVER_METHODS.worktreeLeases, async (): Promise<ServerWorktreeLease[]> =>
    (await core.worktrees.pool.snapshots())
      .flatMap((snapshot) => snapshot.slots)
      .map((slot) => ({
        path: slot.path,
        lease: slot.lease ? { workspaceId: slot.lease.workspaceId, agentId: slot.lease.agentId } : null,
      })),
  )
  rpc.handle(SERVER_METHODS.quitStops, async () => {
    const listed = core.conversations.listSessions()
    const wsl = (await core.wslServers?.manager.backgroundWork({ budgetMs: 800 })) ?? []
    return {
      agents: listed.ok ? listed.sessions.filter(conversationTurnInProgress).length : 0,
      ...quitStopsOf(backgroundWorkOf(core), wsl),
    }
  })
  rpc.handle(SERVER_METHODS.thirdPartyLaunchSession, () => deps.modules.thirdPartyLaunchSession())
  const takePort = (params: unknown): TunnelPort => {
    const clientId = (params as { clientId?: unknown } | null)?.clientId
    const pending = typeof clientId === 'string' ? pendingConnections.get(clientId) : undefined
    if (!pending || typeof clientId !== 'string') throw new Error('No connection port arrived for this request.')
    pendingConnections.delete(clientId)
    return pending
  }
  // A window's ticket for the window listener. Only the shell asks (the
  // control channel is process-private), and it asks only for a window it
  // checked is one of the app's own, from that window's origin.
  rpc.handle(SERVER_METHODS.windowTicket, (params) => {
    const request = params as { windowKey?: unknown; origin?: unknown } | null
    if (typeof request?.windowKey !== 'string' || typeof request.origin !== 'string')
      throw new Error('A window ticket names its window and origin.')
    return deps.studioRpc.windowTicket({ windowKey: request.windowKey, origin: request.origin })
  })
  rpc.handle(SERVER_METHODS.windowRevoke, (params) => {
    const windowKey = (params as { windowKey?: unknown } | null)?.windowKey
    if (typeof windowKey === 'string') deps.studioRpc.revokeWindow(windowKey)
  })
  // The control channel is process-private, so whatever asks here is the
  // shell: its connection gets the shell role, which may offer the built-in
  // toolsets (phase 5, 7.2).
  rpc.handle(SERVER_METHODS.shellConnect, (params) => deps.studioRpc.connectShell(tunnelPortFrames(takePort(params))))
  rpc.handle(SERVER_METHODS.meshCheckReachability, async (params) => {
    const { connectionId } = (params ?? {}) as { connectionId?: unknown }
    await deps.gateway.mesh().checkReachability(typeof connectionId === 'string' ? connectionId : undefined)
  })
  rpc.handle(SERVER_METHODS.info, (): ServerInfo => {
    const status = deps.gateway.getStatus()
    return {
      pid: process.pid,
      uptimeMs: Date.now() - startedAt,
      version: deps.envelope.app.version,
      gatewaySocket: status.running ? status.socketPath : null,
      tailnetBound: null,
      cipher: deps.cipherKind === 'shell' ? 'desktop keychain (through the shell)' : 'key file',
      rssMb: Math.round(process.memoryUsage.rss() / (1024 * 1024)),
    }
  })
  return { pendingConnections }
}

/** A utility process's `MessagePortMain` as the frames a Studio connection reads and writes. */
function tunnelPortFrames(port: TunnelPort) {
  const closeListeners: Array<() => void> = []
  let closed = false
  const end = () => {
    if (closed) return
    closed = true
    for (const listener of closeListeners.splice(0)) listener()
  }
  port.on('close', end)
  return {
    post: (frame: string) => {
      if (!closed) port.postMessage(frame)
    },
    onFrame: (listener: (frame: string) => void) => {
      port.on('message', (event) => {
        if (typeof event.data === 'string') listener(event.data)
      })
      port.start()
    },
    onClose: (listener: () => void) => {
      if (closed) listener()
      else closeListeners.push(listener)
    },
    close: () => {
      port.close()
      end()
    },
  }
}
