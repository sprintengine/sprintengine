import { lstat, realpath, rm } from 'node:fs/promises'
import type { StudioExtensionApproval, StudioExtensionDevFolder } from '../../../packages/studio-protocol/src/public'
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
  ExtensionSettingValueView,
} from '../../../packages/studio-protocol/src/public'
import { extensionSettingValues, settingValueProblem } from '../../../packages/extension-sdk/src/extension-manifest'
import { moduleAppStateMirrorFor } from '../module-host/module-app-state-mirror'
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
import { collectExtensionContributions, readSurfaceModules } from './extension-surface-entries'
import { noteReplacementLosers, withInstallOrder } from './extension-replacement-log'
import { readInstallRecordsSync } from '../../server/extensions/catalogue/catalogue-files'
import { formatSourceProblem } from '../../../packages/extension-sdk/src/source-modules'
import { isExtensionRunnable } from './module-signature'
import { pinExtensionFrame } from './extension-frame-grant'
import { readExtensionStandingContextSync } from './extension-standing-context'
import {
  accessGrowth,
  extensionAccess,
  readExtensionApprovalsSync,
  writeExtensionApproval,
} from './extension-approvals'
import {
  discoverUserModules,
  installModuleFolder,
  loadDevelopmentManifest,
  type InstalledModule,
} from './user-module-registry'
import { MAX_DEV_FOLDERS, readDevFoldersSync, resolveDevFolder, writeDevFolders } from './extension-dev-folders'
import { contentFileIssues } from './extension-content'
import { resolveContainedPath } from './entry-containment'
import { agentContributionIssues } from '../../server/extensions/agent-contributions/install-checks'
import { extensionDevEvents } from '../../server/extensions/dev/dev-events'
import { readFile } from 'node:fs/promises'
import { reconcileInstalledAgentContributions } from '../../server/extensions/agent-contributions/reconcile-installed'
import {
  createExtensionCatalogue,
  type ExtensionCatalogue,
  type ExtensionCatalogueDeps,
} from '../../server/extensions/catalogue/extension-catalogue'

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
  /**
   * An extension is about to leave for good: uninstalled, or its version
   * killed. What it opened that outlives a switch-off (its terminals) closes.
   */
  removing?: (moduleId: string, why: 'uninstalled' | 'killed') => void
  /** Where installed extensions live. */
  moduleRoot: () => string
  view: () => ModuleLifecycleView | null
  /** Apply these overrides to the running kernel; written first. */
  applyEnablement: (overrides: Record<string, boolean>) => Promise<{ ok: true } | { ok: false; message: string }>
  /** What is installed or approved changed: tell the windows. */
  changed: () => void
  /** An extension's settings values changed, here or in another process holding the same data folder. */
  settingsChanged?: (moduleId: string) => void
  /** What this server run did with its extensions: their workers and their tools. */
  run: () => ExtensionRunView
  /** The registry a window resolved, kept for the agents' `module.*` tools. */
  registry: Pick<ModuleRegistryMirror, 'write'>
  /** Ids an extension's provider may not take: Studio's own providers' and agent CLIs'. */
  protectedProviderIds?: () => ReadonlySet<string>
  /** Something worth a line in the log. */
  warn?: (message: string) => void
  /** The catalogue's own seams and its notices (catalogue/extension-catalogue.ts). */
  catalogue?: Omit<ExtensionCatalogueDeps, 'dataDir' | 'installChecked' | 'installed' | 'killListChanged' | 'warn'>
}

export type ModuleLifecycle = {
  /** Browsing, installing from a catalogue or a git URL, updates and the kill list. */
  readonly catalogue: ExtensionCatalogue
  list(): StudioModuleSummary[]
  setEnabled(moduleId: string, enabled: boolean | null): Promise<Answer<'extension.setEnabled'>>
  install(path: string): Promise<Answer<'extension.install'>>
  approve(moduleId: string, fingerprint: string): Promise<Answer<'extension.approve'>>
  uninstall(moduleId: string): Promise<Answer<'extension.uninstall'>>
  installed(): Promise<ThirdPartyModuleListResult>
  contributions(): Promise<ExtensionContributionsResult>
  /** One piece of what an extension adds, checked, or why it is not served here. */
  content(request: StudioExtensionContentRequest): Promise<ContentAnswer>
  /** The values of an extension's declared settings, or why there are none here. */
  settings(
    moduleId: string,
  ): Promise<{ ok: true; values: Record<string, ExtensionSettingValueView> } | { ok: false; message: string }>
  setSetting(
    moduleId: string,
    key: string,
    value: ExtensionSettingValueView | null,
  ): Promise<Answer<'extension.setSetting'>>
  /** One surface's frame document, or why it is not drawn here. */
  frame(
    request: StudioExtensionFrameRequest,
  ): Promise<{ ok: true; hash: string; html: string } | { ok: false; message: string }>
  reportRegistry(snapshot: unknown): ModuleRegistrySnapshotWriteResult
  /** The development folders registered here, in their order, each with the extension it holds or why none. */
  devFolders(): Promise<StudioExtensionDevFolder[]>
  /**
   * Register a development folder (or read one already registered again).
   * Nothing here approves it: the person does, in Studio's window
   * (`approve`), and an agent may register one.
   */
  devLoad(path: string): Promise<DevLoadAnswer>
  /** Take a development folder out, by its path or its extension's key: only takes access away. */
  devUnload(target: { path: string } | { moduleId: string }): Promise<DevUnloadAnswer>
  /**
   * Project what the extensions hand agents again, from the folder as it is
   * now: for a change made outside these calls (the drop-in folder's watcher
   * hears one), so an extension rewritten, removed or copied in by hand is
   * retracted or handed out at once. `modules`: what the caller discovered
   * for this change already, so one change is discovered once.
   */
  reproject(modules?: readonly InstalledModule[]): Promise<void>
  /**
   * An install from outside the window waits for the person: their window
   * asks them now (`reviewAsked`), while it waits. Nothing here approves it.
   */
  askReview(moduleId: string): void
}

/** `extension.devLoad`'s answer: the key it loads under, and how its approval stands. */
export type DevLoadAnswer =
  | {
      ok: true
      moduleId: string
      path: string
      /** False when the folder was registered already, and this read it again. */
      added: boolean
      approval: StudioExtensionApproval
    }
  | {
      ok: false
      code: 'invalid_argument' | 'extension_invalid' | 'unavailable'
      message: string
      issues?: Array<{ path: string; message: string }>
    }

export type DevUnloadAnswer =
  | { ok: true; path: string; moduleId: string | null }
  | { ok: false; code: 'not_found' | 'unavailable'; message: string; loaded?: string[] }

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
  if (deps.settingsChanged) {
    const heard = deps.settingsChanged
    moduleAppStateMirrorFor(deps.dataDir).subscribeAll((moduleId) => heard(moduleId))
  }
  const installed = async (moduleId: string) =>
    (await discoverUserModules(deps.moduleRoot(), standingContext())).modules.find((module) => module.key === moduleId)
  // The installed extensions alone, as if no development folder were
  // registered: what an install updates and an uninstall removes.
  const installedOnly = async () =>
    (await discoverUserModules(deps.moduleRoot(), { ...standingContext(), devFolders: [] })).modules
  // What an install checks of a folder's content and of what it hands agents,
  // checked of a development folder when it is registered and when it is read again.
  const developmentIssues = async (
    folder: string,
    extension: Parameters<typeof contentFileIssues>[0] & Parameters<typeof agentContributionIssues>[0],
  ) => [
    ...(await contentFileIssues(extension, async (path, maxBytes) => {
      try {
        const file = resolveContainedPath(folder, path, path)
        const info = await lstat(file)
        if (!info.isFile() || info.size > maxBytes) return null
        return await readFile(file, 'utf8')
      } catch {
        return null
      }
    })),
    ...(await agentContributionIssues(extension, folder, deps.protectedProviderIds?.())),
  ]
  const failed = (error: unknown) => ({
    ok: false as const,
    message: error instanceof Error ? error.message : String(error),
  })
  // What the extensions hand agents and chats (their skills, MCP servers and
  // providers) follows every change here, and is put right at every start:
  // a projection a crash interrupted is finished or undone before anything
  // reads it (agent-contributions/projection.ts).
  const project = async (modules?: readonly InstalledModule[]): Promise<void> => {
    try {
      await reconcileInstalledAgentContributions({
        dataDir: deps.dataDir,
        moduleRoot: deps.moduleRoot(),
        ...(modules ? { modules } : {}),
        ...(deps.protectedProviderIds ? { protectedProviderIds: deps.protectedProviderIds } : {}),
        ...(deps.warn ? { warn: deps.warn } : {}),
      })
    } catch (error) {
      deps.warn?.(`What extensions hand agents could not be projected: ${failed(error).message}`)
    }
  }
  void oneAtATime(() => project())
  // Studio's own folders, which no development folder may be inside.
  const refusedRoots = () => [deps.moduleRoot(), deps.dataDir]
  // Every development folder discovered now: those running, and those waiting
  // to stand in for an installed extension with their key.
  const developmentModules = (result: { modules: InstalledModule[]; waiting?: InstalledModule[] }) => [
    ...result.modules.filter((module) => module.development),
    ...(result.waiting ?? []),
  ]

  // Install the extension in a folder: a folder the person picked (`local`),
  // or one the catalogue checked out (its publisher, the repository's owner).
  const installFolder = async (
    path: string,
    {
      before: checkFirst,
      ...options
    }: {
      publisher?: string
      official?: boolean
      /** Run first, in the queue with the copy (the catalogue's check and record); an answer refuses. */
      before?: () => Promise<Answer<'extension.install'> | null>
    } = {},
  ): Promise<Answer<'extension.install'>> => {
    try {
      const stop = await checkFirst?.()
      if (stop) return stop
      const context = standingContext()
      // Read before the copy replaces it: the version an update replaces,
      // and whether the person approved it as it is.
      const before = await installedOnly()
      const result = await installModuleFolder(path, deps.moduleRoot(), context, {
        ...(deps.protectedProviderIds ? { protectedProviderIds: deps.protectedProviderIds() } : {}),
        ...options,
      })
      if (!result.ok)
        return {
          ok: false as const,
          message: result.message,
          ...(result.rejected.issues.length > 0 ? { issues: result.rejected.issues } : {}),
        }
      let approval = approvalView(result.standing.approval)
      const previous = before.find((module) => module.key === result.id)
      const record = readExtensionApprovalsSync(deps.dataDir).get(result.id)
      // An update of an approved extension that asks for no more access
      // keeps its approval, its new code included: trust once per access.
      if (
        result.standing.approval.state === 'pending' &&
        previous?.standing.approval.state === 'approved' &&
        record &&
        record.devFolder === undefined &&
        accessGrowth(record.access, extensionAccess(result.extension, result.standing.verifiedFiles)).length === 0
      ) {
        const carried = await writeExtensionApproval(deps.dataDir, result.id, {
          fingerprint: result.standing.approval.fingerprint,
          access: extensionAccess(result.extension, result.standing.verifiedFiles),
        })
        if (carried.ok) approval = { state: 'approved', fingerprint: result.standing.approval.fingerprint }
      }
      // A release of Studio's official catalogue installs without asking, and
      // so does its update that asks for more (owner ruling): the catalogue
      // checked it was the release it lists, its bytes, its owner and the
      // kill list before it came here. The approval is written for exactly
      // the fingerprint installed, so any other bytes under the key ask as
      // ever. Added and community catalogues, git URLs and folders never get
      // this (`official` is set by the catalogue for its official one only).
      else if (
        options.official === true &&
        result.standing.approval.state === 'pending' &&
        result.standing.killed === undefined
      ) {
        const granted = await writeExtensionApproval(deps.dataDir, result.id, {
          fingerprint: result.standing.approval.fingerprint,
          access: extensionAccess(result.extension, result.standing.verifiedFiles),
        })
        if (granted.ok) approval = { state: 'approved', fingerprint: result.standing.approval.fingerprint }
      }
      await project()
      deps.changed()
      return { ok: true as const, moduleId: result.id, approval, strippedLinks: result.strippedLinks }
    } catch (error) {
      return failed(error)
    }
  }
  const catalogue = createExtensionCatalogue({
    ...deps.catalogue,
    dataDir: deps.dataDir,
    ...(deps.warn ? { warn: deps.warn } : {}),
    installChecked: (dir, options) => oneAtATime(() => installFolder(dir, options)),
    installed: async () => {
      const { modules, waiting = [] } = await discoverUserModules(deps.moduleRoot(), standingContext())
      const overrides = readModuleOverridesSync(deps.dataDir)
      return [...modules, ...waiting].map((module) => ({
        key: module.key,
        manifest: module.extension,
        approval: module.standing.approval.state,
        development: module.development !== undefined,
        killed: module.standing.killed !== undefined,
        // An installed extension is on unless the person switched it off.
        enabled: overrides[module.key] !== false,
      }))
    },
    // A killed version stops, and what it handed agents is taken back.
    killListChanged: async () => {
      await oneAtATime(async () => {
        if (deps.removing) {
          const { modules, waiting = [] } = await discoverUserModules(deps.moduleRoot(), standingContext())
          for (const module of [...modules, ...waiting]) if (module.standing.killed) deps.removing(module.key, 'killed')
        }
        await project()
      })
      deps.changed()
    },
  })

  // Installs from outside the window that wait for the person, for this run:
  // a restart leaves them waiting in Settings, as a dismissed question does.
  const reviewAsked = new Set<string>()

  return {
    catalogue,

    askReview(moduleId) {
      reviewAsked.add(moduleId)
      deps.changed()
    },

    list() {
      const view = deps.view()
      return view ? summarizeModules(view) : []
    },

    async installed() {
      const { modules, rejected, waiting = [] } = await discoverUserModules(deps.moduleRoot(), standingContext())
      const run = deps.run()
      const overrides = readModuleOverridesSync(deps.dataDir)
      return {
        // A folder waiting to stand in for an installed one is listed beside
        // it, for the person to review; the installed one is what runs.
        modules: catalogue
          .annotate([...modules, ...waiting].map((module) => toThirdPartyModuleView(module, run, overrides)))
          .map((view) =>
            view.approval.state === 'pending' && reviewAsked.has(view.manifest.id)
              ? { ...view, reviewAsked: true as const }
              : view,
          ),
        rejected,
      }
    },

    async contributions() {
      const { modules } = await discoverUserModules(deps.moduleRoot(), standingContext())
      // When each was installed, so a window lets the first of two that
      // replace one Studio action take it over; the other hears so in its log.
      const result = withInstallOrder(
        collectExtensionContributions(modules),
        modules,
        readInstallRecordsSync(deps.dataDir),
      )
      noteReplacementLosers(result.extensions)
      return result
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

    async settings(moduleId) {
      const target = await installed(moduleId)
      if (!target) return { ok: false, message: `Extension "${moduleId}" is not installed.` }
      return { ok: true, values: declaredSettingValues(target.extension.contributes.settings, deps.dataDir, moduleId) }
    },

    setSetting: (moduleId, key, value) =>
      oneAtATime(async () => {
        const target = await installed(moduleId)
        if (!target) return { ok: false, message: `Extension "${moduleId}" is not installed.` }
        const declared = target.extension.contributes.settings
        const setting = declared.find((candidate) => candidate.key === key)
        if (!setting) return { ok: false, message: `Extension "${moduleId}" declares no setting "${key}".` }
        if (value !== null) {
          const problem = settingValueProblem(setting, value)
          if (problem) return { ok: false, message: `${setting.title} ${problem}` }
        }
        // The store the extension's own code reads (`settings.get`,
        // `getModuleAppState`); `null` removes the value, so its default is read.
        moduleAppStateMirrorFor(deps.dataDir).setValue(moduleId, key, value === null ? undefined : value)
        return { ok: true, values: declaredSettingValues(declared, deps.dataDir, moduleId) }
      }),

    async frame({ moduleId, point, id, theme }) {
      const unavailable = {
        ok: false as const,
        message: `Extension "${moduleId}" is not available here: it is not installed, not approved as it is now, or switched off.`,
      }
      const target = await installed(moduleId)
      if (!target || !isExtensionRunnable(target.standing)) return unavailable
      if (readModuleOverridesSync(deps.dataDir)[moduleId] === false) return unavailable
      const entry = await readSurfaceModules(target, point, id)
      // The author's own mistake (a syntax error, an import that cannot
      // load) is drawn in the frame, which logs it at its file and line; a
      // development folder's next save draws it again.
      if (!entry.ok && !entry.problem) return entry
      const html = buildExtensionFrameDocument({
        surface: { point, id },
        entryPath: target.extension.contributes[point].find((surface) => surface.id === id)?.entry ?? '',
        ...(entry.ok
          ? { modules: entry.modules, token: entry.token }
          : { modules: [], token: 'se-module-none-', problem: formatSourceProblem(entry.problem!) }),
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

    reproject: (modules) => oneAtATime(() => project(modules)),

    async devFolders() {
      const folders = readDevFoldersSync(deps.dataDir)
      const discovered = await discoverUserModules(deps.moduleRoot(), standingContext())
      const { rejected } = discovered
      const modules = developmentModules(discovered)
      return folders.map((path) => {
        const module = modules.find((candidate) => candidate.moduleRoot === path)
        if (module)
          return {
            path,
            moduleId: module.key,
            name: module.extension.name,
            approval: approvalView(module.standing.approval),
            overrides: module.development?.overrides === true,
            ...(module.development?.waiting ? { waiting: true } : {}),
          }
        const rejection = rejected.find(
          (entry) => entry.path === path || entry.path.startsWith(`${path}/`) || entry.path.startsWith(`${path}\\`),
        )
        return {
          path,
          error:
            rejection?.issues.map((issue) => `${issue.path ? `${issue.path}: ` : ''}${issue.message}`).join('; ') ??
            'It holds no extension Studio can read.',
        }
      })
    },

    devLoad: (path) =>
      oneAtATime(async (): Promise<DevLoadAnswer> => {
        try {
          const resolved = resolveDevFolder(path, refusedRoots())
          if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message }
          const folder = resolved.path
          // A registration under the name given that now leads elsewhere is
          // replaced by where it leads, which asks for approval again.
          const registered = readDevFoldersSync(deps.dataDir)
          const folders = registered.filter((entry) => entry === folder || entry !== path)
          const added = !folders.includes(folder)
          if (added && folders.length >= MAX_DEV_FOLDERS)
            return {
              ok: false,
              code: 'invalid_argument',
              message: `Studio holds at most ${MAX_DEV_FOLDERS} development folders; remove one first.`,
            }
          // Read before it is registered, so a folder that holds no extension is not kept.
          const loaded = loadDevelopmentManifest(folder)
          if (!loaded.ok)
            return {
              ok: false,
              code: 'extension_invalid',
              message: `${folder} holds no extension Studio can load.`,
              issues: loaded.rejection.issues,
            }
          const issues = await developmentIssues(folder, loaded.extension)
          if (issues.length > 0)
            return { ok: false, code: 'extension_invalid', message: `${issues[0]!.path} ${issues[0]!.message}`, issues }
          if (added || folders.length !== registered.length)
            await writeDevFolders(deps.dataDir, added ? [...folders, folder] : folders)
          const module = developmentModules(await discoverUserModules(deps.moduleRoot(), standingContext())).find(
            (candidate) => candidate.moduleRoot === folder,
          )
          if (!module) {
            // Another folder holds its key: say so, and leave this one out.
            if (added) await writeDevFolders(deps.dataDir, registered)
            const { rejected } = await discoverUserModules(deps.moduleRoot(), {
              ...standingContext(),
              devFolders: [...folders, folder],
            })
            const rejection = rejected.find((entry) => entry.path.startsWith(folder))
            return {
              ok: false,
              code: 'extension_invalid',
              message: rejection?.issues[0]?.message ?? `${folder} holds no extension Studio can load.`,
              ...(rejection ? { issues: rejection.issues } : {}),
            }
          }
          if (added)
            extensionDevEvents.add({ key: module.key, kind: 'loaded', message: `Development folder ${folder} loaded.` })
          await project()
          deps.changed()
          return {
            ok: true,
            moduleId: module.key,
            path: folder,
            added,
            approval: approvalView(module.standing.approval),
          }
        } catch (error) {
          return { ok: false, code: 'unavailable', message: failed(error).message }
        }
      }),

    devUnload: (target) =>
      oneAtATime(async (): Promise<DevUnloadAnswer> => {
        try {
          const folders = readDevFoldersSync(deps.dataDir)
          const modules = developmentModules(await discoverUserModules(deps.moduleRoot(), standingContext()))
          let folder: string | undefined
          if ('moduleId' in target) {
            folder = modules.find((module) => module.key === target.moduleId)?.moduleRoot
          } else {
            const resolved = resolveDevFolder(target.path)
            const candidate = resolved.ok ? resolved.path : target.path
            folder = folders.find((entry) => entry === candidate || entry === target.path)
          }
          if (!folder || !folders.includes(folder))
            return {
              ok: false,
              code: 'not_found',
              message: 'That is not a development folder registered here.',
              loaded: folders,
            }
          const moduleId = modules.find((module) => module.moduleRoot === folder)?.key ?? null
          await writeDevFolders(
            deps.dataDir,
            folders.filter((entry) => entry !== folder),
          )
          // Its approval is for that folder alone: it goes with it, under
          // every key it was given (its id may have changed since, or its
          // extension.json may not read now).
          const revoked: string[] = []
          const held = new Set(moduleId ? [moduleId] : [])
          for (const [key, record] of readExtensionApprovalsSync(deps.dataDir)) {
            if (record.devFolder !== folder) continue
            held.add(key)
            const written = await writeExtensionApproval(deps.dataDir, key, null)
            if (!written.ok) revoked.push(`${key}: ${written.message}`)
          }
          // And everything kept for it, as an uninstall forgets (its
          // Settings values, secrets, storage, provider keys and switch), so
          // a later folder or install under its key starts with none of it.
          // Not under a key an installed extension holds: a folder standing
          // in for it shared its data, which stays the installed one's.
          const installedKeys = new Set((await installedOnly()).map((module) => module.key))
          const unforgotten = await forgetModules(
            deps.dataDir,
            [...held].filter((key) => !installedKeys.has(key)),
          )
          if (moduleId)
            extensionDevEvents.add({
              key: moduleId,
              kind: 'unloaded',
              message: `Development folder ${folder} removed.`,
            })
          await project()
          deps.changed()
          if (revoked.length > 0)
            return {
              ok: false,
              code: 'unavailable',
              message: `Removed ${folder}, but could not forget its approval (${revoked.join('; ')}).`,
            }
          if (unforgotten.length > 0)
            return {
              ok: false,
              code: 'unavailable',
              message: `Removed ${folder}, but could not forget ${unforgotten.join('; ')}.`,
            }
          return { ok: true, path: folder, moduleId }
        } catch (error) {
          return { ok: false, code: 'unavailable', message: failed(error).message }
        }
      }),

    setEnabled: (moduleId, enabled) =>
      oneAtATime(async () => {
        if (!isModuleIdSegment(moduleId)) return { ok: false, message: 'That is not a module id.' }
        const overrides = { ...readModuleOverridesSync(deps.dataDir) }
        if (enabled === null) delete overrides[moduleId]
        else overrides[moduleId] = enabled
        const written = await writeModuleOverrides(deps.dataDir, overrides)
        if (!written.ok) return { ok: false, message: written.message ?? 'The choice could not be saved.' }
        await project()
        // Kept for the next start even when applying it now fails.
        const applied = await deps.applyEnablement(overrides).catch(failed)
        if (!applied.ok) return { ok: false, message: applied.message }
        const view = deps.view()
        const manifest = view?.manifests().find((candidate) => candidate.id === moduleId)
        return { ok: true, module: view && manifest ? summarize(view, manifest) : null }
      }),

    install: (path) => oneAtATime(() => installFolder(path)),

    approve: (moduleId, fingerprint) =>
      oneAtATime(async () => {
        try {
          if (!isModuleIdSegment(moduleId)) return { ok: false, message: 'That is not a module id.' }
          // The approval binds to what is on disk now, and only when that is
          // what the person was shown: the fingerprint they approved. A
          // development folder waiting to stand in for the installed one
          // under this key is told apart by its fingerprint.
          const discovered = await discoverUserModules(deps.moduleRoot(), standingContext())
          const candidates = [...discovered.modules, ...(discovered.waiting ?? [])].filter(
            (module) => module.key === moduleId,
          )
          const target =
            candidates.find(
              (module) =>
                module.standing.approval.state === 'pending' && module.standing.approval.fingerprint === fingerprint,
            ) ?? candidates[0]
          if (!target) return { ok: false, message: `Extension "${moduleId}" is not installed.` }
          const { standing } = target
          if (standing.killed)
            return {
              ok: false,
              message: `Studio’s kill list removed this version of "${moduleId}": ${standing.killed.reason}`,
            }
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
          const written = await writeExtensionApproval(deps.dataDir, moduleId, approvalRecordFor(target, fingerprint))
          if (!written.ok) return { ok: false, message: written.message }
          await project()
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
          const target = (await installedOnly()).find((module) => module.key === moduleId)
          if (!target)
            return {
              ok: false,
              message: readDevFoldersSync(deps.dataDir).length
                ? `Extension "${moduleId}" is not installed. A development folder is taken out with Remove, not uninstalled.`
                : `Extension "${moduleId}" is not installed.`,
            }
          const contained = await containedModuleFolder(deps.moduleRoot(), target.moduleRoot)
          if (!contained.ok) return { ok: false, message: contained.message }
          deps.removing?.(moduleId, 'uninstalled')
          await rm(contained.path, { recursive: true, force: true })
          // Nothing about it outlives it: its approval, enablement, stored
          // secrets, and the window's question from an install outside it.
          reviewAsked.delete(moduleId)
          const revoked = await writeExtensionApproval(deps.dataDir, moduleId, null)
          const unforgotten = await forgetModules(deps.dataDir, [moduleId])
          await catalogue.forget(moduleId)
          await project()
          deps.changed()
          if (!revoked.ok)
            return {
              ok: false,
              message: `Removed "${moduleId}" but could not forget its approval: ${revoked.message}`,
            }
          if (unforgotten.length > 0)
            return { ok: false, message: `Removed "${moduleId}" but could not forget ${unforgotten.join('; ')}.` }
          return { ok: true, removedModuleIds: [moduleId] }
        } catch (error) {
          return failed(error)
        }
      }),
  }
}

/** Each declared setting's value: the one stored here when it still fits, else its default. */
function declaredSettingValues(
  declared: ReadonlyArray<Parameters<typeof settingValueProblem>[0]>,
  dataDir: string,
  moduleId: string,
): Record<string, ExtensionSettingValueView> {
  // The rule the extension's own code reads by too (extension-declared-settings.ts).
  return extensionSettingValues(declared, moduleAppStateMirrorFor(dataDir).get(moduleId))
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

/** What approving an extension as it is now records: for a development folder, bound to that folder. */
function approvalRecordFor(
  target: {
    extension: Parameters<typeof extensionAccess>[0]
    standing: { verifiedFiles?: Parameters<typeof extensionAccess>[1] }
    moduleRoot: string
    development?: object
  },
  fingerprint: string,
) {
  if (target.development)
    return { fingerprint, access: extensionAccess(target.extension, {}), devFolder: target.moduleRoot }
  return { fingerprint, access: extensionAccess(target.extension, target.standing.verifiedFiles) }
}
