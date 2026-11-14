import { app, ipcMain, protocol, session, shell } from 'electron'
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
import { resolveModuleEnablement } from '../shared/modules/resolve'
import { loadMainModules } from './module-host/load-modules'
import { readModuleOverridesSync } from './module-host/enablement-store'
import { ScheduledAgentsServiceToken } from './module-host/service-tokens'
import { AGENT_RUNTIME_MANIFEST, createAgentRuntimeModule } from './modules/agent-runtime-module'
import type { CapabilityManifest } from '../shared/modules/manifest'
import { SCHEDULED_AGENTS_MANIFEST, scheduledAgentsSwitchModule } from './modules/scheduled-agents-switch'
import { isLoadEligible, type ModuleTrustContext } from './modules/module-signature'
import { readModuleTrustContextSync } from './modules/trust-context'
import {
  planThirdPartyMainModules,
  readThirdPartyMainLaunchSnapshot,
  thirdPartyLaunchSession,
  recordThirdPartyMainLaunchReport,
} from './modules/third-party-main-loader'
import { registerAppRestartIpc } from './ipc/app-restart-ipc'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { MODULE_ASSET_SCHEME } from '../shared/modules/assets'
import { createModuleAssetOriginResolver } from './modules/module-asset-origins'
import { createModuleAssetHandler, isAllowedModuleAssetRequest } from './modules/module-assets'
import { defaultUserModuleRoot, discoverUserModules, discoverUserModulesSync } from './modules/user-module-registry'
import { watchUserModuleRoot } from './modules/user-module-watch'
import { createModuleLifecycle, liveModuleIds } from './modules/module-lifecycle'
import { attachBuildSkewWatch, createBuildSkewWatch } from './build-skew'
import { registerCoreIpc } from './register-core-ipc'
import { markStartup } from './startup-timeline'
import { readStudioEnv } from '../shared/studio-env'
import { allowsMultipleInstances } from './app-instance'
import { writeDiagnosticLog } from './diagnostics-service'
import { removeRetiredEntitlementCache } from './retired-entitlement-cache'
import { removeRetiredRelayState } from './retired-relay-state'
import { applyHostApiGate } from './modules/host-api-gate'
import { studioPlatform } from '../server/platform/platform'
import { SERVER_EVENTS, SERVER_METHODS } from '../server/desktop/server-methods'
import type { AgentPhaseEvent } from '../shared/agent-runtime'
import {
  readServerMode,
  SERVER_FALLBACK_ARGUMENT,
  setSessionServerMode,
  takeServerFallbackNote,
  writeServerFallbackNote,
  writeServerMode,
} from './server-mode'
import { readSshPreview, registerSshPreviewIpc, setSessionSshPreview } from './environments/ssh/ssh-preview'
import { registerStudioServerIpc } from './ipc/studio-server-ipc'
import { STUDIO_SERVER_CHANNELS } from '../shared/studio-server-status'
import { createDesktopServerHost } from './server-supervisor/desktop-server-host'
import { channelForVersion } from './update-channel-store'

/** How long the boot's workspace pass waits for the Studio server out of process. */
const BOOT_SERVER_WAIT_MS = 15_000

// The app proper, loaded by the entry (index.ts) only in the process that holds
// the single-instance lock. By the time this runs the startup timeline is
// attached, the userData override is applied, the Electron platform is
// installed and the module-asset scheme is registered.

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

// Where the Studio server runs this session: in this process, the default, or
// in a utility process of its own (phase 6). Decided once, here, before any
// service is built, so every store has one writer for the whole session.
const serverMode = readServerMode(app.getPath('userData'))
setSessionServerMode(serverMode.mode)
// SSH machines, a preview until phase 8 is complete: off by default, and
// with it off no SSH code runs. Fixed for the session, like the server mode.
const sshPreview = readSshPreview(app.getPath('userData'))
setSessionSshPreview(sshPreview.enabled)
// A launch that follows one whose server could not start says why, once.
const serverFellBack =
  serverMode.source === 'fallback'
    ? (takeServerFallbackNote(app.getPath('userData')) ?? 'The Studio server could not start.')
    : null
const serverHost =
  serverMode.mode === 'out-of-process'
    ? createDesktopServerHost({
        buildStamp: mainBuildStamp.commit,
        diagnosticsEnabled: DIAGNOSTICS_ENABLED,
        version: app.getVersion(),
        channel: channelForVersion(app.getVersion()) === 'nightly' ? 'nightly' : 'latest',
      })
    : null
if (serverHost) {
  console.info(`[studio-server] out of process (${serverMode.source})`)
}
const services = createAppServices(DIAGNOSTICS_ENABLED, serverHost?.link ?? null)

const coreIpc = registerCoreIpc(ipcMain, services, DIAGNOSTICS_ENABLED, {
  ...(serverHost
    ? {
        server: {
          windowTickets: serverHost.windowTickets,
        },
      }
    : {}),
})

// Capability modules register their own IPC/services/sidecars through the host
// kernel, gated by the user's enablement overrides (mirrored from the renderer
// into userData). A disabled module skips registration entirely. The
// agent-runtime core module seeds the shared services (terminal runtime, auth,
// token stores) that the optional modules consume via the service bridge; the
// resolver orders it first because every dependent declares
// `dependsOn: ['agent-runtime']`. See docs/module-authors/drop-in-extensions.md.
const moduleOverrides = readModuleEnablementOverrides()

const thirdPartyMainLoad = planThirdPartyMainModules(
  discoverUserModulesSync(defaultUserModuleRoot(), readModuleTrustContext()),
)
// ── extension-platform additions ──
// A module built for another host API stays unloaded whatever its trust says,
// and the load report says why (modules/host-api-gate.ts).
applyHostApiGate(thirdPartyMainLoad.ineligible, thirdPartyMainLoad.modules)
// Live-resolved main enablement, kept in step with the renderer's overrides (see
// recomputeMainEnablement below). A module with no main runtime of its own — one
// whose work rides another module's engine tick — is honored through this set
// rather than through load/unload, so its toggle (and its dependency cascade)
// takes effect without a reload. Declared before module construction so the
// predicate can close over it; the set is filled in once the manifest list exists.
const enabledMainModuleIds = new Set<string>()
// The schedules are the core's; the kernel holds them under the person's
// Scheduled agents switch. Out of process the server's kernel does
// (server-modules.ts), and this process knows only the manifest.
const scheduledAgentsModule = serverHost
  ? null
  : scheduledAgentsSwitchModule(
      services.studioCore.scheduledAgents,
      // Read only once a module asks, by which time `getModulePermissions` exists.
      (moduleId): readonly string[] | undefined => getModulePermissions(moduleId),
    )
const activeMainModules = scheduledAgentsModule ? [scheduledAgentsModule] : []
// Resolves any module id to the permissions it declared in its manifest, across
// every module the app assembled. The companion registry gates attach on it.
const moduleManifestsById = new Map<string, CapabilityManifest>(
  [
    AGENT_RUNTIME_MANIFEST,
    SCHEDULED_AGENTS_MANIFEST,
    ...thirdPartyMainLoad.modules.map((module) => module.manifest),
  ].map((manifest) => [manifest.id, manifest]),
)
const getModulePermissions = (moduleId: string): readonly string[] | undefined =>
  moduleManifestsById.get(moduleId)?.permissions
// Extracted as a const (rather than inlined) so `mainModuleManifests` below can
// reference its manifest for the enablement gate; constructed after
// `getModulePermissions` so the companion-attach permission check is wired in.
const agentRuntimeModule = createAgentRuntimeModule(services, {
  getModulePermissions,
  platform: studioPlatform(),
  // A module's prompt that names no runtime answers on the person's choice.
  getTextGenerationSettings: () => services.studioCore.textGenerationSettings.get(),
})
// Out of process every module's server half loads in the server
// (src/server/desktop/server-modules.ts); the shell loads none and keeps an
// empty kernel for the renderer-entry channel, which is the shell's.
const moduleLoad = loadMainModules({
  modules: serverHost ? [] : [agentRuntimeModule, ...activeMainModules, ...thirdPartyMainLoad.modules],
  overrides: moduleOverrides,
  // Skill directories a third-party module registers are resolved against —
  // and must stay inside — its install folder.
  moduleRoots: thirdPartyMainLoad.moduleRoots,
  // What `getAssetPath` resolves: the files each module was verified with.
  moduleVerifiedFiles: thirdPartyMainLoad.verifiedFiles,
  ineligible: thirdPartyMainLoad.ineligible,
  launchErrors: thirdPartyMainLoad.launchErrors,
  // Module events reach every client following the Studio's `module.events`
  // stream; each window routes them to its own module's subscribers. Nothing
  // is buffered for a client that connects later (shared/modules/events.ts).
  deliverModuleEvent: (event) => services.moduleHub.deliverEvent(event),
  // A module's notify is a bell row on `module.notifications`; the kernel
  // keeps the recent ones, which the stream sends a client first.
  deliverModuleNotification: (notification) => services.moduleHub.deliverNotification(notification),
  // A module tool that would shadow one of the gateway's own is refused at
  // registration, naming the tool it collides with.
  coreMcpToolNames: () => services.automationService?.coreToolNames() ?? [],
})
services.moduleHub.readRecentFrom(() => moduleLoad.kernel.recentNotifications())
// A module's declared methods, called over the Studio RPC's `module.read` and `module.operate`.
services.moduleHub.serveCallsFrom((request) => moduleLoad.kernel.callModuleMethod(request))
// The host's services a module's window half calls: `moduleBacklog.*` and `moduleUsage.query`.
services.moduleHub.serveHostServicesFrom((moduleId) => moduleLoad.kernel.hostServicesFor(moduleId))
// The manifest universe the enablement gate resolves against — every main module
// present on this channel, so a module and its dependencies (scheduled agents,
// agent-runtime) all resolve. Recompute mirrors the renderer's
// resolution so the gate's answer matches what the user sees in Settings.
const mainModuleManifests = [
  agentRuntimeModule.manifest,
  SCHEDULED_AGENTS_MANIFEST,
  ...thirdPartyMainLoad.modules.map((module) => module.manifest),
]
const recomputeMainEnablement = (overrides: Record<string, boolean>): void => {
  const { order } = resolveModuleEnablement(mainModuleManifests, overrides)
  enabledMainModuleIds.clear()
  for (const id of order) enabledMainModuleIds.add(id)
}
recomputeMainEnablement(moduleOverrides)
// An extension's schedules are held to its permissions, and wait while it is not here.
if (!serverHost)
  services.studioCore.attachModules({
    permissions: getModulePermissions,
    loaded: () => [...enabledMainModuleIds],
  })
// What runs here, listed and changed over the Studio RPC (`module.*`). Out of
// process the server's kernel holds the modules and serves it
// (server-modules.ts); this process's kernel is empty.
if (!serverHost)
  services.moduleHub.serveLifecycleFrom(
    createModuleLifecycle({
      dataDir: app.getPath('userData'),
      moduleRoot: defaultUserModuleRoot,
      changed: () => services.moduleHub.deliverChanged(),
      // What this session's kernel loaded, read only when an extension list is
      // asked for, long after `moduleLoad` exists.
      launchSession: () =>
        thirdPartyLaunchSession(readThirdPartyMainLaunchSnapshot(), moduleLoad.kernel.mcpToolRegistrations()),
      registry: services.moduleRegistryMirror,
      applyEnablement: async (overrides) => {
        const report = await moduleLoad.applyEnablement(overrides, {
          liveModuleIds: liveModuleIds(Object.keys(thirdPartyMainLoad.moduleRoots), moduleLoad.report.errors),
        })
        // A module with no live-loadable main half takes its toggle through the
        // enablement gate rather than module load/unload — refresh the resolved set.
        // The rest of the change was applied even when one module's half failed,
        // so the gate follows it either way.
        recomputeMainEnablement(overrides)
        // Module-contributed gateway tools follow enablement live: the
        // gateway re-reads the registry and enablement per request, so only the
        // connected MCP clients need a nudge to refresh their tool lists.
        services.automationService?.notifyToolsListChanged()
        const scheduledAgentsError = report.errors.find((error) => error.id === 'scheduled-agents')
        if (scheduledAgentsError) return { ok: false, message: scheduledAgentsError.message }
        return { ok: true }
      },
      view: () => {
        const overrides = readModuleEnablementOverrides()
        return {
          manifests: () => mainModuleManifests,
          enabled: (id) =>
            overrides[id] ?? mainModuleManifests.find((manifest) => manifest.id === id)?.defaultEnabled ?? false,
          running: (id) => moduleLoad.isRunning(id),
          ineligible: (id) => thirdPartyMainLoad.ineligible[id],
          loadError: (id) => moduleLoad.report.errors.find((error) => error.id === id)?.message,
          declaredMethods: (id) => moduleLoad.kernel.declaredMethods(id),
        }
      },
    }),
  )
// A module copied into the drop-in folder while Studio runs is listed at once,
// not after a reload. Out of process the server watches (server-modules.ts).
if (!serverHost) {
  const stopWatchingModules = watchUserModuleRoot(defaultUserModuleRoot(), () => services.moduleHub.deliverChanged())
  app.once('will-quit', stopWatchingModules)
}
// Automation server ← Scheduled agents module: resolved per tool call so a live
// module disable/enable cycle is reflected immediately (service absent ⇒ the
// scheduled-agent tools say the module is off).
services.setScheduledAgentsResolver(
  () => moduleLoad.kernel.hostFor('@host').getService(ScheduledAgentsServiceToken) ?? null,
)
// Module enablement for gateway tools that belong to a capability module: the
// resolved set is recomputed on every override the renderer pushes, so a module
// switched off in Settings is off for MCP callers on their next call, not after
// a restart (an owner ruling).
services.setModuleEnabledResolver((moduleId) => enabledMainModuleIds.has(moduleId))
// Module-contributed MCP tools ← the host kernel. The gateway was
// constructed above, before loadMainModules ran; this seam hands it the live
// registry, and the per-request evaluation makes the tools visible immediately.
services.setModuleMcpToolsResolver(() => moduleLoad.kernel.mcpToolRegistrations())
recordThirdPartyMainLaunchReport(
  thirdPartyMainLoad.modules.map((module) => module.manifest.id),
  moduleLoad.report,
)
const moduleAssetOrigin = createModuleAssetOriginResolver(app.getPath('userData'))
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
  const shellUrl = process.env['ELECTRON_RENDERER_URL'] ?? pathToFileURL(join(__dirname, '../renderer/index.html')).href
  session.defaultSession.webRequest.onBeforeRequest({ urls: [`${MODULE_ASSET_SCHEME}://*/*`] }, (details, callback) => {
    callback({ cancel: !isAllowedModuleAssetRequest(details, shellUrl) })
  })
  protocol.handle(
    MODULE_ASSET_SCHEME,
    createModuleAssetHandler({
      assetOrigin: moduleAssetOrigin,
      discoverModules: () => discoverUserModules(defaultUserModuleRoot(), readModuleTrustContext()),
      isEnabled: (installed, modules) => {
        const trusted = modules.filter((module) => isLoadEligible(module.trust.status))
        const manifests = [
          ...mainModuleManifests.filter((manifest) => !modules.some((module) => module.manifest.id === manifest.id)),
          ...trusted.map((module) => module.manifest),
        ]
        return resolveModuleEnablement(manifests, readModuleEnablementOverrides()).order.includes(installed.manifest.id)
      },
    }),
  )
})
if (DIAGNOSTICS_ENABLED) {
  console.info('[modules] extension roots:', extensionFolders.moduleRoot, extensionFolders.pluginRoot)
  if (extensionFolders.errors.length > 0) {
    console.warn('[modules] extension folder setup errors:', extensionFolders.errors)
  }
  console.info(
    '[modules] loaded:',
    moduleLoad.report.loaded,
    'manifest-only:',
    moduleLoad.report.manifestOnly,
    'disabled:',
    moduleLoad.report.disabled,
    'sidecars:',
    moduleLoad.report.sidecars.map((s) => s.id),
  )
  if (moduleLoad.report.errors.length > 0) {
    console.warn('[modules] load errors:', moduleLoad.report.errors)
  }
  if (thirdPartyMainLoad.diagnostics.rejected.length > 0) {
    console.warn('[modules] rejected third-party modules:', thirdPartyMainLoad.diagnostics.rejected)
  }
}

function readModuleEnablementOverrides(): Record<string, boolean> {
  try {
    return readModuleOverridesSync(app.getPath('userData'))
  } catch {
    return {}
  }
}

function readModuleTrustContext(): ModuleTrustContext {
  return readModuleTrustContextSync(app.getPath('userData'))
}

// Everything above ran synchronously during entry evaluation: module
// construction, sync user-module discovery, IPC registration. This mark closes
// that phase, so a slow module registration shows up as its own segment rather
// than hiding inside "app ready".
markStartup('main.module-evaluated')

// The server's phase in words for every window, the Advanced toggle and the
// actions on it: registered in process too, where the toggle is all there is.
const relaunchApp = (args: string[] = []): void => {
  app.relaunch({
    args: [...withoutDeepLinks(process.argv.slice(1)).filter((arg) => arg !== SERVER_FALLBACK_ARGUMENT), ...args],
  })
  // A restart the person asked for in Settings, or the server's fallback: the
  // app comes straight back, so it is not a quit to ask about.
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
  choice: serverMode,
  supervisor: serverHost?.supervisor ?? null,
  fellBack: serverFellBack,
  readSavedMode: () => readServerMode(app.getPath('userData'), {}, []).mode,
  writeSavedMode: (mode) => writeServerMode(app.getPath('userData'), mode),
  openLog: async () => {
    const path = serverHost?.log.currentPath() ?? app.getPath('logs')
    return (await shell.openPath(path)) === ''
  },
  relaunch: ({ compatibility }) => {
    if (compatibility) writeServerMode(app.getPath('userData'), 'in-process')
    relaunchApp()
  },
  publish: (status) => studioPlatform().clients.publish(STUDIO_SERVER_CHANNELS.changed, status),
})

if (serverHost) {
  // Three failed boots with no server ever ready: this session goes on in
  // process (decision O9), by starting again in process at once, never by
  // building a second writer mid-session. The next ordinary launch tries the
  // separate process again; the fallback launch says why, in words.
  let fellBack = false
  serverHost.supervisor.onState((state) => {
    if (fellBack || state.kind !== 'failed' || !state.neverReady) return
    fellBack = true
    writeServerFallbackNote(app.getPath('userData'), state.reason)
    relaunchApp([SERVER_FALLBACK_ARGUMENT])
  })
  // What the server asks of the shell: the keychain, notices, terminal
  // launches, the integrations gate, a removed skill's Trash, Studio's own
  // plugin in a workspace, which the shell installs, and for artifacts a
  // page's picture and the set-up question with no window showing.
  serverHost.serveShell(services.shellBridge, {
    trash: (path) => shellTrash(path),
    studioPluginStatus: (workspaceRoot) => services.studioPluginStatus(workspaceRoot),
    artifacts: { thumbnailer: createElectronThumbnailer(), askNatively: askToSetUpArtifacts },
  })
}

registerAppLifecycle({
  diagnosticsEnabled: DIAGNOSTICS_ENABLED,
  allowMultipleInstances: allowsMultipleInstances(app),
  terminalRuntime: services.terminalLifecycle,
  conversations: services.conversations,
  conversationOwner: services.conversationOwner,
  automationService: services.automationService ?? undefined,
  studioRpcService: services.studioRpcService ?? undefined,
  agentStateService: services.agentStateService,
  workspaceSyncService: services.workspaceSyncService,
  removeSessionIntegrations: services.removeSessionIntegrations,
  releaseDataDir: () => (serverHost ? undefined : services.studioCore.dataDirLock?.release()),
  canvasService: services.canvasService,
  worktreePool: services.worktreePool,
  dependencyInstaller: services.dependencyInstaller,
  browserRecorder: services.browserRecorder,
  desktopShell: serverHost ? services.desktopShell : null,
  conversationCommands: coreIpc.conversationCommands,
  onAgentAttentionReady: (attention) => services.setTourAttention((key) => attention.notify(key)),
  agentNotifier: services.agentNotifier,
  onChatLinksReady: (open) => services.setChatLinkOpener(open),
  pullRequestRecord: services.pullRequestRecord,
  ...(services.localServers ? { localServers: services.localServers } : {}),
  ...(services.usageLimitResumes ? { usageLimitResumes: services.usageLimitResumes } : {}),
  ...(services.scheduledMessages ? { scheduledMessages: services.scheduledMessages } : {}),
  launchNotices: services.launchNotices ?? undefined,
  analytics: services.analytics,
  // Out of process the server runs every module's startup and shutdown hooks.
  ...(serverHost ? {} : { moduleKernel: moduleLoad.kernel }),
  updateService: services.updateService,
  // The skill sources are the server's out of process: their hourly check runs there.
  checkPluginSourceUpdates: serverHost
    ? async () => {
        if (serverHost.link.isServing()) await serverHost.link.rpc.call(SERVER_METHODS.skillSourcesCheck)
      }
    : () => services.skillsService?.checkSourceUpdates() ?? Promise.resolve(),
  // The hosted feeds are the Studio's: out of process the server fetches them.
  refreshHostedFeeds: serverHost
    ? async () => {
        if (serverHost.link.isServing()) await serverHost.link.rpc.call(SERVER_METHODS.hostedFeedsRefresh)
      }
    : async () => {
        await services.studioCore.extensions?.feeds.refresh()
      },
  startDeferredBootJobs: services.startDeferredBootJobs,
  // Out of process the workspaces to prepare arrive with the server's first
  // snapshot; the pass waits for it, inside the same boot budget.
  prepareWorkspacesAtBoot: serverHost
    ? () =>
        serverHost.link
          .whenServing(BOOT_SERVER_WAIT_MS)
          .then(() => serverHost.mirror.whenLoaded())
          .then(() => services.prepareWorkspacesAtBoot())
    : services.prepareWorkspacesAtBoot,
  ...(serverHost
    ? {
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
      }
    : {}),
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
  // ── extension-platform additions ──
  ...(serverHost ? {} : { moduleLoadReady: moduleLoad.ready }),
})
