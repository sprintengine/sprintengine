import { createRequire } from 'node:module'

import type { ExtensionMcpToolContribution } from '../../../packages/extension-sdk/src/extension-manifest'
import type { ModuleFileDigests, ModuleResolutionErrorCode } from '../../shared/modules/manifest'
import type { CapabilityModule, MainModuleLoadError, MainModuleLoadReport } from '../module-host/load-modules'
import type { MainHost } from '../module-host/main-host'
import { resolveContainedEntry, sanitizeEntryMessage } from './entry-containment'
import { isLoadEligible, moduleFileDigestIssuesSync } from './module-signature'
import type { InstalledModule, ModuleRejection } from './user-module-registry'

type ThirdPartyMainLoadDiagnostics = {
  rejected: ModuleRejection[]
}

export type ThirdPartyMainLoadInput = {
  modules: InstalledModule[]
  rejected: ModuleRejection[]
}

export type ThirdPartyMainLoadPlan = {
  modules: CapabilityModule[]
  /** Install folder per module id — what contains its entries and its skills. */
  moduleRoots: Record<string, string>
  /** The file digests each trusted module was verified with — what `getAssetPath` resolves against. */
  verifiedFiles: Record<string, ModuleFileDigests>
  /** The MCP tools each extension's extension.json declares: all its worker may register. */
  mcpTools: Record<string, readonly ExtensionMcpToolContribution[]>
  ineligible: Record<string, ModuleResolutionErrorCode>
  launchErrors: MainModuleLoadError[]
  diagnostics: ThirdPartyMainLoadDiagnostics
}

type ThirdPartyMainExport = {
  activate?: unknown
  default?: unknown
}

export type ThirdPartyMainLaunchSnapshot = {
  loaded: ReadonlySet<string>
  manifestOnly: ReadonlySet<string>
  errors: ReadonlyMap<string, string>
}

let launchSnapshot: ThirdPartyMainLaunchSnapshot = {
  loaded: new Set(),
  manifestOnly: new Set(),
  errors: new Map(),
}

/** Why an extension's worker did not run here; Settings shows it in these words. */
export const NEEDS_ELECTRON_MAIN = 'skipped: needs electron-main'

/** `require('electron')` from a module's main half, where its main half runs without Electron. */
export class ElectronUnavailableError extends Error {
  constructor(request: string) {
    super(
      `${NEEDS_ELECTRON_MAIN}: this extension's worker requires "${request}", which the Studio server ` +
        'does not provide.',
    )
    this.name = 'ElectronUnavailableError'
  }
}

export function planThirdPartyMainModules(
  input: ThirdPartyMainLoadInput,
  options: {
    /**
     * Whether `electron` can be required where the workers run: false in the
     * Studio server out of process (owner default 2026-10-01), where a worker
     * that requires it is reported as skipped rather than as a crash.
     */
    electronMain?: boolean
  } = {},
): ThirdPartyMainLoadPlan {
  const modules: CapabilityModule[] = []
  const moduleRoots: Record<string, string> = {}
  const verifiedFiles: Record<string, ModuleFileDigests> = {}
  const ineligible: Record<string, ModuleResolutionErrorCode> = {}
  const mcpTools: Record<string, readonly ExtensionMcpToolContribution[]> = {}
  const electronMain = options.electronMain ?? true

  for (const installed of input.modules) {
    modules.push(createThirdPartyMainModule(installed, { electronMain }))
    moduleRoots[installed.key] = installed.moduleRoot
    mcpTools[installed.key] = installed.extension.contributes.mcpTools
    if (isLoadEligible(installed.trust.status) && installed.trust.verifiedFiles) {
      verifiedFiles[installed.key] = installed.trust.verifiedFiles
    }
    if (isLoadEligible(installed.trust.status)) continue
    ineligible[installed.key] = installed.trust.status === 'invalid' ? 'invalid_signature' : 'untrusted'
  }

  return {
    modules,
    moduleRoots,
    verifiedFiles,
    mcpTools,
    ineligible,
    launchErrors: input.rejected.map(rejectionToLoadError),
    diagnostics: { rejected: input.rejected },
  }
}

export function recordThirdPartyMainLaunchReport(moduleIds: readonly string[], report: MainModuleLoadReport): void {
  const thirdPartyIds = new Set(moduleIds)
  launchSnapshot = {
    loaded: new Set(report.loaded.filter((id) => thirdPartyIds.has(id))),
    manifestOnly: new Set(report.manifestOnly.filter((id) => thirdPartyIds.has(id))),
    errors: new Map(
      report.errors
        .filter((error) => thirdPartyIds.has(error.id))
        .map((error) => [error.id, sanitizeLaunchMessage(error.message)]),
    ),
  }
}

export function readThirdPartyMainLaunchSnapshot(): ThirdPartyMainLaunchSnapshot {
  return launchSnapshot
}

/**
 * What this server run's main halves did, as the installed list reports it:
 * which loaded and which failed, and the MCP tools each registered.
 */
export type ThirdPartyLaunchSession = {
  snapshot: ThirdPartyMainLaunchSnapshot
  mcpTools: ReadonlyMap<string, string[]>
}

export function thirdPartyLaunchSession(
  snapshot: ThirdPartyMainLaunchSnapshot,
  mcpTools: ReadonlyArray<{ moduleId: string; registration: { name: string } }>,
): ThirdPartyLaunchSession {
  const byModule = new Map<string, string[]>()
  for (const tool of mcpTools)
    byModule.set(tool.moduleId, [...(byModule.get(tool.moduleId) ?? []), tool.registration.name])
  return { snapshot, mcpTools: byModule }
}

function rejectionToLoadError(rejection: ModuleRejection): MainModuleLoadError {
  return {
    id: rejection.path,
    message: rejection.issues.map((issue) => `${issue.path ? `${issue.path}: ` : ''}${issue.message}`).join('; '),
  }
}

function sanitizeLaunchMessage(message: string): string {
  return sanitizeEntryMessage(message, 'The extension’s worker failed during startup.')
}

// The extensions whose worker this process skipped because it needs Electron.
const skippedForElectron = new Set<string>()

/** Whether an extension's worker was skipped here because it needs Electron. */
export function skippedForElectronMain(moduleId: string): boolean {
  return skippedForElectron.has(moduleId)
}

function createThirdPartyMainModule(installed: InstalledModule, options: { electronMain: boolean }): CapabilityModule {
  const main = installed.extension.tier === 'worker' ? installed.extension.main : undefined
  if (!isLoadEligible(installed.trust.status) || !main) {
    return { manifest: installed.manifest }
  }

  const verifiedFiles = installed.trust.verifiedFiles
  return {
    manifest: installed.manifest,
    registerMain: (host) => {
      if (options.electronMain) return loadTrustedWorker(installed.moduleRoot, main, verifiedFiles, host)
      // A `require('electron')` is caught as it happens (the Studio server's
      // require guard throws ElectronUnavailableError), and classified by name
      // rather than reported as a crash.
      const classify = (error: unknown): never => {
        if (error instanceof Error && error.name === 'ElectronUnavailableError') {
          skippedForElectron.add(installed.key)
        }
        throw error
      }
      try {
        const activated = loadTrustedWorker(installed.moduleRoot, main, verifiedFiles, host)
        return activated ? Promise.resolve(activated).catch(classify) : activated
      } catch (error) {
        return classify(error)
      }
    },
  }
}

// Trust was decided over the files as discovery found them, and the worker
// is loaded later. The whole folder is held to those digests again here,
// synchronously and immediately before require(), so a file swapped in between
// — the worker or anything it loads from its own folder — is refused rather
// than run. require() reads the entry from disk once more after this check;
// loading from the very bytes hashed would mean compiling through Node's
// private module internals, so the window left is the one between this
// synchronous check and require's own read, in the same tick.
function loadTrustedWorker(
  moduleRoot: string,
  main: string,
  verifiedFiles: ModuleFileDigests | undefined,
  host: MainHost,
): void | Promise<void> {
  const entryPath = resolveContainedEntry(moduleRoot, main, 'main')
  if (!verifiedFiles || verifiedFiles[main] === undefined) {
    throw new Error('main is not among the extension’s files that were verified.')
  }
  const changed = moduleFileDigestIssuesSync(moduleRoot, verifiedFiles, { label: 'digests verified at discovery' })
  if (changed.length > 0) {
    throw new Error(
      `The extension’s files changed after they were verified, so its worker was not loaded: ${changed
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    )
  }
  const entryModule = createRequire(`${entryPath}.loader.cjs`)(entryPath) as ThirdPartyMainExport
  // Returned, not dropped: an async activate's promise is what the loader
  // races against its timeout.
  return resolveActivate(entryModule)(host)
}

// `activate` as a named export, or the default export (a CommonJS bundle's
// `module.exports.default`, or an ES module's).
function resolveActivate(entryModule: ThirdPartyMainExport): (host: MainHost) => void | Promise<void> {
  if (typeof entryModule.activate === 'function') {
    return entryModule.activate as (host: MainHost) => void | Promise<void>
  }
  if (typeof entryModule.default === 'function') {
    return entryModule.default as (host: MainHost) => void | Promise<void>
  }
  if (
    entryModule.default &&
    typeof entryModule.default === 'object' &&
    typeof (entryModule.default as { activate?: unknown }).activate === 'function'
  ) {
    return (entryModule.default as { activate: (host: MainHost) => void | Promise<void> }).activate
  }
  throw new Error('main must export activate(studio), as a named export or its default.')
}
