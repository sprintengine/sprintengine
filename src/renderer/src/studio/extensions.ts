import {
  STUDIO_EXTENSIONS_CAPABILITY,
  STUDIO_MODULES_CAPABILITY,
  type AgentLaunchPreviewInput,
  type AgentLaunchPreviewResult,
  type ExtensionScaffoldCreateInput,
  type ExtensionScaffoldCreateResult,
  type ExtensionScaffoldTarget,
  type ExtensionScaffoldTargetInput,
  type GithubExtensionInstallInput,
  type GithubExtensionResolveResult,
  type HostedCardFeedReadResult,
  type HostedSourcesFeedReadResult,
  type MarketplacePluginRegistryInstallInput,
  type MarketplacePluginRegistryInstallResult,
  type MarketplacePluginUninstallInput,
  type MarketplacePluginUninstallResult,
  type MarketplacePluginVerifyResult,
  type MarketplaceRegistryReadInput,
  type MarketplaceRegistryReadResult,
  type MarketplaceUpdateStatesResult,
  type ModuleRegistrySnapshot,
  type ModuleRegistrySnapshotWriteResult,
  type PluginAvailabilityResult,
  type PluginDetectAvailabilityInput,
  type PluginRegistryListResult,
  type StudioCapability,
  type StudioMethod,
  type StudioMethodParams,
  type StudioMethodResult,
  type StudioModuleSummary,
  type StudioPluginStatus,
  type ThirdPartyModuleListResult,
  type ThirdPartyRendererEntriesResult,
} from '../../../../packages/studio-protocol/src/public'
import { followWindowStudioPush, rereadOnReopen } from './windowStudioPush'
import { windowStudioClient, windowStudioIsAnotherMachine } from './windowStudioClient'

// The window's way to what its Studio is extended with: the marketplace and
// installing from it or from GitHub (`marketplace.*`), the agent CLIs' plugin
// catalogue (`cliPlugins.*`), Studio's own plugin in a workspace, building an
// extension (`extensionScaffold.*`), the hosted feeds, and the extensions
// installed there (`module.installed`, `module.rendererEntries`,
// `module.changed`, `module.list`). Over the window's own connection, as every
// other client reaches them. The members keep the names the window has always
// called them by, so a caller changes only where it imports them from. A
// command carries a command id made for the call; a follow (`on…`) is kept
// across the window's reconnects and returns its unsubscriber.

export type ExtensionsApi = {
  readMarketplaceRegistry(input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult>
  readMarketplacePluginUpdateStates(input?: MarketplaceRegistryReadInput): Promise<MarketplaceUpdateStatesResult>
  /** Review an entry: what installing it would do, and the one-time approval that installs exactly that. */
  verifyMarketplacePlugin(input: { id: string }): Promise<MarketplacePluginVerifyResult>
  installMarketplacePluginFromRegistry(
    input: MarketplacePluginRegistryInstallInput,
  ): Promise<MarketplacePluginRegistryInstallResult>
  updateMarketplacePluginFromRegistry(
    input: MarketplacePluginRegistryInstallInput,
  ): Promise<MarketplacePluginRegistryInstallResult>
  /** Remove a plugin and what it put in place; `pluginId` is its id or one of its modules'. */
  uninstallMarketplacePlugin(input: MarketplacePluginUninstallInput): Promise<MarketplacePluginUninstallResult>
  resolveGithubExtension(input: { url: string }): Promise<GithubExtensionResolveResult>
  installGithubExtension(input: GithubExtensionInstallInput): Promise<MarketplacePluginRegistryInstallResult>
  pluginsList(): Promise<PluginRegistryListResult>
  pluginsDetectAvailability(input?: PluginDetectAvailabilityInput): Promise<PluginAvailabilityResult>
  /** What launching a CLI at these settings would run. */
  agentLaunchPreview(input: AgentLaunchPreviewInput): Promise<AgentLaunchPreviewResult>
  studioPluginStatus(input: { workspaceRoot: string | null }): Promise<StudioPluginStatus>
  extensionScaffoldHome(): Promise<string>
  extensionScaffoldTarget(input: ExtensionScaffoldTargetInput): Promise<ExtensionScaffoldTarget | null>
  extensionScaffoldCreate(input: ExtensionScaffoldCreateInput): Promise<ExtensionScaffoldCreateResult>
  /** The Extensions home's cards as the Studio holds them; never waits on the network. */
  hostedCardFeedGet(): Promise<HostedCardFeedReadResult>
  /** Each read that changed the cards the Studio holds. */
  onHostedCardFeedChanged(cb: (result: HostedCardFeedReadResult) => void): () => void
  hostedSourcesFeedGet(): Promise<HostedSourcesFeedReadResult>
  /** Every extension installed on the Studio, with its trust, origin and launch state. */
  listThirdPartyModules(): Promise<ThirdPartyModuleListResult>
  /** Every module the Studio holds, switched on or off, and whether it runs there now. */
  listStudioModules(): Promise<StudioModuleSummary[]>
  /** The trusted extensions' window halves, for this window to run; none where the Studio is another machine. */
  listThirdPartyRendererEntries(): Promise<ThirdPartyRendererEntriesResult>
  /** What is installed or trusted on the Studio changed. */
  onThirdPartyModulesChanged(cb: () => void): () => void
  /** The person's values for the modules' Settings sections, which their main halves read. */
  setModuleAppState(state: Record<string, Record<string, unknown>>): Promise<void>
  /** The module registry this window resolved, which the Studio's agent tools report. */
  setModuleRegistrySnapshot(snapshot: ModuleRegistrySnapshot): Promise<ModuleRegistrySnapshotWriteResult>
}

function commandId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

async function call<M extends StudioMethod>(
  capability: StudioCapability,
  method: M,
  params: StudioMethodParams<M>,
): Promise<StudioMethodResult<M>> {
  const client = await windowStudioClient()
  if (!client.supports(capability)) throw new Error(`This Studio does not serve ${method}.`)
  return client.request(method, params)
}

const extensions = <M extends StudioMethod>(method: M, params: StudioMethodParams<M>) =>
  call(STUDIO_EXTENSIONS_CAPABILITY, method, params)
const modules = <M extends StudioMethod>(method: M, params: StudioMethodParams<M>) =>
  call(STUDIO_MODULES_CAPABILITY, method, params)

export { windowHasStudio } from './windowStudioClient'

function words(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A command's answer, or its failure to be asked in the shape its result says a failure. */
async function answered<T>(work: () => Promise<T>, failed: (message: string) => T): Promise<T> {
  try {
    return await work()
  } catch (error) {
    return failed(words(error))
  }
}

export const extensionsApi: ExtensionsApi = {
  readMarketplaceRegistry: (input = {}) => extensions('marketplace.read', input),
  readMarketplacePluginUpdateStates: (input = {}) => extensions('marketplace.updateStates', input),
  verifyMarketplacePlugin: ({ id }) => extensions('marketplace.verify', { id }),
  installMarketplacePluginFromRegistry: (input) =>
    answered(
      () => extensions('marketplace.install', { ...input, commandId: commandId() }),
      (message) => ({ ok: false, message }),
    ),
  updateMarketplacePluginFromRegistry: (input) =>
    answered(
      () => extensions('marketplace.update', { ...input, commandId: commandId() }),
      (message) => ({ ok: false, message }),
    ),
  uninstallMarketplacePlugin: (input) =>
    answered(
      () => extensions('marketplace.uninstall', { ...input, commandId: commandId() }),
      (message) => ({ ok: false, message }),
    ),
  resolveGithubExtension: ({ url }) =>
    answered(
      () => extensions('marketplace.resolveGithub', { url }),
      (message) => ({ ok: false, message }),
    ),
  installGithubExtension: (input) =>
    answered(
      () => extensions('marketplace.installGithub', { ...input, commandId: commandId() }),
      (message) => ({ ok: false, message }),
    ),
  pluginsList: () => extensions('cliPlugins.list', {}),
  pluginsDetectAvailability: (input = {}) => extensions('cliPlugins.availability', input),
  agentLaunchPreview: (input) => extensions('cliPlugins.launchPreview', input),
  studioPluginStatus: ({ workspaceRoot }) => extensions('studioPlugin.status', { workspaceFolder: workspaceRoot }),
  extensionScaffoldHome: async () => (await extensions('extensionScaffold.home', {})).folder,
  extensionScaffoldTarget: async (input) => (await extensions('extensionScaffold.target', input)).target,
  extensionScaffoldCreate: (input) =>
    answered(
      () => extensions('extensionScaffold.create', { ...input, commandId: commandId() }),
      (message) => ({ ok: false, code: 'io_error', message }),
    ),
  hostedCardFeedGet: () => extensions('cardFeed.get', {}),
  onHostedCardFeedChanged: (cb) =>
    followWindowStudioPush({
      topic: 'cardFeed.changed',
      params: {},
      capability: STUDIO_EXTENSIONS_CAPABILITY,
      onPayload: cb,
      onReopen: rereadOnReopen(() => extensions('cardFeed.get', {}), cb),
    }),
  hostedSourcesFeedGet: () => extensions('sourcesFeed.get', {}),
  listThirdPartyModules: () => modules('module.installed', {}),
  listStudioModules: async () => (await modules('module.list', {})).modules,
  listThirdPartyRendererEntries: async () =>
    // A window half's assets are served from this computer's own folders, so
    // a window whose Studio is another machine (a browser tab) runs none.
    windowStudioIsAnotherMachine() ? { entries: [], failures: {} } : modules('module.rendererEntries', {}),
  onThirdPartyModulesChanged: (cb) =>
    followWindowStudioPush({
      topic: 'module.changed',
      params: {},
      capability: STUDIO_MODULES_CAPABILITY,
      onPayload: () => cb(),
      // A change itself carries nothing: the listener reads the list.
      onReopen: () => cb(),
    }),
  // A browser tab loads no extension and starts from the default settings, so
  // what it would send would replace the desktop window's with blanks.
  setModuleAppState: async (state) => {
    if (windowStudioIsAnotherMachine()) return
    await modules('module.setAppState', { state, commandId: commandId() })
  },
  setModuleRegistrySnapshot: async (snapshot) =>
    windowStudioIsAnotherMachine()
      ? { ok: true }
      : modules('module.reportRegistry', { snapshot, commandId: commandId() }),
}
