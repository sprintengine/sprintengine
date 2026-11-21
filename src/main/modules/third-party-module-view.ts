import type {
  ModuleEnablementOverrides,
  ThirdPartyModuleLaunchView,
  ThirdPartyModuleView,
} from '../../shared/modules/manifest'
import { approvalView } from './extension-approval-view'
import { isExtensionRunnable } from './module-signature'
import { readThirdPartyMainLaunchSnapshot, type ThirdPartyMainLaunchSnapshot } from './third-party-main-loader'
import { rendererEntryView } from './third-party-renderer-entries'
import type { InstalledModule } from './user-module-registry'

// One installed extension as `extension.installed` answers it: what is on disk,
// whether the person approved it as it is, its signature, and whether it runs
// (module-lifecycle.ts).

export function toThirdPartyModuleView(
  module: InstalledModule,
  launchSnapshot: ThirdPartyMainLaunchSnapshot = readThirdPartyMainLaunchSnapshot(),
  enablementOverrides: ModuleEnablementOverrides = {},
  extras: Pick<ThirdPartyModuleView, 'mcpTools'> = {},
): ThirdPartyModuleView {
  return {
    manifest: module.manifest,
    extension: module.extension,
    approval: approvalView(module.standing.approval),
    signature: module.standing.signature,
    ...(module.standing.signer ? { signer: module.standing.signer } : {}),
    launch: launchViewFor(module, launchSnapshot, enablementOverrides),
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
  const { standing } = module
  const hasMainEntry = module.extension.tier === 'worker' && Boolean(module.extension.main)
  if (standing.signature === 'invalid') {
    return {
      status: 'blocked_invalid',
      hasMainEntry,
      expectedToLoad: false,
      message: standing.tampered
        ? 'Its files do not match the digests extension.sig signs (tampered), so it will not run.'
        : 'Its signature is invalid, so it will not run.',
    }
  }
  if (!isExtensionRunnable(standing)) {
    return {
      status: 'awaiting_approval',
      hasMainEntry,
      expectedToLoad: false,
      message:
        standing.approval.state === 'unavailable'
          ? 'It holds files an extension cannot ship, so there is nothing to approve. Install it again.'
          : 'It waits for your approval before it runs.',
    }
  }

  if (!hasMainEntry) {
    return {
      status: 'runs_without_worker',
      hasMainEntry,
      expectedToLoad: false,
      message: 'It has no worker; nothing runs in the background.',
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
    status: 'runs_worker',
    hasMainEntry,
    expectedToLoad,
    message: expectedToLoad ? 'Its worker runs.' : 'Its worker is switched off until you switch it on.',
  }
}
