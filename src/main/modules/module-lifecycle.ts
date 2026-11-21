import { lstat, realpath, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

import type {
  ModuleRegistrySnapshotWriteResult,
  StudioModuleDeclaredMethod,
  StudioModulesMethodMap,
  StudioModuleSummary,
  ThirdPartyModuleListResult,
  ThirdPartyRendererEntriesResult,
} from '../../../packages/studio-protocol/src/public'
import {
  LIVE_ENABLED_MODULE_IDS,
  type CapabilityManifest,
  type ModuleResolutionErrorCode,
} from '../../shared/modules/manifest'
import { readModuleOverridesSync, writeModuleOverrides } from '../module-host/enablement-store'
import { moduleAppStateMirrorFor } from '../module-host/module-app-state-mirror'
import { forgetModules, isModuleIdSegment } from './forget-modules'
import { createModuleAssetOriginResolver } from './module-asset-origins'
import type { ModuleRegistryMirror } from './registry-mirror'
import type { ThirdPartyLaunchSession } from './third-party-main-loader'
import { toThirdPartyModuleView } from './third-party-module-view'
import { collectThirdPartyRendererEntries } from './third-party-renderer-entries'
import { readModuleTrustContextSync } from './trust-context'
import { setModuleTrust } from './trust-store'
import { discoverUserModules, installModuleFolder } from './user-module-registry'

// What runs on a Studio, changed through its server (`extension.setEnabled`,
// `extension.install`, `extension.setTrust`, `extension.uninstall`) and read
// (`extension.list`): the same steps in process and out of process, over the
// data folder and the module root the server reads at load. Nothing here
// needs Electron.
//
// - Switching a module on or off writes the person's choice to the data
//   folder, then has the running kernel apply it: at once for an installed
//   extension and the bundled modules that can (`liveModuleIds`), at the next
//   start otherwise.
// - Installing, trusting and uninstalling change what is on disk and in the
//   trust store; the kernel reads them at its next start. `changed` tells the
//   windows, which load a trusted extension's window half again.
// - Listing the installed extensions (`extension.installed`) reads the disk, the
//   trust store and the receipts now, with what this server run loaded; the
//   window halves (`extension.rendererEntries`) are read and checked against
//   their verified bytes per request, so revoking trust applies at once.
// - The modules' Settings values (`extension.setAppState`) are kept in the data
//   folder for their main halves; the registry a window resolved
//   (`extension.reportRegistry`) is kept in memory for the agents' tools.
// Every change runs one at a time: two switches arriving together must not
// each write the overrides they read before the other's.

/**
 * The modules whose switch applies at once: the bundled ones that can
 * (`LIVE_ENABLED_MODULE_IDS`) and every installed extension, whose main half
 * is unloaded when it is switched off (its methods, tools, services and
 * sidecars go with it) and loaded again when it is switched back on. An
 * extension whose main half failed to load at start waits for the next one:
 * a switch of some other module must not retry it, and ring the bell again.
 */
export function liveModuleIds(
  extensionIds: readonly string[],
  failedAtStart: readonly { id: string }[] = [],
): string[] {
  const failed = new Set(failedAtStart.map((error) => error.id))
  return [...new Set([...LIVE_ENABLED_MODULE_IDS, ...extensionIds.filter((id) => !failed.has(id))])]
}

type Answer<M extends keyof StudioModulesMethodMap> = StudioModulesMethodMap[M]['result']

/** Which modules a Studio's kernel holds, and how each stands. Null before it has loaded. */
export type ModuleLifecycleView = {
  manifests(): readonly CapabilityManifest[]
  enabled(moduleId: string): boolean
  running(moduleId: string): boolean
  /** Why a module the kernel holds may not run (its trust, its host API, its dependencies). */
  ineligible(moduleId: string): ModuleResolutionErrorCode | undefined
  /** Why a module failed to load. */
  loadError(moduleId: string): string | undefined
  declaredMethods(moduleId: string): readonly StudioModuleDeclaredMethod[]
}

export type ModuleLifecycleDeps = {
  /** The data folder: enablement, trust grants and plugin receipts. */
  dataDir: string
  /** Where installed extensions live. */
  moduleRoot: () => string
  view: () => ModuleLifecycleView | null
  /** Apply these overrides to the running kernel; written first. */
  applyEnablement: (overrides: Record<string, boolean>) => Promise<{ ok: true } | { ok: false; message: string }>
  /** What is installed or trusted changed: tell the windows. */
  changed: () => void
  /** What this server run's kernel loaded of the extensions' main halves, and their tools. */
  launchSession: () => ThirdPartyLaunchSession
  /** The registry a window resolved, kept for the agents' `module.*` tools. */
  registry: Pick<ModuleRegistryMirror, 'write'>
}

export type ModuleLifecycle = {
  list(): StudioModuleSummary[]
  setEnabled(moduleId: string, enabled: boolean | null): Promise<Answer<'extension.setEnabled'>>
  install(path: string): Promise<Answer<'extension.install'>>
  setTrust(moduleId: string, trusted: boolean): Promise<Answer<'extension.setTrust'>>
  uninstall(moduleId: string): Promise<Answer<'extension.uninstall'>>
  installed(): Promise<ThirdPartyModuleListResult>
  rendererEntries(): Promise<ThirdPartyRendererEntriesResult>
  setAppState(state: Record<string, Record<string, unknown>>): void
  reportRegistry(snapshot: unknown): ModuleRegistrySnapshotWriteResult
}

const INELIGIBLE_WORDS: Record<ModuleResolutionErrorCode, string> = {
  duplicate_id: 'Another module has the same id.',
  missing_dependency: 'A module it needs is not installed.',
  disabled_dependency: 'A module it needs is switched off.',
  conflict: 'It conflicts with a module that is switched on.',
  dependency_cycle: 'Its dependencies depend on it.',
  untrusted: 'It waits to be trusted.',
  invalid_signature: 'Its signature or its files do not match, so it will not run.',
}

/** Every module a kernel holds, as `extension.list` answers it. */
export function summarizeModules(view: ModuleLifecycleView): StudioModuleSummary[] {
  return view.manifests().map((manifest) => summarize(view, manifest))
}

function summarize(view: ModuleLifecycleView, manifest: CapabilityManifest): StudioModuleSummary {
  const id = manifest.id
  const enabled = view.enabled(id)
  const running = view.running(id)
  const ineligible = view.ineligible(id)
  const blocked = view.loadError(id) ?? (ineligible ? INELIGIBLE_WORDS[ineligible] : undefined)
  return {
    id,
    name: manifest.displayName?.trim() || id,
    version: manifest.version,
    source: manifest.source === 'third-party' ? 'third-party' : 'bundled',
    enabled,
    running,
    ...(enabled && !running && blocked ? { blocked } : {}),
    methods: running ? view.declaredMethods(id).map((method) => ({ name: method.name, access: method.access })) : [],
  }
}

export function createModuleLifecycle(deps: ModuleLifecycleDeps): ModuleLifecycle {
  let queue: Promise<unknown> = Promise.resolve()
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }
  const trustContext = () => readModuleTrustContextSync(deps.dataDir)
  const installed = async (moduleId: string) =>
    (await discoverUserModules(deps.moduleRoot(), trustContext())).modules.find((module) => module.key === moduleId)
  const failed = (error: unknown) => ({
    ok: false as const,
    message: error instanceof Error ? error.message : String(error),
  })

  // Built when first asked: the secret it keeps is written on first use.
  let assetOrigin: ((moduleId: string) => string) | undefined
  const assetOriginOf = (moduleId: string) => (assetOrigin ??= createModuleAssetOriginResolver(deps.dataDir))(moduleId)

  return {
    list() {
      const view = deps.view()
      return view ? summarizeModules(view) : []
    },

    async installed() {
      const { modules, rejected } = await discoverUserModules(deps.moduleRoot(), trustContext())
      const session = deps.launchSession()
      const overrides = readModuleOverridesSync(deps.dataDir)
      return {
        modules: modules.map((module) =>
          toThirdPartyModuleView(module, session.snapshot, overrides, {
            mcpTools: session.mcpTools.get(module.key) ?? [],
          }),
        ),
        rejected,
      }
    },

    async rendererEntries() {
      const { modules } = await discoverUserModules(deps.moduleRoot(), trustContext())
      return collectThirdPartyRendererEntries(modules, assetOriginOf)
    },

    setAppState(state) {
      moduleAppStateMirrorFor(deps.dataDir).set(state)
    },

    reportRegistry: (snapshot) => deps.registry.write(snapshot),

    setEnabled: (moduleId, enabled) =>
      oneAtATime(async () => {
        if (!isModuleIdSegment(moduleId)) return { ok: false, message: 'That is not a module id.' }
        const overrides = { ...readModuleOverridesSync(deps.dataDir) }
        if (enabled === null) delete overrides[moduleId]
        else overrides[moduleId] = enabled
        const written = await writeModuleOverrides(deps.dataDir, overrides)
        if (!written.ok) return { ok: false, message: written.message ?? 'The choice could not be saved.' }
        // Kept for the next start even when applying it now fails.
        const applied = await deps.applyEnablement(overrides).catch(failed)
        if (!applied.ok) return { ok: false, message: applied.message }
        const view = deps.view()
        const manifest = view?.manifests().find((candidate) => candidate.id === moduleId)
        return { ok: true, module: view && manifest ? summarize(view, manifest) : null }
      }),

    install: (path) =>
      oneAtATime(async () => {
        try {
          const result = await installModuleFolder(path, deps.moduleRoot(), trustContext())
          if (!result.ok)
            return {
              ok: false as const,
              message: result.message,
              ...(result.rejected.issues.length > 0 ? { issues: result.rejected.issues } : {}),
            }
          deps.changed()
          return {
            ok: true as const,
            moduleId: result.id,
            trust: result.trust.status,
            strippedLinks: result.strippedLinks,
          }
        } catch (error) {
          return failed(error)
        }
      }),

    setTrust: (moduleId, trusted) =>
      oneAtATime(async () => {
        try {
          if (!isModuleIdSegment(moduleId)) return { ok: false, message: 'That is not a module id.' }
          if (!trusted) {
            const { result } = await setModuleTrust(deps.dataDir, moduleId, null)
            if (!result.ok) return { ok: false, message: result.message ?? 'Trust could not be withdrawn.' }
            deps.changed()
            return { ok: true }
          }
          // Trust binds to what is on disk now, never to a client's idea of it.
          const target = await installed(moduleId)
          if (!target) return { ok: false, message: `Extension "${moduleId}" is not installed.` }
          if (target.trust.status === 'invalid')
            return {
              ok: false,
              message: target.trust.tampered
                ? `Extension "${moduleId}" does not match the file digests extension.sig signs and cannot be trusted.`
                : `Extension "${moduleId}" has an invalid signature and cannot be trusted.`,
            }
          // The grant binds to the content of the folder as it is now: every
          // file, extension.json included. A folder whose files cannot all be
          // digested (a symbolic link put there since) cannot be vouched for.
          const content = target.trust.contentFingerprint
          if (content === undefined)
            return {
              ok: false,
              message: `Extension "${moduleId}" holds files an extension cannot ship, so trusting it could not cover what runs. Install it again.`,
            }
          const { result } = await setModuleTrust(deps.dataDir, moduleId, content)
          if (!result.ok) return { ok: false, message: result.message ?? 'Trust could not be saved.' }
          deps.changed()
          return { ok: true }
        } catch (error) {
          return failed(error)
        }
      }),

    uninstall: (moduleId) =>
      oneAtATime(async () => {
        try {
          if (!isModuleIdSegment(moduleId)) return { ok: false, message: 'That is not a module id.' }
          const target = await installed(moduleId)
          if (!target) return { ok: false, message: `Extension "${moduleId}" is not installed.` }
          const contained = await containedModuleFolder(deps.moduleRoot(), target.moduleRoot)
          if (!contained.ok) return { ok: false, message: contained.message }
          await rm(contained.path, { recursive: true, force: true })
          // Nothing about it outlives it: trust, enablement, stored secrets.
          const { result: revoked } = await setModuleTrust(deps.dataDir, moduleId, null)
          await forgetModules(deps.dataDir, [moduleId])
          deps.changed()
          if (!revoked.ok)
            return {
              ok: false,
              message: `Removed "${moduleId}" but could not withdraw its trust: ${revoked.message ?? 'unknown error'}`,
            }
          return { ok: true, removedModuleIds: [moduleId] }
        } catch (error) {
          return failed(error)
        }
      }),
  }
}

// The folder an uninstall may remove: a real directory (not a link to one)
// whose parent is the module root itself, both taken through realpath so a
// symlinked root or folder cannot move the target somewhere else.
async function containedModuleFolder(
  moduleRoot: string,
  folder: string,
): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const refused = {
    ok: false as const,
    message: 'That extension’s folder is not inside the extensions folder, so it was left alone.',
  }
  try {
    const info = await lstat(folder)
    if (!info.isDirectory() || info.isSymbolicLink()) return refused
    const [root, real] = await Promise.all([realpath(moduleRoot), realpath(folder)])
    if (dirname(real) !== root || basename(real) === '') return refused
    return { ok: true, path: real }
  } catch {
    return refused
  }
}
