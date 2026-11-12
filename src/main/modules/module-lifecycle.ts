import { lstat, realpath, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

import type {
  StudioModuleDeclaredMethod,
  StudioModulesMethodMap,
  StudioModuleSummary,
} from '../../../packages/studio-protocol/src/public'
import {
  LIVE_ENABLED_MODULE_IDS,
  type CapabilityManifest,
  type ModuleResolutionErrorCode,
} from '../../shared/modules/manifest'
import { readModuleOverridesSync, writeModuleOverrides } from '../module-host/enablement-store'
import {
  defaultMarketplacePluginInstallStorePath,
  readMarketplacePluginInstallReceipts,
} from '../marketplace/plugin-lifecycle'
import { forgetModules, isModuleIdSegment } from './forget-modules'
import { manifestFingerprint } from './module-signature'
import { readModuleTrustContextSync } from './trust-context'
import { setModuleTrust } from './trust-store'
import { discoverUserModules, installModuleFolder } from './user-module-registry'

// What runs on a Studio, changed through its server (`module.setEnabled`,
// `module.install`, `module.setTrust`, `module.uninstall`) and read
// (`module.list`): the same steps in process and out of process, over the
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
// - A module a marketplace or GitHub install put in place belongs to that
//   plugin: uninstalling it here is refused with the plugin's id, and the
//   plugin's own uninstall removes it with the rest of its bundle.
//
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
}

export type ModuleLifecycle = {
  list(): StudioModuleSummary[]
  setEnabled(moduleId: string, enabled: boolean | null): Promise<Answer<'module.setEnabled'>>
  install(path: string): Promise<Answer<'module.install'>>
  setTrust(moduleId: string, trusted: boolean): Promise<Answer<'module.setTrust'>>
  uninstall(moduleId: string): Promise<Answer<'module.uninstall'>>
}

const INELIGIBLE_WORDS: Record<ModuleResolutionErrorCode, string> = {
  duplicate_id: 'Another module has the same id.',
  missing_dependency: 'A module it needs is not installed.',
  disabled_dependency: 'A module it needs is switched off.',
  conflict: 'It conflicts with a module that is switched on.',
  dependency_cycle: 'Its dependencies depend on it.',
  untrusted: 'It waits to be trusted.',
  invalid_signature: 'Its signature or its files do not match, so it will not run.',
  incompatible_host_api: 'It was built for a host API this Studio does not provide.',
}

/** Every module a kernel holds, as `module.list` answers it. */
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
    (await discoverUserModules(deps.moduleRoot(), trustContext())).modules.find(
      (module) => module.manifest.id === moduleId,
    )
  const failed = (error: unknown) => ({
    ok: false as const,
    message: error instanceof Error ? error.message : String(error),
  })

  return {
    list() {
      const view = deps.view()
      return view ? summarizeModules(view) : []
    },

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
          return { ok: true as const, moduleId: result.id, trust: result.trust.status }
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
          if (!target) return { ok: false, message: `Module "${moduleId}" is not installed.` }
          if (target.trust.status === 'invalid')
            return {
              ok: false,
              message: target.trust.tampered
                ? `Module "${moduleId}" does not match the file digests its manifest signs and cannot be trusted.`
                : `Module "${moduleId}" has an invalid signature and cannot be trusted.`,
            }
          // The grant binds to the manifest fingerprint, which covers the
          // `files` digests the folder was just held to; without them a grant
          // would vouch for nothing that runs.
          if (!target.manifest.files)
            return {
              ok: false,
              message:
                `Module "${moduleId}" lists no digests of its code, so trusting it could not cover what runs. ` +
                'Sign it with `sprintengine-module sign`, which records them, and install it again.',
            }
          const { result } = await setModuleTrust(deps.dataDir, moduleId, manifestFingerprint(target.manifest))
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
          const receipts = await readMarketplacePluginInstallReceipts(
            defaultMarketplacePluginInstallStorePath(deps.dataDir),
          )
          if (!receipts.ok) return { ok: false, message: receipts.message }
          const owner = receipts.receipts.find(
            (receipt) =>
              receipt.id === moduleId ||
              receipt.components.some((component) => component.kind === 'module' && component.id === moduleId),
          )
          if (owner)
            return {
              ok: false,
              message: `Module "${moduleId}" came with the plugin "${owner.id}": uninstall the plugin.`,
              pluginId: owner.id,
            }
          const target = await installed(moduleId)
          if (!target) return { ok: false, message: `Module "${moduleId}" is not installed.` }
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
    message: 'That module’s folder is not inside the modules folder, so it was left alone.',
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
