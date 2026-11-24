import {
  studioGrantAllows,
  STUDIO_EXTENSIONS_CAPABILITY,
  STUDIO_EXTENSION_EDITORS_CAPABILITY,
  STUDIO_EXTENSION_FRAMES_CAPABILITY,
  STUDIO_EXTENSION_HOST_CAPABILITY,
  type ExtensionContent,
  type ExtensionContributionsResult,
  type ExtensionFrameDocument,
  type ExtensionSettingValueView,
  type StudioExtensionContentRequest,
  type StudioExtensionCall,
  type StudioExtensionCallAnswer,
  type StudioExtensionFrameRequest,
  type StudioModuleEvent,
  type AgentLaunchPreviewInput,
  type AgentLaunchPreviewResult,
  type ExtensionScaffoldCreateInput,
  type ExtensionScaffoldCreateResult,
  type ExtensionScaffoldTarget,
  type ExtensionScaffoldTargetInput,
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
} from '../../../../packages/studio-protocol/src/public'
import { followWindowStudioPush, rereadOnReopen } from './windowStudioPush'
import { windowStudioClient, windowStudioIsAnotherMachine } from './windowStudioClient'

// The window's way to what its Studio is extended with: the marketplace and
// installing from it or from GitHub (`marketplace.*`), the agent CLIs' plugin
// catalogue (`cliPlugins.*`), Studio's own plugin in a workspace, building an
// extension (`extensionScaffold.*`), the hosted feeds, and the extensions
// installed there (`extension.installed`, `extension.contributions`,
// `extension.changed`, `extension.list`), and their surfaces' frames
// (`extension.frame`, `extension.call`, `extension.events`). Over the window's own connection, as every
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
  /** What the approved extensions add to this window, as their extension.json declares it. */
  listExtensionContributions(): Promise<ExtensionContributionsResult>
  /** Whether the Studio draws extension surfaces in frames (`extension-frames`). */
  drawsExtensionFrames(): Promise<boolean>
  /** Whether the window's Studio opens files in its extensions' custom editors (`extension-editors`). */
  opensExtensionEditors(): Promise<boolean>
  /** Whether this window's connection may write files on its Studio (`filesystem:write`). */
  canWriteFiles(): Promise<boolean>
  /** The document one surface's frame is drawn from. */
  extensionFrame(request: StudioExtensionFrameRequest): Promise<ExtensionFrameDocument>
  /** One host call a frame made, as this window's connection; never throws. */
  extensionCall(call: StudioExtensionCall): Promise<StudioExtensionCallAnswer>
  /** One piece of what a content extension adds (a syntax's grammar), checked by the Studio. */
  extensionContent(request: StudioExtensionContentRequest): Promise<ExtensionContent>
  /** The values of an extension's declared settings, each its default until set. */
  extensionSettings(moduleId: string): Promise<Record<string, ExtensionSettingValueView>>
  /** Whether this window's connection may read and change extensions' settings (`settings:write`). */
  canChangeExtensionSettings(): Promise<boolean>
  /** Hear whose settings values changed, from any writer, and once more after a reconnect. */
  onExtensionSettingsChanged(cb: (moduleId: string | null) => void): () => void
  /** Set one declared setting (`null`: back to its default); never throws. */
  setExtensionSetting(input: {
    moduleId: string
    key: string
    value: ExtensionSettingValueView | null
  }): Promise<{ ok: true; values: Record<string, ExtensionSettingValueView> } | { ok: false; message: string }>
  /** Hear one extension's worker events, across reconnects. */
  onExtensionEvents(moduleId: string, cb: (event: StudioModuleEvent) => void): () => void
  /** One of Studio's events for one extension's surfaces, as the Studio admits it (`extension.studioEvents`). */
  onStudioEvents(moduleId: string, event: string, cb: (payload: unknown) => void): () => void
  /** What is installed or trusted on the Studio changed. */
  onThirdPartyModulesChanged(cb: () => void): () => void
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
  call(STUDIO_EXTENSION_HOST_CAPABILITY, method, params)

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
      reread: rereadOnReopen(() => extensions('cardFeed.get', {}), cb),
    }),
  hostedSourcesFeedGet: () => extensions('sourcesFeed.get', {}),
  listThirdPartyModules: () => modules('extension.installed', {}),
  listStudioModules: async () => (await modules('extension.list', {})).modules,
  // A Studio with no extension host (a WSL, SSH or headless one) adds nothing.
  listExtensionContributions: async () => {
    const client = await windowStudioClient()
    if (!client.supports(STUDIO_EXTENSION_HOST_CAPABILITY)) return { extensions: [], failures: {} }
    return client.request('extension.contributions', {})
  },
  drawsExtensionFrames: async () => (await windowStudioClient()).supports(STUDIO_EXTENSION_FRAMES_CAPABILITY),
  opensExtensionEditors: async () => (await windowStudioClient()).supports(STUDIO_EXTENSION_EDITORS_CAPABILITY),
  canWriteFiles: async () => studioGrantAllows((await windowStudioClient()).grant, 'files.writeText'),
  extensionFrame: (request) => call(STUDIO_EXTENSION_FRAMES_CAPABILITY, 'extension.frame', request),
  extensionCall: (request) =>
    answered(
      () => call(STUDIO_EXTENSION_FRAMES_CAPABILITY, 'extension.call', { ...request, commandId: commandId() }),
      (message) => ({ ok: false, code: 'unavailable', message }),
    ),
  extensionContent: (request) => modules('extension.content', request),
  extensionSettings: async (moduleId) => (await modules('extension.settings', { moduleId })).values,
  canChangeExtensionSettings: async () => {
    const client = await windowStudioClient()
    return client.supports(STUDIO_EXTENSION_HOST_CAPABILITY) && studioGrantAllows(client.grant, 'extension.setSetting')
  },
  onExtensionSettingsChanged: (cb) =>
    followWindowStudioPush({
      topic: 'extension.settingsChanged',
      params: {},
      capability: STUDIO_EXTENSION_HOST_CAPABILITY,
      onPayload: (payload) => cb(payload.moduleId),
      // What changed while the window was away is not known: read every one again.
      onReopen: () => cb(null),
    }),
  setExtensionSetting: (input) =>
    answered(
      () => modules('extension.setSetting', { ...input, commandId: commandId() }),
      (message) => ({ ok: false, message }),
    ),
  onExtensionEvents: (moduleId, cb) =>
    followWindowStudioPush({
      topic: 'extension.events',
      params: { moduleId },
      capability: STUDIO_EXTENSION_HOST_CAPABILITY,
      onPayload: cb,
    }),
  onStudioEvents: (moduleId, event, cb) =>
    followWindowStudioPush({
      topic: 'extension.studioEvents',
      params: { moduleId, event },
      capability: STUDIO_EXTENSION_FRAMES_CAPABILITY,
      onPayload: (heard) => cb(heard.payload),
    }),
  onThirdPartyModulesChanged: (cb) =>
    followWindowStudioPush({
      topic: 'extension.changed',
      params: {},
      capability: STUDIO_EXTENSION_HOST_CAPABILITY,
      onPayload: () => cb(),
      // A change itself carries nothing: the listener reads the list.
      onReopen: () => cb(),
    }),
  setModuleRegistrySnapshot: async (snapshot) =>
    windowStudioIsAnotherMachine()
      ? { ok: true }
      : modules('extension.reportRegistry', { snapshot, commandId: commandId() }),
}
