import type {
  ModuleEnablementOverrides,
  ThirdPartyModuleLaunchView,
  ThirdPartyModuleView,
} from '../../shared/modules/manifest'
import { readThirdPartyMainLaunchSnapshot, type ThirdPartyMainLaunchSnapshot } from './third-party-main-loader'
import { rendererEntryView } from './third-party-renderer-entries'
import type { InstalledModule } from './user-module-registry'

// One installed extension as `extension.installed` answers it: what is on disk,
// its trust, and whether it runs (module-lifecycle.ts).

export function toThirdPartyModuleView(
  module: InstalledModule,
  launchSnapshot: ThirdPartyMainLaunchSnapshot = readThirdPartyMainLaunchSnapshot(),
  enablementOverrides: ModuleEnablementOverrides = {},
  extras: Pick<ThirdPartyModuleView, 'mcpTools'> = {},
): ThirdPartyModuleView {
  return {
    manifest: module.manifest,
    extension: module.extension,
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
    mainLoaded: launchSnapshot.loaded.has(module.key),
    rendererEntry: rendererEntryView(module),
  }
}

function mainEntryLaunchView(
  module: InstalledModule,
  launchSnapshot: ThirdPartyMainLaunchSnapshot,
  enablementOverrides: ModuleEnablementOverrides,
): ThirdPartyModuleLaunchView {
  const id = module.key
  const hasMainEntry = module.extension.tier === 'worker' && Boolean(module.extension.main)
  if (module.trust.status === 'invalid') {
    return {
      status: 'blocked_invalid',
      hasMainEntry,
      expectedToLoad: false,
      message: module.trust.tampered
        ? 'Its files do not match the digests extension.sig signs (tampered), so it will not run.'
        : 'Invalid signature blocks startup execution.',
    }
  }
  if (module.trust.status === 'signed') {
    return {
      status: 'blocked_signed',
      hasMainEntry,
      expectedToLoad: false,
      message: 'Signed extension is waiting for trust before it runs.',
    }
  }
  if (module.trust.status === 'unsigned') {
    return {
      status: 'blocked_unsigned',
      hasMainEntry,
      expectedToLoad: false,
      message: 'Unsigned extension is waiting for trust before it runs.',
    }
  }

  if (!hasMainEntry) {
    return {
      status: 'trusted_manifest_only',
      hasMainEntry,
      expectedToLoad: false,
      message: 'Trusted extension with no worker; nothing runs in the background.',
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
    message: expectedToLoad ? 'Trusted worker is eligible to run.' : 'Trusted worker is switched off until enabled.',
  }
}
