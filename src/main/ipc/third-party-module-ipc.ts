import { app, shell, type IpcMain, type IpcMainInvokeEvent } from 'electron'

import { checkHostApiCompatibility } from '../../shared/modules/host-api'
import type {
  ModuleEnablementOverrides,
  ThirdPartyModuleLaunchView,
  ThirdPartyModuleListResult,
  ThirdPartyModuleOrigin,
  ThirdPartyModuleTrustResult,
  ThirdPartyModuleView,
} from '../../shared/modules/manifest'
import { readModuleOverridesSync } from '../module-host/enablement-store'
import { isModuleIdSegment } from '../modules/forget-modules'
import { computeHostApiIneligible } from '../modules/host-api-gate'
import type { ModuleTrustContext } from '../modules/module-signature'
import {
  defaultMarketplacePluginInstallStorePath,
  readMarketplacePluginInstallReceipts,
  type MarketplacePluginInstallReceipt,
} from '../marketplace/plugin-lifecycle'
import { assertAppSender } from './ipc-sender'
import {
  readThirdPartyMainLaunchSnapshot,
  type ThirdPartyLaunchSession,
  type ThirdPartyMainLaunchSnapshot,
} from '../modules/third-party-main-loader'
import { rendererEntryView } from '../modules/third-party-renderer-entries'
import { defaultUserModuleRoot, discoverUserModules, type InstalledModule } from '../modules/user-module-registry'
import { readModuleTrustContextSync } from '../modules/trust-context'

// The shell's view of the installed extensions for Settings: what is on disk,
// its trust and launch readiness, and showing its folder. Installing,
// trusting, switching and uninstalling go through the Studio server
// (`module.*`, main/modules/module-lifecycle.ts).
export function registerThirdPartyModuleIpc(
  ipcMain: IpcMain,
  options: {
    /**
     * What this session's main halves did. In process that is this process's
     * own launch snapshot; out of process the modules load in the server and
     * the shell asks it. The default reads the local snapshot and knows no
     * MCP tools.
     */
    readLaunchSession?: () => Promise<ThirdPartyLaunchSession>
  } = {},
): void {
  const trustContext = (): ModuleTrustContext => readModuleTrustContextSync(app.getPath('userData'))

  const readLaunchSession = async (): Promise<ThirdPartyLaunchSession> => {
    const local = { snapshot: readThirdPartyMainLaunchSnapshot(), mcpTools: new Map<string, string[]>() }
    if (!options.readLaunchSession) return local
    try {
      return await options.readLaunchSession()
    } catch {
      // A server that is restarting answers nothing; the list still answers.
      return local
    }
  }

  ipcMain.handle('modules:third-party:list', async (): Promise<ThirdPartyModuleListResult> => {
    const userData = app.getPath('userData')
    const [{ modules, rejected }, session, receipts] = await Promise.all([
      discoverUserModules(defaultUserModuleRoot(), trustContext()),
      readLaunchSession(),
      readMarketplacePluginInstallReceipts(defaultMarketplacePluginInstallStorePath(userData)),
    ])
    const enablementOverrides = readModuleOverridesSync(userData)
    // An unreadable receipt store leaves origins unknown rather than calling
    // every module a folder install.
    const origins = receipts.ok ? moduleOriginsFromReceipts(receipts.receipts) : null
    return {
      modules: modules.map((module) =>
        toThirdPartyModuleView(module, session.snapshot, enablementOverrides, {
          ...(origins ? { origin: origins.get(module.manifest.id) ?? { kind: 'folder' } } : {}),
          mcpTools: session.mcpTools.get(module.manifest.id) ?? [],
        }),
      ),
      rejected,
    }
  })

  // "Show files": open the module's own folder. The renderer never learns
  // where modules live, so main resolves the id to its installed folder.
  ipcMain.handle(
    'modules:third-party:reveal',
    async (event: IpcMainInvokeEvent, input: unknown): Promise<ThirdPartyModuleTrustResult> => {
      assertAppSender(event)
      const id = typeof input === 'string' ? input.trim() : ''
      if (!isModuleIdSegment(id)) return { ok: false, message: 'A module id is required.' }
      const { modules } = await discoverUserModules(defaultUserModuleRoot(), trustContext())
      const target = modules.find((module) => module.manifest.id === id)
      if (!target) return { ok: false, message: `Module "${id}" is not installed.` }
      const failure = await shell.openPath(target.moduleRoot)
      return failure ? { ok: false, message: failure } : { ok: true }
    },
  )
}

// Each module a receipt put in place, by module id, with where the receipt's
// bundle came from. A receipt without a source predates the field and was
// always the registry.
export function moduleOriginsFromReceipts(
  receipts: readonly MarketplacePluginInstallReceipt[],
): Map<string, ThirdPartyModuleOrigin> {
  const origins = new Map<string, ThirdPartyModuleOrigin>()
  for (const receipt of receipts) {
    const origin: ThirdPartyModuleOrigin =
      receipt.source?.kind === 'github'
        ? { kind: 'github', pluginId: receipt.id, repo: `${receipt.source.owner}/${receipt.source.repo}` }
        : { kind: 'marketplace', pluginId: receipt.id }
    for (const component of receipt.components) {
      if (component.kind === 'module') origins.set(component.id, origin)
    }
  }
  return origins
}

export function toThirdPartyModuleView(
  module: InstalledModule,
  launchSnapshot: ThirdPartyMainLaunchSnapshot = readThirdPartyMainLaunchSnapshot(),
  enablementOverrides: ModuleEnablementOverrides = {},
  extras: Pick<ThirdPartyModuleView, 'origin' | 'mcpTools'> = {},
): ThirdPartyModuleView {
  return {
    manifest: module.manifest,
    trust: module.trust.status,
    fingerprint: module.trust.fingerprint,
    launch: launchViewFor(module, launchSnapshot, enablementOverrides),
    ...(module.trust.status === 'trusted' && module.trust.via ? { trustedVia: module.trust.via } : {}),
    ...extras,
  }
}

function launchViewFor(
  module: InstalledModule,
  launchSnapshot: ThirdPartyMainLaunchSnapshot,
  enablementOverrides: ModuleEnablementOverrides,
): ThirdPartyModuleLaunchView {
  return {
    ...mainEntryLaunchView(module, launchSnapshot, enablementOverrides),
    mainLoaded: launchSnapshot.loaded.has(module.manifest.id),
    rendererEntry: rendererEntryView(module),
  }
}

function mainEntryLaunchView(
  module: InstalledModule,
  launchSnapshot: ThirdPartyMainLaunchSnapshot,
  enablementOverrides: ModuleEnablementOverrides,
): ThirdPartyModuleLaunchView {
  const id = module.manifest.id
  const hasMainEntry = Boolean(module.manifest.entry?.main)
  // Built for a host API this app does not provide: neither entry loads, and
  // trusting it would not change that, so it says so ahead of any trust
  // state. A tampered module keeps its own, louder, reason (host-api-gate.ts).
  if (module.trust.status !== 'invalid' && computeHostApiIneligible([module])[id]) {
    const compatibility = checkHostApiCompatibility(module.manifest)
    return {
      status: 'blocked_host_api',
      hasMainEntry,
      expectedToLoad: false,
      message: compatibility.ok ? 'Built for another host API.' : compatibility.message,
    }
  }
  if (module.trust.status === 'invalid') {
    return {
      status: 'blocked_invalid',
      hasMainEntry,
      expectedToLoad: false,
      message: module.trust.tampered
        ? 'Its files do not match the digests its manifest signs (tampered), so it will not run.'
        : 'Invalid signature blocks startup execution.',
    }
  }
  if (module.trust.status === 'signed') {
    return {
      status: 'blocked_signed',
      hasMainEntry,
      expectedToLoad: false,
      message: 'Signed module is waiting for trust before startup execution.',
    }
  }
  if (module.trust.status === 'unsigned') {
    return {
      status: 'blocked_unsigned',
      hasMainEntry,
      expectedToLoad: false,
      message: 'Unsigned module is waiting for trust before startup execution.',
    }
  }

  if (!hasMainEntry) {
    return {
      status: 'trusted_manifest_only',
      hasMainEntry,
      expectedToLoad: false,
      message: 'Trusted manifest-only module; no main entry will run.',
    }
  }

  const launchError = launchSnapshot.errors.get(id)
  if (launchError) {
    return {
      status: 'launch_error',
      hasMainEntry,
      expectedToLoad: false,
      message: launchError,
    }
  }

  const expectedToLoad = enablementOverrides[id] ?? module.manifest.defaultEnabled
  return {
    status: 'trusted_executable',
    hasMainEntry,
    expectedToLoad,
    message: expectedToLoad
      ? 'Trusted main entry is eligible for startup execution.'
      : module.manifest.defaultEnabled
        ? 'Trusted main entry is disabled by user setting until enabled.'
        : 'Trusted main entry is disabled by default until enabled.',
  }
}
