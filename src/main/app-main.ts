import { app, ipcMain, protocol, shell } from 'electron'
import { shellTrash } from './cards/shell-trash'
import { createElectronThumbnailer } from './artifacts/artifact-thumbnail-electron'
import { askToSetUpArtifacts } from './artifacts/artifacts-setup-consent-electron'
import { buildStamp as mainBuildStamp } from 'virtual:sprintengine-build-stamp'
import { withoutDeepLinks } from '../shared/deep-link-scheme'
import { parseAuthCallbackFromArgv } from './auth-service'
import { registerAppLifecycle } from './app-lifecycle'
import { createAppServices } from './app-services'
import { ensureExtensionFolders } from './extension-folders'
import { ignoreMacosTypeOfServiceEinval, raiseConnectAttemptTimeout } from './network-defaults'
import { registerAppRestartIpc } from './ipc/app-restart-ipc'
import { handleExtensionFrameScheme, stagedExtensionFrames } from './extension-frames/extension-frame-shell'
import { attachBuildSkewWatch, createBuildSkewWatch } from './build-skew'
import { registerCoreIpc } from './register-core-ipc'
import { markStartup } from './startup-timeline'
import { readStudioEnv } from '../shared/studio-env'
import { allowsMultipleInstances } from './app-instance'
import { writeDiagnosticLog } from './diagnostics-service'
import { removeRetiredEntitlementCache } from './retired-entitlement-cache'
import { removeRetiredRelayState } from './retired-relay-state'
import { studioPlatform } from '../server/platform/platform'
import { SERVER_EVENTS, SERVER_METHODS } from '../server/desktop/server-methods'
import type { AgentPhaseEvent } from '../shared/agent-runtime'
import { readSshPreview, registerSshPreviewIpc, setSessionSshPreview } from './environments/ssh/ssh-preview'
import { registerStudioServerIpc } from './ipc/studio-server-ipc'
import { STUDIO_SERVER_CHANNELS } from '../shared/studio-server-status'
import { createDesktopServerHost } from './server-supervisor/desktop-server-host'
import { channelForVersion } from './update-channel-store'

/** How long the boot's workspace pass waits for the Studio server. */
const BOOT_SERVER_WAIT_MS = 15_000

// The app proper, loaded by the entry (index.ts) only in the process that holds
// the single-instance lock. By the time this runs the startup timeline is
// attached, the userData override is applied, the Electron platform is
// installed and the extension frame scheme is registered.

// Build-identity check. Registered next to the startup marks and for
// the same reason: a window reports the moment it starts, and the listener has
// to already be there. Log-only by explicit choice (2026-09-01): the dialog
// this used to raise interrupted the normal edit-the-running-app dev loop, so
// a skew now lands on the log (`[build-skew]`, greppable) and nowhere else.
attachBuildSkewWatch(ipcMain, createBuildSkewWatch({ mainStamp: mainBuildStamp }))

// Make the drop-in extension roots discoverable on a fresh (packaged) install:
// create ~/.sprintengine/{modules,plugins} and seed each with a README describing
// what to drop there. Best-effort — never block startup on it.
const extensionFolders = ensureExtensionFolders()

// Before anything here fetches: a slow IPv4 host behind an IPv6 address with
// no route answers within a second, not Node's quarter-second, and a macOS
// socket reset mid-request is not an uncaught exception.
raiseConnectAttemptTimeout()
ignoreMacosTypeOfServiceEinval()

const DIAGNOSTICS_ENABLED = readStudioEnv('SPRINTENGINE_DIAGNOSTICS') === '1'

// SSH machines, a preview until phase 8 is complete: off by default, and
// with it off no SSH code runs. Fixed for the session.
const sshPreview = readSshPreview(app.getPath('userData'))
setSessionSshPreview(sshPreview.enabled)
// The Studio server, in a process of its own: it holds the core, the chats,
// the stores and the extensions, one writer for each. This process is the
// shell around the windows; it forks the server at ready and supervises it.
// A server that cannot start is a failure every window shows, with its
// reason, Retry and Open log: there is no other place for the chats to run.
const serverHost = createDesktopServerHost({
  buildStamp: mainBuildStamp.commit,
  diagnosticsEnabled: DIAGNOSTICS_ENABLED,
  version: app.getVersion(),
  channel: channelForVersion(app.getVersion()) === 'nightly' ? 'nightly' : 'latest',
})
const services = createAppServices(DIAGNOSTICS_ENABLED, serverHost.link)

registerCoreIpc(ipcMain, services, DIAGNOSTICS_ENABLED, {
  server: { windowTickets: serverHost.windowTickets },
})

void app.whenReady().then(() => {
  // The hosted relay's leftover pairings and push tokens (retired-relay-state.ts).
  // Best effort and off the startup path; tailnet pairings are never touched.
  void removeRetiredRelayState(app.getPath('userData')).then((result) => {
    if (result.outcome === 'absent') return
    void writeDiagnosticLog(
      result.outcome === 'removed'
        ? {
            level: 'info',
            source: 'auth',
            title: 'Removed the hosted relay pairings',
            message: `The phone now pairs over Tailscale only. Deleted the relay's stored state: ${result.relayPairings} relay pairing(s) and ${result.pushRegistrations} push registration(s). Tailnet pairings were not touched.`,
          }
        : {
            level: 'warning',
            source: 'auth',
            title: 'Could not remove the hosted relay pairings',
            message: `The retired relay's state file is still in userData: ${result.message}`,
          },
    ).catch(() => {})
  })
  // The cached entitlement snapshot from when there was a paywall
  // (retired-entitlement-cache.ts). Best effort; the sign-in is never touched.
  void removeRetiredEntitlementCache(app.getPath('userData')).then((result) => {
    if (result.outcome === 'failed') {
      console.warn('[auth] retired-entitlement-cache-remove-failed', { message: result.message })
    }
  })
  // Extension frames: the documents this app's windows stage (extension-frames/).
  handleExtensionFrameScheme(protocol, stagedExtensionFrames)
})
if (DIAGNOSTICS_ENABLED) {
  console.info('[modules] extension root:', extensionFolders.moduleRoot)
  if (extensionFolders.errors.length > 0) {
    console.warn('[modules] extension folder setup errors:', extensionFolders.errors)
  }
}

// Everything above ran synchronously during entry evaluation: the services
// and IPC registration. This mark closes that phase, so a slow registration
// shows up as its own segment rather than hiding inside "app ready".
markStartup('main.module-evaluated')

// The server's phase in words for every window, and the actions on it.
const relaunchApp = (): void => {
  app.relaunch({ args: withoutDeepLinks(process.argv.slice(1)) })
  // A restart the person asked for: the app comes straight back, so it is
  // not a quit to ask about.
  services.quitConfirmation.quitWithoutAsking()
  app.quit()
}
// Settings → Extensions' "Restart now": a restart the person asked for, so it
// is asked about the way their own quit is when agents are working.
registerAppRestartIpc(ipcMain, {
  confirm: () => services.quitConfirmation.confirm(),
  relaunch: () => relaunchApp(),
})
registerSshPreviewIpc(ipcMain, sshPreview, app.getPath('userData'))
registerStudioServerIpc(ipcMain, {
  supervisor: serverHost.supervisor,
  openLog: async () => (await shell.openPath(serverHost.log.currentPath() ?? app.getPath('logs'))) === '',
  publish: (status) => studioPlatform().clients.publish(STUDIO_SERVER_CHANNELS.changed, status),
})

// What the server asks of the shell: the keychain, notices, terminal
// launches, the integrations gate, a removed skill's Trash, Studio's own
// plugin in a workspace, which the shell installs, for artifacts a page's
// picture and the set-up question with no window showing, the windows
// `extension.open` shows an extension in, the built-in browser's tabs, and
// the machine's boards for other devices (`canvas.*`).
serverHost.serveShell(services.shellBridge, {
  trash: (path) => shellTrash(path),
  studioPluginStatus: (workspaceRoot) => services.studioPluginStatus(workspaceRoot),
  artifacts: { thumbnailer: createElectronThumbnailer(), askNatively: askToSetUpArtifacts },
  extensionOpener: services.extensionOpener,
  browserTabs: services.browserTabs,
  canvas: services.canvasHost,
})

registerAppLifecycle({
  diagnosticsEnabled: DIAGNOSTICS_ENABLED,
  allowMultipleInstances: allowsMultipleInstances(app),
  agentStateService: services.agentStateService,
  removeSessionIntegrations: services.removeSessionIntegrations,
  canvasService: services.canvasService,
  browserRecorder: services.browserRecorder,
  desktopShell: services.desktopShell,
  onAgentAttentionReady: (attention) => services.setTourAttention((key) => attention.notify(key)),
  agentNotifier: services.agentNotifier,
  onChatLinksReady: (open) => services.setChatLinkOpener(open),
  analytics: services.analytics,
  updateService: services.updateService,
  // The skill sources are the server's: their hourly check runs there.
  checkPluginSourceUpdates: async () => {
    if (serverHost.link.isServing()) await serverHost.link.rpc.call(SERVER_METHODS.skillSourcesCheck)
  },
  // The hosted feeds are the Studio's: the server fetches them.
  refreshHostedFeeds: async () => {
    if (serverHost.link.isServing()) await serverHost.link.rpc.call(SERVER_METHODS.hostedFeedsRefresh)
  },
  startDeferredBootJobs: services.startDeferredBootJobs,
  // The workspaces to prepare arrive with the server's first snapshot; the
  // pass waits for it, inside the same boot budget.
  prepareWorkspacesAtBoot: () =>
    serverHost.link
      .whenServing(BOOT_SERVER_WAIT_MS)
      .then(() => serverHost.mirror.whenLoaded())
      .then(() => services.prepareWorkspacesAtBoot()),
  server: {
    start: () => serverHost.start(),
    shutdown: (options) => serverHost.shutdown(options),
    log: serverHost.log,
    onAttentionPhase: (listener) =>
      void serverHost.link.rpc.on(SERVER_EVENTS.attentionPhase, (event) => listener(event as AgentPhaseEvent)),
    // The CLIs and their version check are the server's: the boot's
    // detection waits for it to serve, inside the same budget.
    detectClis: (which) =>
      serverHost.link
        .whenServing(BOOT_SERVER_WAIT_MS)
        .then((serving) => (serving ? serverHost.link.rpc.call(SERVER_METHODS.cliDetect, { which }) : 0)),
    refreshCliVersions: async () => {
      if (serverHost.link.isServing()) await serverHost.link.rpc.call(SERVER_METHODS.cliVersionsRefresh)
    },
  },
  backgroundMode: {
    isEnabled: () => services.backgroundModeStore.isEnabled(),
    readStatus: () => services.readBackgroundStatus(),
  },
  quitConfirmation: services.quitConfirmation,
  agentKeepAwake: services.agentKeepAwake,
  handleAuthCallback: (argv) => {
    void parseAuthCallbackFromArgv(services.sprintengineAuth, argv)
  },
  chatWindows: {
    holderOf: (chatId) =>
      services.workspaceSyncService
        .getSnapshot()
        .state.workspaceWindows.find((windowState) => windowState.workspaceIds.includes(chatId))?.id ?? null,
    primaryWindowId: () => services.workspaceSyncService.getSnapshot().state.primaryWorkspaceWindowId,
  },
})
