import { lstat, realpath, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

import type {
  ModuleRegistrySnapshotWriteResult,
  StudioModuleDeclaredMethod,
  StudioModulesMethodMap,
  StudioModuleSummary,
  ExtensionContributionsResult,
  StudioExtensionContentRequest,
  StudioExtensionFrameRequest,
  ThirdPartyModuleListResult,
} from '../../../packages/studio-protocol/src/public'
import { readExtensionContent, type ContentAnswer } from './extension-content'
import { EXTENSION_FRAME_THEMES } from '../../shared/extension-frame-themes.generated'
import { extensionFrameDocuments } from '../../server/extensions/frames/frame-cache'
import { buildExtensionFrameDocument, extensionFrameHash } from '../../server/extensions/frames/frame-document'
import {
  LIVE_ENABLED_MODULE_IDS,
  type CapabilityManifest,
  type ModuleResolutionErrorCode,
} from '../../shared/modules/manifest'
import { readModuleOverridesSync, writeModuleOverrides } from '../module-host/enablement-store'
import { forgetModules, isModuleIdSegment } from './forget-modules'
import type { ModuleRegistryMirror } from './registry-mirror'
import { approvalView } from './extension-approval-view'
import { toThirdPartyModuleView, type ExtensionRunView } from './third-party-module-view'
import { collectExtensionContributions, readExtensionSurfaceEntry } from './extension-surface-entries'
import { isExtensionRunnable } from './module-signature'
import { pinExtensionFrame } from './extension-frame-grant'
import { readExtensionStandingContextSync } from './extension-standing-context'
import { accessGrowth, extensionAccess, writeExtensionApproval } from './extension-approvals'
import { discoverUserModules, installModuleFolder } from './user-module-registry'

// What runs on a Studio, changed through its server (`extension.setEnabled`,
// `extension.install`, `extension.approve`, `extension.uninstall`) and read
// (`extension.list`): the same steps in process and out of process, over the
// data folder and the module root the server reads at load. Nothing here
// needs Electron.
//
// - Switching a module on or off writes the person's choice to the data
//   folder, then has the running kernel apply it: at once for an installed
//   extension and the bundled modules that can (`liveModuleIds`), at the next
//   start otherwise.
// - Installing, approving and uninstalling change what is on disk and in the
//   approvals (extension-approvals.ts); the kernel reads them at its next
//   start. `changed` tells the clients, which list what the approved
//   extensions add again, and the server, which stops a worker whose
//   approval is gone or changed since it started. Installing a new version of an approved extension keeps
//   the approval when it asks for no more access; otherwise it waits.
// - Listing the installed extensions (`extension.installed`) reads the disk, the
//   approvals and the receipts now, with what this server run loaded; what
//   the approved extensions add to a client (`extension.contributions`) is read
//   per request, so an uninstall applies at once.
// - A surface's frame document (`extension.frame`) is built per request from
//   its entry, read and checked against its verified bytes then, and kept by
//   hash for the web listener to serve (server/extensions/frames).
// - The registry a window resolved (`extension.reportRegistry`) is kept in
//   memory for the agents' tools.
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
  /** Why a module the kernel holds may not run (its approval, its signature, its dependencies). */
  ineligible(moduleId: string): ModuleResolutionErrorCode | undefined
  /** Why a module failed to load. */
  loadError(moduleId: string): string | undefined
  declaredMethods(moduleId: string): readonly StudioModuleDeclaredMethod[]
}

export type ModuleLifecycleDeps = {
  /** The data folder: enablement, approvals and plugin receipts. */
  dataDir: string
  /** Where installed extensions live. */
  moduleRoot: () => string
  view: () => ModuleLifecycleView | null
  /** Apply these overrides to the running kernel; written first. */
  applyEnablement: (overrides: Record<string, boolean>) => Promise<{ ok: true } | { ok: false; message: string }>
  /** What is installed or approved changed: tell the windows. */
  changed: () => void
  /** What this server run did with its extensions: their workers and their tools. */
  run: () => ExtensionRunView
  /** The registry a window resolved, kept for the agents' `module.*` tools. */
  registry: Pick<ModuleRegistryMirror, 'write'>
}

export type ModuleLifecycle = {
  list(): StudioModuleSummary[]
  setEnabled(moduleId: string, enabled: boolean | null): Promise<Answer<'extension.setEnabled'>>
  install(path: string): Promise<Answer<'extension.install'>>
  approve(moduleId: string, fingerprint: string): Promise<Answer<'extension.approve'>>
  uninstall(moduleId: string): Promise<Answer<'extension.uninstall'>>
  installed(): Promise<ThirdPartyModuleListResult>
  contributions(): Promise<ExtensionContributionsResult>
  /** One piece of what an extension adds, checked, or why it is not served here. */
  content(request: StudioExtensionContentRequest): Promise<ContentAnswer>
  /** One surface's frame document, or why it is not drawn here. */
  frame(
    request: StudioExtensionFrameRequest,
  ): Promise<{ ok: true; hash: string; html: string } | { ok: false; message: string }>
  reportRegistry(snapshot: unknown): ModuleRegistrySnapshotWriteResult
}

const INELIGIBLE_WORDS: Record<ModuleResolutionErrorCode, string> = {
  duplicate_id: 'Another module has the same id.',
  missing_dependency: 'A module it needs is not installed.',
  disabled_dependency: 'A module it needs is switched off.',
  conflict: 'It conflicts with a module that is switched on.',
  dependency_cycle: 'Its dependencies depend on it.',
  unapproved: 'It waits for your approval.',
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
  const standingContext = () => readExtensionStandingContextSync(deps.dataDir)
  const installed = async (moduleId: string) =>
    (await discoverUserModules(deps.moduleRoot(), standingContext())).modules.find((module) => module.key === moduleId)
  const failed = (error: unknown) => ({
    ok: false as const,
    message: error instanceof Error ? error.message : String(error),
  })

  return {
    list() {
      const view = deps.view()
      return view ? summarizeModules(view) : []
    },

    async installed() {
      const { modules, rejected } = await discoverUserModules(deps.moduleRoot(), standingContext())
      const run = deps.run()
      const overrides = readModuleOverridesSync(deps.dataDir)
      return {
        modules: modules.map((module) => toThirdPartyModuleView(module, run, overrides)),
        rejected,
      }
    },

    async contributions() {
      const { modules } = await discoverUserModules(deps.moduleRoot(), standingContext())
      return collectExtensionContributions(modules)
    },

    async content(request) {
      const target = await installed(request.moduleId)
      if (!target || readModuleOverridesSync(deps.dataDir)[request.moduleId] === false)
        return {
          ok: false,
          message: `Extension "${request.moduleId}" is not available here: it is not installed, or switched off.`,
        }
      return readExtensionContent(target, request)
    },

    async frame({ moduleId, point, id, theme }) {
      const unavailable = {
        ok: false as const,
        message: `Extension "${moduleId}" is not available here: it is not installed, not approved as it is now, or switched off.`,
      }
      const target = await installed(moduleId)
      if (!target || !isExtensionRunnable(target.standing)) return unavailable
      if (readModuleOverridesSync(deps.dataDir)[moduleId] === false) return unavailable
      const entry = await readExtensionSurfaceEntry(target, point, id)
      if (!entry.ok) return entry
      const html = buildExtensionFrameDocument({
        surface: { point, id },
        entryPath: entry.entryPath,
        entryCode: entry.code,
        theme:
          theme !== undefined && Object.hasOwn(EXTENSION_FRAME_THEMES, theme) ? EXTENSION_FRAME_THEMES[theme]! : null,
      })
      const hash = extensionFrameHash(html)
      extensionFrameDocuments.put(hash, html)
      // What this document's calls may use at most: what the approval held now.
      pinExtensionFrame(hash, moduleId, standingContext().approvals.get(moduleId)?.access.permissions ?? [])
      return { ok: true, hash, html }
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
          const context = standingContext()
          // Read before the copy replaces it: the version an update replaces,
          // and whether the person approved it as it is.
          const before = (await discoverUserModules(deps.moduleRoot(), context)).modules
          const result = await installModuleFolder(path, deps.moduleRoot(), context)
          if (!result.ok)
            return {
              ok: false as const,
              message: result.message,
              ...(result.rejected.issues.length > 0 ? { issues: result.rejected.issues } : {}),
            }
          let approval = approvalView(result.standing.approval)
          const previous = before.find((module) => module.key === result.id)
          const record = context.approvals.get(result.id)
          // An update of an approved extension that asks for no more access
          // keeps its approval, its new code included: trust once per access.
          if (
            result.standing.approval.state === 'pending' &&
            previous?.standing.approval.state === 'approved' &&
            record &&
            accessGrowth(record.access, extensionAccess(result.extension)).length === 0
          ) {
            const carried = await writeExtensionApproval(deps.dataDir, result.id, {
              fingerprint: result.standing.approval.fingerprint,
              access: extensionAccess(result.extension),
            })
            if (carried.ok) approval = { state: 'approved', fingerprint: result.standing.approval.fingerprint }
          }
          deps.changed()
          return { ok: true as const, moduleId: result.id, approval, strippedLinks: result.strippedLinks }
        } catch (error) {
          return failed(error)
        }
      }),

    approve: (moduleId, fingerprint) =>
      oneAtATime(async () => {
        try {
          if (!isModuleIdSegment(moduleId)) return { ok: false, message: 'That is not a module id.' }
          // The approval binds to what is on disk now, and only when that is
          // what the person was shown: the fingerprint they approved.
          const target = await installed(moduleId)
          if (!target) return { ok: false, message: `Extension "${moduleId}" is not installed.` }
          const { standing } = target
          if (standing.signature === 'invalid')
            return {
              ok: false,
              message: standing.tampered
                ? `Extension "${moduleId}" does not match the file digests extension.sig signs and cannot be approved.`
                : `Extension "${moduleId}" has an invalid signature and cannot be approved.`,
            }
          if (standing.approval.state === 'not-needed' || standing.approval.state === 'approved') return { ok: true }
          if (standing.approval.state === 'unavailable')
            return {
              ok: false,
              message: `Extension "${moduleId}" holds files an extension cannot ship, so approving it could not cover what runs. Install it again.`,
            }
          if (standing.approval.fingerprint !== fingerprint)
            return {
              ok: false,
              message: `Extension "${moduleId}" changed since you reviewed it. Review what it asks for now, and approve that.`,
            }
          const written = await writeExtensionApproval(deps.dataDir, moduleId, {
            fingerprint,
            access: extensionAccess(target.extension),
          })
          if (!written.ok) return { ok: false, message: written.message }
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
          // Nothing about it outlives it: its approval, enablement, stored secrets.
          const revoked = await writeExtensionApproval(deps.dataDir, moduleId, null)
          await forgetModules(deps.dataDir, [moduleId])
          deps.changed()
          if (!revoked.ok)
            return {
              ok: false,
              message: `Removed "${moduleId}" but could not forget its approval: ${revoked.message}`,
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
