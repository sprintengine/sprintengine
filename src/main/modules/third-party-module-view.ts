import type {
  ModuleEnablementOverrides,
  ThirdPartyModuleLaunchView,
  ThirdPartyModuleView,
} from '../../shared/modules/manifest'
import type { WorkerStatus } from '../../server/extensions/workers/worker-manager'
import { sanitizeEntryMessage } from './entry-containment'
import { approvalView } from './extension-approval-view'
import { isExtensionRunnable } from './module-signature'
import { surfaceEntriesView } from './extension-surface-entries'
import type { InstalledModule } from './user-module-registry'

// One installed extension as `extension.installed` answers it: what is on disk,
// whether the person approved it as it is, its signature, and whether it runs
// (module-lifecycle.ts).

/** What this server run did with its extensions: which it loaded, how each worker stands, and their tools. */
export type ExtensionRunView = {
  /** Whether this run's kernel holds its worker (it was approved and switched on at load, or since). */
  attached(moduleId: string): boolean
  /** Its worker now, while the kernel holds it. */
  worker(moduleId: string): WorkerStatus | null
  /** Why it failed to load in this run. */
  loadError(moduleId: string): string | undefined
  /** The MCP tools it serves on the gateway. */
  mcpTools(moduleId: string): string[]
}

export const NO_EXTENSION_RUN: ExtensionRunView = {
  attached: () => false,
  worker: () => null,
  loadError: () => undefined,
  mcpTools: () => [],
}

export function toThirdPartyModuleView(
  module: InstalledModule,
  run: ExtensionRunView = NO_EXTENSION_RUN,
  enablementOverrides: ModuleEnablementOverrides = {},
): ThirdPartyModuleView {
  return {
    manifest: module.manifest,
    extension: module.extension,
    approval: approvalView(module.standing.approval),
    signature: module.standing.signature,
    ...(module.standing.signer ? { signer: module.standing.signer } : {}),
    launch: launchViewFor(module, run, enablementOverrides),
    mcpTools: run.mcpTools(module.key),
  }
}

function launchViewFor(
  module: InstalledModule,
  run: ExtensionRunView,
  enablementOverrides: ModuleEnablementOverrides,
): ThirdPartyModuleLaunchView {
  return {
    ...mainEntryLaunchView(module, run, enablementOverrides),
    mainLoaded: run.attached(module.key),
    rendererEntry: surfaceEntriesView(module),
  }
}

function mainEntryLaunchView(
  module: InstalledModule,
  run: ExtensionRunView,
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

  const loadError = run.loadError(id)
  if (loadError) {
    return {
      status: 'launch_error',
      hasMainEntry,
      expectedToLoad: false,
      message: sanitizeEntryMessage(loadError, 'The extension’s worker failed during startup.'),
    }
  }
  const worker = run.worker(id)
  if (worker?.state === 'errored' || (worker?.state === 'stopped' && worker.message)) {
    return {
      status: 'launch_error',
      hasMainEntry,
      expectedToLoad: false,
      message: sanitizeEntryMessage(worker.message ?? '', 'Its worker stopped.'),
    }
  }

  const expectedToLoad = enablementOverrides[id] ?? module.manifest.defaultEnabled
  return {
    status: 'runs_worker',
    hasMainEntry,
    expectedToLoad,
    ...(worker?.state === 'waiting' && worker.message ? { waiting: worker.message } : {}),
    message: expectedToLoad
      ? worker?.state === 'running'
        ? 'Its worker runs.'
        : 'Its worker starts when something uses it.'
      : 'Its worker is switched off until you switch it on.',
  }
}
