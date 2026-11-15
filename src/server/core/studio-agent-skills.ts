import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type {
  CardRunInput,
  CardRunResult,
  DesignSystemAttachSource,
  McpServerConfig,
  SkillSourceUpdateCheck,
} from '../../../packages/studio-protocol/src/public'
import { createAgentSkillInstaller, type AgentSkillInstaller } from '../../main/agent-skill-installer'
import { createCapabilityWatcher } from '../../main/capability-watcher'
import { runCard, type CardRunDeps } from '../../main/cards/run-card'
import { detectCli } from '../../main/cli-runtime-install'
import { listDesignSystemArrivals } from '../../main/design-system/arrivals'
import { attachDesignSystemBundle, detachDesignSystemBundle } from '../../main/design-system/attach'
import { runDesignSystemBundleLint } from '../../main/design-system/bundle-lint-run'
import { readDesignSystemBundle } from '../../main/design-system/bundle-read'
import { seedDesignSystemBundle } from '../../main/design-system/bundle-scaffold'
import { runBundleScriptInChildProcess } from '../../main/design-system/bundle-script-process'
import {
  defaultDesignSystemLibraryRoot,
  defaultDesignSystemRegistryPath,
  forgetDesignSystemFolder,
  listDesignSystemLibrary,
  registerDesignSystemFolder,
  type LibraryPaths,
} from '../../main/design-system/library-registry'
import { resolveDesignSystemTemplatesDir } from '../../main/design-system/templates-path'
import { cloneRepository } from '../../main/git-clone'
import { githubRepoFromRemote } from '../../main/git-github'
import { createGitTransportProbe } from '../../main/git-transport-probe'
import { runGit } from '../../main/git-utils'
import { sharedGhRunner } from '../../main/github/gh'
import { createGhHostTokenResolver } from '../../main/github/host-token'
import { GitHubTokenStore } from '../../main/github-token-store'
import { createInstalledSkillsService } from '../../main/installed-skills-service'
import { createMcpServerResolver } from '../../main/mcp-config-readers/resolve-servers'
import type { McpConfigService } from '../../main/mcp-config-service'
import { getPluginManifest, listPluginRegistryEntries } from '../../main/plugin-registry-instance'
import { createSkillsService, type SkillsService } from '../../main/skills'
import { sweepGitRepoCache } from '../../main/skills/git-repo-reader'
import { STUDIO_MARKETPLACE_RESOURCE_DIR } from '../../main/skills/studio-plugin'
import { installedSkillCopies } from '../../main/skills/sync'
import { ensureDefaultUserSkillsDir } from '../../main/skills/user-skills-dir'
import { probeWslHome } from '../../main/wsl-home'
import {
  createAgentCapabilityService,
  createFsSkillDirectoryReader,
  createWorkspaceSkillsService,
  type AgentCapabilityService,
  type WorkspaceSkillsService,
} from '../../main/workspace-skills-service'
import { parseCliPermissionPreset } from '../../shared/cli-permission-preset'
import { parseCardAction, type CardAction } from '../../shared/hosted-card-feed'
import { normalizeMcpServerConfig } from '../../shared/mcp/normalize-server'
import type { StudioPlatform } from '../platform/platform'

// The skills, design systems and cards a Studio's agents are given
// (`agent-skills`), composed in the core so every server serves them about
// its own machine: the desktop in process or in a process of its own, and a
// server on a WSL or SSH machine.
//
// What only a desktop can do is handed in, and a server without it answers in
// words:
// - moving a removed skill to the Trash (Electron's `shell`);
// - a card's `install.module`, through the marketplace a desktop's Studio
//   holds (its extensions, extensions-domain.ts).
// Everything else (git, the GitHub token, a bundle's own scripts, which run
// in a child process of this one) is the server's own.

/** A clone nobody has read in sixty days is not worth the disk; the reader rebuilds it on the next read. */
const SKILL_REPO_CACHE_IDLE_MS = 60 * 24 * 60 * 60 * 1000

/** The marketplace a card's `install.module` goes through: a desktop's Studio's own. */
export type StudioCardMarketplace = Pick<
  CardRunDeps,
  'readMarketplaceRegistry' | 'listMarketplaceReceipts' | 'installMarketplaceEntry'
>

export type StudioAgentSkillsDeps = {
  mcpConfig: McpConfigService
  /** The GitHub token a source on github.com reads with; the core's own store when not given. */
  resolveGitHubToken?: () => Promise<string>
  /** When the git probe may first run (the desktop waits for its window); at once when not given. */
  whenGitMayRun?: Promise<unknown>
  /** A window of the desktop came forward: the capability answers re-check what they watch. */
  onWorkspaceFocus?: (listener: () => void) => () => void
  /** Move a folder to the Trash, where the Studio's machine has a shell that can. */
  trash?: (path: string) => Promise<void>
  marketplace?: StudioCardMarketplace
}

/** What the Studio protocol's `agent-skills` handlers answer from. */
export type StudioAgentSkills = {
  skills: SkillsService
  onSourcesUpdated(listener: (check: SkillSourceUpdateCheck) => void): () => void
  ensureUserSkillsFolder(): string
  workspaceSkills: WorkspaceSkillsService
  agentCapabilities: AgentCapabilityService
  agentSkillInstaller: AgentSkillInstaller
  installedSkills: ReturnType<typeof createInstalledSkillsService>
  designSystem: {
    library(): ReturnType<typeof listDesignSystemLibrary>
    arrivals(): ReturnType<typeof listDesignSystemArrivals>
    register(folder: string): ReturnType<typeof registerDesignSystemFolder>
    forget(id: string): ReturnType<typeof forgetDesignSystemFolder>
    read(bundleFolder: string): ReturnType<typeof readDesignSystemBundle>
    seed(input: {
      sourceFolder: string | null
      targetFolder: string
      name: string
      summary: string
    }): ReturnType<typeof seedDesignSystemBundle>
    lint(bundleFolder: string): ReturnType<typeof runDesignSystemBundleLint>
    attach(source: DesignSystemAttachSource, workspaceFolder: string): ReturnType<typeof attachDesignSystemBundle>
    detach(workspaceFolder: string): ReturnType<typeof detachDesignSystemBundle>
  }
  runCard(input: CardRunInput): Promise<CardRunResult>
}

const MODULES_ON_THE_DESKTOP = 'Modules are installed by the desktop app, and this Studio has none beside it.'

export function createStudioAgentSkills(platform: StudioPlatform, deps: StudioAgentSkillsDeps): StudioAgentSkills {
  const dataDir = platform.paths.dataDir()
  const tokens = deps.resolveGitHubToken ? null : new GitHubTokenStore()
  const resolveToken = deps.resolveGitHubToken ?? (() => tokens!.resolveToken())
  // Repositories are read over git, not the GitHub API: the API's anonymous
  // limit capped a Sync at twenty linked repositories. A machine without a
  // usable git keeps the API reader, and the door says to install git.
  const skillRepoCacheDir = join(dataDir, 'skill-repos')
  const gitTransport = createGitTransportProbe({
    cacheDir: skillRepoCacheDir,
    resolveToken,
    resolveHostToken: createGhHostTokenResolver(sharedGhRunner()),
  })
  void Promise.resolve(deps.whenGitMayRun).then(async () => {
    await gitTransport.refresh()
    await sweepGitRepoCache(skillRepoCacheDir, SKILL_REPO_CACHE_IDLE_MS).catch(() => undefined)
  })
  const sourceListeners = new Set<(check: SkillSourceUpdateCheck) => void>()
  const skills = createSkillsService(dataDir, {
    resolveToken,
    get repoReader() {
      return gitTransport.reader
    },
    get repoTransport() {
      return gitTransport.reader ? ('git' as const) : ('api' as const)
    },
    get gitInstalled() {
      return gitTransport.installed
    },
    refreshTransport: () => gitTransport.refresh(),
    // The bundled plugin tree, read as the offline seed of Studio's own tab.
    studioMarketplaceSeedRoot: () => bundledStudioPluginRoot(platform),
    broadcastSourceUpdates: (check) => {
      for (const listener of [...sourceListeners]) listener(check)
    },
  })

  const capabilityWatcher = createCapabilityWatcher({
    listPlugins: () => listPluginRegistryEntries(),
    lookupManifest: (pluginId) => getPluginManifest(pluginId),
    ...(deps.onWorkspaceFocus ? { onWorkspaceFocus: deps.onWorkspaceFocus } : {}),
  })
  const agentCapabilities = createAgentCapabilityService({
    reader: createFsSkillDirectoryReader(),
    listPlugins: () => listPluginRegistryEntries(),
    lookupManifest: (pluginId) => getPluginManifest(pluginId),
    mcpResolver: createMcpServerResolver(),
    freshness: capabilityWatcher,
  })
  const agentSkillInstaller = createAgentSkillInstaller({
    listPlugins: () => listPluginRegistryEntries(),
    invalidate: (workspaceRoot, harnessId) => capabilityWatcher.invalidate(workspaceRoot, harnessId),
  })
  const trash = deps.trash
  const installedSkills = createInstalledSkillsService({
    listPlugins: listPluginRegistryEntries,
    trashItem: async (path) => {
      if (!trash) throw new Error(`This Studio cannot move ${path} to the Trash on its machine; remove it by hand.`)
      await trash(path)
    },
    // The machine's distribution's home (else the default's), cached for a minute.
    ...(process.platform === 'win32' ? { probeWsl: (distro?: string | null) => probeWslHome(distro) } : {}),
  })

  const libraryPaths = (): LibraryPaths => ({
    registryPath: defaultDesignSystemRegistryPath(),
    legacyRoot: defaultDesignSystemLibraryRoot(),
  })
  // One arrivals listing serves every client that asks within ten minutes,
  // and concurrent askers share one read: each is a `git log` per registered
  // bundle. A library change drops it.
  let arrivalsMemo: { at: number; result: ReturnType<typeof listDesignSystemArrivals> } | null = null
  const ARRIVALS_MEMO_MS = 10 * 60 * 1000
  const forgetArrivals = () => {
    arrivalsMemo = null
  }

  const cardDeps: CardRunDeps = {
    syncMcp: (input) => deps.mcpConfig.sync(input),
    getSkillScan: (input) => skills.getScan(input),
    installSkill: (input) => skills.install(input),
    installPlugin: (input) => skills.installPlugin(input),
    listInstalledPlugins: (input) => skills.listInstalledPlugins(input),
    installedSkillCopies: (workspaceRoot) => installedSkillCopies(workspaceRoot),
    // Only the agent CLIs this build registers: a `require.cli` naming
    // anything else never reaches a probe.
    listAgentCliIds: () => listPluginRegistryEntries().map((entry) => entry.id),
    detectCli: async (cli) => {
      const detected = await detectCli(cli)
      // A probe that errored decided nothing, and that is not "installed".
      return { installed: detected.error === null && detected.installed }
    },
    cloneRepo: async (input) => cloneRepository(input, { token: await resolveToken() }),
    pathExists: (path) => existsSync(path),
    // Strictly `origin`, and strictly GitHub: a fork whose `upstream` is the
    // card's repository is not the card's clone.
    repoOriginName: async (dir) => {
      try {
        const ref = githubRepoFromRemote(await runGit(dir, ['remote', 'get-url', 'origin']))
        return ref ? `${ref.owner}/${ref.repo}` : null
      } catch {
        return null
      }
    },
    joinPath: (...segments) => join(...segments),
    readMarketplaceRegistry: () =>
      deps.marketplace
        ? deps.marketplace.readMarketplaceRegistry()
        : Promise.resolve({ ok: false, message: MODULES_ON_THE_DESKTOP } as Awaited<
            ReturnType<CardRunDeps['readMarketplaceRegistry']>
          >),
    listMarketplaceReceipts: () =>
      deps.marketplace
        ? deps.marketplace.listMarketplaceReceipts()
        : Promise.resolve({ ok: false, message: MODULES_ON_THE_DESKTOP }),
    installMarketplaceEntry: (input) => {
      if (!deps.marketplace) throw new Error(MODULES_ON_THE_DESKTOP)
      return deps.marketplace.installMarketplaceEntry(input)
    },
  }

  return {
    skills,
    onSourcesUpdated(listener) {
      sourceListeners.add(listener)
      return () => void sourceListeners.delete(listener)
    },
    ensureUserSkillsFolder: () => ensureDefaultUserSkillsDir(),
    workspaceSkills: createWorkspaceSkillsService(),
    agentCapabilities,
    agentSkillInstaller,
    installedSkills,
    designSystem: {
      library: () => listDesignSystemLibrary(libraryPaths()),
      arrivals: () => {
        if (arrivalsMemo && Date.now() - arrivalsMemo.at < ARRIVALS_MEMO_MS) return arrivalsMemo.result
        const result = listDesignSystemArrivals(libraryPaths()).catch((error: unknown) => {
          forgetArrivals()
          throw error
        })
        arrivalsMemo = { at: Date.now(), result }
        return result
      },
      register: (folder) => {
        forgetArrivals()
        return registerDesignSystemFolder(libraryPaths(), folder)
      },
      forget: (id) => {
        forgetArrivals()
        return forgetDesignSystemFolder(libraryPaths(), id)
      },
      read: (bundleFolder) => readDesignSystemBundle(bundleFolder),
      // The one place the design surface writes a bundle, and only into the
      // folder the person picked; it never overwrites an existing one.
      seed: (input) =>
        seedDesignSystemBundle({
          sourceDir: input.sourceFolder?.trim() ? input.sourceFolder : null,
          targetDir: input.targetFolder,
          name: input.name,
          summary: input.summary,
          templatesDir: resolveDesignSystemTemplatesDir(platform.paths),
        }),
      lint: (bundleFolder) => runDesignSystemBundleLint(bundleFolder, runBundleScriptInChildProcess),
      attach: (source, workspaceFolder) => attachDesignSystemBundle(source, workspaceFolder, libraryPaths()),
      detach: (workspaceFolder) => detachDesignSystemBundle(workspaceFolder),
    },
    runCard: async (input) => {
      const request = reparseCard(input)
      if (!request.ok) return refusedCard(null, request.message)
      try {
        return await runCard(request.input, cardDeps)
      } catch (error) {
        return refusedCard(request.input.workspaceRoot, error instanceof Error ? error.message : String(error))
      }
    },
  }
}

function refusedCard(workspaceRoot: string | null, message: string): CardRunResult {
  return { ok: false, outcomes: [], workspaceRoot, mcpServers: [], chat: null, surface: null, message }
}

/**
 * A card's actions, read again by the Studio's own parser. They were read once
 * when the feed was, but have been to a client and back since, so one that
 * does not read refuses the whole card: half of Go is worse than none of it.
 * The MCP servers go through the settings store's normalizer (a row that does
 * not normalize is left out of the sync, as the store would), the two folders
 * are dropped when not absolute, and the picker row's axes keep their shape.
 */
function reparseCard(input: CardRunInput): { ok: true; input: CardRunInput } | { ok: false; message: string } {
  const actions: CardAction[] = []
  for (const entry of input.actions as unknown[]) {
    const parsed = parseCardAction(entry)
    if (!parsed.ok)
      return { ok: false, message: `That card asks for something this build cannot do: ${parsed.message}` }
    actions.push(parsed.action)
  }
  const mcpServers: McpServerConfig[] = []
  for (const entry of input.mcpServers as unknown[]) {
    const normalized = normalizeMcpServerConfig(entry)
    if (normalized) mcpServers.push(normalized)
  }
  const permissionPreset = parseCliPermissionPreset(input.permissionPreset)
  return {
    ok: true,
    input: {
      slug: input.slug.trim(),
      actions,
      workspaceRoot: absoluteOrNull(input.workspaceRoot),
      cloneParentDir: absoluteOrNull(input.cloneParentDir),
      mcpServers,
      mcpSyncEnabled: input.mcpSyncEnabled === true,
      model: textOrNull(input.model),
      reasoning: textOrNull(input.reasoning),
      ...(permissionPreset ? { permissionPreset } : {}),
    },
  }
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function absoluteOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const path = value.trim()
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : null
}

/** `resources/studio-plugin` in this build: beside the other resources when packaged, in the checkout otherwise. */
function bundledStudioPluginRoot(platform: StudioPlatform): string | null {
  const { paths } = platform
  const resources = paths.resourcesDir()
  const candidates = [
    ...(paths.isPackaged() && resources ? [join(resources, STUDIO_MARKETPLACE_RESOURCE_DIR)] : []),
    join(paths.appRoot() ?? process.cwd(), 'resources', STUDIO_MARKETPLACE_RESOURCE_DIR),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}
