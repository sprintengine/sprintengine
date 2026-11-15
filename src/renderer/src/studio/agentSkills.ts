import {
  STUDIO_AGENT_SKILLS_CAPABILITY,
  type AgentCapabilitiesInput,
  type AgentCapabilitiesResult,
  type AgentSkillWriteInput,
  type AgentSkillWriteResult,
  type CardRunInput,
  type CardRunResult,
  type DesignSystemArrivalsResult,
  type DesignSystemAttachResult,
  type DesignSystemAttachSource,
  type DesignSystemBundleLintRunResult,
  type DesignSystemBundleReadResult,
  type DesignSystemDetachResult,
  type DesignSystemLibraryListResult,
  type DesignSystemRegisterResult,
  type DesignSystemScaffoldResult,
  type InstalledSkillRemoveInput,
  type InstalledSkillRemoveResult,
  type InstalledSkillsInput,
  type InstalledSkillsResult,
  type SkillAddLocalSourceInput,
  type SkillAddSourceInput,
  type SkillAddSourceResult,
  type SkillInstallInput,
  type SkillInstallOutcome,
  type SkillInstalledPluginsInput,
  type SkillInstalledPluginsOutcome,
  type SkillPluginInstallInput,
  type SkillPluginInstallOutcome,
  type SkillPluginScanLinkedInput,
  type SkillPluginScanLinkedOutcome,
  type SkillPluginUninstallInput,
  type SkillPluginUninstallOutcome,
  type SkillPopularReposOutcome,
  type SkillReadFileInput,
  type SkillReadFileResult,
  type SkillRemoveSourceInput,
  type SkillRemoveSourceResult,
  type SkillScanInput,
  type SkillScanOutcome,
  type SkillSearchInput,
  type SkillSearchOutcome,
  type SkillSourceUpdateCheck,
  type SkillSourcesResult,
  type SkillSyncSourceInput,
  type SkillSyncSourceOutcome,
  type SkillUninstallInput,
  type SkillUninstallOutcome,
  type StudioMethod,
  type StudioMethodParams,
  type StudioMethodResult,
  type WorkspaceSkillsListInput,
  type WorkspaceSkillsListResult,
} from '../../../../packages/studio-protocol/src/public'
import { followWindowStudioPush } from './windowStudioPush'
import { windowStudioClient } from './windowStudioClient'

// The window's way to the skills, design systems and cards its Studio's agents
// are given: the Studio protocol's `agent-skills` methods, over the window's
// own connection, as every other client reaches them. The members keep the
// names the window has always called them by, so a caller changes only where
// it imports them from. A follow (`on…`) is kept across reconnects and returns
// its unsubscriber.

export type AgentSkillsApi = {
  skillsListSources(): Promise<SkillSourcesResult>
  skillsCheckSourceUpdates(): Promise<SkillSourceUpdateCheck>
  skillsAddSource(input: SkillAddSourceInput): Promise<SkillAddSourceResult>
  skillsAddLocalSource(input: SkillAddLocalSourceInput): Promise<SkillAddSourceResult>
  skillsRemoveSource(input: SkillRemoveSourceInput): Promise<SkillRemoveSourceResult>
  skillsGetScan(input: SkillScanInput): Promise<SkillScanOutcome>
  skillsReadFile(input: SkillReadFileInput): Promise<SkillReadFileResult>
  skillsInstall(input: SkillInstallInput): Promise<SkillInstallOutcome>
  skillsUninstall(input: SkillUninstallInput): Promise<SkillUninstallOutcome>
  skillsSyncSource(input: SkillSyncSourceInput): Promise<SkillSyncSourceOutcome>
  skillsSearch(input: SkillSearchInput): Promise<SkillSearchOutcome>
  skillsListPopularRepos(): Promise<SkillPopularReposOutcome>
  skillsScanLinkedPlugin(input: SkillPluginScanLinkedInput): Promise<SkillPluginScanLinkedOutcome>
  skillsInstallPlugin(input: SkillPluginInstallInput): Promise<SkillPluginInstallOutcome>
  skillsUninstallPlugin(input: SkillPluginUninstallInput): Promise<SkillPluginUninstallOutcome>
  skillsListInstalledPlugins(input: SkillInstalledPluginsInput): Promise<SkillInstalledPluginsOutcome>
  /** Every check of the sources, the hourly one's and Check now's. */
  onSkillSourcesUpdated(cb: (check: SkillSourceUpdateCheck) => void): () => void
  installedSkillsList(input: InstalledSkillsInput): Promise<InstalledSkillsResult>
  installedSkillRemove(input: InstalledSkillRemoveInput): Promise<InstalledSkillRemoveResult>
  workspaceSkillsList(input: WorkspaceSkillsListInput): Promise<WorkspaceSkillsListResult>
  agentCapabilities(input: AgentCapabilitiesInput): Promise<AgentCapabilitiesResult>
  agentSkillAttach(input: AgentSkillWriteInput): Promise<AgentSkillWriteResult>
  /** The folder hand-written skills are kept in, made when it is not there yet. */
  ensureDefaultUserSkillsDir(): Promise<string>
  seedDesignSystemBundle(
    sourceDir: string | null,
    targetDir: string,
    name: string,
    summary: string,
  ): Promise<DesignSystemScaffoldResult>
  lintDesignSystemBundle(bundleDir: string): Promise<DesignSystemBundleLintRunResult>
  readDesignSystemBundle(bundleDir: string): Promise<DesignSystemBundleReadResult>
  listDesignSystemLibrary(): Promise<DesignSystemLibraryListResult>
  listDesignSystemArrivals(): Promise<DesignSystemArrivalsResult>
  registerDesignSystemFolder(folderPath: string): Promise<DesignSystemRegisterResult>
  forgetDesignSystemFolder(id: string): Promise<{ ok: true; forgotten: boolean }>
  attachDesignSystemBundle(source: DesignSystemAttachSource, workspaceRoot: string): Promise<DesignSystemAttachResult>
  detachDesignSystemBundle(workspaceRoot: string): Promise<DesignSystemDetachResult>
  /** Go on a card. */
  cardsRun(input: CardRunInput): Promise<CardRunResult>
}

const UNSERVED =
  'This Studio is older than this app and does not serve skills, design systems or cards. Update it to use them here.'

function randomId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

async function call<M extends StudioMethod>(method: M, params: StudioMethodParams<M>): Promise<StudioMethodResult<M>> {
  const client = await windowStudioClient()
  if (!client.supports(STUDIO_AGENT_SKILLS_CAPABILITY)) throw new Error(UNSERVED)
  return client.request(method, params)
}

const commandId = () => ({ commandId: randomId() })

export { windowHasStudio } from './windowStudioClient'

export const agentSkillsApi: AgentSkillsApi = {
  skillsListSources: () => call('skillSources.list', {}),
  skillsCheckSourceUpdates: () => call('skillSources.checkUpdates', {}),
  skillsAddSource: (input) => call('skillSources.add', { ...input, ...commandId() }),
  skillsAddLocalSource: ({ path, replace }) =>
    call('skillSources.addLocal', { folder: path, ...(replace ? { replace } : {}), ...commandId() }),
  skillsRemoveSource: (input) => call('skillSources.remove', { ...input, ...commandId() }),
  skillsGetScan: (input) => call('skills.scan', input),
  skillsReadFile: (input) => call('skills.readFile', input),
  skillsInstall: ({ sourceId, skillId, workspaceRoot, scope }) =>
    call('skills.install', {
      sourceId,
      skillId,
      ...(workspaceRoot === undefined ? {} : { workspaceFolder: workspaceRoot }),
      ...(scope ? { scope } : {}),
      ...commandId(),
    }),
  skillsUninstall: ({ workspaceRoot, dirName }) =>
    call('skills.uninstall', { workspaceFolder: workspaceRoot, dirName, ...commandId() }),
  skillsSyncSource: ({ sourceId, workspaceRoot, mcpServers }) =>
    call('skillSources.sync', {
      sourceId,
      workspaceFolder: workspaceRoot,
      ...(mcpServers ? { mcpServers } : {}),
      ...commandId(),
    }),
  skillsSearch: (input) => call('skills.search', input),
  skillsListPopularRepos: () => call('skills.popularRepos', {}),
  skillsScanLinkedPlugin: (input) => call('skillPlugins.scanLinked', input),
  skillsInstallPlugin: (input) => call('skillPlugins.install', { ...input, ...commandId() }),
  skillsUninstallPlugin: (input) => call('skillPlugins.uninstall', { ...input, ...commandId() }),
  skillsListInstalledPlugins: ({ workspaceRoot }) =>
    call('skillPlugins.listInstalled', { workspaceFolder: workspaceRoot }),
  onSkillSourcesUpdated: (cb) =>
    followWindowStudioPush({
      topic: 'skillSources.updated',
      params: {},
      capability: STUDIO_AGENT_SKILLS_CAPABILITY,
      onPayload: (payload) => cb(payload as SkillSourceUpdateCheck),
    }),
  installedSkillsList: ({ workspaceRoot, ...cli }) =>
    call('installedSkills.list', { workspaceFolder: workspaceRoot, ...cli }),
  installedSkillRemove: ({ workspaceRoot, ...rest }) =>
    call('installedSkills.remove', { workspaceFolder: workspaceRoot, ...rest, ...commandId() }),
  workspaceSkillsList: ({ workspaceRoot, includeGlobal }) =>
    call('workspaceSkills.list', { workspaceFolder: workspaceRoot, ...(includeGlobal ? { includeGlobal } : {}) }),
  agentCapabilities: ({ workspaceRoot, pluginId, includeGlobal }) =>
    call('agentCapabilities.resolve', {
      workspaceFolder: workspaceRoot,
      pluginId,
      ...(includeGlobal ? { includeGlobal } : {}),
    }),
  agentSkillAttach: ({ workspaceRoot, skillId }) =>
    call('agentSkills.attach', { workspaceFolder: workspaceRoot, skillId, ...commandId() }),
  ensureDefaultUserSkillsDir: async () => (await call('skills.ensureUserFolder', commandId())).folder,
  seedDesignSystemBundle: (sourceDir, targetDir, name, summary) =>
    call('designSystem.seed', { sourceFolder: sourceDir, targetFolder: targetDir, name, summary, ...commandId() }),
  lintDesignSystemBundle: (bundleDir) => call('designSystem.lint', { bundleFolder: bundleDir, ...commandId() }),
  readDesignSystemBundle: (bundleDir) => call('designSystem.read', { bundleFolder: bundleDir }),
  listDesignSystemLibrary: () => call('designSystem.library', {}),
  listDesignSystemArrivals: () => call('designSystem.arrivals', {}),
  registerDesignSystemFolder: (folderPath) => call('designSystem.register', { folder: folderPath, ...commandId() }),
  forgetDesignSystemFolder: (id) => call('designSystem.forget', { id, ...commandId() }),
  attachDesignSystemBundle: (source, workspaceRoot) =>
    call('designSystem.attach', {
      source: source.kind === 'library' ? source : { kind: 'folder', folder: source.path },
      workspaceFolder: workspaceRoot,
      ...commandId(),
    }),
  detachDesignSystemBundle: (workspaceRoot) =>
    call('designSystem.detach', { workspaceFolder: workspaceRoot, ...commandId() }),
  cardsRun: (input) => call('cards.run', { ...input, ...commandId() }),
}
