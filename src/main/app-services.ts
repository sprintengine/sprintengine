import { app, BrowserWindow, ipcMain, powerSaveBlocker, safeStorage } from 'electron'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { existsSync } from 'fs'
import { buildAgentStateReporterCommand, buildLauncherHookCommand } from './agent-state'
import { LAUNCH_FILES_DIR, prepareLaunchIntegration, pruneLaunchFiles } from './integrations/launch-integration'
import { launchExtensionContributions } from '../server/extensions/agent-contributions/projection'
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
import { createDesktopSsh, type DesktopSsh } from './environments/ssh/desktop-ssh'
import { createDesktopEnvironments } from './environments/desktop-environments'
import { registerEnvironmentsIpc } from './ipc/environments-ipc'
import type { EnvironmentTicketResult } from '../shared/environments'
import { isMachinePath } from '../shared/machine-paths'
import { workspaceProjectRootOf } from '../shared/worktree-paths'
import type { WorkspaceEnvironmentRef } from '../shared/workspace'
import { sessionSshPreview } from './environments/ssh/ssh-preview'
import { cliTakesLaunchPlugins } from './agent-launch-render'
import {
  appLaunchPluginsActive,
  launchCarriesAppPluginsFor,
  setLaunchPluginDirsResolver,
  setLaunchSkillPluginDirsResolver,
  setLaunchStatusLineScriptResolver,
} from './terminal-launch'
import { CANVAS_MODULE_DEFAULT_ENABLED } from '../shared/modules/manifest'
import { createShellBridge } from './shell-bridge'
import { electronImageCodec } from './conversation-image-codec-electron'
import { createShellReveal } from './shell-reveal'
import { revealMainWindow } from './window-factory'
import { createDesktopShellTools } from './desktop-shell-tools'
import { liveGatewayLaunchTokens, onGatewayLaunchTokenChange } from '../server/core/gateway-launch-tokens'
import { createModuleRegistryMirror } from './modules/registry-mirror'
import type { StudioPluginStatus } from '../../packages/studio-protocol/src/public'
import {
  ensureSkillInstalled,
  setDefaultSkillManager,
  setLaunchDeliversBundledSkillResolver,
  pruneRetiredBuiltinSkillCopies,
  BUILTIN_SKILLS_RESOURCE_DIR,
  findBuiltinSkill,
  resolveSkillById,
} from './builtin-skills'
import { SprintEngineAuthBridge } from './auth-service'
import { createMainDiagnostics } from './main-diagnostics'
import { listKnownWorkspaceRoots, uniqueResolvedRoots } from './workspace-roots'
import {
  getBundledAgentStateReporterPath,
  getBundledAgentStateReporterTemplatePath,
  getBundledResourceDir,
  getBundledStatusLineForwarderPath,
  getBundledStudioPluginRoot,
} from './bundled-resources'
import type { HostAgentIntegration } from './hosts/execution-host'
import { hostRegistry } from './hosts/host-registry'
import { createStudioAgentServices } from '../server/core/studio-agent-services'
import { createBackgroundModeStore } from './background-mode-store'
import { createQuitConfirmationStore } from './quit-confirmation-store'
import { createAgentNotificationsStore } from './agent-notifications-store'
import { readStudioEnvironmentId } from '../server/environment/environment-id'
import { createAgentBrowserToolsStore } from './agent-browser-tools-store'
import {
  createBrowserTabAutoCloseSetting,
  createBrowserTabSweep,
  listedBrowserTabs,
} from './browser/browser-tab-auto-close'
import type { StudioBrowserTabs } from '../server/processes/browser-tabs'
import { createAgentNotifier } from './agent-notifications'
import type { ChatLink } from '../shared/deep-link'
import { createKeepAwakeStore } from './keep-awake-store'
import { createAgentKeepAwake, terminalAgentWorking } from './agent-keep-awake'
import { countWorkingTerminalAgents, createQuitConfirmation, type QuitStopping } from './quit-confirmation'
import { askToQuitWhileWorking } from './quit-confirmation-electron'
import { workspaceLastActiveAt } from '../shared/workspace-lifecycle'
import { createAnalyticsService } from './telemetry/analytics-service'
import { createTelemetryConsentStore } from './telemetry/consent-store'
import { readInstallId } from './telemetry/install-id'
import type { BackgroundStatus } from '../shared/background-mode'
import { isTelemetryEventName, type TelemetryProperties } from '../shared/telemetry'
import { syncStudioMcpConfig } from './studio-mcp-sync'
import { excludeMcpConfigFromWorktree } from './git'
import { excludeFromWorktree } from './integrations/worktree-exclude'
import { createConversationPeekService } from './conversation-peek/service'
import { listTerminalRoots } from './terminal-runtime'
import type { TerminalLaunchPreparation } from '../server/terminals/terminal-launch-preparation'
import { remoteShellTerminals, type ShellTerminals } from './shell-terminals'
import type { AgentPhaseEvent } from '../shared/agent-runtime'
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
import { createExtensionOpenBroker } from './extension-open-broker'
import { createTourTools } from './automation/tour-tools'
import { createVisualTools } from './automation/visual-tools'
import { createElectronVisualPreview } from './visual/visual-preview-window'
import { shootExtensionSurface } from './extension-frames/extension-shot'
import { createExtensionShotTool } from './automation/extension-shot-tool'
import type { McpToolRegistration } from '../shared/modules/mcp-tools'
import type { StudioClient } from '../../packages/client-runtime/src/public'
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
import { studioBridgeScriptPath } from '../server/platform/studio-paths'
import { installWorkspaceStoreMigration } from './workspace-store-migration'
import { desktopStudioUpdates, UPDATE_COMMAND_FILENAME, updateCommandFile } from './studio-rpc/desktop-updates'
import { SERVER_EVENTS, SERVER_METHODS, SHELL_METHODS } from '../server/desktop/server-methods'
import { createRemoteCore, createRemoteGitHubTokenStore, type ShellServerLink } from './server-supervisor/remote-core'
import type { ConversationLaunchRequest, ConversationLaunchResult } from './conversation-launch-service'
import type { ConversationEvent } from '../shared/conversation-runtime'
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

/** How long a chat the shell asks the server to start may take: a worktree lease, then the launch. */
const CONVERSATION_LAUNCH_TIMEOUT_MS = 120_000

export function createAppServices(
  diagnosticsEnabled: boolean,
  /**
   * The Studio server, in a process of its own. The shell builds no
   * server-owned store: it reaches the core through the mirror and the
   * control channel (server-supervisor/remote-core.ts).
   */
  server: ShellServerLink,
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
  // service tokens. The shell serves it to the server over the control channel.
  // Its late-bound members (the launch, the gate) resolve at call time.
  // The chat-link router opens a chat a clicked banner names; it is built with
  // the app's lifecycle, after these services (setChatLinkOpener).
  let chatLinkOpener: ((link: ChatLink) => void) | null = null
  const shellBridge = createShellBridge({
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
  // the config import): the shell's own uses, for the launches it prepares.
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
  // The server takes the choices; this copy adopts each one.
  server.rpc.on(SERVER_EVENTS.mirrorAreaSkills, (choices) => studioAreaSkillStore.adopt(choices))

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
    excludeFromGit: (workspaceRoot, entries) => excludeFromWorktree(workspaceRoot, entries),
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
  // services only the shell keeps. The server asks for it over the shell
  // bridge, which answers from this object. Its members are read at launch time, long
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
          const root = getBundledResourceDir(BUILTIN_SKILLS_RESOURCE_DIR)
          return findBuiltinSkill(skillId) && root ? join(root, skillId) : null
        },
        skill: (skillId) => resolveSkillById(skillId),
        homeDir: () => homedir(),
        gitTracks: (path) => gitTracksPath(dirname(path), basename(path)),
        extensionContributions: () => launchExtensionContributions(app.getPath('userData')),
        skillCopyOwner: () => app.getPath('userData'),
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
  const core = createRemoteCore(server)
  const { agentLaunchSettings, hosts, workspaceRegistry, workspaceSyncService, conversationOwner, conversations } = core
  // The terminals and their agents are the server's (studio-agent-terminals.ts),
  // which the shell reads through `shellTerminals`.
  const shellTerminals: ShellTerminals = remoteShellTerminals(server.rpc)

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
    // The live word on each terminal agent, by its pty and hook state. A chat
    // runs in the server: it is held only by its own events (and the stale cap).
    liveWorking: () => {
      const terminals = shellTerminals.list().filter((session) => session.kind === 'agent')
      return (workspaceId, agentId) => {
        const terminal = terminals.find(
          (session) => session.agentId === agentId && (session.workspaceId ?? null) === workspaceId,
        )
        return terminal ? terminalAgentWorking(terminal) : undefined
      }
    },
  })

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

  // The renderer's module registry, as a window reports it to its Studio
  // (`extension.reportRegistry`) and the server passes it on: the canvas tools
  // below hold to the person's Canvas switch in it.
  const moduleRegistryMirror = createModuleRegistryMirror()
  server.rpc.on(SERVER_EVENTS.mirrorModuleRegistry, (snapshot) => void moduleRegistryMirror.write(snapshot))

  // What each agent wrote, for the editor reveal: a file outside the workspace
  // that the asking agent wrote itself may be shown without asking the person.
  // The server's terminals say each file their agents write.
  const agentWrittenFiles = createAgentWrittenFiles()
  server.rpc.on(SERVER_EVENTS.agentFileWritten, (raw) => {
    const { workspaceId, agentId, path } = (raw ?? {}) as Record<string, unknown>
    if (typeof agentId === 'string' && typeof path === 'string')
      agentWrittenFiles.note(typeof workspaceId === 'string' ? workspaceId : undefined, agentId, path)
  })

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
  // The token is the server's; the shell's skills, cards and marketplace ask it for one.
  const githubTokenStore = createRemoteGitHubTokenStore(server.rpc)
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
  // Built-in browser tabs, for the Processes list on every client
  // (`browserTabs.*`), and closed once unused for the setting's time
  // (browser-tab-auto-close.ts). Whether a chat's agent is still at work is
  // read off the registry's clocks, and off its live session where the chats
  // run in this process.
  const browserTabAutoClose = createBrowserTabAutoCloseSetting({
    resolveUserDataDir: () => app.getPath('userData'),
    log: (message) =>
      void writeDiagnosticLog({ level: 'warning', source: 'workspace', title: 'Browser tabs', message }),
  })
  // Which chats' agents are working right now: a terminal agent by its pty
  // and hook state, a chat by its session, asked of the server. Null when that could not be asked: then every chat
  // counts as working, and nothing is closed on a guess.
  const workingWorkspaceIds = async (): Promise<ReadonlySet<string> | null> => {
    const ids = new Set<string>()
    for (const session of shellTerminals.list()) {
      if (session.kind === 'agent' && session.workspaceId && terminalAgentWorking(session)) ids.add(session.workspaceId)
    }
    const working = await server.rpc.call<string[]>(SERVER_METHODS.conversationsWorking, {}).catch(() => null)
    if (!Array.isArray(working)) return null
    for (const id of working) ids.add(id)
    return ids
  }
  // When each chat's agent last worked: now while it works, its registry
  // clocks otherwise, null once the chat is settled or gone.
  const browserTabAgentClock = async (): Promise<(workspaceId: string) => number | null> => {
    const working = await workingWorkspaceIds()
    const at = Date.now()
    const records = new Map(workspaceSyncService.getSnapshot().state.workspaces.map((record) => [record.id, record]))
    return (workspaceId) => {
      if (!working || working.has(workspaceId)) return at
      const record = records.get(workspaceId)
      if (!record || record.settledAt) return null
      return workspaceLastActiveAt(record)
    }
  }
  const browserTabs: StudioBrowserTabs = {
    list: async () =>
      listedBrowserTabs(browserManager.listAllTabs(), browserTabAutoClose.hours(), await browserTabAgentClock()),
    close: (tabId) => browserManager.requestClose(tabId),
  }
  const browserTabSweep = createBrowserTabSweep({
    listTabs: () => browserManager.listAllTabs(),
    close: (tabId) => browserManager.requestClose(tabId),
    setting: browserTabAutoClose,
    agentClock: browserTabAgentClock,
    log: (message) => void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'Browser tabs', message }),
  })
  browserTabSweep.start()
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
  // `extension.open`'s window half: asks the workspace windows one at a time
  // to show an extension's panel or custom editor, never raising one. The
  // server reaches it over the control channel (extension-open-bridge.ts).
  const extensionOpenBroker = createExtensionOpenBroker({
    targets: () =>
      listWorkspaceWindows().map((window) => ({
        id: window,
        isDestroyed: () => window.isDestroyed() || window.webContents.isDestroyed(),
        isFocused: () => window.isFocused(),
        isVisible: () => window.isVisible() && !window.isMinimized(),
        send: (channel: string, payload: unknown) => window.webContents.send(channel, payload),
      })),
  })
  const extensionOpener = extensionOpenBroker.open

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
    // A tour's prompt is Studio's, typed to its author: the extensions' prompt
    // hooks check it first, where the author's terminal runs (this process, or
    // the Studio server's), as whoever started that agent.
    hookPrompt: (session, text) =>
      shellTerminals.hookPrompt(session.sessionId, text, { inputKind: 'tour', from: 'studio' }),
    launchAgent: async (request) => {
      const launched = await shellTerminals.launch(request)
      return launched.ok ? { ok: true, agentId: launched.agentId } : { ok: false, message: launched.message }
    },
    broadcastToWorkspaceWindows,
    broadcastToViewers: (channel, payload) => broadcastToAllWindows(channel, payload, { skipCanvasWorker: true }),
    isAppFocused: () => anyWindowFocused(),
  })
  const tourService = tours.service
  // The author's phases, from the server's attention relay, which carries every agent's.
  server.rpc.on(SERVER_EVENTS.attentionPhase, (event) => tourService.onAgentPhase(event as AgentPhaseEvent))

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
  // the server's gateway as client toolsets, the way any app offers its tools.
  // "Let agents use the built-in browser" (Settings → Agents): the browser
  // toolset is withdrawn and offered again as it changes, read when it is
  // needed, never kept.
  const agentBrowserToolsStore = createAgentBrowserToolsStore({
    resolveUserDataDir: () => app.getPath('userData'),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })
  const browserToolsOffered = () => agentBrowserToolsStore.isEnabled()
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
  // The editor and tour tools act on what a window shows: the shell offers
  // them as its `editor` and `tour` toolsets (phase 6, 6.3).
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
  // The shell's connection to its Studio, once `desktopShell` below exists.
  let shellClient: () => StudioClient | null = () => null
  const visualTools: McpToolRegistration[] = [
    ...createVisualTools(createElectronVisualPreview(listWorkspaceWindows)),
    // A picture of an extension's surface, for its author (extension-shot.ts):
    // drawn here, its calls answered by the Studio over the shell's own connection.
    createExtensionShotTool((input) =>
      shootExtensionSurface({ client: (): StudioClient | null => shellClient() }, input),
    ),
  ]
  const tourTools = createTourTools({
    service: tourService,
    hasWorkspace: (workspaceId) =>
      workspaceSyncService.getSnapshot().state.workspaces.some((workspace) => workspace.id === workspaceId),
  })
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
    // The mesh is the gateway's, which the server runs.
    mesh: server.mirror.meshConnections,
    meshReachability: {
      list: () => server.mirror.meshReachability.list(),
      onChanged: (listener) => server.mirror.meshReachability.onChanged(listener),
      check: (connectionId) => server.rpc.call(SERVER_METHODS.meshCheckReachability, { connectionId }),
    },
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
      // A WSL distribution's own window listener, asked over the owner
      // connection the server holds; the socket goes to the server's loopback
      // route to that distribution.
      if (route.kind === 'wsl')
        return server.rpc.call<EnvironmentTicketResult>(SERVER_METHODS.wslWindowTicket, {
          distro: route.distro,
          windowKey,
          origin,
        })
      if (route.kind !== 'tailnet')
        return { ok: false, code: 'unsupported_route', message: 'This window reaches that machine through this one.' }
      return server.rpc.call<EnvironmentTicketResult>(SERVER_METHODS.meshWindowTicket, {
        connectionId: route.connection,
        origin,
      })
    },
    revokeWindow: (windowKey) => {
      ssh?.environments.revokeWindow(windowKey)
      void server.rpc.call(SERVER_METHODS.wslRevokeWindow, { windowKey }).catch(() => undefined)
    },
  })
  // This desktop updates itself (`update.*`) through the app updater, which is
  // the shell's: the server begins one through the shell methods below.
  const desktopUpdates = desktopStudioUpdates(updateService, {
    commands: updateCommandFile(join(app.getPath('userData'), UPDATE_COMMAND_FILENAME)),
    log: (message) => void writeDiagnosticLog({ level: 'warning', source: 'update', title: 'Client update', message }),
  })
  // Which window may take over a running terminal's output: set once the pane
  // pop-out relay is registered (register-core-ipc.ts), asked by the server,
  // whose terminals they are.
  const terminalAttachGuard: { current: ((windowKey: string, sessionId: string) => boolean) | null } = {
    current: null,
  }
  server.rpc.handle(SHELL_METHODS.terminalMayAttach, (params) => {
    const { windowKey, sessionId } = (params ?? {}) as { windowKey?: unknown; sessionId?: unknown }
    if (typeof windowKey !== 'string' || typeof sessionId !== 'string') return true
    return terminalAttachGuard.current?.(windowKey, sessionId) ?? true
  })
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
  shellClient = () => desktopShell.client()
  // The shell, a client of its own server over a port it brokers to the
  // server. It offers what only a screen can serve (phase 6, 6.3, decision
  // R78): the browser and the canvas, the editor and tours, and previews. The
  // terminal and agent tools are the server's own, as the terminals are, and
  // so are `artifacts.*`, `extension.*` and `plugin.*`.
  const desktopShell = createDesktopShellTools({
    transport: server.shellTransport(),
    version: app.getVersion(),
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
  // The shell's client starts now and connects once the server is up; it
  // comes back on its own after a restart and offers again.
  void desktopShell.start()
  // The launch tokens the shell issues, by digest: each change as it
  // happens, and all of them again to a server that has just started.
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
    desktopShell.client()?.wake()
  })
  // The conversation peek (hover a chat row or an agent tab): the prompts this
  // app captured for the session the card is anchored to. Built here rather
  // than inside the runtime so its assembly rules stay Electron-free and
  // testable.
  const conversationPeek = createConversationPeekService({
    readSessionState: (sessionId) => shellTerminals.peekState(sessionId),
    // The chats are the server's: it reads the first message and the newest
    // turn, never the whole transcript.
    readConversationEvents: (sessionId) =>
      server.rpc
        .call<ConversationEvent[] | null>(SERVER_METHODS.conversationPeekEvents, { sessionId })
        .catch(() => null),
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
  // The registry arrives with the server's first snapshot, not as events: the
  // pass runs again once it has.
  void server.mirror
    .whenLoaded()
    .then(() =>
      studioPluginService.ensureInstalledForRoots(
        uniqueResolvedRoots(listKnownWorkspaceRoots(workspaceSyncService.getSnapshot())),
      ),
    )
    .catch(() => undefined)
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
    // The gateway is listening once the server has said ready.
    const gatewayReady = server.whenServing(AGENT_LAUNCH_SERVER_WAIT_MS)
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
      gateway: { running: server.isServing() },
    }
  }

  // What a quit would stop: terminal agents mid-turn, chats with a turn in
  // progress, and by name the schedules and pull request watches this
  // computer's servers run (its own and each WSL server's). They are the
  // server's, asked with a short budget: a server that does not answer must
  // not hold up the quit, so it stops nothing it can name.
  async function whatQuitStops(): Promise<QuitStopping> {
    const terminals = countWorkingTerminalAgents(shellTerminals.list())
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
    /**
     * Another device's boards (a paired desktop's Canvas pane, the phone's
     * list and pictures), served by the server over this canvas service and
     * the same tools that list and draw them, each held to where a board's
     * file really is.
     */
    canvasHost: canvasRemoteSubscribers.host(canvasService, canvasToolsOver),
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
    browserTabAutoClose,
    /** The built-in browser's tabs, which the server serves from the shell. */
    browserTabs,
    browserTabSweep,
    setChatLinkOpener(open: (link: ChatLink) => void): void {
      chatLinkOpener = open
    },
    keepAwakeStore,
    agentKeepAwake,
    telemetryConsentStore,
    analytics,
    readBackgroundStatus,
    moduleRegistryMirror,
    /** What the shell reads of the terminals and asks of them (shell-terminals.ts). */
    shellTerminals,
    tourService,
    setTourAttention: tours.setAttention,
    builtinSkillManager,
    studioPluginService,
    studioPluginStatus,
    studioAreaSkillStore,
    conversationOwner,
    conversations,
    githubTokenStore,
    logMainPerfEvent,
    mcpConfigService,
    sprintengineAuth,
    agentLaunchSettings,
    hosts,
    conversationPeek,
    editorRevealBroker,
    extensionOpenBroker,
    /** `extension.open`'s window half, for the shell to serve the server. */
    extensionOpener,
    /** A chat the person starts from a window here (a board's "Continue in new chat"), started by the server. */
    launchConversation: (request: ConversationLaunchRequest): Promise<ConversationLaunchResult> =>
      server.rpc
        .call<ConversationLaunchResult>(SERVER_METHODS.conversationLaunch, request, {
          timeoutMs: CONVERSATION_LAUNCH_TIMEOUT_MS,
        })
        .catch((error: unknown): ConversationLaunchResult => ({
          ok: false,
          code: 'server_unavailable',
          message: `Studio server did not start the chat: ${error instanceof Error ? error.message : String(error)}`,
        })),
    // A hover on a terminal agent's line: ask the server again.
    refreshPullRequestsForSession: async (sessionId: string): Promise<boolean> =>
      server.rpc
        .call<boolean>(SERVER_METHODS.terminalPullRequestsRefresh, { sessionId })
        .then((asked) => asked === true)
        .catch(() => false),
    updateService,
    withIpcDiagnostics,
    workspaceSyncService,
    workspaceRegistry,
  }
}

export type AppServices = ReturnType<typeof createAppServices>
