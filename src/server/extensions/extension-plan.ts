import type { ExtensionMcpToolContribution } from '../../../packages/extension-sdk/src/extension-manifest'
import type { ModuleFileDigests, ModuleResolutionErrorCode } from '../../shared/modules/manifest'
import type { CapabilityModule, MainModuleLoadError } from '../../main/module-host/load-modules'
import { isExtensionRunnable } from '../../main/modules/module-signature'
import { readExtensionStandingContextSync } from '../../main/modules/extension-standing-context'
import {
  discoverUserModulesSync,
  type InstalledModule,
  type ModuleRejection,
} from '../../main/modules/user-module-registry'
import type { ExtensionWorkers, InstalledStanding } from './workers/worker-manager'

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
    launchErrors: input.rejected.map((rejection) => ({
      id: rejection.path,
      message: rejection.issues.map((issue) => `${issue.path ? `${issue.path}: ` : ''}${issue.message}`).join('; '),
    })),
  }
  for (const installed of input.modules) {
    const { key, standing, extension } = installed
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
          },
          host,
        ),
    })
  }
  return plan
}

/**
 * The installed extensions as discovery finds them now, for the workers to
 * hold what runs against: whether each may run as it is, and the approval it
 * is approved under. Reads and digests every folder, so it is read when
 * something changed, not per call.
 */
export function readInstalledStanding(moduleRoot: string, dataDir: string): Map<string, InstalledStanding> {
  const { modules } = discoverUserModulesSync(moduleRoot, readExtensionStandingContextSync(dataDir))
  return new Map(
    modules.map((module) => [
      module.key,
      {
        runnable: isExtensionRunnable(module.standing),
        fingerprint: module.standing.approval.state === 'approved' ? module.standing.approval.fingerprint : null,
      },
    ]),
  )
}
