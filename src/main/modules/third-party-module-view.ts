import { checkHostApiCompatibility } from '../../shared/modules/host-api'
import type {
  ModuleEnablementOverrides,
  ThirdPartyModuleLaunchView,
  ThirdPartyModuleOrigin,
  ThirdPartyModuleView,
} from '../../shared/modules/manifest'
import type { MarketplacePluginInstallReceipt } from '../marketplace/plugin-lifecycle'
import { computeHostApiIneligible } from './host-api-gate'
import { readThirdPartyMainLaunchSnapshot, type ThirdPartyMainLaunchSnapshot } from './third-party-main-loader'
import { rendererEntryView } from './third-party-renderer-entries'
import type { InstalledModule } from './user-module-registry'

// One installed extension as `module.installed` answers it: what is on disk,
// its trust, where it came from, and whether it runs (module-lifecycle.ts).

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
