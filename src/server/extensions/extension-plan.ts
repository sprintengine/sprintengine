import type { ExtensionMcpToolContribution } from '../../../packages/extension-sdk/src/extension-manifest'
import type { ModuleFileDigests, ModuleResolutionErrorCode } from '../../shared/modules/manifest'
import type { CapabilityModule, MainModuleLoadError } from '../../main/module-host/load-modules'
import { isExtensionRunnable } from '../../main/modules/module-signature'
import type { InstalledModule, ModuleRejection, UserModuleListResult } from '../../main/modules/user-module-registry'
import type { ExtensionWorkers, InstalledStanding } from './workers/worker-manager'
import type { ExtensionFrameStanding } from '../../main/modules/extension-frame-grant'

// The installed extensions as one Studio server's module kernel loads them.
//
// Every one is listed with the kernel, so its switch, its surfaces and its
// frames' host calls work. One whose code is a worker is handed to the
// server's workers (workers/worker-manager.ts) when the kernel loads it: its
// code runs in a process of its own, started when something needs it (or at
// once, for a `background` one), never in the server's. One that may not run
// (not approved as it is, or broken) is passed to the kernel as ineligible,
// so nothing of it loads.

export type InstalledExtensionsInput = {
  modules: InstalledModule[]
  rejected: ModuleRejection[]
}

/**
 * What an extension that runs was loaded under: whether it needed the
 * person's approval (content only does not), and the permissions it was
 * loaded with. Its calls are held to these, and to what its approval holds
 * as the approvals stand at each call.
 */
export type ExtensionLoadedApproval = { approved: boolean; permissions: string[] }

export type InstalledExtensionsPlan = {
  modules: CapabilityModule[]
  /** Install folder per extension id. */
  moduleRoots: Record<string, string>
  /** The file digests each runnable extension was verified with. */
  verifiedFiles: Record<string, ModuleFileDigests>
  /** The MCP tools each extension's extension.json declares. */
  mcpTools: Record<string, readonly ExtensionMcpToolContribution[]>
  /** What each extension that runs was approved for, as it was loaded: the host's gate reads it. */
  approvals: Record<string, ExtensionLoadedApproval>
  ineligible: Record<string, ModuleResolutionErrorCode>
  launchErrors: MainModuleLoadError[]
  /**
   * What each extension was loaded as: its folder, whether it may run, the
   * approval it runs under, its files and its extension.json. When this
   * changes (a save in a development folder, an update, an approval), the
   * kernel loads it again (`reloadInstalledExtensions`).
   */
  identities: Record<string, string>
}

export function planInstalledExtensions(
  input: InstalledExtensionsInput,
  workers: () => ExtensionWorkers,
): InstalledExtensionsPlan {
  const plan: InstalledExtensionsPlan = {
    modules: [],
    moduleRoots: {},
    verifiedFiles: {},
    mcpTools: {},
    approvals: {},
    ineligible: {},
    identities: {},
    launchErrors: input.rejected.map((rejection) => ({
      id: rejection.path,
      message: rejection.issues.map((issue) => `${issue.path ? `${issue.path}: ` : ''}${issue.message}`).join('; '),
    })),
  }
  for (const installed of input.modules) {
    const { key, standing, extension } = installed
    plan.identities[key] = JSON.stringify([
      installed.moduleRoot,
      isExtensionRunnable(standing),
      standing.signature,
      standing.approval.state === 'approved' ? standing.approval.fingerprint : standing.approval.state,
      standing.contentDigest ?? null,
      installed.development?.order ?? null,
      extension,
    ])
    plan.moduleRoots[key] = installed.moduleRoot
    plan.mcpTools[key] = extension.contributes.mcpTools
    if (!isExtensionRunnable(standing) || !standing.verifiedFiles) {
      plan.modules.push({ manifest: installed.manifest })
      plan.ineligible[key] = standing.signature === 'invalid' ? 'invalid_signature' : 'unapproved'
      continue
    }
    const verifiedFiles = standing.verifiedFiles
    plan.verifiedFiles[key] = verifiedFiles
    plan.approvals[key] = { approved: standing.approval.state === 'approved', permissions: [...extension.permissions] }
    const main = extension.tier === 'worker' ? extension.main : undefined
    if (!main || standing.approval.state !== 'approved') {
      plan.modules.push({ manifest: installed.manifest })
      continue
    }
    const fingerprint = standing.approval.fingerprint
    plan.modules.push({
      manifest: installed.manifest,
      registerMain: (host) =>
        workers().attach(
          {
            extensionId: key,
            displayName: installed.manifest.displayName?.trim() || key,
            root: installed.moduleRoot,
            main,
            verifiedFiles,
            background: extension.background === true,
            fingerprint,
            declaredTools: extension.contributes.mcpTools,
            declaredHooks: extension.contributes.hooks,
            declaredEvents: extension.contributes.events.map((subscription) => subscription.on),
            ...(installed.development ? { development: { order: installed.development.order } } : {}),
          },
          host,
        ),
    })
  }
  return plan
}

/**
 * The extensions as discovery found them (extension-discovery.ts), for the
 * workers to hold what runs against: whether each may run as it is, and the
 * approval it is approved under.
 */
export function installedStandingOf(discovered: UserModuleListResult): Map<string, InstalledStanding> {
  return new Map(
    discovered.modules.map((module) => [
      module.key,
      {
        runnable: isExtensionRunnable(module.standing),
        fingerprint: module.standing.approval.state === 'approved' ? module.standing.approval.fingerprint : null,
      },
    ]),
  )
}

/** How one extension stands as discovery found it, for its frames' calls (extension-frame-grant.ts). */
export function frameStandingOf(discovered: UserModuleListResult, key: string): ExtensionFrameStanding | undefined {
  const module = discovered.modules.find((candidate) => candidate.key === key)
  if (!module) return undefined
  return {
    runnable: isExtensionRunnable(module.standing),
    version: module.extension.version,
    moduleRoot: module.moduleRoot,
    contentDigest: module.standing.contentDigest,
    development: module.development !== undefined,
  }
}
