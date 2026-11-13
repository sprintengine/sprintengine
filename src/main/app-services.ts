import { app, BrowserWindow, ipcMain, net, powerMonitor, powerSaveBlocker, safeStorage } from 'electron'
import { desktopFileSystemShell } from './desktop-file-system-shell'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { existsSync } from 'fs'
import { buildAgentStateReporterCommand, buildLauncherHookCommand } from './agent-state'
import { LAUNCH_FILES_DIR, prepareLaunchIntegration, pruneLaunchFiles } from './integrations/launch-integration'
import { knowledgeActivityLaunchCommand } from './memory-activity'
import { gitTracksPath } from './skills/studio-plugin'
import {
  ensureAgentIntegrationHome,
  LAUNCH_REPORTER_REL,
  LAUNCH_STATUS_LINE_REL,
  pruneAgentIntegrationHomes,
  type EnsureAgentIntegrationHomeOptions,
} from './agent-integration-home'
import { createAgentStateService } from './agent-state-service'
import { primeDefaultWslDistro } from './hosts/wsl-distro'
import { configureWslHelpers } from './hosts/wsl-helper-runtime'
import { createDesktopWslServers } from '../server/wsl/desktop-wsl-servers'
import { createDesktopSsh, type DesktopSsh } from './environments/ssh/desktop-ssh'
import { createDesktopEnvironments } from './environments/desktop-environments'
import { registerEnvironmentsIpc } from './ipc/environments-ipc'
import type { EnvironmentTicketResult } from '../shared/environments'
import { isMachinePath } from '../shared/machine-paths'
import { workspaceProjectRootOf } from '../shared/worktree-paths'
import type { WorkspaceEnvironmentRef } from '../renderer/src/types/workspace'
import { sessionSshPreview } from './environments/ssh/ssh-preview'
import { relayShellToolsets, SSH_RELAYED_TOOLSETS } from '../server/wsl/wsl-tool-relay'
import { cliTakesLaunchPlugins } from './agent-launch-render'
import { resolveSocketPath as resolveAutomationSocketPath } from './automation/automation-service'
import { invalidateCliAvailabilityOnHost } from './cli-availability'
import { wslHostId } from '../shared/execution-host'
import {
  appLaunchPluginsActive,
  launchCarriesAppPluginsFor,
  setLaunchPluginDirsResolver,
  setLaunchSkillPluginDirsResolver,
  setLaunchStatusLineScriptResolver,
} from './terminal-launch'
import { TAILNET_EVENT_CHANNEL } from '../shared/tailnet'
import { MESH_EVENT_CHANNEL, meshListChanged } from '../shared/tailnet-mesh'
import { CANVAS_MODULE_DEFAULT_ENABLED } from '../shared/modules/manifest'
import { createTailnetNotifier } from './tailnet-notifications'
import { createInProcessShellBridge } from './shell-bridge'
import { electronImageCodec } from './conversation-image-codec-electron'
import { createShellReveal } from './shell-reveal'
import { revealMainWindow } from './window-factory'
import { createAutomationTools } from './automation/automation-tools'
import { createTailnetTools, type TailnetToolsFrontDoor } from './automation/tailnet/tailnet-tools'
import { desktopGatewayTools } from './automation/desktop-gateway-tools'
import { createDesktopShellTools } from './desktop-shell-tools'
import { liveGatewayLaunchTokens, onGatewayLaunchTokenChange } from '../server/core/gateway-launch-tokens'
import { readStudioEnv } from '../shared/studio-env'
import type { McpToolContribution } from './module-host/main-host'
import { getGitRepoWatch } from '../server/git/checkout-watch'
import { announceChangelistsChanged } from '../server/git/changelist-events'
import { createModuleRegistryMirror } from './modules/registry-mirror'
import type { StudioPluginStatus } from '../../packages/studio-protocol/src/public'
import type { ScheduledAgentsService } from './scheduled-agents/service'
import {
  ensureSkillInstalled,
  setDefaultSkillManager,
  setLaunchDeliversBundledSkillResolver,
  pruneRetiredBuiltinSkillCopies,
  BUILTIN_SKILLS_RESOURCE_DIR,
  findBuiltinSkill,
  findModuleSkill,
  resolveSkillById,
} from './builtin-skills'
import { SprintEngineAuthBridge } from './auth-service'
import { createMainDiagnostics } from './main-diagnostics'
import { listKnownWorkspaceRoots, uniqueResolvedRoots } from './workspace-roots'
import type { SkillsService } from './skills'
import { createWorkspaceExtensionsReader } from './workspace-extensions'
import {
  getBundledAgentStateReporterPath,
  getBundledAgentStateReporterTemplatePath,
  getBundledResourceDir,
  getBundledStatusLineForwarderPath,
  getBundledStudioPluginRoot,
} from './bundled-resources'
import type { HostAgentIntegration } from './hosts/execution-host'
import { hostRegistry } from './hosts/host-registry'
import { shellTrash } from './cards/shell-trash'
import { createStudioAgentServices } from '../server/core/studio-agent-services'
import { createBackgroundModeStore } from './background-mode-store'
import { createQuitConfirmationStore } from './quit-confirmation-store'
import { createAgentNotificationsStore } from './agent-notifications-store'
import { readStudioEnvironmentId } from '../server/environment/environment-id'
import { agentBrowserToolGate, createAgentBrowserToolsStore } from './agent-browser-tools-store'
import { createAgentNotifier } from './agent-notifications'
import type { ChatLink } from '../shared/deep-link'
import { createKeepAwakeStore } from './keep-awake-store'
import { createAgentKeepAwake, terminalAgentWorking } from './agent-keep-awake'
import { countWorkingTerminalAgents, createQuitConfirmation, type QuitStopping } from './quit-confirmation'
import { backgroundWorkOf, quitStopsOf } from '../server/core/background-work'
import { askToQuitWhileWorking } from './quit-confirmation-electron'
import { conversationSummaryPhase, conversationTurnInProgress } from '../shared/conversation/phase'
import { createAnalyticsService } from './telemetry/analytics-service'
import { createTelemetryConsentStore } from './telemetry/consent-store'
import { readInstallId } from './telemetry/install-id'
import type { BackgroundStatus } from '../shared/background-mode'
import { isTelemetryEventName, type TelemetryProperties } from '../shared/telemetry'
import { syncStudioMcpConfig } from './studio-mcp-sync'
import { STUDIO_MCP_SERVER_ID, STUDIO_MCP_SERVER_NAME } from '../shared/product-identity'
import { excludeMcpConfigFromWorktree } from './git'
import { createElectronThumbnailer } from './artifacts/artifact-thumbnail-electron'
import { askToSetUpArtifacts } from './artifacts/artifacts-setup-consent-electron'
import { createConversationPeekService } from './conversation-peek/service'
import {
  getTerminalSessionById,
  listLiveTerminalSessions,
  listTerminalRoots,
  notePullRequestRecordChanged,
} from './terminal-runtime'
import type { TerminalLaunchPreparation } from '../server/terminals/terminal-launch-preparation'
import { localShellTerminals, remoteShellTerminals, type ShellTerminals } from './shell-terminals'
import type { AgentPhaseEvent, AgentPhaseListener } from '../shared/agent-runtime'
import { setSessionPullRequestReader } from './terminal-session'
import { createAgentChangelistFeed } from './agent-changelist-feed'
import { createTerminalPullRequests, type TerminalPullRequests } from './terminal-pull-requests'
import { createBrowserManager } from './browser/browser-manager'
import { setAfterWindowZoom } from './app-menu'
import { createBrowserControl } from './browser/browser-control'
import { createBrowserRecorder } from './browser/browser-recorder'
import { createHostRecordingEncoder } from './browser/recording-encoder'
import { createWorkspaceRecordingOutputs } from './browser/recording-output'
import { createBrowserTools } from './automation/browser-tools'
import { createCanvasTools } from './automation/canvas-tools'
import { createEditorTools } from './automation/editor-tools'
import { createAgentWrittenFiles } from './editor-reveal/agent-written-files'
import { createEditorRevealBroker } from './editor-reveal/editor-reveal-broker'
import { createEditorToolBackends } from './editor-reveal/editor-tool-backends'
import { EDITOR_REVEAL_PENDING_CHANNEL } from '../shared/editor-reveal'
import { createTourTools } from './automation/tour-tools'
import { createVisualTools } from './automation/visual-tools'
import { createElectronVisualPreview } from './visual/visual-preview-window'
import { createExtensionTools } from './automation/extension-tools'
import { createPluginTools } from './automation/plugin-tools'
import { resolveScaffoldRoots } from './extension-scaffold'
import { createAppTourService } from './tours/tour-app'
import { canvasBoardStoreDir } from './canvas/canvas-board-store'
import { createCanvasService } from './canvas/canvas-service'
import type { CanvasService } from './canvas/canvas-service-types'
import { createCanvasStoreCatalogue } from './canvas/canvas-store-catalogue'
import { createNodeCanvasFs, watchCanvasDirectory } from './canvas/canvas-node-fs'
import { createCanvasSubscriberRegistry } from './canvas/canvas-subscribers'
import { createCanvasRemoteSubscribers, isRemoteCanvasSubscriber } from './canvas/canvas-remote-subscribers'
import { createCanvasWorkerHost } from './canvas/canvas-worker-host'
import { createCanvasWorkerTransport, isCanvasWorkerWindow } from './canvas/canvas-worker-window'
import { broadcastToWorkspaceWindows, isBrowserHostWebContents, listWorkspaceWindows } from './window-factory'
import { SprintEngineUpdateService } from './update-service'
import { channelForVersion, createUpdateChannelStore } from './update-channel-store'
import { createUpdateInstallNoteStore } from './update-install-note'
import { sendSplashProgress, showUpdateProgressWindow } from './splash-window'
import { GitHubTokenStore } from './github-token-store'
import { createWorkspaceBackupService } from './workspace-backup'
import { writeDiagnosticLog } from './diagnostics-service'
import { getPluginById, getPluginRegistry } from './plugin-registry-instance'
import { createStudioPluginService } from './studio-plugin-service'
import { resolveInstalledSkillHarnesses } from './marketplace/skill-harness-targets'
import { buildLauncherMcpServer, usableLocalLauncherRef } from './integrations/launcher'
import {
  cleanRepositoriesAtBoot,
  prepareStudioIntegrations,
  wslLedgerMirrorPath,
} from './integrations/integration-boot'
import {
  holdLauncher,
  launcherHeldByOthers,
  leaveLiveInstances,
  otherInstanceRunning,
  registerLiveInstance,
  releaseLauncher,
} from './integrations/live-instances'
import { entriesRunLauncher, removeIntegrations, SESSION_INTEGRATION_KINDS } from './integrations/remove-integrations'
import { studioPlatform } from '../server/platform/platform'
import { createStudioCore, studioBridgeScriptPath } from '../server/core/studio-core'
import { installWorkspaceStoreMigration } from './workspace-store-migration'
import { createStudioGateway } from '../server/core/studio-gateway'
import { desktopStudioUpdates, UPDATE_COMMAND_FILENAME, updateCommandFile } from './studio-rpc/desktop-updates'
import { createStudioRpc } from '../server/core/studio-rpc'
import { createStudioModuleHub } from '../server/rpc/studio-modules'
import type { StudioRpcService } from './studio-rpc/studio-rpc-service'
import { createServerGatewayBackends, launchSettingsGatewayDeps } from '../server/desktop/gateway-backends'
import { SERVER_EVENTS, SERVER_METHODS, SHELL_METHODS } from '../server/desktop/server-methods'
import { createRemoteCore, createRemoteGitHubTokenStore, type ShellServerLink } from './server-supervisor/remote-core'
import { anyWindowFocused, broadcastToAllWindows } from './window-broadcast'

// How long the quit gives the session integrations' removal. What it does not
// reach stays listed, and the next quit takes it out.
const QUIT_INTEGRATION_REMOVAL_BUDGET_MS = 5_000
// How long the first launch of a run waits for the repository clean-up.
const BOOT_REPOSITORY_CLEANUP_BUDGET_MS = 4_000

// How long a quit waits for the server to say how many chats are working
// before it asks (or does not) on what the shell knows by itself.
const QUIT_COUNT_SERVER_BUDGET_MS = 1_000

// How long an agent launch waits for a server that is still starting before
// it goes ahead and lets the launch report what is missing.
const AGENT_LAUNCH_SERVER_WAIT_MS = 30_000
import {
  createIntegrationLedger,
  hostIdForPath,
  installIntegrationLedger,
  INTEGRATION_LEDGER_FILE,
} from './integrations/ledger'

export function createAppServices(
  diagnosticsEnabled: boolean,
  /**
   * The Studio server in a process of its own (phase 6). Null in process, the
   * default: everything below is built here, as it always has been. With a
   * server, the shell builds no server-owned store and reaches the core
   * through the mirror and the control channel (server-supervisor/remote-core.ts).
   */
  server: ShellServerLink | null = null,
) {
  // What the server-bound services below take from Electron, installed by the
  // entry. Read through it where a service is being moved off Electron.
  const platform = studioPlatform()
  const { logMainPerfEvent, withIpcDiagnostics } = createMainDiagnostics({
    enabled: diagnosticsEnabled,
  })
  // What the server's code asks of the shell that is not an agent tool: the
  // keychain, OS notifications and where a click on one goes, the analytics
  // sink, the integrations gate, and terminal launches for the internal
  // service tokens. In process it calls the shell's services directly; the
  // same object is what the shell serves a server in a process of its own.
  // Its late-bound members (the launch, the gate) resolve at call time.
  // The chat-link router opens a chat a clicked banner names; it is built with
  // the app's lifecycle, after these services (setChatLinkOpener).
  let chatLinkOpener: ((link: ChatLink) => void) | null = null
  const shellBridge = createInProcessShellBridge({
    safeStorage,
    launches: () => terminalLaunchPreparation,
    reveal: createShellReveal({
      windows: () => BrowserWindow.getAllWindows(),
      // Never the hidden canvas worker: with the pane closed and an agent
      // drawing it can be the only window open.
      isCanvasWorker: isCanvasWorkerWindow,
      revealMainWindow,
      openChat: () => chatLinkOpener,
    }),
    notifier: platform.notifier,
    // Only the events this app sends at all; the record drops any property
    // value that is not a plain string, number or boolean.
    analytics: (event) => {
      if (isTelemetryEventName(event.name)) analytics.record(event.name, event.properties as TelemetryProperties)
    },
    integrationsReady: () => agentIntegrationReady,
    imageCodec: electronImageCodec,
  })
  // Learn the default WSL distribution's name once, in the background, so a WSL
  // launch built later can name it with `-d` (Windows only; a no-op elsewhere).
  primeDefaultWslDistro()
  const sprintengineAuth = new SprintEngineAuthBridge()
  // What the agents are set up with (MCP sync, the built-in and area skills,
  // the config import): built once here and handed to the core in process, so
  // the shell's own uses and the server's methods share one of each.
  const agentServices = createStudioAgentServices(platform)
  const mcpConfigService = agentServices.mcpConfig
  // Every file, entry and piece of machine state the app writes outside
  // userData is recorded here as it is written (integrations/ledger.ts), so it
  // can all be taken back out. Installed before anything that writes.
  const integrationLedgerStore = createIntegrationLedger({
    path: join(app.getPath('userData'), INTEGRATION_LEDGER_FILE),
    // A distribution's entries are mirrored into it while its helper is up.
    mirrorPathFor: (hostId) => {
      const host = hostRegistry().get(hostId)
      const home = host.kind === 'wsl' ? host.agentIntegration()?.home.native : null
      return home ? wslLedgerMirrorPath(home) : null
    },
    onError: (error) => {
      void writeDiagnosticLog({
        level: 'warning',
        title: 'Integration ledger not written',
        message: error instanceof Error ? error.message : String(error),
        source: 'workspace',
      })
    },
  })
  installIntegrationLedger(integrationLedgerStore)
  const resolveStudioMcpBridgeScriptPath = () => studioBridgeScriptPath(platform.paths)

  // The skill installer a launch's skill-at-spawn uses (terminalLaunchPreparation).
  // Reads loaded CLI plugins to compute native targets.
  const builtinSkillManager = agentServices.builtinSkills
  // The process-wide `ensureSkillInstalled` — the one the launch boundary,
  // the Backlog action and `MainHost.ensureSkillInstalled` all call — must use
  // THIS manager, the only one that knows the installed CLI plugins and can
  // therefore compute the `all-native` fan-out.
  setDefaultSkillManager(builtinSkillManager)

  // Authoritative agent state: owns the reporter socket + per-workspace install.
  // Declared before the agent-state service because that service's
  // `resolveLaunchInjectsPlugins` closes over it: the launch flag and the
  // workspace installer must read one value, never two that can disagree.
  let agentIntegrationPluginDirs: string[] = []
  // The one-skill plugins in that copy, by skill id (`launchSkillPluginDir`).
  let agentIntegrationSkillPluginDirs: Record<string, string> = {}
  // The status-line forwarder inside that copy. Separate from the directories
  // because a status line is not a plugin component — no plugin can declare
  // one — so it travels in the launch's `--settings` document instead.
  let agentIntegrationStatusLinePath = ''
  // THE question every workspace writer asks before touching the repository on
  // behalf of an agent launch: will this CLI's launch carry the app's own plugin
  // directories? One closure, so the launch flag (terminal-launch's
  // `pluginDirsForLaunch` asks the same three things), the agent-state
  // installer, the skill installer and the MCP sync can never disagree — a
  // disagreement is either a doubled registration or a session with none.
  //
  // Asked with the launch's machine. A WSL distribution carries the copy its
  // helper wrote inside it, once the helper is up; the launch builder reads the
  // same host (`pluginDirsForLaunch`), so the two agree there too. A launch
  // passes the `integration` it captured when it prepared that machine, so a
  // helper restarting in between cannot make this answer differ from what the
  // launch itself carries; absent, the machine is asked as it stands now.
  const launchCarriesAppPlugins = (
    cli: string,
    hostId?: string | null,
    integration?: HostAgentIntegration | null,
  ): boolean => {
    const host = hostRegistry().get(hostId)
    if (host.kind === 'wsl') {
      const current = integration === undefined ? host.agentIntegration() : integration
      return cliTakesLaunchPlugins(cli) && (current?.pluginDirs.length ?? 0) > 0
    }
    return launchCarriesAppPluginsFor(cli, agentIntegrationPluginDirs)
  }
  // The app's MCP gateway as a stdio server on the machine a CLI runs on: this
  // app's own binary run as Node here, and inside a WSL distribution the
  // pinned Node and the bridge the helper installed, which finds the helper's
  // socket through the discovery file in the helper's directory. Null (no
  // gateway written) for a WSL machine whose helper is not up. `integration`
  // as for `launchCarriesAppPlugins`.
  const studioGatewayFor = (
    hostId?: string | null,
    integration?: HostAgentIntegration | null,
  ): { command: string; args: string[]; env: Record<string, string>; envVarNames?: string[] } | null => {
    const host = hostRegistry().get(hostId)
    if (host.kind === 'wsl') {
      return (integration === undefined ? host.agentIntegration() : integration)?.studioMcpEntry ?? null
    }
    // Through the Studio launcher, so the entry this writes into a repository
    // keeps working when the app moves or updates, and serves an empty MCP
    // server rather than failing to start once the app is gone.
    const launcher = usableLocalLauncherRef(homedir())
    if (!launcher) {
      // The launcher could not be written this run: name this build directly,
      // which works for as long as it stays installed.
      return {
        command: process.execPath,
        args: [resolveStudioMcpBridgeScriptPath()],
        env: { ELECTRON_RUN_AS_NODE: '1', SPRINTENGINE_USER_DATA_DIR: app.getPath('userData') },
      }
    }
    return {
      ...buildLauncherMcpServer(launcher),
      env: { SPRINTENGINE_USER_DATA_DIR: app.getPath('userData') },
    }
  }
  // The agent-state hook a launch hands Codex on its command line: the
  // launcher, which needs no Node on PATH, else the reporter inside this
  // build's plugin copy. Null when neither is there, which leaves the launch
  // on the workspace registration.
  const launchAgentStateHookCommand = (): string | null => {
    const socketPath = agentStateService.getSocketPath()
    const launcher = usableLocalLauncherRef(homedir())
    if (launcher) return buildLauncherHookCommand(launcher, 'agent-state', socketPath)
    const home = agentIntegrationPluginDirs[0] ? dirname(agentIntegrationPluginDirs[0]) : null
    const reporter = home ? join(home, LAUNCH_REPORTER_REL) : null
    return reporter && existsSync(reporter) ? buildAgentStateReporterCommand(reporter, socketPath) : null
  }
  // A bundled skill arrives as a plugin of its own, in that same copy, on the
  // launch whose prompt invokes it — when the copy on the launch's machine
  // holds it. The launch builder reads the same map (`pluginDirsForLaunch`).
  setLaunchDeliversBundledSkillResolver((cli, skillId, hostId, integration) => {
    if (!launchCarriesAppPlugins(cli, hostId, integration)) return false
    const host = hostRegistry().get(hostId)
    const available =
      host.kind === 'wsl'
        ? ((integration === undefined ? host.agentIntegration() : integration)?.skillPluginDirs ?? {})
        : agentIntegrationSkillPluginDirs
    return Object.hasOwn(available, skillId)
  })
  const listAgentStateSpecs = () =>
    getPluginRegistry()
      .loaded()
      .flatMap((plugin) => (plugin.manifest.agentStateSpec ? [plugin.manifest.agentStateSpec] : []))

  // The reporter's installer, for the shell's part of a launch. Its frames
  // are heard where the terminals run, in the Studio server
  // (server/terminals/agent-state-listener.ts), on the socket this names.
  const agentStateService = createAgentStateService({
    resolveUserDataDir: () => app.getPath('userData'),
    resolveAgentStateSpec: (cli) =>
      getPluginRegistry()
        .loaded()
        .find((plugin) => plugin.manifest.id === cli)?.manifest.agentStateSpec ?? null,
    resolveReporterScriptPath: getBundledAgentStateReporterPath,
    resolveStatusLineScriptPath: getBundledStatusLineForwarderPath,
    // A CLI that takes the app's plugin directories at launch gets this same
    // reporter for the session, so nothing is written into the workspace. Both
    // halves must hold: a manifest that declares the flag, and a materialised
    // copy to point it at — until the copy exists (or if this build shipped
    // none) the workspace install remains the way agent state works at all.
    resolveLaunchInjectsPlugins: launchCarriesAppPlugins,
    // Read when a launch-injected CLI tidies what an earlier build wrote into
    // the workspace: the shared reporter script stays while another CLI's
    // registration there still runs it.
    listAgentStateSpecs,
    resolveReporterTemplatePath: getBundledAgentStateReporterTemplatePath,
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })

  // Which of the built-in plugin's area skills agents get: none until the
  // person opts in, from a surface's suggestion or from Settings, and then in
  // every workspace (shared/studio-area-skills.ts). Read by every plugin copy
  // (this machine's launch home, each WSL distribution's) and the workspace
  // installer; a change re-runs them.
  const studioAreaSkillStore = agentServices.areaSkills
  // Out of process the server takes the choices; this copy adopts each one.
  server?.rpc.on(SERVER_EVENTS.mirrorAreaSkills, (choices) => studioAreaSkillStore.adopt(choices))

  // WSL machines: each distribution's helper relays its agents' hook frames,
  // their MCP connections and PATH changes back here (hosts/wsl-helper-*.ts).
  // Configured on every platform because it costs nothing; only Windows ever
  // starts a helper.
  configureWslHelpers({
    appVersion: platform.identity.version(),
    userDataDir: app.getPath('userData'),
    resources: () => {
      const helperDir = getBundledResourceDir('wsl-helper')
      const hooksDir = getBundledResourceDir('hooks')
      const automationDir = getBundledResourceDir('automation')
      return helperDir && hooksDir && automationDir ? { helperDir, hooksDir, automationDir } : null
    },
    pluginSources: () => ({
      templateRoot: getBundledStudioPluginRoot(),
      reporterSourcePath: getBundledAgentStateReporterPath(),
      statusLineSourcePath: getBundledStatusLineForwarderPath(),
      enabledSkillDirs: studioAreaSkillStore.enabledSkillDirs(),
      launchSkillsSourceRoot: getBundledResourceDir(BUILTIN_SKILLS_RESOURCE_DIR),
    }),
    automationSocketPath: () => resolveAutomationSocketPath(app.getPath('userData')),
    // The helper is the shell's; the reporter's listener is the server's.
    ingestAgentStateLine: (line) => {
      if (server) server.rpc.emit(SERVER_EVENTS.agentStateLine, line)
      else coreTerminals?.agentState.ingestLine(line)
    },
    // What a launch knows of that machine's CLIs is the core's to forget.
    onPathsChanged: (distro) => {
      if (server) server.rpc.emit(SERVER_EVENTS.cliPathsChanged, { hostId: wslHostId(distro) })
      else invalidateCliAvailabilityOnHost(wslHostId(distro))
    },
    // Chromium's network stack, so the one-time Node.js download honours the
    // system proxy the way the rest of the app's requests do.
    fetch: (url, init) => net.fetch(url, init),
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', title: 'WSL helper', message, source: 'terminal' })
    },
  })

  // Boot jobs that nothing on screen needs — the git probe and the rest — wait
  // for the main window to reveal, so they do not compete with the renderer's
  // first load. The lifecycle opens the gate on reveal; an agent launch opens
  // it early.
  let openBootJobsGate: () => void = () => undefined
  const bootJobsGate = new Promise<void>((resolve) => {
    openBootJobsGate = resolve
  })
  // The workspace sync — the launcher, the plugin home and the pass over every
  // known workspace — runs while the loading screen is up instead (owner,
  // 2026-09-28: it "should happen when the user opens the application"). The
  // lifecycle opens this gate as the plate goes up and waits a bounded time for
  // the pass (`prepareWorkspacesAtBoot`); the reveal, and an agent launch, open
  // it too, so nothing depends on the lifecycle having asked.
  let openWorkspaceSyncGate: () => void = () => undefined
  const workspaceSyncGate = new Promise<void>((resolve) => {
    openWorkspaceSyncGate = resolve
  })
  const startDeferredBootJobs = (): void => {
    openWorkspaceSyncGate()
    openBootJobsGate()
  }

  const agentIntegrationHomeOptions = (): EnsureAgentIntegrationHomeOptions => ({
    templateRoot: getBundledStudioPluginRoot(),
    reporterSourcePath: getBundledAgentStateReporterPath(),
    // The forwarder the launch names in its `--settings` status line: it is
    // how the app reads context usage, cost and lines changed for a session.
    statusLineSourcePath: getBundledStatusLineForwarderPath(),
    userDataDir: app.getPath('userData'),
    tokens: {
      nodeCommand: process.execPath,
      bridgeScriptPath: resolveStudioMcpBridgeScriptPath(),
      userDataDir: app.getPath('userData'),
      agentStateSocketPath: agentStateService.getSocketPath(),
    },
    enabledSkillDirs: studioAreaSkillStore.enabledSkillDirs(),
    launchSkillsSourceRoot: getBundledResourceDir(BUILTIN_SKILLS_RESOURCE_DIR),
    // Native Windows runs the copy's hooks through the launcher, which the
    // launch waits for before materialising (`launcherWritten` below).
    hookLauncher: process.platform === 'win32' ? usableLocalLauncherRef(homedir()) : null,
  })

  // The app's own plugin, materialised ONCE for this build under the profile's
  // userData directory and handed to every launch that can take it
  // (`--plugin-dir`) rather than written into the person's repository. Empty
  // until the copy lands; every agent launch waits for it to settle (see
  // `whenAgentLaunchReady`), and a build whose copy failed falls back to the
  // workspace installer instead of losing agent state.
  // Opens once the launcher pass (`prepareStudioIntegrations`) has finished.
  let repositoryCleanupGate: Promise<void> = Promise.resolve()
  const agentIntegrationReady = (async () => {
    await workspaceSyncGate
    // The Studio launcher every hook and gateway entry runs, pointed at this
    // build — before any launch, because a launch writes commands that name
    // it. Then, in the background, the one-time list of what earlier builds
    // wrote and every listed entry moved onto the launcher.
    let launcherReady: () => void = () => undefined
    const launcherWritten = new Promise<void>((resolve) => {
      launcherReady = resolve
    })
    let integrationsPrepared: () => void = () => undefined
    repositoryCleanupGate = new Promise<void>((resolve) => {
      integrationsPrepared = resolve
    })
    // Listed as running before anything is written, so another instance's
    // quit leaves what this one is about to use (integrations/live-instances.ts).
    await registerLiveInstance(homedir()).catch(() => undefined)
    void prepareStudioIntegrations({
      onLauncherReady: () => launcherReady(),
      ledger: integrationLedgerStore,
      home: homedir(),
      shell: process.platform === 'win32' ? 'windows' : 'posix',
      pointer: {
        node: process.execPath,
        runAsNode: true,
        payload: app.isPackaged
          ? process.resourcesPath
          : dirname(getBundledResourceDir('hooks') ?? join(app.getAppPath(), 'resources', 'hooks')),
        packaged: app.isPackaged,
      },
      // This machine's checkouts only: reading a `\\wsl.localhost` folder
      // would boot a stopped distribution just to look.
      listRoots: () =>
        workspaceRegistry
          .getState()
          .workspaces.flatMap((workspace) =>
            workspace.folderPath &&
            !isMachinePath(workspace.folderPath) &&
            hostIdForPath(workspace.folderPath) === 'local'
              ? [{ path: workspace.folderPath, hostId: 'local' }]
              : [],
          ),
      log: (message) => {
        void writeDiagnosticLog({ level: 'info', title: 'Integrations', message, source: 'workspace' })
      },
    })
      .finally(() => integrationsPrepared())
      .catch((error: unknown) => {
        void writeDiagnosticLog({
          level: 'warning',
          title: 'Studio integrations not prepared',
          message:
            'The launcher, or the pass over what earlier builds wrote, failed. A hook naming a missing launcher fails until it is written; the pass is tried again next start.',
          details: error instanceof Error ? error.message : String(error),
          source: 'workspace',
        })
      })
    await launcherWritten
    const home = await ensureAgentIntegrationHome(agentIntegrationHomeOptions())
    if (!home.ok) {
      void writeDiagnosticLog({
        level: 'warning',
        title: 'Agent plugin directory unavailable',
        message: 'Agents fall back to the per-workspace install for skills and agent state.',
        details: home.message,
        source: 'workspace',
      })
      return
    }
    agentIntegrationPluginDirs = home.home.pluginDirs
    agentIntegrationSkillPluginDirs = home.home.skillPluginDirs
    agentIntegrationStatusLinePath = join(home.home.root, LAUNCH_STATUS_LINE_REL)
    // Old versions are only safe to delete here: a CLI reads a plugin directory
    // as it starts, and every agent this app launches dies with the app, so no
    // live session is reading a sibling version at startup.
    await pruneAgentIntegrationHomes(app.getPath('userData'), home.home.version)
  })()
  // The files the last run's launches named (`--mcp-config`, Cursor's launch
  // plugin, OpenCode's agent-state plugin): no session that read them outlived
  // that run. Before the first launch of this one, which waits on the copy.
  const launchFilesPruned = pruneLaunchFiles(join(app.getPath('userData'), LAUNCH_FILES_DIR)).catch(() => undefined)
  // What earlier builds wrote into repositories for what a launch now carries
  // itself, taken out once the launcher pass is done and before the first
  // launch, which waits on it for at most the budget (cleanRepositoriesAtBoot).
  // Skipped while another Studio runs: its sessions may still read those files.
  //
  // Launches wait for all of it, so nothing it removes is a file a launch just
  // wrote; both waits are bounded, and a pass that has not begun in time is
  // left to the quit.
  const repositoryCleanup = (async () => {
    await agentIntegrationReady
    let gateTimer: ReturnType<typeof setTimeout> | undefined
    const prepared = await Promise.race([
      repositoryCleanupGate.then(() => true),
      new Promise<boolean>((resolve) => {
        gateTimer = setTimeout(() => resolve(false), BOOT_REPOSITORY_CLEANUP_BUDGET_MS)
      }),
    ])
    if (gateTimer) clearTimeout(gateTimer)
    if (!prepared) return
    const home = homedir()
    if (await otherInstanceRunning(home).catch(() => true)) return
    const report = await cleanRepositoriesAtBoot({
      ledger: integrationLedgerStore,
      listRoots: () =>
        workspaceRegistry
          .getState()
          .workspaces.flatMap((workspace) =>
            workspace.folderPath &&
            !isMachinePath(workspace.folderPath) &&
            hostIdForPath(workspace.folderPath) === 'local'
              ? [{ path: workspace.folderPath, hostId: 'local' }]
              : [],
          ),
      migrateKnowledgeActivity: async (repo) => {
        await knowledgeActivityLaunchCommand(repo)
      },
      deadline: Date.now() + BOOT_REPOSITORY_CLEANUP_BUDGET_MS - 250,
      stop: () => otherInstanceRunning(home),
    })
    if (report.removed > 0 || report.failed > 0) {
      void writeDiagnosticLog({
        level: report.failed > 0 ? 'warning' : 'info',
        title: 'Repositories tidied',
        message: `${report.removed} of Studio's files and entries an earlier build left in repositories were removed${report.failed > 0 ? `; ${report.failed} could not be, and are tried again at quit` : ''}.`,
        details: report.outcomes
          .filter((outcome) => outcome.status !== 'skipped')
          .map((outcome) => `${outcome.status}\t${outcome.label}\t${outcome.path}\t${outcome.reason ?? ''}`)
          .join('\n'),
        source: 'workspace',
      })
    }
  })().catch(() => undefined)
  setLaunchPluginDirsResolver(() => agentIntegrationPluginDirs)
  setLaunchSkillPluginDirsResolver(() => agentIntegrationSkillPluginDirs)
  setLaunchStatusLineScriptResolver(() => agentIntegrationStatusLinePath)

  // The app's own plugin, installed into every workspace it opens. Declared
  // here because it needs the same bridge path the managed MCP sync uses, and
  // the same reporter the agent-state service installs — one resolver each,
  // never a second spelling of either.
  const studioPluginService = createStudioPluginService({
    resolveTemplateRoot: getBundledStudioPluginRoot,
    resolveAgentStateReporterPath: getBundledAgentStateReporterPath,
    resolveBridgeScriptPath: resolveStudioMcpBridgeScriptPath,
    resolveNodeCommand: () => process.execPath,
    resolveUserDataDir: () => app.getPath('userData'),
    resolveAgentStateSocketPath: () => agentStateService.getSocketPath(),
    listHarnesses: () => resolveInstalledSkillHarnesses(),
    // Read at install time, not at wiring time, and only once the copy has
    // settled: a workspace opened during startup is then never installed the
    // old way seconds before the launch starts carrying the same pieces, while
    // a build whose copy FAILED still gets the workspace install, which is what
    // keeps agent state working rather than losing it.
    resolveLaunchPluginsActive: () => appLaunchPluginsActive(agentIntegrationPluginDirs),
    whenLaunchPluginsSettled: () => agentIntegrationReady,
    resolveEnabledSkillDirs: () => studioAreaSkillStore.enabledSkillDirs(),
    pruneRetiredSkillCopies: pruneRetiredBuiltinSkillCopies,
    listAgentStateSpecs,
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })
  // The catalogue's row for Studio's own plugin in a workspace
  // (`studioPlugin.status`): what this build ships, and what this process
  // installed there this run ('' until it has).
  const studioPluginStatus = async (workspaceRoot: string | null): Promise<StudioPluginStatus> => {
    const root = workspaceRoot?.trim() ?? ''
    const [bundledVersion, hooksAcknowledgedAt] = await Promise.all([
      studioPluginService.bundledVersion(),
      studioPluginService.hooksAcknowledgedAt(),
    ])
    const record = root === '' ? null : studioPluginService.installed(root)
    return {
      bundledVersion,
      hooksAcknowledgedAt,
      installedVersion: record?.version ?? '',
      skillDirNames: record?.skillDirNames ?? [],
      claudePluginKey: record?.claudePluginKey ?? '',
    }
  }

  // The core this process serves from: launch settings and machines, the
  // workspace registry, the conversation runtime and the backend chats are
  // driven through, the launch service. The same composition a standalone
  // server builds under plain Node (src/server/core/studio-core.ts); built here
  // because a chat's agent is handed this app's gateway and the launch
  // cap reads this app's terminals.
  // SSH machines (phase 8), a preview off by default: with it off, none of
  // this exists. Main holds their sessions, because their prompts are dialogs
  // and the pane's forward is a session proxy.
  // Read lazily: the registry is the core's, built just below.
  const workspaceRegistryOf = (): {
    getRecord(id: string): { environment?: WorkspaceEnvironmentRef | null } | null | undefined
  } => core.workspaceRegistry
  const ssh: DesktopSsh | null = sessionSshPreview()
    ? createDesktopSsh({
        version: platform.identity.version(),
        server,
        workspaceEnvironment: (workspaceId: string): WorkspaceEnvironmentRef | null =>
          workspaceRegistryOf().getRecord(workspaceId)?.environment ?? null,
      })
    : null

  // This process reads and writes project stores too (the backlog, the
  // browser's captures, module storage), so it moves an older build's
  // in-project state the first time it meets a folder that still has some,
  // even when the core, which also moves every registered project at start,
  // runs in a server process of its own (main/workspace-store.ts).
  installWorkspaceStoreMigration({ log: (message) => console.info(`[workspace-store] ${message}`) })
  // The shell's part of every terminal agent's launch (terminal-launch-
  // preparation.ts): built from the plugin copy, launcher, MCP and skill
  // services only the shell keeps. The core's runtime asks for it directly in
  // process; out of process the server asks over the shell bridge, which
  // answers from this same object. Its members are read at launch time, long
  // after everything they reach is built.
  const terminalLaunchPreparation: TerminalLaunchPreparation = {
    prepareLaunchIntegration: async (input) => {
      await whenAgentLaunchReady()
      return prepareLaunchIntegration(input, {
        spec: (cli) => getPluginById(cli)?.manifest.launchIntegration ?? null,
        isThisMachine: (hostId) => hostRegistry().get(hostId).kind !== 'wsl',
        carriesAppPlugins: launchCarriesAppPlugins,
        launchFilesDir: () => join(app.getPath('userData'), LAUNCH_FILES_DIR),
        gateway: (hostId) => studioGatewayFor(hostId),
        agentStateSpec: (cli) => getPluginById(cli)?.manifest.agentStateSpec ?? null,
        agentStateHookCommand: () => launchAgentStateHookCommand(),
        agentStateTemplatePath: getBundledAgentStateReporterTemplatePath,
        socketPath: () => agentStateService.getSocketPath(),
        bundledSkillPluginDir: (skillId) =>
          Object.hasOwn(agentIntegrationSkillPluginDirs, skillId) ? agentIntegrationSkillPluginDirs[skillId]! : null,
        skillSourceDir: (skillId) => {
          const moduleSkill = findModuleSkill(skillId)
          if (moduleSkill) return moduleSkill.sourceDir
          const root = getBundledResourceDir(BUILTIN_SKILLS_RESOURCE_DIR)
          return findBuiltinSkill(skillId) && root ? join(root, skillId) : null
        },
        skill: (skillId) => resolveSkillById(skillId),
        homeDir: () => homedir(),
        knowledgeActivityCommand: (workspaceRoot) => knowledgeActivityLaunchCommand(workspaceRoot),
        gitTracks: (path) => gitTracksPath(dirname(path), basename(path)),
        warn: (message) => {
          void writeDiagnosticLog({ level: 'warning', title: 'Launch integration', message, source: 'terminal' })
        },
      })
    },
    syncMcpConfig: ({ integration, ...input }) =>
      whenAgentLaunchReady().then(() =>
        syncStudioMcpConfig(
          {
            ...input,
            // A launch that carries the app's plugin directory gets the gateway
            // from that plugin's own `.mcp.json`; pinning it into the repository
            // as well would be a second copy of the server, and one a plain
            // terminal's `claude` in that checkout would load too.
            studioGatewayDeliveredAtLaunch:
              input.clients.length === 1 && launchCarriesAppPlugins(input.clients[0], input.hostId, integration),
          },
          {
            mcpConfigService,
            studioGateway: () => studioGatewayFor(input.hostId, integration),
            // Once per server per run: the same config is synced on every
            // WSL launch, and the same sentence each time is noise.
            warn: (message) => {
              if (mcpWslWarningsSeen.has(message)) return
              mcpWslWarningsSeen.add(message)
              void writeDiagnosticLog({
                level: 'warning',
                title: 'MCP server may not start in WSL',
                message,
                source: 'terminal',
              })
            },
          },
        ),
      ),
    // Skill-at-spawn: make the skill the launch's prompt invokes present in the
    // session CLI's native skill dir before launch. Check-first so already-installed workspaces skip
    // the rewrite; install only fills missing or stale native targets. A CLI
    // whose launch carries the skill in the app's plugin directory gets no copy.
    ensureBuiltinSkillInstalled: async (workspaceRoot, skillId, cli, launch) => {
      const result = await ensureSkillInstalled(workspaceRoot, skillId, {
        cli,
        ...(launch ? { hostId: launch.hostId, integration: launch.integration } : {}),
      })
      if (result.ok) return
      // An id nothing answers to used to be a silent no-op, so a renamed skill
      // or a module that failed to load produced an agent invoking a skill
      // that was never copied — with nothing anywhere saying so.
      const level = result.status === 'unknown-skill' ? 'warn' : 'log'
      console[level](
        `[skills] could not ensure skill "${skillId}" in ${workspaceRoot}: ${result.status}${result.message ? ` — ${result.message}` : ''}`,
      )
      void writeDiagnosticLog({
        source: 'terminal',
        level: result.status === 'unknown-skill' ? 'warning' : 'info',
        title: `Skill "${skillId}" was not installed`,
        message: result.message ?? `The skill installer answered "${result.status}".`,
        details: `status=${result.status} workspaceRoot=${workspaceRoot}`,
        extensionsRow: 'skills',
      })
    },
    // Connector launch: keep the generated managed MCP config out of the
    // connector chat's worktree git (`.mcp.json` / `.codex/config.toml`).
    excludeWorktreeMcpConfig: (worktreePath) => excludeMcpConfigFromWorktree(worktreePath),
    prepareAgentStateHook: async (workspaceRoot, cli, execution) => {
      // A workspace's Studio skills, before the CLI reads its skill folder: the
      // boot pass reaches the known workspaces one at a time, and the last quit
      // took every copy back out. Settled, this costs nothing. A workspace
      // folder only — never an agent worktree, which the pass never writes to.
      const [root] = uniqueResolvedRoots([workspaceRoot])
      if (root && listKnownWorkspaceRoots(workspaceSyncService.getSnapshot()).includes(root)) {
        await studioPluginService.ensureInstalled(root)
      }
      return agentStateService.installForWorkspace(workspaceRoot, cli, execution)
    },
  }
  const core = server
    ? createRemoteCore(server)
    : createStudioCore(platform, {
        role: 'desktop',
        // The person's Scheduled agents switch turns the scheduler on and off,
        // through the module kernel (modules/scheduled-agents-switch.ts).
        scheduledAgentsSwitch: 'modules',
        // A chat's agent is handed the gateway itself, on the machine its CLI
        // runs on: a Claude chat's child loads no project settings, so the
        // gateway pinned into a workspace's `.mcp.json` never reached it, and a
        // Codex or ACP chat would otherwise have only what a terminal launch left
        // pinned in the folder, with no identity.
        resolveStudioMcpServer: async ({ hostId }) => {
          await whenAgentLaunchReady()
          const gateway = studioGatewayFor(hostId ?? null)
          if (!gateway) return null
          return {
            id: STUDIO_MCP_SERVER_ID,
            name: STUDIO_MCP_SERVER_NAME,
            transport: 'stdio',
            command: gateway.command,
            args: gateway.args,
            env: gateway.env,
            ...(gateway.envVarNames?.length ? { envVarNames: gateway.envVarNames } : {}),
          }
        },
        // The terminals run in the core, in this process: the shell prepares
        // each launch (its plugin copy, MCP sync, skills, hook) and hears its
        // sessions for its changelists, the editor's written files, the
        // pull request marks and the git view.
        terminalHost: {
          launchPreparation: terminalLaunchPreparation,
          observers: {
            onAgentLaunched: (session) => agentChangelistFeed.onAgentLaunched(session),
            onAgentFileEdit: (input) => {
              // Under the workspace the process reports itself in, which is
              // where the editor tools look: an agent moved to another chat
              // still names that one.
              const { launchWorkspaceId, workspaceId, agentId } = input.session
              agentWrittenFiles.note(launchWorkspaceId ?? workspaceId, agentId, input.path)
              agentChangelistFeed.onAgentFileEdit(input)
            },
            onAgentSessionExit: (session) => agentChangelistFeed.onAgentSessionExit(session),
            onObservedCheckoutResolved: (session, resolution) =>
              terminalPullRequests?.noteCheckoutResolved(session, resolution),
            onAgentToolCall: (session, toolCall) => terminalPullRequests?.noteToolCall(session, toolCall),
          },
          // The sidebar re-reads a checkout an agent just worked in now,
          // rather than at the next fallback sweep.
          onCheckoutResolved: (facts) => {
            if (facts.gitRoot) getGitRepoWatch().noteActivity(facts.gitRoot)
          },
          isAppFocused: () => anyWindowFocused(),
          diagnosticsEnabled,
          logMainPerfEvent,
          mayAttach: (windowKey, sessionId) => terminalAttachGuard.current?.(windowKey, sessionId) ?? true,
          // Only the resolved CLI and a few shape flags go out: never the
          // prompt, name, folder or cwd (the boundary in shared/telemetry.ts).
          onLaunched: (request, result) =>
            analytics.record('agent.launched', {
              cli: result.cli,
              worktree: request.worktreePath !== undefined,
              connector: request.connectorId !== undefined,
              withPrompt: Boolean(request.prompt),
              ...(request.permissionPreset ? { permissionPreset: request.permissionPreset } : {}),
            }),
        },
        agentServices,
        // What the shell adds to the agents' skills and cards: the token its
        // store keeps, git once the window is up, its window focus and its
        // Trash. A card's `install.module` goes through the core's marketplace.
        agentSkills: {
          resolveGitHubToken: () => githubTokenStore.resolveToken(),
          whenGitMayRun: Promise.all([app.whenReady(), bootJobsGate]),
          onWorkspaceFocus: (listener) => {
            app.on('browser-window-focus', listener)
            return () => app.off('browser-window-focus', listener)
          },
          trash: shellTrash,
        },
        // This desktop's Studio holds the marketplace, the CLI catalogue, the
        // extension scaffold and the hosted feeds; Studio's own plugin in a
        // workspace is this shell's, which installs it.
        extensions: {
          studioPluginStatus: (workspaceRoot) => studioPluginStatus(workspaceRoot),
          changed: () => moduleHub.deliverChanged(),
        },
        // Where this desktop publishes its agents' pages: Settings ▸
        // Artifacts, its set-up and the `artifacts.*` tools are the core's. A
        // page's picture is drawn in a hidden window of this shell, and with
        // no workspace window showing the set-up question is a message box.
        artifacts: {
          thumbnailer: createElectronThumbnailer(),
          hasWindow: () => listWorkspaceWindows().some((window) => window.isVisible() && !window.isMinimized()),
          askNatively: askToSetUpArtifacts,
          resolveGitHubToken: () => githubTokenStore.resolveToken(),
        },
        ...(ssh
          ? {
              sshServers: {
                servers: ssh.environments.routed,
                onConnected: (listener: Parameters<typeof ssh.environments.onConnected>[0]) =>
                  ssh.environments.onConnected(listener),
                // The host and port every device keys the machine's mark by,
                // as Settings › Machines does (`sshMachineRef`): what its SSH
                // config resolves to, else what was typed.
                machineOf: (savedId: string) => {
                  const machine = ssh.environments.list().find((entry) => entry.id === savedId)
                  if (!machine) return null
                  return machine.resolved
                    ? { host: machine.resolved.hostname, port: machine.resolved.port }
                    : { host: machine.destination }
                },
              },
            }
          : {}),
        // A distribution whose chats run on a Studio server inside it (phase
        // 7, off unless the person turns it on in Settings › Machines).
        wslServers: ({ readHostSettings }) =>
          createDesktopWslServers({
            readHostSettings,
            userDataDir: app.getPath('userData'),
            app: {
              version: platform.identity.version(),
              channel: channelForVersion(app.getVersion()) === 'nightly' ? 'nightly' : 'latest',
            },
            packaged: app.isPackaged,
            resourcesDir: app.isPackaged ? process.resourcesPath : null,
            appRoot: app.getAppPath(),
            isDefaultProfile: app.isPackaged && !readStudioEnv('SPRINTENGINE_USER_DATA_DIR')?.trim(),
            fetch: (url, init) => net.fetch(url, init),
            log: (message) => {
              void writeDiagnosticLog({ level: 'info', title: 'WSL server', message, source: 'workspace' })
            },
          }),
      })
  const {
    agentLaunchSettings,
    hosts,
    workspaceRegistry,
    workspaceSyncService,
    conversationOwner,
    conversations,
    conversationModelCatalog,
    conversationLaunchService,
    resolveAgentPermissionPreset,
  } = core
  // The terminals and their agents are the core's (studio-agent-terminals.ts):
  // in process this one's, null where no pty can start; out of process the
  // server's, which the shell reads through `shellTerminals`.
  const coreTerminals = !server && 'agentTerminals' in core ? core.agentTerminals : null
  const shellTerminals: ShellTerminals = server ? remoteShellTerminals(server.rpc) : localShellTerminals(coreTerminals)
  // Every launch the shell starts itself (a tour's author) goes to the core's launch service.
  const agentLaunchService = coreTerminals?.launchService ?? null
  const conversationTerminalHandoff = coreTerminals?.handoff ?? null

  // Renderer-pushed "keep running in the background" setting. Read
  // synchronously inside `window-all-closed`, which is precisely when no
  // renderer is left to ask.
  const backgroundModeStore = createBackgroundModeStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })

  // "Ask before quitting while agents are working": main's own, since the
  // quit dialog's "Don't ask again" writes it with no renderer involved.
  const quitConfirmationStore = createQuitConfirmationStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })

  // A banner when a chat finishes or waits on the person while they are in
  // another app (agent-notifications.ts). Main owns the setting: the banners
  // are raised here, with no renderer to ask.
  const agentNotificationsStore = createAgentNotificationsStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })
  const agentNotifier = createAgentNotifier({
    // A banner opens its chat by address: this desktop's environment, whose
    // Studio holds every chat this runtime's phases are about.
    environmentId: readStudioEnvironmentId(app.getPath('userData'), {
      log: (message) => void writeDiagnosticLog({ level: 'info', title: 'Environments', message, source: 'workspace' }),
    }),
    mode: () => agentNotificationsStore.mode(),
    isAnyWindowFocused: () =>
      BrowserWindow.getAllWindows().some(
        (window) => !window.isDestroyed() && !isCanvasWorkerWindow(window) && window.isFocused(),
      ),
    chatLabel: (workspaceId, agentId) => {
      const workspace = workspaceSyncService
        .getSnapshot()
        .state.workspaces.find((candidate) => candidate.id === workspaceId)
      // Only a chat the sidebar lists: a module's background host is found
      // through its own door, and a banner would open somewhere the rail
      // cannot take the person back from.
      if (!workspace || (workspace.mode && workspace.mode !== 'standard')) return null
      const agents = Object.values(workspace.agents ?? {})
      const agentName = agents.length > 1 ? workspace.agents?.[agentId]?.name : undefined
      return { title: workspace.name || 'Chat', ...(agentName ? { agentName } : {}) }
    },
    show: (notice) => shellBridge.notify(notice),
  })

  // "Keep the computer awake while agents work": main's own, since main takes
  // and releases the blocker as agents start and stop. The lifecycle feeds it
  // the agents' phases and lets it go at quit.
  const keepAwakeStore = createKeepAwakeStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })
  const agentKeepAwake = createAgentKeepAwake({
    // Read through at each call: the blocker is only touched once an agent works.
    blocker: {
      start: (type) => powerSaveBlocker.start(type),
      stop: (id) => powerSaveBlocker.stop(id),
    },
    isEnabled: () => keepAwakeStore.isEnabled(),
    // The live word on each agent: a terminal agent by its pty and hook state,
    // a chat run here by its session. A chat on an out-of-process server is
    // not known here, and is held only by its own events (and the stale cap).
    liveWorking: () => {
      const terminals = shellTerminals.list().filter((session) => session.kind === 'agent')
      const listed = server ? null : conversations.listSessions()
      const chats = listed?.ok ? listed.sessions : []
      return (workspaceId, agentId) => {
        const terminal = terminals.find(
          (session) => session.agentId === agentId && (session.workspaceId ?? null) === workspaceId,
        )
        if (terminal) return terminalAgentWorking(terminal)
        const chat = chats.find((session) => session.agentId === agentId && session.workspaceId === workspaceId)
        if (!chat) return undefined
        return conversationSummaryPhase(chat) === 'running'
      }
    },
  })

  // A pty that exits mid-turn reports no phase; its exit is the agent stopping.
  coreTerminals?.runtime.registerAgentSessionExitListener((event) => agentKeepAwake.onAgentExit(event))

  // Renderer-pushed "Share anonymous usage data" setting, and the one service
  // that acts on it. Built here, beside the other userData mirrors and before
  // anything that records, because `app.boot` is emitted below and the launch
  // paths further down take `analytics` as a dependency.
  //
  // Silent unless a PostHog project key is configured — see
  // `src/shared/telemetry.ts`, which is also where the collection boundary is
  // written down. From-source builds ship no key, so this is inert in dev.
  const telemetryConsentStore = createTelemetryConsentStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })
  const analytics = createAnalyticsService({
    resolveUserDataDir: () => app.getPath('userData'),
    isConsented: () => telemetryConsentStore.isEnabled(),
    appVersion: app.getVersion(),
    // A dev build reports itself as such rather than being filtered out here,
    // so "is anyone using the shipped app" stays answerable without guessing
    // which version strings were builds from someone's laptop.
    packaged: app.isPackaged,
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })
  // The install/active-machine counter. `firstRun` is true only on the boot
  // that minted the install id, which is what separates new installs from
  // returning ones without a second event.
  //
  // Guarded on `isActive` rather than left to `record`'s own no-op: reading the
  // id is what MINTS it, and an unkeyed or opted-out build has no business
  // writing an identity file it will never use.
  if (analytics.isActive()) {
    analytics.record('app.boot', {
      firstRun: readInstallId({ resolveUserDataDir: () => app.getPath('userData') }).created,
    })
  }

  // One warning per distinct message per run: the same MCP config is synced
  // on every WSL launch, and the same sentence each time is noise.
  const mcpWslWarningsSeen = new Set<string>()

  // The Scheduled agents module registers on the module kernel AFTER app
  // services are constructed; index.ts injects the resolver once the kernel is
  // up. Declared here because the scheduled-agent tools resolve it lazily, at
  // call time. Until the module is up, they report it as unavailable rather
  // than buffering.
  let resolveScheduledAgents: () => ScheduledAgentsService | null = () => null
  // Live main-process module enablement, injected by index.ts once the manifest
  // universe exists; it recomputes on every override the renderer pushes, so a
  // module the user just switched off is off here on the next call. Until then
  // nothing is enabled: a gateway tool that cannot learn its module's state must
  // report the capability as off rather than act on its behalf.
  let resolveModuleEnabled: (moduleId: string) => boolean = () => false
  // Module-contributed MCP tools on the Studio gateway, injected by
  // index.ts from the host kernel after loadMainModules. The gateway is
  // constructed before modules load, so until the seam is wired the registry
  // reads empty — and because the tool set is evaluated per request, module
  // tools appear on the very next call once modules are up.
  let resolveModuleMcpTools: () => ReadonlyArray<McpToolContribution> = () => []
  // The renderer's module registry, mirrored here. Empty until a
  // window pushes one; consumers report "not yet known" rather than "no
  // modules", the same rule the enablement mirror follows.
  // In process, the Studio's own (`module.reportRegistry`); out of process the
  // server keeps its own and this one stays empty.
  const moduleRegistryMirror = createModuleRegistryMirror()
  // The marketplace, the scaffold and the feeds, where this process's core holds them.
  const coreExtensions = 'extensions' in core ? core.extensions : null
  // Settings ▸ Artifacts and the `artifacts.*` tools, where this process's core
  // holds them; out of process the server's, which serves the tools itself.
  const coreArtifacts = 'artifacts' in core ? core.artifacts : null

  // Agent changelists: an agent's own list, holding exactly the lines it wrote.
  // The feed owns every rule about WHICH checkout a claim belongs to and what it
  // refuses to claim (see agent-changelist-feed.ts); this only hands it the
  // user-data dir it writes under and the way to tell the windows to re-read.
  // Shared by the feed and by the changelist IPC handlers (register-core-ipc):
  // a list moved by an agent and a list renamed by a person reach the other
  // windows the same way.
  const broadcastGitChangelistsChanged = (repoRoot: string): void => {
    // Every client's `git.changelistsChanged` stream hears it and re-reads that root.
    announceChangelistsChanged(repoRoot)
  }
  const agentChangelistFeed = createAgentChangelistFeed({
    userDataDir: app.getPath('userData'),
    broadcast: broadcastGitChangelistsChanged,
  })
  // What each agent wrote, for the editor reveal: a file outside the workspace
  // that the asking agent wrote itself may be shown without asking the person.
  const agentWrittenFiles = createAgentWrittenFiles()

  // The pull request record is the Studio server's (owner ruling 2026-10-03):
  // the terminal agents' marks are read from it over the protocol, by
  // `terminalPullRequests`, built below once the shell's connection to the
  // server exists. Bound late; until it is, a session wears no marks.
  let terminalPullRequests: TerminalPullRequests | null = null
  // The snapshot's `pullRequests` field is filled from here, and nowhere else.
  setSessionPullRequestReader((session) => terminalPullRequests?.listForSession(session) ?? [])

  // The saved update channel is main's: the updater is configured here, before
  // any renderer exists to ask.
  const updateChannelStore = createUpdateChannelStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'update' })
    },
  })
  const updateService = new SprintEngineUpdateService({
    writeDiagnosticLog,
    channelStore: updateChannelStore,
    // The note an update leaves for the build that starts after it.
    installNotes: createUpdateInstallNoteStore({ resolveUserDataDir: () => app.getPath('userData') }),
    // "Restart to update" shows its progress on the launch plate.
    progressWindow: {
      show: (progress) => showUpdateProgressWindow(channelForVersion(app.getVersion()), progress),
      update: (progress) => sendSplashProgress(progress),
    },
  })
  const agentConfigImportService = agentServices.agentConfigImport
  // The token is the server's out of process; the shell's skills, cards and
  // marketplace ask it for one.
  const githubTokenStore = server
    ? (createRemoteGitHubTokenStore(server.rpc) as GitHubTokenStore)
    : new GitHubTokenStore()

  // The backups are the server's out of process (its own copy writes them).
  const workspaceBackupService = server
    ? null
    : createWorkspaceBackupService({
        resolveUserDataDir: () => app.getPath('userData'),
        // Read at write time, from the core's registry.
        readRegistry: () => workspaceRegistry.getState(),
        // At most one registry serialization every ten seconds; the newest request
        // inside the interval is written when it ends.
        minRegistryIntervalMs: 10_000,
      })
  // The skill sources, their scans and installs are the core's
  // (studio-agent-skills.ts): in process this one's; out of process the
  // server's, whose `plugin` tools and hourly check read them there.
  const skillsService: SkillsService | null = 'agents' in core ? core.agents.skills.skills : null
  // The `tailnet.*` tools configure the service that (transitively) owns them,
  // so the tool set cannot capture it at construction. Assigned immediately
  // below; until then those tools answer that they are not wired up yet.
  let tailnetToolsFrontDoor: TailnetToolsFrontDoor | null = null
  // OS notifications for pairing and reachability (pair-from-the-scan-and-
  // stay-paired, phase 3): only while no window is focused, only the events a
  // person is waiting on, never the code. A click brings the app forward and
  // opens the Remote popover in the first workspace window.
  // The server notifies for its own tailnet out of process.
  const tailnetNotifier = server
    ? null
    : createTailnetNotifier({
        isAnyWindowFocused: () =>
          BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused()),
        isEnabled: () => automationService?.getTailnetStatus().notifications ?? false,
        openRemote: () => void shellBridge.reveal.tab({ kind: 'remote' }),
        // A later phase of the same request replaces the banner rather than
        // stacking "waiting" under "paired": the notice's key says which. A click
        // opens the Remote popover, which the bridge's reveal does.
        show: (notice) => shellBridge.notify({ ...notice, activate: { kind: 'remote' } }),
      })
  // The embedded browser's main half (browser-pane epic): adopts the guests the
  // pane's browser tabs attach, drives them, and finds the dev servers this
  // workspace's terminals are running. The control layer is the agents' hands
  // on those same tabs, exposed as the gateway's browser.* tools below.
  const browserManager = createBrowserManager({
    listTerminalRoots,
    // A pane popped out of its window hosts its browser tabs there.
    isHostWindow: isBrowserHostWebContents,
    broadcast: broadcastToWorkspaceWindows,
    resolveWorkspaceRoot: (workspaceId) =>
      workspaceSyncService.getSnapshot().state.workspaces.find((workspace) => workspace.id === workspaceId)
        ?.folderPath ?? null,
    ...(ssh ? { machinePartitions: ssh.panes } : {}),
  })
  const browserControl = createBrowserControl(browserManager)
  browserManager.onUnregister((tabId) => browserControl.forget(tabId))
  setAfterWindowZoom((contents) => browserManager.reapplyGuestZoom(contents))
  // Recording a tab to video for the agents' `browser.record_*` tools: the
  // window hosting the tab captures and encodes it, and the file goes into the
  // calling agent's workspace (docs/design/browser-recording.md).
  const browserRecorder = createBrowserRecorder({
    encoder: createHostRecordingEncoder({ ipcMain, tabs: browserManager }),
    outputs: createWorkspaceRecordingOutputs({
      // The project's own folder: for a chat in a worktree (every New chat
      // leases one from the pool), the checkout it was cut from, so the video
      // outlives the worktree and never holds a pool slot on disk.
      resolveWorkspaceRoot: (workspaceId) => {
        const record = workspaceSyncService
          .getSnapshot()
          .state.workspaces.find((workspace) => workspace.id === workspaceId)
        return record ? workspaceProjectRootOf(record) : null
      },
      machineLabel: (id) => ssh?.environments.list().find((machine) => machine.id === id)?.label ?? null,
    }),
    publish: (tabId, recording) => browserManager.setRecording(tabId, recording),
    describeTab: (tabId) => {
      try {
        return new URL(browserManager.state(tabId)?.url ?? '').host
      } catch {
        return ''
      }
    },
    log: (message) => {
      void writeDiagnosticLog({ level: 'warning', source: 'workspace', title: 'Browser recording', message })
    },
  })
  browserManager.onUnregister((tabId) => browserRecorder.tabClosed(tabId))

  // The Canvas pane's main half. It owns the `.excalidraw` files under a
  // workspace root — the SAME root the browser sidecar and the backlog resolve
  // against — and it is the only writer of them: the tab commits through it and
  // the `canvas.*` tools call it directly, so a board has one merge and one
  // revision however it was edited. The hidden worker window behind it is built
  // lazily on the first call that needs a DOM and disposed when it goes idle.
  // The editor reveal's main half (editor.* tools): asks the windows to open a
  // file or diff, and keeps what no window could show for when one does.
  const editorRevealBroker = createEditorRevealBroker({
    targets: () =>
      listWorkspaceWindows().map((window) => ({
        id: window,
        isDestroyed: () => window.isDestroyed() || window.webContents.isDestroyed(),
        send: (channel: string, payload: unknown) => window.webContents.send(channel, payload),
      })),
    broadcastPending: (workspaceIds) => broadcastToWorkspaceWindows(EDITOR_REVEAL_PENDING_CHANNEL, { workspaceIds }),
  })

  // The worktree pool, its installs and `worktree.*` are the core's
  // (server/core/studio-worktree-pool.ts): in process this one's, out of
  // process the server's, which the windows reach over their tunnel.
  const worktrees = 'worktrees' in core ? core.worktrees : null

  const canvasSubscribers = createCanvasSubscriberRegistry()
  // A board another device holds over the Studio protocol is a subscriber too
  // (canvas-remote-subscribers.ts): it hears every write a window here would.
  const canvasRemoteSubscribers = createCanvasRemoteSubscribers()
  const canvasStoreCatalogue = createCanvasStoreCatalogue({
    userDataDir: app.getPath('userData'),
    listWorkspaces: () => workspaceSyncService.getSnapshot().state.workspaces,
    log: (message, details) => {
      void writeDiagnosticLog({
        level: 'warning',
        source: 'workspace',
        title: 'Canvas',
        message,
        ...(details ? { details: JSON.stringify(details) } : {}),
      })
    },
  })
  const canvasService = createCanvasService({
    fs: createNodeCanvasFs(),
    now: () => Date.now(),
    resolveWorkspaceRoot: (workspaceId) =>
      workspaceSyncService.getSnapshot().state.workspaces.find((workspace) => workspace.id === workspaceId)
        ?.folderPath ?? null,
    resolveBoardStore: (_workspaceId, workspaceRoot) => canvasBoardStoreDir(app.getPath('userData'), workspaceRoot),
    storeCatalogue: canvasStoreCatalogue,
    broadcast: (channel, payload) => {
      broadcastToWorkspaceWindows(channel, payload)
      canvasRemoteSubscribers.broadcast(channel, payload)
    },
    sendTo: (subscriberId, channel, payload) => {
      if (isRemoteCanvasSubscriber(subscriberId)) canvasRemoteSubscribers.sendTo(subscriberId, channel, payload)
      else canvasSubscribers.sendTo(subscriberId, channel, payload)
    },
    watch: watchCanvasDirectory,
    worker: createCanvasWorkerHost({
      transport: createCanvasWorkerTransport({
        ipcMain,
        log: (message, details) => {
          void writeDiagnosticLog({
            level: 'warning',
            source: 'workspace',
            title: 'Canvas',
            message,
            ...(details ? { details: JSON.stringify(details) } : {}),
          })
        },
      }),
    }),
    log: (message, details) => {
      void writeDiagnosticLog({
        level: 'info',
        source: 'workspace',
        title: 'Canvas',
        message,
        ...(details ? { details: JSON.stringify(details) } : {}),
      })
    },
  })
  // Diff tours (tour.* tools, the Diff viewer's tour mode). One owner for
  // every tour: the gateway writes them, the viewer plays them, and an owner's
  // question is typed into the author's terminal from here.
  const tours = createAppTourService({
    userDataDir: app.getPath('userData'),
    resolveWorkspaceRoot: (workspaceId) =>
      workspaceSyncService.getSnapshot().state.workspaces.find((workspace) => workspace.id === workspaceId)
        ?.folderPath ?? null,
    // The author's terminal is the server's: read, typed into and launched there.
    listTerminals: () => shellTerminals.list(),
    writeTerminal: (sessionId, data) => shellTerminals.write(sessionId, data),
    launchAgent: async (request) => {
      const launched = await shellTerminals.launch(request)
      return launched.ok ? { ok: true, agentId: launched.agentId } : { ok: false, message: launched.message }
    },
    broadcastToWorkspaceWindows,
    broadcastToViewers: (channel, payload) => broadcastToAllWindows(channel, payload, { skipCanvasWorker: true }),
    isAppFocused: () => anyWindowFocused(),
  })
  const tourService = tours.service
  // The author's phases: the runtime's in process, the server's attention
  // relay out of process, which carries every agent's.
  if (server) server.rpc.on(SERVER_EVENTS.attentionPhase, (event) => tourService.onAgentPhase(event as AgentPhaseEvent))
  else coreTerminals?.runtime.registerAgentPhaseListener((event) => tourService.onAgentPhase(event))

  /**
   * Whether the Canvas module is on.
   *
   * `canvas` is a renderer-only module: main's enablement gate resolves the
   * manifests of modules with a MAIN half, and a module whose whole substance
   * is a pane tab is not in that list — it would answer false for a module the
   * person can see switched on. The renderer's mirrored registry is the one
   * place main can read the user's actual switch, and until a window has pushed
   * one the module's own `defaultEnabled` stands: refusing every canvas tool
   * for the first seconds of a run would read as a broken capability, not a
   * disabled one.
   *
   * A snapshot that ARRIVED but carries no `canvas` entry means the same thing
   * as no snapshot at all — the window's registry has not listed it yet — so it
   * falls to the same default. Reading it as "off" put the answer through a
   * resolver that has no canvas manifest to resolve and therefore always says
   * false, which turned a module the person can see switched on into every
   * canvas tool refusing.
   */
  const isCanvasEnabled = (): boolean => {
    const snapshot = moduleRegistryMirror.read()
    const entry = snapshot?.modules.find((module) => module.id === 'canvas')
    if (entry) return entry.enabled
    return CANVAS_MODULE_DEFAULT_ENABLED
  }

  // The browser and canvas tools, as main runs them. The shell offers both to
  // the gateway as client toolsets, the way any app offers its tools;
  // `SPRINTENGINE_CLIENT_TOOLS=0` keeps them registered in process, as before,
  // for one release. The canvas service stays on this disk's files while the
  // server runs in this process: they are the server's files too.
  const clientToolsEnabled = readStudioEnv('SPRINTENGINE_CLIENT_TOOLS') !== '0'
  // "Let agents use the built-in browser" (Settings → Agents). Offered as a
  // client toolset, the tools are withdrawn and offered again as it changes;
  // served in process (the env switch above), each list leaves them out while
  // it is off. Either way the switch is read when it is needed, never kept.
  const agentBrowserToolsStore = createAgentBrowserToolsStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })
  const browserToolsOffered = () => agentBrowserToolsStore.isEnabled()
  const browserToolGate = agentBrowserToolGate(browserToolsOffered)
  const browserTools = createBrowserTools({
    manager: browserManager,
    control: browserControl,
    recorder: browserRecorder,
    hasWorkspace: (workspaceId) =>
      workspaceSyncService.getSnapshot().state.workspaces.some((workspace) => workspace.id === workspaceId),
  })
  const canvasToolsOver = (service: CanvasService) =>
    createCanvasTools({
      service,
      hasWorkspace: (workspaceId) =>
        workspaceSyncService.getSnapshot().state.workspaces.some((workspace) => workspace.id === workspaceId),
      isCanvasEnabled,
    })
  const canvasTools = canvasToolsOver(canvasService)
  // The editor and tour tools act on what a window shows. In process they are
  // the gateway's own; out of process the shell offers them as its `editor`
  // and `tour` toolsets (phase 6, 6.3).
  const editorTools = createEditorTools(
    createEditorToolBackends({
      findWorkspace: (workspaceId) =>
        workspaceSyncService.getSnapshot().state.workspaces.find((workspace) => workspace.id === workspaceId) ?? null,
      listTerminalSessions: () => shellTerminals.list(),
      agentWrittenFiles,
      broker: editorRevealBroker,
      userDataDir: () => app.getPath('userData'),
      isAppFocused: () => anyWindowFocused(),
    }),
  )
  // `visual.preview` draws in a hidden window of this app, so the shell serves it.
  const visualTools = createVisualTools(createElectronVisualPreview(listWorkspaceWindows))
  const tourTools = createTourTools({
    service: tourService,
    hasWorkspace: (workspaceId) =>
      workspaceSyncService.getSnapshot().state.workspaces.some((workspace) => workspace.id === workspaceId),
  })
  // `extension.create` and `extension.guide`: a project made on this machine's
  // disk, by the scaffold a window's New chat door uses, and the guide shipped
  // beside the app. `plugin.search` and `plugin.offer`: the plugin sources the
  // Extensions door lists. In process the gateway's own; out of process the
  // server's (desktop-server.ts).
  const extensionTools = coreExtensions
    ? createExtensionTools({ scaffold: coreExtensions.scaffold, guideRoot: () => resolveScaffoldRoots().guideRoot })
    : []
  const pluginTools = skillsService
    ? createPluginTools({
        listSources: () => skillsService.listSources(),
        getScan: (input) => skillsService.getScan(input),
      })
    : []

  // Instance-global SprintEngine Studio MCP surface: reads come from the
  // workspace-sync snapshot and terminal runtime, and mutations go straight to
  // the main services that own them — one lane, no window required.
  // The gateway starts with the app.
  // Who hears that the paired desktops changed, while the mesh is this process's.
  const meshListeners = new Set<() => void>()
  // Who hears whether a paired desktop answers, while the mesh is this process's.
  const meshReachabilityListeners = new Set<() => void>()
  // Out of process the gateway, the tailnet and the mesh are the server's.
  const automationService = server
    ? null
    : createStudioGateway(core, {
        // A picture a paired device uploads is sized for the model on receipt,
        // with this process's own image codec.
        downscaleUpload: (bytes, mediaType) => shellBridge.images.downscale(bytes, mediaType),
        // The live-state push (remote-sessions-ux): every window hears listener,
        // pairing, and connection changes the moment main does — the fix for pair
        // requests that could expire while only Settings, if open, would show them.
        onTailnetEvent: (payload) => {
          broadcastToAllWindows(TAILNET_EVENT_CHANNEL, payload)
          tailnetNotifier?.onTailnetEvent(payload)
        },
        onMeshEvent: (event) => {
          broadcastToAllWindows(MESH_EVENT_CHANNEL, event)
          tailnetNotifier?.onMeshEvent(event)
          if (meshListChanged(event)) for (const listener of [...meshListeners]) listener()
          if (meshListChanged(event) || event.kind === 'machine-reachability')
            for (const listener of [...meshReachabilityListeners]) listener()
        },
        // A window someone could be looking at: the mesh's reachability timer and
        // its re-checks of an absent machine only feed rows on screen.
        hasWindow: () =>
          BrowserWindow.getAllWindows().some(
            (window) =>
              !window.isDestroyed() && !isCanvasWorkerWindow(window) && window.isVisible() && !window.isMinimized(),
          ),
        // Module-contributed tools, read from the host kernel per request and
        // gated on their owner's live enablement.
        resolveModuleTools: () => resolveModuleMcpTools(),
        isModuleEnabled: (moduleId) => resolveModuleEnabled(moduleId),
        // The core's own tools (`conversation.create`) among this app's window,
        // terminal and run tools, in the order agents have always listed them
        // (`desktopGatewayTools`).
        // This server's shell offers these, and an agent's first list waits for them.
        // Not the browser when it is switched off: the first list would wait
        // out the boot window for a toolset that is never coming.
        expectShellToolsets: clientToolsEnabled ? browserToolGate.expectedToolsets(['browser', 'canvas']) : [],
        ...(clientToolsEnabled ? {} : { hideTool: browserToolGate.hidesTool }),
        // An agent that starts a chat hears back from it, as one that launches
        // a terminal agent does.
        ...(coreTerminals
          ? {
              linkLaunchedAgent: (link: Parameters<typeof coreTerminals.launchNotices.link>[0]) =>
                coreTerminals.launchNotices.link(link),
              dismissLaunchNotice: (sessionId: string) => coreTerminals.launchNotices.dismiss(sessionId),
            }
          : {}),
        appTools: desktopGatewayTools({
          browser: clientToolsEnabled ? [] : browserTools,
          canvas: clientToolsEnabled ? [] : canvasTools,
          editor: editorTools,
          tour: tourTools,
          visual: visualTools,
          automation: createAutomationTools(
            createServerGatewayBackends({
              getWorkspaceSyncSnapshot: () => workspaceSyncService.getSnapshot(),
              listTerminalSessions: () => shellTerminals.list(),
              ...(coreTerminals
                ? {
                    readTerminalOutputTail: (sessionId: string, options: { maxBytes: number; since?: string }) =>
                      coreTerminals.runtime.readTerminalOutputTail(sessionId, options),
                    linkLaunchedAgent: (link: Parameters<typeof coreTerminals.launchNotices.link>[0]) =>
                      coreTerminals.launchNotices.link(link),
                  }
                : {}),
              launchAgent: (request) => shellTerminals.launch(request),
              resolveAgentPermissionPreset,
              createWorkspace: (input, actor) => workspaceSyncService.createWorkspace(input, actor),
              studioDataDirs: () => [app.getPath('userData')],
              getScheduledAgents: () => resolveScheduledAgents(),
              ...launchSettingsGatewayDeps(agentLaunchSettings),
              // module.*/marketplace.*. The registry snapshot is the one a
              // window reported (`module.reportRegistry`): the kernel's own list
              // omits every window-only module, so reporting from it would be
              // wrong by construction. The installed extensions and the
              // marketplace are read as a window's `module.installed` and
              // `marketplace.read` are, cache included.
              getModuleRegistrySnapshot: () => moduleRegistryMirror.read(),
              listInstalledThirdPartyModules: async () =>
                (await moduleHub.lifecycle()?.installed()) ?? { modules: [], rejected: [] },
              listModuleContributedTools: () =>
                resolveModuleMcpTools().map((tool) => ({ moduleId: tool.moduleId, toolName: tool.registration.name })),
              readMarketplaceRegistry: (input) =>
                coreExtensions
                  ? coreExtensions.marketplace.read(input)
                  : Promise.reject(new Error('This Studio holds no marketplace.')),
              // What a paired machine's composer offers a chat here.
              readWorkspaceExtensions: createWorkspaceExtensionsReader({
                listWorkspaceSkills: (input) => core.agents.skills.workspaceSkills.listWorkspaceSkills(input),
                agentCapabilities: (input) => core.agents.skills.agentCapabilities.resolve(input),
                listSources: () => core.agents.skills.skills.listSources(),
              }),
            }),
          ),
          // Remote-control configuration, local socket only: the listener refuses
          // this whole family regardless of a device's scopes (tailnet-scopes.ts).
          artifacts: coreArtifacts?.tools ?? [],
          extension: extensionTools,
          plugin: pluginTools,
          tailnet: createTailnetTools({ resolveTailnet: () => tailnetToolsFrontDoor }),
        }),
      })
  tailnetToolsFrontDoor = automationService
  // Every Studio this desktop knows, with the routes it reaches each by and how
  // each stands: this machine, its WSL distributions, its SSH machines and its
  // paired desktops (environments/environment-registry.ts). Every window draws
  // its machines from it (design-environments).
  const environments = createDesktopEnvironments({
    userDataDir: app.getPath('userData'),
    platform: process.platform,
    hosts: {
      get: () => agentLaunchSettings.get().hosts,
      onChanged: (listener) => agentLaunchSettings.subscribe(() => listener()),
    },
    hostStates: hostRegistry(),
    ssh: ssh
      ? {
          list: () => ssh.environments.list(),
          onChanged: (listener) => ssh.environments.onChanged(listener),
          connect: (id) => ssh.environments.connect(id),
        }
      : null,
    // The mesh is the gateway's: this process's in process, the server's out of it.
    mesh: automationService
      ? {
          list: () => automationService.mesh().listConnections(),
          onChanged: (listener) => {
            meshListeners.add(listener)
            return () => meshListeners.delete(listener)
          },
        }
      : (server?.mirror.meshConnections ?? null),
    meshReachability: automationService
      ? {
          list: () => automationService.mesh().getLiveState().reachability,
          onChanged: (listener) => {
            meshReachabilityListeners.add(listener)
            return () => meshReachabilityListeners.delete(listener)
          },
          check: (connectionId) => automationService.mesh().checkReachability(connectionId),
        }
      : server
        ? {
            list: () => server.mirror.meshReachability.list(),
            onChanged: (listener) => server.mirror.meshReachability.onChanged(listener),
            check: (connectionId) => server.rpc.call(SERVER_METHODS.meshCheckReachability, { connectionId }),
          }
        : null,
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', title: 'Environments', message, source: 'workspace' })
    },
  })
  registerEnvironmentsIpc(ipcMain, {
    environments,
    broadcast: (channel) => broadcastToAllWindows(channel, null),
    // A window's own client of a paired desktop's Studio (design-lane-on-protocol
    // D1): the mesh keeps the device token and buys each connection's ticket.
    // The other kinds of route are reached through this machine's server for now.
    ticket: async (route, origin, windowKey) => {
      // An SSH machine's own window listener mints it, asked over main's
      // owner connection; the window's socket goes to main's loopback route.
      if (route.kind === 'ssh') {
        if (!ssh)
          return { ok: false, code: 'unsupported_route', message: 'SSH machines are not turned on in this app.' }
        return ssh.environments.windowTicket(route.machine, { windowKey, origin })
      }
      if (route.kind !== 'tailnet')
        return { ok: false, code: 'unsupported_route', message: 'This window reaches that machine through this one.' }
      if (automationService) return automationService.mesh().windowTicket(route.connection, origin)
      if (server)
        return server.rpc.call<EnvironmentTicketResult>(SERVER_METHODS.meshWindowTicket, {
          connectionId: route.connection,
          origin,
        })
      return { ok: false, code: 'unavailable', message: 'Studio’s server is not running yet.' }
    },
  })
  // A chat agent in WSL reaches its own server's gateway: the desktop's
  // toolsets, and this side's own tools of the families the WSL server cannot
  // serve, are offered there too, and run here (phase 7).
  const wslServersOfCore = 'wslServers' in core ? core.wslServers : null
  // An SSH machine's agents get the pane's browser, whose tabs reach that
  // machine's network, and the canvas (phase 8).
  if (automationService && ssh)
    relayShellToolsets({
      onConnected: (listener) =>
        ssh.environments.onConnected((connection) =>
          listener({
            key: connection.key,
            name: connection.label,
            backend: connection.backend,
            open: (purpose: 'studio') => connection.open(purpose),
            toolsets: SSH_RELAYED_TOOLSETS,
            args: (_toolset, args) => args,
          }),
        ),
      registry: automationService.clientTools,
      log: (message) => {
        void writeDiagnosticLog({ level: 'info', title: 'SSH machine', message, source: 'workspace' })
      },
    })
  if (automationService && wslServersOfCore)
    relayShellToolsets({
      onConnected: (listener) => wslServersOfCore.onConnected(listener),
      registry: automationService.clientTools,
      gatewayTools: () => automationService.ownTools(),
      log: (message) => {
        void writeDiagnosticLog({ level: 'info', title: 'WSL server', message, source: 'workspace' })
      },
    })
  // The Studio RPC: the protocol applications on this machine follow, drive
  // and start chats with, on an owner-only socket in userData/run, composed
  // over the core and its gateway as a standalone server composes it. Its
  // paths, version and the push to Settings are the platform's. Nothing in the
  // app uses it yet; paired apps are listed and revoked in Settings.
  // This desktop updates itself (`update.*`), through the app updater, in
  // process here and out of process through the shell methods below.
  const desktopUpdates = desktopStudioUpdates(updateService, {
    commands: updateCommandFile(join(app.getPath('userData'), UPDATE_COMMAND_FILENAME)),
    log: (message) => void writeDiagnosticLog({ level: 'warning', source: 'update', title: 'Client update', message }),
  })
  // What this process's modules say to clients (`module.events`,
  // `module.notifications`): app-main's kernel delivers into it.
  const moduleHub = createStudioModuleHub()
  // Which window may take over a running terminal's output: set once the pane
  // pop-out relay is registered (register-core-ipc.ts).
  const terminalAttachGuard: { current: ((windowKey: string, sessionId: string) => boolean) | null } = {
    current: null,
  }
  const studioRpc = automationService
    ? createStudioRpc(core, automationService, {
        updates: desktopUpdates,
        modules: moduleHub,
        // What this desktop's shell adds to the files on its disk: its Trash,
        // its image codec for project logos, and where Documents is.
        fileSystemShell: desktopFileSystemShell(),
        // The GitHub account this desktop keeps, for `github.*`.
        githubTokens: githubTokenStore,
        // Another device's boards (a paired desktop's Canvas pane, the phone's
        // list and pictures), through the same canvas service this machine's
        // windows and agents use, and the same tools that list and draw them,
        // each held to where a board's file really is.
        canvas: canvasRemoteSubscribers.host(canvasService, canvasToolsOver),
      })
    : null
  // Where the person's attention is, for routing a call to the window in
  // front of them when more than one desktop offers a toolset.
  const desktopFocus = {
    current: () => ({
      focused: anyWindowFocused({ skipCanvasWorker: true }),
      // A desktop shows every workspace it holds, each a tab away.
      workspaceIds: workspaceSyncService
        .getSnapshot()
        .state.workspaces.map((workspace) => workspace.id)
        .slice(0, 64),
    }),
    onChange: (listener: () => void) => {
      app.on('browser-window-focus', listener)
      app.on('browser-window-blur', listener)
      const unsubscribe = workspaceSyncService.subscribeEvents(listener)
      return () => {
        app.off('browser-window-focus', listener)
        app.off('browser-window-blur', listener)
        unsubscribe()
      }
    },
  }
  const logDesktopTools = (message: string) => {
    void writeDiagnosticLog({ level: 'warning', source: 'workspace', title: 'Desktop tools', message })
  }
  // The shell, a client of its own server: in process over a port main holds
  // both ends of, out of process over one it brokers to the server. It offers
  // what only a screen or a terminal can serve.
  const desktopShell = studioRpc
    ? createDesktopShellTools({
        transport: studioRpc.shellTransport(),
        version: app.getVersion(),
        toolsets: clientToolsEnabled
          ? [
              { name: 'browser', registrations: browserTools, enabled: browserToolsOffered },
              { name: 'canvas', registrations: canvasTools },
            ]
          : [],
        focus: desktopFocus,
        log: logDesktopTools,
      })
    : server
      ? createDesktopShellTools({
          transport: server.shellTransport(),
          version: app.getVersion(),
          // Out of process the server serves none of these itself (phase 6,
          // 6.3, decision R78): the browser and the canvas, the editor and
          // tours, and previews. The terminal and agent tools are the server's own, as the
          // terminals are, and so are `artifacts.*`, `extension.*` and `plugin.*`.
          toolsets: [
            { name: 'browser', registrations: browserTools, enabled: browserToolsOffered },
            { name: 'canvas', registrations: canvasTools },
            { name: 'editor', registrations: editorTools },
            { name: 'tour', registrations: tourTools },
            { name: 'visual', registrations: visualTools },
          ],
          focus: desktopFocus,
          log: logDesktopTools,
        })
      : null
  // Out of process the shell's client starts now and connects once the
  // server is up; it comes back on its own after a restart and offers again.
  if (server) void desktopShell?.start()
  // The terminal agents' pull request marks, from the core's record, over a
  // connection of the shell's own: where each agent works goes to the record,
  // and the lists it answers ride the terminal snapshot. In process only: out
  // of process the terminals are the server's, which reads them itself.
  terminalPullRequests =
    studioRpc && coreTerminals
      ? createTerminalPullRequests({
          transport: studioRpc.shellTransport(),
          version: app.getVersion(),
          sessions: {
            list: () => listLiveTerminalSessions(),
            get: (sessionId) => getTerminalSessionById(sessionId),
          },
          onListsChanged: (affects) => notePullRequestRecordChanged(affects),
          log: logDesktopTools,
        })
      : null
  if (server) {
    // The launch tokens the shell issues (its WSL helper's channels, R87), by
    // digest: each change as it happens, and all of them again to a server
    // that has just started.
    onGatewayLaunchTokenChange((change) => server.rpc.emit(SERVER_EVENTS.launchTokens, { changes: [change] }))
    // Asked by a server as it starts, before its gateway listens.
    server.rpc.handle(SHELL_METHODS.liveLaunchTokens, () => liveGatewayLaunchTokens())
    // A client's `update.start` runs the app updater, which is the shell's;
    // `update.status` follows its state, sent whole on every change.
    server.rpc.handle(SHELL_METHODS.updateStart, (payload) => {
      const { commandId, targetVersion } = (payload ?? {}) as { commandId?: unknown; targetVersion?: unknown }
      if (typeof commandId !== 'string' || !commandId)
        return { ok: false, message: 'The update was asked for without a command id.' }
      return desktopUpdates.start({ commandId, ...(typeof targetVersion === 'string' ? { targetVersion } : {}) })
    })
    const sendUpdateState = () => server.rpc.emit(SERVER_EVENTS.updateState, desktopUpdates.status())
    updateService.onStateChange(sendUpdateState)
    server.onServing(() => {
      sendUpdateState()
      server.rpc.emit(SERVER_EVENTS.launchTokens, { reset: true, changes: liveGatewayLaunchTokens() })
      // A server back from a restart: the shell's client connects now rather
      // than at the end of its backoff, and the SDK offers every toolset again.
      desktopShell?.client()?.wake()
    })
  }
  // Started and stopped with the RPC: the shell's client goes first, so the
  // RPC's goodbye is never one it would answer by reconnecting.
  const studioRpcService: StudioRpcService | null = studioRpc
    ? {
        ...studioRpc,
        start: () => {
          void desktopShell?.start()
          void terminalPullRequests?.start()
          return studioRpc.start()
        },
        stop: () => {
          desktopShell?.stop()
          terminalPullRequests?.stop()
          return studioRpc.stop()
        },
      }
    : null
  // The conversation peek (hover a chat row or an agent tab): the prompts this
  // app captured for the session the card is anchored to. Built here rather
  // than inside the runtime so its assembly rules stay Electron-free and
  // testable.
  const conversationPeek = createConversationPeekService({
    readSessionState: (sessionId) => shellTerminals.peekState(sessionId),
    readConversationEvents: async (sessionId) => {
      if (server) {
        return server.rpc
          .call<Awaited<ReturnType<typeof conversations.readPeekTranscript>> | null>(
            SERVER_METHODS.conversationPeekEvents,
            { sessionId },
          )
          .catch(() => null)
      }
      const listed = conversations.listSessions()
      const summary = listed.ok ? listed.sessions.find((session) => session.sessionId === sessionId) : undefined
      if (!summary) return null
      const workspaceRoot = workspaceRegistry.getRecord(summary.workspaceId)?.folderPath
      if (!workspaceRoot) return []
      // The first message and the newest turn, never the whole transcript:
      // a long chat is tens of megabytes, and a hover must not parse it.
      return conversations
        .readPeekTranscript({ workspaceRoot, workspaceId: summary.workspaceId, agentId: summary.agentId })
        .catch(() => [])
    },
  })

  // The app's own plugin goes into every workspace it opens, at the two moments
  // a workspace becomes real to main: the roots the registry already holds when
  // this process starts, and every accepted registry event after that. Not at
  // agent spawn like the hook and the MCP config — an agent that reaches its
  // first prompt without the skills has already lost the session they were for
  // (backlog/2026-09-06-sprintengine-studio-ships-as-a-plugin.md).
  workspaceSyncService.subscribeEvents(() => {
    void studioPluginService.ensureInstalledForRoots(
      uniqueResolvedRoots(listKnownWorkspaceRoots(workspaceSyncService.getSnapshot())),
    )
  })
  // The pass over the roots the registry already holds runs once the app's own
  // plugin copy has settled, so it installs the arrangement launches will
  // actually use. Each install also waits for that copy on its own, which is
  // what keeps an install triggered by an early registry event from writing the
  // old arrangement. Both start while the loading screen is up (see
  // `prepareWorkspacesAtBoot`); whatever the plate's budget does not cover
  // simply carries on after the reveal.
  const bootWorkspacePass = agentIntegrationReady.then(() =>
    studioPluginService.ensureInstalledForRoots(
      uniqueResolvedRoots(listKnownWorkspaceRoots(workspaceSyncService.getSnapshot())),
    ),
  )
  void bootWorkspacePass.catch(() => undefined)
  // Out of process the registry arrives with the server's first snapshot, not
  // as events: the pass runs again once it has.
  if (server) {
    void server.mirror
      .whenLoaded()
      .then(() =>
        studioPluginService.ensureInstalledForRoots(
          uniqueResolvedRoots(listKnownWorkspaceRoots(workspaceSyncService.getSnapshot())),
        ),
      )
      .catch(() => undefined)
  }
  const prepareWorkspacesAtBoot = (): Promise<void> => {
    openWorkspaceSyncGate()
    return bootWorkspacePass
  }
  // A Studio skill switched on or off reaches the next agent launched: the
  // plugin home the launch passes is brought in line, then every known
  // workspace (the choice is machine-wide). A session already running keeps
  // the skills it started with.
  studioAreaSkillStore.onChange(() => {
    void (async () => {
      await agentIntegrationReady
      if (agentIntegrationPluginDirs.length > 0) await ensureAgentIntegrationHome(agentIntegrationHomeOptions())
      await studioPluginService.ensureInstalledForRoots(
        uniqueResolvedRoots(listKnownWorkspaceRoots(workspaceSyncService.getSnapshot())),
      )
    })().catch((error: unknown) => {
      void writeDiagnosticLog({
        level: 'warning',
        title: 'Studio skills not updated',
        message: 'The choice is saved and applies the next time a workspace is opened.',
        details: error instanceof Error ? error.message : String(error),
        source: 'workspace',
      })
    })
  })
  // Staying paired across sleep (phase 4): waking re-checks every paired
  // machine and re-dials waiting panes at once. `powerMonitor` needs the app
  // ready; services are built before that, so the hook waits for it.
  void app.whenReady().then(() => {
    // Out of process the server hears the wake as a power hint.
    if (!automationService) return
    const gateway = automationService
    const wake = () => gateway.mesh().onWake()
    powerMonitor.on('resume', wake)
    powerMonitor.on('unlock-screen', wake)
  })

  // Background mode: what the tray reports with no window open. Read
  // straight from the live main-process owners — the terminal runtime's session
  // list and the gateway's own status — because a presence that reported a
  // renderer projection would go stale the moment the last window it came from
  // closed.
  /**
   * What every agent launch waits for before it writes MCP config or builds a
   * command line: the Studio gateway listening (boot starts it alongside the
   * windows rather than ahead of them) and the plugin-home copy settled. A
   * launch before the reveal starts the deferred boot jobs itself.
   */
  function whenAgentLaunchReady(): Promise<void> {
    startDeferredBootJobs()
    // Out of process the gateway is listening once the server has said ready.
    const gatewayReady = automationService
      ? automationService.whenGatewayReady()
      : (server?.whenServing(AGENT_LAUNCH_SERVER_WAIT_MS) ?? Promise.resolve())
    return Promise.all([gatewayReady, agentIntegrationReady, launchFilesPruned, repositoryCleanup]).then(
      () => undefined,
    )
  }

  function readBackgroundStatus(): BackgroundStatus {
    const sessions = shellTerminals
      .list()
      .filter((session) => session.kind === 'agent' && session.processAlive && !session.suspended)
    return {
      agentSessions: sessions.length,
      gateway: { running: automationService ? automationService.getStatus().running : (server?.isServing() ?? false) },
    }
  }

  // What a quit would stop: terminal agents mid-turn here in the shell, chats
  // with a turn in progress wherever they run, and by name the schedules and
  // pull request watches this computer's servers run (its own core's and each
  // WSL server's). Out of process they are the server's, asked with a short
  // budget: a server that does not answer must not hold up the quit, so it
  // stops nothing it can name.
  async function whatQuitStops(): Promise<QuitStopping> {
    const terminals = countWorkingTerminalAgents(shellTerminals.list())
    if (!server) {
      const listed = conversations.listSessions()
      const chats = listed.ok ? listed.sessions.filter(conversationTurnInProgress).length : 0
      const wsl = (await core.wslServers?.manager.backgroundWork({ budgetMs: QUIT_COUNT_SERVER_BUDGET_MS })) ?? []
      return { agents: terminals + chats, ...quitStopsOf(backgroundWorkOf(core), wsl) }
    }
    if (!server.isServing()) return { agents: terminals, schedules: [], watches: [] }
    let budget: NodeJS.Timeout | undefined
    const asked = await Promise.race([
      server.rpc.call<unknown>(SERVER_METHODS.quitStops).catch(() => null),
      new Promise<null>((resolve) => {
        budget = setTimeout(() => resolve(null), QUIT_COUNT_SERVER_BUDGET_MS)
      }),
    ])
    clearTimeout(budget)
    const answer = (asked && typeof asked === 'object' ? asked : {}) as Partial<QuitStopping>
    const names = (value: unknown) =>
      Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : []
    return {
      agents: terminals + (typeof answer.agents === 'number' && answer.agents > 0 ? answer.agents : 0),
      schedules: names(answer.schedules),
      watches: names(answer.watches),
    }
  }
  const quitConfirmation = createQuitConfirmation({
    isEnabled: () => quitConfirmationStore.isEnabled(),
    stopAsking: () => quitConfirmationStore.set(false),
    whatQuitStops,
    ask: askToQuitWhileWorking,
  })

  // This profile, as the launcher's other users know it (integrations/live-instances.ts).
  const launcherProfile = createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 16)
  // Every quit takes back out what the app writes again whenever it next needs
  // it (SESSION_INTEGRATION_KINDS): nothing Studio put into a repository or a
  // CLI's configuration outlives it, and deleting the app — which nothing
  // announces on macOS or Linux — leaves none of it behind. This machine's
  // entries only: reaching into a distribution would boot it just as its
  // helper is being stopped (the Windows uninstaller takes those out).
  async function removeSessionIntegrations(): Promise<void> {
    const home = homedir()
    // Held first: should the quit be cut short, what it leaves in place keeps
    // the launcher it runs, whichever profile quits next.
    await holdLauncher(home, launcherProfile).catch(() => undefined)
    const { othersRunning } = await leaveLiveInstances(home)
    // Another Studio (a development build beside the packaged app) runs the
    // same entries; they stay listed here, for a quit with nobody else running.
    if (othersRunning) return
    const removal = removeIntegrations(
      { ledger: integrationLedgerStore, scan: false },
      {
        kinds: SESSION_INTEGRATION_KINDS,
        hostId: 'local',
        keepCommitted: true,
        keepLauncher: await launcherHeldByOthers(home, launcherProfile),
        // Stops early enough to record what it did before the leg is cut off,
        // and as soon as another Studio starts.
        deadline: Date.now() + QUIT_INTEGRATION_REMOVAL_BUDGET_MS - 500,
        stop: () => otherInstanceRunning(home),
      },
    ).then(
      async (report) => {
        if (!entriesRunLauncher(await integrationLedgerStore.list(), 'local')) {
          await releaseLauncher(home, launcherProfile)
        }
        if (report.failed === 0) return
        void writeDiagnosticLog({
          level: 'warning',
          title: 'Integrations not removed at quit',
          message: `${report.failed} of Studio's entries could not be removed; the next quit tries them again.`,
          details: report.outcomes
            .filter((outcome) => outcome.status === 'failed')
            .map((outcome) => `${outcome.label}\t${outcome.path}\t${outcome.reason ?? ''}`)
            .join('\n'),
          source: 'workspace',
        })
      },
      (error: unknown) => {
        void writeDiagnosticLog({
          level: 'warning',
          title: 'Integrations not removed at quit',
          message: error instanceof Error ? error.message : String(error),
          source: 'workspace',
        })
      },
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      removal,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, QUIT_INTEGRATION_REMOVAL_BUDGET_MS)
      }),
    ])
    if (timer) clearTimeout(timer)
  }

  return {
    /** SSH machines (phase 8), when their preview is on this session. */
    ssh,
    /** Every Studio this desktop knows, by environment id, with its routes. */
    environments,
    shellBridge,
    /** The shell's client of its server: stopped first at quit, so the server's goodbye is not answered. */
    desktopShell,
    removeSessionIntegrations,
    startDeferredBootJobs,
    prepareWorkspacesAtBoot,
    agentConfigImportService,
    agentStateService,
    browserManager,
    browserRecorder,
    canvasService,
    canvasSubscribers,
    /** The core's worktree pool and installs, in process; out of process the server's, which quits them itself. */
    worktreePool: worktrees?.pool,
    dependencyInstaller: worktrees?.installer,
    automationService,
    studioRpcService,
    moduleHub,
    /** Ask the pane pop-out relay which window may take over a running terminal. */
    setTerminalAttachGuard: (guard: (windowKey: string, sessionId: string) => boolean) => {
      terminalAttachGuard.current = guard
    },
    backgroundModeStore,
    quitConfirmationStore,
    quitConfirmation,
    agentNotificationsStore,
    agentNotifier,
    agentBrowserToolsStore,
    setChatLinkOpener(open: (link: ChatLink) => void): void {
      chatLinkOpener = open
    },
    keepAwakeStore,
    agentKeepAwake,
    telemetryConsentStore,
    analytics,
    readBackgroundStatus,
    /** The scheduled-agents module's service, or null while it is off (or before modules load). */
    scheduledAgents: (): ScheduledAgentsService | null => resolveScheduledAgents(),
    setScheduledAgentsResolver(resolver: () => ScheduledAgentsService | null): void {
      resolveScheduledAgents = resolver
    },
    setModuleEnabledResolver(resolver: (moduleId: string) => boolean): void {
      resolveModuleEnabled = resolver
    },
    setModuleMcpToolsResolver(resolver: () => ReadonlyArray<McpToolContribution>): void {
      resolveModuleMcpTools = resolver
    },
    moduleRegistryMirror,
    /** The core's, in process (for the module host's tokens); null out of process. */
    agentControlPlane: coreTerminals?.controlPlane ?? null,
    agentLaunchService,
    conversationTerminalHandoff,
    /** What the shell reads of the terminals and asks of them, in either mode (shell-terminals.ts). */
    shellTerminals,
    conversationLaunchService,
    conversationModelCatalog,
    tourService,
    setTourAttention: tours.setAttention,
    builtinSkillManager,
    studioPluginService,
    studioPluginStatus,
    studioAreaSkillStore,
    studioCore: core,
    // Read when a module asks, not here: out of process the core is the
    // server's, and reading its member at composition throws (remote-core.ts).
    createConversationHost: (...args: Parameters<typeof core.createConversationHost>) =>
      core.createConversationHost(...args),
    conversationOwner,
    conversations,
    githubTokenStore,
    logMainPerfEvent,
    mcpConfigService,
    sprintengineAuth,
    skillsService,
    agentLaunchSettings,
    hosts,
    conversationPeek,
    /** The core's runtime in process, for the module host; null out of process, where it is the server's. */
    terminalRuntime: coreTerminals?.runtime ?? null,
    /**
     * The terminals' part of the quit, and the phases the dock and banners
     * hear: in process the core's; out of process the server ends its own and
     * its phases arrive on the attention relay.
     */
    terminalLifecycle: {
      registerAgentPhaseListener: coreTerminals
        ? (listener: AgentPhaseListener) => coreTerminals.runtime.registerAgentPhaseListener(listener)
        : undefined,
      shutdown: async () => {
        await coreTerminals?.stopAgentState()
        await coreTerminals?.shutdown()
      },
    },
    agentChangelistFeed,
    editorRevealBroker,
    // At quit: the shell's client closes, and in process the core's record
    // settles its writes (out of process the server does, in its own legs).
    // A hover on a terminal agent's line: ask the server again.
    refreshPullRequestsForSession: async (sessionId: string): Promise<boolean> =>
      server
        ? server.rpc
            .call<boolean>(SERVER_METHODS.terminalPullRequestsRefresh, { sessionId })
            .then((asked) => asked === true)
            .catch(() => false)
        : (terminalPullRequests?.refreshForSession(sessionId) ?? false),
    pullRequestRecord: {
      flush: async () => {
        terminalPullRequests?.stop()
        if (!server) await core.pullRequests.flush()
      },
      dispose: () => {
        if (!server) core.pullRequests.dispose()
      },
    },
    // In process, the core's local servers settle at quit and the runs the
    // Studio started stop; out of process the server does that itself.
    localServers: server
      ? null
      : { flush: () => core.localServers.flush(), dispose: () => core.localServers.dispose() },
    // In process, the core's resumes after a usage limit and the messages a
    // person scheduled stop before the chats; out of process the server stops
    // them in its own legs.
    // Auto compact's timers stop with them: it is Studio's own send too.
    usageLimitResumes: server
      ? null
      : {
          dispose: () => {
            core.stopAutoCompact()
            // So does the rest sweep, which writes the chats' records.
            core.stopSettlementSweep()
            return core.stopUsageLimitResumes()
          },
        },
    scheduledMessages: server ? null : { dispose: () => core.stopScheduledMessages() },
    // In process the core's notices are kept at quit; out of process the server keeps its own.
    launchNotices: coreTerminals ? { freeze: () => coreTerminals.launchNotices.freeze() } : null,
    broadcastGitChangelistsChanged,
    updateService,
    withIpcDiagnostics,
    workspaceBackupService,
    workspaceSyncService,
    workspaceRegistry,
  }
}

export type AppServices = ReturnType<typeof createAppServices>
