import { GitHubTokenStore } from '../../main/github-token-store'
import { readModuleOverridesSync } from '../../main/module-host/enablement-store'
import { loadMainModules, type LoadMainModulesResult } from '../../main/module-host/load-modules'
import type { McpToolContribution } from '../../main/module-host/main-host'
import { ScheduledAgentsServiceToken } from '../../main/module-host/service-tokens'
import { AGENT_RUNTIME_MANIFEST, createAgentRuntimeModule } from '../../main/modules/agent-runtime-module'
import { createModuleLifecycle, liveModuleIds } from '../../main/modules/module-lifecycle'
import type { ExtensionRunView } from '../../main/modules/third-party-module-view'
import { scheduledAgentsSwitchModule } from '../../main/modules/scheduled-agents-switch'
import { planInstalledExtensions, readInstalledStanding } from '../extensions/extension-plan'
import { createExtensionWorkers } from '../extensions/workers/worker-manager'
import { resolveWorkerEntryPath } from '../extensions/workers/worker-process'
import { join } from 'node:path'
import { readExtensionStandingContextSync } from '../../main/modules/extension-standing-context'
import { createExtensionApprovalReader } from '../../main/modules/extension-approvals'
import { createExtensionFrameGrant } from '../../main/modules/extension-frame-grant'
import { defaultUserModuleRoot, discoverUserModulesSync } from '../../main/modules/user-module-registry'
import { watchUserModuleRoot } from '../../main/modules/user-module-watch'
import type { ScheduledAgentsService } from '../../main/scheduled-agents/service'
import { createStudioModuleHub, type StudioModules } from '../rpc/studio-modules'
import { createModuleRegistryMirror, type ModuleRegistryMirror } from '../../main/modules/registry-mirror'
import type { CapabilityManifest, ModuleResolutionErrorCode } from '../../shared/modules/manifest'
import { resolveModuleEnablement } from '../../shared/modules/resolve'
import type { StudioCore } from '../core/studio-core'
import type { StudioGateway } from '../core/studio-gateway'
import type { StudioPlatform } from '../platform/platform'

// The module kernel in the Studio server out of process (phase 6 spec, 12.2):
// every module's server half, registered on the server's IPC tunnel, its MCP
// tools on the server's gateway, its events and bell rows on the Studio RPC's
// `module.*` streams. The same steps app-main.ts takes in process, over the server's own
// services.
//
// What runs here is changed through the Studio RPC (`extension.setEnabled`,
// `.install`, `.approve`, `.uninstall`, main/modules/module-lifecycle.ts):
// enablement applies live where a module can load live; what is installed
// and trusted is read at the next start. The marketplace installs here too
// (`marketplace.*`, the core's extensions).

export type ServerModules = {
  /** What the modules say to clients, for the Studio RPC. */
  readonly hub: StudioModules
  /** Register every enabled module. Called once the gateway exists. */
  load(gateway: StudioGateway): void
  mcpTools(): ReadonlyArray<McpToolContribution>
  /** The module registry a window resolved (`extension.reportRegistry`), for the agents' `module.*` tools. */
  readonly registry: ModuleRegistryMirror
  isEnabled(moduleId: string): boolean
  scheduledAgents(): ScheduledAgentsService | null
  startup(): void
  shutdownBegin(): Promise<void>
  shutdown(): Promise<void>
}

export function createServerModules(deps: {
  platform: StudioPlatform
  core: StudioCore
  log: (message: string) => void
}): ServerModules {
  const { platform, core } = deps
  const dataDir = platform.paths.dataDir()
  const readOverrides = (): Record<string, boolean> => {
    try {
      return readModuleOverridesSync(dataDir)
    } catch {
      return {}
    }
  }
  const enabled = new Set<string>()
  const hub = createStudioModuleHub()
  const registry = createModuleRegistryMirror()
  hub.readRecentFrom(() => load?.kernel.recentNotifications() ?? [])
  // A module's declared methods, called over the Studio RPC's `extension.read` and `extension.operate`.
  hub.serveCallsFrom(async (request) =>
    load
      ? load.kernel.callModuleMethod(request)
      : {
          ok: false,
          code: 'extension_unavailable',
          message: `Extension "${request.moduleId}" is not running on this Studio.`,
        },
  )
  // The host calls an extension's frames make, over the Studio RPC's `extension.call`.
  hub.serveFrameCallsFrom(async (request) =>
    load
      ? load.kernel.callFrameMethod(request)
      : { ok: false, code: 'unavailable', message: `Extension "${request.moduleId}" is not running on this Studio.` },
  )
  let load: LoadMainModulesResult | null = null
  let gateway: StudioGateway | null = null
  const approvals = createExtensionApprovalReader(dataDir)
  // Every worker extension's code runs in a process of its own.
  const { workers, bind: bindWorkers } = createExtensionWorkers({
    entryPath: resolveWorkerEntryPath(),
    logDir: join(platform.paths.logsDir(), 'extensions'),
    approvals,
    installed: () => readInstalledStanding(defaultUserModuleRoot(), dataDir),
    toolsChanged: () => gateway?.notifyToolsListChanged(),
    stateChanged: () => hub.deliverChanged(),
  })
  let stopWatchingModules: (() => void) | null = null
  let manifests: CapabilityManifest[] = []
  let ineligible: Record<string, ModuleResolutionErrorCode> = {}
  // The installed extensions, by id: each is switched on and off live.
  let moduleRootsById: Record<string, string> = {}

  // The overrides, already written, applied to the running kernel.
  async function applyEnablement(
    overrides: Record<string, boolean>,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!load) return { ok: true }
    const report = await load.applyEnablement(overrides, {
      liveModuleIds: liveModuleIds(Object.keys(moduleRootsById), load.report.errors),
    })
    // The rest of the change was applied even when one module's half
    // failed, so the gate follows it either way.
    recompute(overrides)
    // The gateway reads the registry and enablement per request; connected
    // clients only need telling that their lists changed.
    gateway?.notifyToolsListChanged()
    const scheduledAgentsError = report.errors.find((error) => error.id === 'scheduled-agents')
    if (scheduledAgentsError) return { ok: false, message: scheduledAgentsError.message }
    return { ok: true }
  }
  // What runs here, listed and changed over the Studio RPC (`module.*`).
  hub.serveLifecycleFrom(
    createModuleLifecycle({
      dataDir,
      moduleRoot: defaultUserModuleRoot,
      applyEnablement,
      // Every client following `extension.changed` lists and loads them again,
      // and a worker whose approval is gone or changed stops.
      changed: () => {
        workers.reconcile()
        hub.deliverChanged()
      },
      run: () => extensionRunView(),
      // Every client following `extension.settingsChanged` reads them again.
      settingsChanged: (moduleId) => hub.deliverSettingsChanged(moduleId),
      registry,
      view: () => {
        const current = load
        if (!current) return null
        const overrides = readOverrides()
        return {
          manifests: () => manifests,
          enabled: (id) => overrides[id] ?? manifests.find((manifest) => manifest.id === id)?.defaultEnabled ?? false,
          running: (id) => current.isRunning(id),
          ineligible: (id) => ineligible[id],
          loadError: (id) => current.report.errors.find((error) => error.id === id)?.message,
          declaredMethods: (id) => current.kernel.declaredMethods(id),
        }
      },
    }),
  )

  const extensionRunView = (): ExtensionRunView => {
    const current = load
    const tools = current?.kernel.mcpToolRegistrations() ?? []
    return {
      attached: (id) => workers.serves(id) && workers.status(id)?.state !== 'stopped',
      worker: (id) => workers.status(id),
      loadError: (id) => current?.report.errors.find((error) => error.id === id)?.message,
      mcpTools: (id) => tools.filter((tool) => tool.moduleId === id).map((tool) => tool.registration.name),
    }
  }

  const recompute = (overrides: Record<string, boolean>): void => {
    const { order } = resolveModuleEnablement(manifests, overrides)
    enabled.clear()
    for (const id of order) enabled.add(id)
  }

  return {
    hub,
    registry,
    load(nextGateway) {
      gateway = nextGateway
      const overrides = readOverrides()
      const thirdParty = planInstalledExtensions(
        discoverUserModulesSync(defaultUserModuleRoot(), readExtensionStandingContextSync(dataDir)),
        () => workers,
      )
      ineligible = thirdParty.ineligible
      moduleRootsById = thirdParty.moduleRoots
      // The schedules are the core's; the kernel holds them under the
      // person's Scheduled agents switch.
      const bundled = [
        scheduledAgentsSwitchModule(
          core.scheduledAgents,
          // Read only once a module asks, by which time `byId` exists.
          (moduleId): readonly string[] | undefined => byId.get(moduleId)?.permissions,
        ),
      ]
      const byId = new Map<string, CapabilityManifest>(
        [AGENT_RUNTIME_MANIFEST, ...bundled.map((m) => m.manifest), ...thirdParty.modules.map((m) => m.manifest)].map(
          (manifest) => [manifest.id, manifest],
        ),
      )
      const agentRuntime = createAgentRuntimeModule(
        {
          agentLaunchSettings: core.agentLaunchSettings,
          githubTokenStore: new GitHubTokenStore(),
          workspaceSyncService: core.workspaceSyncService,
          workspaceRegistry: core.workspaceRegistry,
          conversations: core.conversations,
          conversationLaunchService: core.conversationLaunchService,
          conversationModelCatalog: core.conversationModelCatalog,
          createConversationHost: core.createConversationHost,
        },
        {
          getModulePermissions: (moduleId) => byId.get(moduleId)?.permissions,
          platform,
          getTextGenerationSettings: () => core.textGenerationSettings.get(),
        },
      )
      load = loadMainModules({
        modules: [agentRuntime, ...bundled, ...thirdParty.modules],
        overrides,
        moduleRoots: thirdParty.moduleRoots,
        moduleVerifiedFiles: thirdParty.verifiedFiles,
        moduleMcpTools: thirdParty.mcpTools,
        // What each extension runs under; its calls are refused once that approval is gone.
        extensionApprovals: thirdParty.approvals,
        currentApprovals: approvals,
        resolveFrameGrant: createExtensionFrameGrant({ approvals, dataDir }),
        onKernel: bindWorkers,
        frameFileExclusions: () => [dataDir, defaultUserModuleRoot()],
        ineligible: thirdParty.ineligible,
        launchErrors: thirdParty.launchErrors,
        deliverModuleEvent: (event) => hub.deliverEvent(event),
        deliverModuleNotification: (notification) => hub.deliverNotification(notification),
        // A module tool that would shadow one of the gateway's own is refused
        // at registration, naming the tool it collides with.
        coreMcpToolNames: () => nextGateway.coreToolNames(),
      })
      manifests = [
        agentRuntime.manifest,
        ...bundled.map((m) => m.manifest),
        ...thirdParty.modules.map((m) => m.manifest),
      ]
      recompute(overrides)
      // An extension's schedules are held to its permissions, and wait while it is not here.
      core.attachModules({
        permissions: (moduleId) => byId.get(moduleId)?.permissions,
        loaded: () => [...enabled],
      })
      if (load.report.errors.length > 0) {
        deps.log(`module load errors: ${load.report.errors.map((error) => `${error.id}: ${error.message}`).join('; ')}`)
      }
    },
    mcpTools: () => load?.kernel.mcpToolRegistrations() ?? [],
    isEnabled: (moduleId) => enabled.has(moduleId),
    scheduledAgents: () => load?.kernel.hostFor('@host').getService(ScheduledAgentsServiceToken) ?? null,
    startup() {
      const current = load
      if (current) void current.ready.then(() => current.kernel.runStartup())
      // A module copied into the drop-in folder while Studio runs is listed
      // at once, not after a reload.
      // A worker whose extension was removed from the folder (and its approval with it) stops.
      stopWatchingModules ??= watchUserModuleRoot(defaultUserModuleRoot(), () => {
        workers.reconcile()
        hub.deliverChanged()
      })
    },
    shutdownBegin: () => load?.kernel.runShutdownBegin() ?? Promise.resolve(),
    shutdown: async () => {
      stopWatchingModules?.()
      stopWatchingModules = null
      await (load?.kernel.runShutdown() ?? Promise.resolve())
      await workers.close()
    },
  }
}
