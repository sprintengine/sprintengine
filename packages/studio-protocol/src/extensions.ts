import {
  studioNoParams,
  studioParams,
  studioParamsRefused as refuse,
  type StudioMethodTable,
  type StudioParsed,
  type StudioTopicTable,
} from './contract.js'
import type { McpClientTarget, McpSettings } from './agents.js'
import type { SkillHarness } from './agent-setup.js'
import { STUDIO_EXTENSIONS_CAPABILITY } from './handshake.js'
import type {
  AgentLaunchPreviewInput,
  AgentLaunchPreviewResult,
  ExtensionScaffoldCreateInput,
  ExtensionScaffoldCreateResult,
  ExtensionScaffoldTarget,
  ExtensionScaffoldTargetInput,
  GithubExtensionInstallInput,
  GithubExtensionResolveResult,
  HostedCardFeedReadResult,
  HostedSourcesFeedReadResult,
  MarketplaceInstallEnvelope,
  MarketplacePluginRegistryInstallInput,
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginUninstallInput,
  MarketplacePluginUninstallResult,
  MarketplacePluginVerifyResult,
  MarketplaceRegistryReadResult,
  MarketplaceUpdateStatesResult,
  PluginAvailabilityResult,
  PluginDetectAvailabilityInput,
  PluginRegistryListResult,
  StudioPluginStatus,
} from './extensions-types.js'

// What a Studio's agents and windows are extended with, beyond the modules it
// runs (`modules.ts`): the marketplace's registry and installing from it or
// from a GitHub repository (`marketplace.*`), the agent CLIs' plugin
// catalogue (`cliPlugins.*`), Studio's own plugin in a workspace
// (`studioPlugin.status`), building a new extension (`extensionScaffold.*`),
// and the hosted feeds the Extensions door draws (`cardFeed.*`,
// `sourcesFeed.get`). Offered as `extensions` where the Studio holds them.
//
// Grants.
// - Reading what could be installed and what can run (the registry, its update
//   states, the feeds, the CLI catalogue) is `providers:read`, as reading the
//   skill sources is. Reading Studio's plugin in a workspace is `files:read`,
//   about a folder a client that is not an owner may name only inside the
//   folders Studio knows.
// - Everything that fetches code to run here, approves it, installs, updates
//   or removes it is an owner's (`STUDIO_MARKETPLACE_OWNER`): reviewing an
//   entry or a repository issues the one-time approval that installs exactly
//   what it disclosed, and only the owner it was disclosed to may spend it.
// - Making an extension project writes a new folder on this machine's disk,
//   outside the folders Studio knows, from the templates beside the app: an
//   owner's (`STUDIO_SCAFFOLD_OWNER`), as the place it would go is.
//
// The installs answer the Studio's own outcome as their result, refusals
// included, under the client's `commandId`; a retry is answered from the
// first attempt. `marketplace.verify` and `marketplace.resolveGithub` issue a
// fresh approval each time and so carry none.

/** Why installing, updating or removing marketplace or GitHub code is an owner's. */
export const STUDIO_MARKETPLACE_OWNER =
  'It fetches an extension’s code from a marketplace or a repository and installs it to run on this machine, approves that, or removes it.'

/** Why making an extension project is an owner's. */
export const STUDIO_SCAFFOLD_OWNER =
  'It reads and writes folders on this machine’s disk outside the ones Studio knows: the extensions home and a new project.'

type Commanded<P> = P & { commandId: string }

export type StudioExtensionsMethodMap = {
  /** The marketplace's registry, from the network when it is due (or `forceRefresh`), else the cache or the seed. */
  'marketplace.read': { params: { forceRefresh?: boolean }; result: MarketplaceRegistryReadResult }
  /** Each installed marketplace or GitHub entry against the registry's latest. */
  'marketplace.updateStates': { params: { forceRefresh?: boolean }; result: MarketplaceUpdateStatesResult }
  /** Review a registry entry: what installing it would do, and the one-time approval that installs exactly that. */
  'marketplace.verify': { params: { id: string }; result: MarketplacePluginVerifyResult }
  /** Install a registry entry under the approval its review issued. */
  'marketplace.install': {
    params: Commanded<MarketplacePluginRegistryInstallInput>
    result: MarketplacePluginRegistryInstallResult
  }
  /** Update an installed registry entry under the approval its review issued. */
  'marketplace.update': {
    params: Commanded<MarketplacePluginRegistryInstallInput>
    result: MarketplacePluginRegistryInstallResult
  }
  /**
   * Remove an installed plugin and everything it put in place: its modules,
   * skill copies and MCP servers. `pluginId` is the plugin's id or one of its
   * modules'.
   */
  'marketplace.uninstall': {
    params: Commanded<MarketplacePluginUninstallInput>
    result: MarketplacePluginUninstallResult
  }
  /** Review a GitHub repository as an extension, and the one-time approval that installs exactly that commit. */
  'marketplace.resolveGithub': { params: { url: string }; result: GithubExtensionResolveResult }
  /** Install a reviewed GitHub repository under its approval. */
  'marketplace.installGithub': {
    params: Commanded<GithubExtensionInstallInput>
    result: MarketplacePluginRegistryInstallResult
  }
  /** Every registered agent CLI, as a client draws it. */
  'cliPlugins.list': { params: Record<string, never>; result: PluginRegistryListResult }
  /** Which registered agent CLIs are installed and runnable on this machine. */
  'cliPlugins.availability': { params: PluginDetectAvailabilityInput; result: PluginAvailabilityResult }
  /** What launching a CLI at these settings would run, rendered by the launch's own function. */
  'cliPlugins.launchPreview': { params: AgentLaunchPreviewInput; result: AgentLaunchPreviewResult }
  /** Studio's own plugin: what this build ships, and what the workspace holds. */
  'studioPlugin.status': { params: { workspaceFolder: string | null }; result: StudioPluginStatus; errors: 'not_found' }
  /** The folder new extension projects go in by default on this machine. */
  'extensionScaffold.home': { params: Record<string, never>; result: { folder: string } }
  /** What is at the folder an extension project would go in; null for a name that is not an id. */
  'extensionScaffold.target': {
    params: ExtensionScaffoldTargetInput
    result: { target: ExtensionScaffoldTarget | null }
  }
  /** Make an extension project from the templates beside the app; nothing that exists is written over. */
  'extensionScaffold.create': {
    params: Commanded<ExtensionScaffoldCreateInput>
    result: ExtensionScaffoldCreateResult
  }
  /** The Extensions home's cards, as this machine holds them (cache, else seed); never waits on the network. */
  'cardFeed.get': { params: Record<string, never>; result: HostedCardFeedReadResult }
  /** The recommended skill sources, as this machine holds them; never waits on the network. */
  'sourcesFeed.get': { params: Record<string, never>; result: HostedSourcesFeedReadResult }
}

export type StudioExtensionsTopicMap = {
  /** A read of the card feed that changed what this machine holds: the new feed. */
  'cardFeed.changed': { params: Record<string, never>; payload: HostedCardFeedReadResult; stream: 'push' }
}

// ── Validation ──────────────────────────────────────────────────────────────

const COMMAND_ID = '"commandId" names this command: a string of 1 to 200 characters.'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0')
}
function id(value: unknown): value is string {
  return text(value, 200)
}
function folder(value: unknown): value is string {
  return text(value, 4096)
}
function strings(value: unknown, max = 50): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every((item) => text(item, 200))
}

function commanded<P>(
  read: (value: Record<string, unknown>) => StudioParsed<P>,
): (value: Record<string, unknown>) => StudioParsed<Commanded<P>> {
  return (value) => {
    if (!id(value.commandId)) return refuse(COMMAND_ID)
    const parsed = read(value)
    return parsed.ok ? studioParams({ ...parsed.params, commandId: value.commandId }) : parsed
  }
}

function refresh(value: Record<string, unknown>): StudioParsed<{ forceRefresh?: boolean }> {
  if (value.forceRefresh !== undefined && typeof value.forceRefresh !== 'boolean')
    return refuse('"forceRefresh" is true or false, when given.')
  return studioParams(value.forceRefresh === true ? { forceRefresh: true } : {})
}

/**
 * Where an install writes beside the module root, as a client may say it. The
 * Studio holds the workspace to one it has open and the harnesses to its own,
 * and its MCP sync normalizes every server; here, only their shapes.
 */
function envelope(value: Record<string, unknown>): StudioParsed<MarketplaceInstallEnvelope> {
  const out: MarketplaceInstallEnvelope = {}
  if (value.workspaceRoot !== undefined && value.workspaceRoot !== null) {
    if (typeof value.workspaceRoot !== 'string' || value.workspaceRoot.length > 4096)
      return refuse('"workspaceRoot" is the open workspace an install writes into, when given.')
    if (value.workspaceRoot.trim()) out.workspaceRoot = value.workspaceRoot
  }
  if (value.mcpSettings !== undefined) {
    if (!record(value.mcpSettings) || !record(value.mcpSettings.servers))
      return refuse('"mcpSettings" is { syncEnabled, servers }, when given.')
    out.mcpSettings = value.mcpSettings as McpSettings
  }
  if (value.mcpClients !== undefined) {
    if (!strings(value.mcpClients)) return refuse('"mcpClients" is a list of CLI ids, when given.')
    out.mcpClients = [...value.mcpClients] as McpClientTarget[]
  }
  if (value.skillHarnesses !== undefined) {
    if (!strings(value.skillHarnesses)) return refuse('"skillHarnesses" is a list of harness ids, when given.')
    out.skillHarnesses = [...value.skillHarnesses] as SkillHarness[]
  }
  return studioParams(out)
}

function registryInstall(value: Record<string, unknown>): StudioParsed<MarketplacePluginRegistryInstallInput> {
  if (!id(value.id)) return refuse('"id" is the registry entry\'s id.')
  if (value.trustToken !== undefined && !text(value.trustToken, 400))
    return refuse('"trustToken" is the approval its review issued, when given.')
  const at = envelope(value)
  if (!at.ok) return at
  return studioParams({
    ...at.params,
    id: value.id,
    ...(value.trustToken !== undefined ? { trustToken: value.trustToken } : {}),
  })
}

function uninstall(value: Record<string, unknown>): StudioParsed<MarketplacePluginUninstallInput> {
  if (!id(value.pluginId)) return refuse('"pluginId" is the plugin\'s id, or one of its modules\'.')
  const at = envelope(value)
  if (!at.ok) return at
  return studioParams({ ...at.params, pluginId: value.pluginId })
}

function githubInstall(value: Record<string, unknown>): StudioParsed<GithubExtensionInstallInput> {
  if (!text(value.trustToken, 400)) return refuse('"trustToken" is the approval the repository\'s review issued.')
  if (value.trustCode !== undefined && typeof value.trustCode !== 'boolean')
    return refuse('"trustCode" is true or false, when given.')
  const at = envelope(value)
  if (!at.ok) return at
  return studioParams({
    ...at.params,
    trustToken: value.trustToken,
    ...(value.trustCode === true ? { trustCode: true } : {}),
  })
}

function runtimeOverride(value: unknown): boolean {
  return record(value)
}

function availability(value: Record<string, unknown>): StudioParsed<PluginDetectAvailabilityInput> {
  const out: PluginDetectAvailabilityInput = {}
  if (value.cliRuntimes !== undefined) {
    if (!record(value.cliRuntimes) || !Object.values(value.cliRuntimes).every(runtimeOverride))
      return refuse('"cliRuntimes" is each CLI\'s runtime settings by its id, when given.')
    out.cliRuntimes = value.cliRuntimes as PluginDetectAvailabilityInput['cliRuntimes']
  }
  if (value.force !== undefined && typeof value.force !== 'boolean') return refuse('"force" is true or false.')
  if (value.force === true) out.force = true
  return studioParams(out)
}

function launchPreview(value: Record<string, unknown>): StudioParsed<AgentLaunchPreviewInput> {
  if (!id(value.cli)) return refuse('"cli" is the agent CLI\'s id.')
  const out: AgentLaunchPreviewInput = { cli: value.cli }
  for (const key of ['cliModel', 'cliReasoning', 'cliPermissionMode'] as const) {
    const member = value[key]
    if (member === undefined) continue
    if (typeof member !== 'string' || member.length > 400) return refuse(`"${key}" is a string, when given.`)
    out[key] = member
  }
  if (value.cliPermissionPreset !== undefined) {
    if (typeof value.cliPermissionPreset !== 'string') return refuse('"cliPermissionPreset" is a preset, when given.')
    out.cliPermissionPreset = value.cliPermissionPreset as AgentLaunchPreviewInput['cliPermissionPreset']
  }
  if (value.cliRuntime !== undefined) {
    if (!record(value.cliRuntime)) return refuse('"cliRuntime" is the CLI\'s runtime settings, when given.')
    out.cliRuntime = value.cliRuntime as AgentLaunchPreviewInput['cliRuntime']
  }
  return studioParams(out)
}

function scaffoldTarget(value: Record<string, unknown>): StudioParsed<ExtensionScaffoldTargetInput> {
  if (typeof value.id !== 'string' || value.id.length > 200) return refuse('"id" is the extension\'s module id.')
  const out: ExtensionScaffoldTargetInput = { id: value.id }
  if (value.folder !== undefined) {
    if (!folder(value.folder)) return refuse('"folder" is the extension\'s own folder, when given.')
    out.folder = value.folder
  }
  if (value.parentDir !== undefined) {
    if (!folder(value.parentDir)) return refuse('"parentDir" is the folder a new project goes in, when given.')
    out.parentDir = value.parentDir
  }
  return studioParams(out)
}

function scaffoldCreate(value: Record<string, unknown>): StudioParsed<ExtensionScaffoldCreateInput> {
  const target = scaffoldTarget(value)
  if (!target.ok) return target
  if (value.ideaMarkdown === undefined) return target
  if (typeof value.ideaMarkdown !== 'string' || value.ideaMarkdown.length > 200_000)
    return refuse('"ideaMarkdown" is the project\'s IDEA.md, when given.')
  return studioParams({ ...target.params, ideaMarkdown: value.ideaMarkdown })
}

// ── The table ───────────────────────────────────────────────────────────────

const reads = (scope: 'providers:read' | 'files:read') =>
  ({ scope, mutation: false, capability: STUDIO_EXTENSIONS_CAPABILITY }) as const
const marketplaceOwner = (mutation: boolean) =>
  ({
    scope: 'environment:maintain',
    mutation,
    capability: STUDIO_EXTENSIONS_CAPABILITY,
    owner: STUDIO_MARKETPLACE_OWNER,
  }) as const
const scaffoldOwner = (mutation: boolean) =>
  ({ scope: 'files:write', mutation, capability: STUDIO_EXTENSIONS_CAPABILITY, owner: STUDIO_SCAFFOLD_OWNER }) as const

export const STUDIO_EXTENSIONS_METHODS: StudioMethodTable<StudioExtensionsMethodMap> = {
  'marketplace.read': { ...reads('providers:read'), params: refresh },
  'marketplace.updateStates': { ...reads('providers:read'), params: refresh },
  'marketplace.verify': {
    ...marketplaceOwner(false),
    params: (value) => (id(value.id) ? studioParams({ id: value.id }) : refuse('"id" is the registry entry\'s id.')),
  },
  'marketplace.install': { ...marketplaceOwner(true), params: commanded(registryInstall) },
  'marketplace.update': { ...marketplaceOwner(true), params: commanded(registryInstall) },
  'marketplace.uninstall': { ...marketplaceOwner(true), params: commanded(uninstall) },
  'marketplace.resolveGithub': {
    ...marketplaceOwner(false),
    params: (value) =>
      text(value.url, 2048) && value.url.trim()
        ? studioParams({ url: value.url })
        : refuse('"url" is the GitHub repository\'s address.'),
  },
  'marketplace.installGithub': { ...marketplaceOwner(true), params: commanded(githubInstall) },
  'cliPlugins.list': { ...reads('providers:read'), params: studioNoParams },
  'cliPlugins.availability': { ...reads('providers:read'), params: availability },
  'cliPlugins.launchPreview': { ...reads('providers:read'), params: launchPreview },
  'studioPlugin.status': {
    ...reads('files:read'),
    params: (value) =>
      value.workspaceFolder === null || value.workspaceFolder === undefined || folder(value.workspaceFolder)
        ? studioParams({ workspaceFolder: (value.workspaceFolder ?? null) as string | null })
        : refuse('"workspaceFolder" is the workspace\'s folder, or null.'),
  },
  'extensionScaffold.home': { ...scaffoldOwner(false), params: studioNoParams },
  'extensionScaffold.target': { ...scaffoldOwner(false), params: scaffoldTarget },
  'extensionScaffold.create': { ...scaffoldOwner(true), params: commanded(scaffoldCreate) },
  'cardFeed.get': { ...reads('providers:read'), params: studioNoParams },
  'sourcesFeed.get': { ...reads('providers:read'), params: studioNoParams },
}

export const STUDIO_EXTENSIONS_TOPICS: StudioTopicTable<StudioExtensionsTopicMap> = {
  'cardFeed.changed': {
    scope: 'providers:read',
    capability: STUDIO_EXTENSIONS_CAPABILITY,
    push: true,
    params: studioNoParams,
  },
}
