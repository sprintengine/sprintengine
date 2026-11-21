import type {
  AgentCli,
  CliPermissionPreset,
  CliRuntimeSettings,
  McpClientTarget,
  McpServerConfig,
  McpSettings,
  McpTransport,
} from './agents.js'
import type { SkillHarness } from './agent-setup.js'
import type { CardAction } from './agent-skills.js'
import type { StudioModuleTrustStatus } from './providers.js'

// The shapes the extensions family (`extensions.ts`) and the module family's
// listing (`modules.ts`) carry: an installed extension as its Studio holds it,
// the marketplace's registry and what installing from it did, the hosted
// feeds, the agent CLIs' plugin catalogue and the extension scaffold.
// `src/shared` re-exports each under the name the app has always used.

// ── Modules ─────────────────────────────────────────────────────────────────

export type CapabilityCategory =
  'core' | 'dev-tools' | 'vcs' | 'orchestration' | 'insight' | 'connectivity' | (string & {})

/** Where a module came from. Absent means 'bundled' (first-party, compiled in). */
export type ModuleSource = 'bundled' | 'third-party'

/**
 * A detached signature over the canonical manifest (signature field excluded).
 * `publicKey` is the signer's ed25519 public key, base64 SPKI/DER; `signature`
 * is base64.
 */
export type ModuleSignature = {
  algorithm: 'ed25519'
  publicKey: string
  signature: string
}

/**
 * sha256 digests of an extension's own files: POSIX path relative to its
 * folder → lowercase hex, every regular file but extension.sig.
 */
export type ModuleFileDigests = Record<string, string>

/**
 * A module as a Studio lists it: one of its own, or an installed extension
 * (its install key as the id, its extension.json's name and version).
 */
export type CapabilityManifest = {
  id: string
  displayName: string
  /** A built-in module's integer, or an extension's semver. */
  version: number | string
  publisher?: string
  category?: CapabilityCategory
  summary?: string
  /** Whether the module loads when the user has expressed no preference. */
  defaultEnabled: boolean
  /** Always enabled; cannot be turned off in the chooser. */
  core?: boolean
  /** Capability ids this module needs loaded (and enabled) before it can load. */
  dependsOn?: string[]
  /** Capability ids that must not be enabled at the same time as this one. */
  conflictsWith?: string[]
  /** Provenance. Absent ⇒ bundled first-party. */
  source?: ModuleSource
  /** The permissions an extension asks for (shown when the person approves it). */
  permissions?: string[]
  /** A plugin bundle's detached signature over its manifest. */
  signature?: ModuleSignature
}

// ── extension.json, as a Studio serves it ───────────────────────────────────
// The SDK's `ExtensionManifest` (packages/extension-sdk/src/extension-manifest.ts),
// already validated by the Studio that sends it. Mirrored here so this package
// stays self-contained; the SDK drift guard holds the two identical.

export type ExtensionTierView = 'content' | 'declarative' | 'ui' | 'worker'
export type ExtensionCommandContributionView = {
  id: string
  title: string
  when?: 'global' | 'workspace'
  action?: string
}
export type ExtensionMenuContributionView = { where: 'backlog.item' | 'file' | 'notification'; command: string }
export type ExtensionTopBarItemContributionView = {
  id: string
  title: string
  icon?: string
  command?: string
  door?: string
}
export type ExtensionSurfaceContributionView = { id: string; title: string; icon?: string; entry: string }
export type ExtensionMcpToolContributionView = { name: string; description: string; access: 'read' | 'operate' }
export type ExtensionContributionsView = {
  commands: ExtensionCommandContributionView[]
  menus: ExtensionMenuContributionView[]
  topBarItems: ExtensionTopBarItemContributionView[]
  panels: ExtensionSurfaceContributionView[]
  doors: ExtensionSurfaceContributionView[]
  settingsSections: ExtensionSurfaceContributionView[]
  mcpTools: ExtensionMcpToolContributionView[]
}
export type ExtensionManifestView = {
  manifestVersion: 1
  id: string
  version: string
  engines: { studio: string }
  tier: ExtensionTierView
  name: string
  description?: string
  icon?: string
  cover?: string
  screenshots?: string[]
  license?: string
  repository?: string
  homepage?: string
  permissions: string[]
  main?: string
  background?: boolean
  contributes: ExtensionContributionsView
}

/** Why a module that wanted to load cannot, as the enablement resolver says. */
export type ModuleResolutionErrorCode =
  | 'duplicate_id'
  | 'missing_dependency'
  | 'disabled_dependency'
  | 'conflict'
  | 'dependency_cycle'
  /** An extension the person switched on but has not approved as it is now. */
  | 'unapproved'
  /** A third-party module whose signature or files failed verification. */
  | 'invalid_signature'

export type ThirdPartyModuleLaunchStatus =
  /** Approved (or content only), with a worker. */
  | 'runs_worker'
  /** Approved (or content only), with nothing that runs in the background. */
  | 'runs_without_worker'
  /** Waiting for the person's approval. */
  | 'awaiting_approval'
  /** Its signature or its files are broken; it never runs. */
  | 'blocked_invalid'
  | 'launch_error'

/**
 * Whether an extension's surfaces (the `entry` of its panels, doors and
 * settings sections) can be drawn in frames: `none`, it declares none;
 * `blocked`, it is not approved (or broken); `error`, declared and approved but refused
 * (outside the folder, missing, changed); `available`, servable.
 */
export type ThirdPartyRendererEntryAvailability = 'none' | 'blocked' | 'error' | 'available'

export type ThirdPartyRendererEntryView = {
  availability: ThirdPartyRendererEntryAvailability
  /** A sentence for the person; never an absolute path. */
  message?: string
}

export type ThirdPartyModuleLaunchView = {
  status: ThirdPartyModuleLaunchStatus
  hasMainEntry: boolean
  expectedToLoad: boolean
  message?: string
  /** Whether its worker (`main`) loaded in this server run; absent reads as not loaded. */
  mainLoaded?: boolean
  /** Whether its surfaces' entries can be drawn. */
  rendererEntry?: ThirdPartyRendererEntryView
}

/**
 * Whether the person approved an extension as it is now. Content only needs
 * no approval; anything else is `pending` until the person approves its
 * `fingerprint` (what it may do, and its files). `growth` is there when an
 * earlier version was approved: what this one asks for beyond it, in words,
 * empty when it asks for nothing new. `unavailable`: its files cannot all be
 * read, so there is nothing to approve.
 */
export type StudioExtensionApproval =
  | { state: 'not-needed' }
  | { state: 'unavailable' }
  | { state: 'approved'; fingerprint: string }
  | { state: 'pending'; fingerprint: string; growth?: string[] }

/** One installed extension, as its Studio holds it. */
export type ThirdPartyModuleView = {
  /** Its install key as the id, with its extension.json's name and version. */
  manifest: CapabilityManifest
  /** Its extension.json. */
  extension: ExtensionManifestView
  /** Whether the person approved it as it is now (modules.ts). */
  approval: StudioExtensionApproval
  /**
   * Its signature: `verified` by a publisher key Studio trusts, `signed` by
   * another, `unsigned`, or `invalid` (it never runs). A badge: only the
   * person's approval lets it run.
   */
  signature: 'verified' | 'signed' | 'unsigned' | 'invalid'
  /** sha256 of the signer's public key, when signed. */
  signer?: string
  launch: ThirdPartyModuleLaunchView
  /** Names of the MCP tools its main half registered this server run. */
  mcpTools?: string[]
}

export type ModuleManifestIssue = { path: string; message: string }

/**
 * `extension.installed`: every installed extension, and the folders that hold
 * none Studio could read. A folder's `path` is its place on that disk (the
 * folder or its `extension.json`) for a connection that may name any path (an
 * owner's own); anyone else is told the folder's name, and an issue's words
 * name the folder rather than its place.
 */
export type ThirdPartyModuleListResult = {
  modules: ThirdPartyModuleView[]
  rejected: Array<{ path: string; issues: ModuleManifestIssue[] }>
}

/** One approved extension, as a client registers what it adds. */
export type ExtensionContributions = {
  /** Its install key. */
  id: string
  manifest: CapabilityManifest
  extension: ExtensionManifestView
}

/**
 * `extension.contributions`: what each approved extension adds to a client,
 * as its extension.json declares it (no code: its surfaces are drawn in
 * frames, `extension.frame`), and why each other one with surfaces is not offered.
 */
export type ExtensionContributionsResult = {
  extensions: ExtensionContributions[]
  /** By module id, a sentence (never a path); extensions waiting for approval are not listed. */
  failures: Record<string, string>
}

/** `extension.frame`: the document one surface is drawn from. */
export type ExtensionFrameDocument = {
  /** `sha256-<hex>` of `html`: where a browser loads it (`/ext-frame/<hash>`), and what a desktop window stages. */
  hash: string
  /** The whole document: Studio's bootstrap, its theme and kit, and the extension's entry. */
  html: string
}

/** Which build a window's module registry was taken in. */
export type ModuleBuildChannel = 'development' | 'production'

/** What a module contributes to a window, by surface kind: ids only. */
export type ModuleContributedSurfaces = {
  workspaceTypes: string[]
  globalSurfaces: string[]
  modalSurfaces: string[]
  sidebarNavEntries: string[]
  settingsSections: string[]
  commands: string[]
  topBarItems: string[]
  backlogItemActions: string[]
}

/** Why a module in a window's registry is not active: the person's switch, or the resolver's code. */
export type ModuleAbsence = {
  reason: 'disabled' | ModuleResolutionErrorCode
  message: string
}

export type ModuleRegistryEntry = {
  id: string
  manifest: CapabilityManifest
  source: ModuleSource
  enabled: boolean
  /** Null when the module is enabled. */
  absence: ModuleAbsence | null
  surfaces: ModuleContributedSurfaces
}

/**
 * The module registry a window resolved, extensions' contributions included,
 * which the Studio's `extension.*` agent tools report from. Valid for the window's session.
 */
export type ModuleRegistrySnapshot = {
  /** Epoch ms the window captured it at. */
  capturedAt: number
  channel: ModuleBuildChannel
  modules: ModuleRegistryEntry[]
}

/** The answer to `extension.reportRegistry`: refused with why when the snapshot is not one. */
export type ModuleRegistrySnapshotWriteResult = { ok: boolean; message?: string }

// ── The marketplace ─────────────────────────────────────────────────────────

/** What a marketplace bundle carries; the module SDK's `MarketplaceComponentKind`. */
export type MarketplaceComponentKind = 'mcp' | 'skills'

/** What a registry entry may say it provides: a bundle's kinds, or `cli` for an agent CLI the app ships. */
export type MarketplaceProvidesKind = MarketplaceComponentKind | 'cli'

export type MarketplaceManifestIssue = { path: string; message: string }

export type MarketplacePublisher = {
  name: string
  verified: boolean
}

/** Digest of one file inside a bundled skill payload. */
export type MarketplacePluginSkillFile = {
  /** Posix path relative to the skill folder. */
  path: string
  /** Lowercase hex sha256 of the file bytes. */
  sha256: string
  size: number
}

/** One Agent Skill a plugin bundles. Without `files` it is display metadata only. */
export type MarketplacePluginSkill = {
  name: string
  description: string
  path?: string
  files?: MarketplacePluginSkillFile[]
  contentDigest?: string
}

/**
 * A registry entry: a bundle (has `source`), an inline MCP server list (has
 * `mcp`), or an agent CLI the app ships (has `cli`).
 */
export type MarketplacePluginEntry = {
  id: string
  name: string
  publisher: MarketplacePublisher
  summary: string
  category: string
  categories?: string[]
  tags?: string[]
  icon: string
  latest: number
  provides: MarketplaceProvidesKind[]
  source?: string
  signature?: ModuleSignature
  mcp?: { servers: McpServerConfig[] }
  cli?: { pluginId: string }
  skills?: MarketplacePluginSkill[]
}

export type MarketplaceIndex = {
  schemaVersion: 1
  plugins: MarketplacePluginEntry[]
}

export type MarketplaceRegistryState = 'ok' | 'empty' | 'offline' | 'fetch-error' | 'invalid-schema'

export type MarketplaceRegistryReadInput = {
  forceRefresh?: boolean
}

export type MarketplaceRegistryReadResult =
  | {
      ok: true
      state: 'ok' | 'empty'
      registryUrl: string
      source: 'network' | 'cache' | 'bundled'
      stale: false
      fetchedAt: string
      etag?: string
      notModified?: boolean
      marketplace: MarketplaceIndex
    }
  | {
      ok: true
      state: 'offline'
      registryUrl: string
      source: 'cache' | 'seed'
      stale: boolean
      fetchedAt: string
      etag?: string
      marketplace: MarketplaceIndex
      message: string
    }
  | {
      ok: false
      state: Exclude<MarketplaceRegistryState, 'ok' | 'empty'>
      registryUrl: string
      stale: false
      message: string
      statusCode?: number
      issues?: MarketplaceManifestIssue[]
    }

export type ModuleUpdateState = 'current' | 'update-available' | 'ahead-of-registry'

export type MarketplaceUpdateAvailability =
  | { state: ModuleUpdateState; installedVersion: number; latestVersion: number }
  | { state: 'unknown'; installedVersion: number; reason: 'registry-unreachable' | 'not-in-registry' }

export type MarketplaceUpdateStateEntry = {
  id: string
  displayName: string
  availability: MarketplaceUpdateAvailability
}

/**
 * Each installed entry against the registry. `checked: false` is "could not
 * check": the registry read failed, so every entry says `unknown`, never
 * current. `ok: false` is a local failure (the receipts could not be read).
 */
export type MarketplaceUpdateStatesResult =
  | {
      ok: true
      checked: true
      registryState: MarketplaceRegistryState
      registrySource: 'network' | 'cache' | 'bundled' | 'seed'
      stale: boolean
      fetchedAt: string
      registryMessage?: string
      entries: MarketplaceUpdateStateEntry[]
    }
  | {
      ok: true
      checked: false
      registryState: MarketplaceRegistryState
      registryMessage?: string
      entries: MarketplaceUpdateStateEntry[]
    }
  | { ok: false; message: string }

/**
 * Where an install writes beside the module root: the workspace an MCP or
 * skill component goes into (one the Studio has open), the MCP settings and
 * CLIs it syncs, and the skill harnesses.
 */
export type MarketplaceInstallEnvelope = {
  workspaceRoot?: string
  mcpSettings?: McpSettings
  mcpClients?: McpClientTarget[]
  skillHarnesses?: SkillHarness[]
}

/**
 * A registry install: which entry, and the one-time token `marketplace.verify`
 * issued for what it disclosed. The entry is resolved by the Studio, never
 * taken from the client. An entry that needs no approval installs without one.
 */
export type MarketplacePluginRegistryInstallInput = MarketplaceInstallEnvelope & {
  id: string
  trustToken?: string
}

export type MarketplacePluginVerifyInput = { id: string }

/** The content a trust review disclosed, pinned so the install refuses anything else. */
export type MarketplaceTrustPin = {
  commitSha?: string
  manifestSha256: string
  componentDigests: Record<string, string>
}

/** An MCP server as an install would write it: never the values of its environment or headers. */
export type MarketplaceMcpServerDisclosure = {
  id: string
  name: string
  transport: McpTransport
  command?: string
  args: string[]
  url?: string
  envKeys: string[]
  headerKeys: string[]
}

/** A GitHub repository an extension is installed from, as the person named it. */
export type GithubExtensionOrigin = {
  url: string
  owner: string
  repo: string
  ref?: string
}

export type MarketplaceInstallSource = { kind: 'registry' } | ({ kind: 'github'; sha: string } & GithubExtensionOrigin)

export type MarketplacePluginTrustClassification = 'verified' | 'community' | 'unsigned' | 'invalid'

export type MarketplacePluginVerifyResult = {
  classification: MarketplacePluginTrustClassification
  permissions: string[]
  sourceUrl: string
  issues?: MarketplaceManifestIssue[]
  message?: string
  /** The files a skill payload installs, disclosed at the review. */
  files?: string[]
  /** Every MCP server the install would add. */
  mcpServers?: MarketplaceMcpServerDisclosure[]
  /** The signer's key fingerprint (sha256 of the public key), when signed. */
  keyFingerprint?: string
  /** What was disclosed, and the one-time token that installs exactly that; absent when nothing may be approved. */
  pin?: MarketplaceTrustPin
  trustToken?: string
}

export type GithubExtensionResolveInput = { url: string }

export type GithubExtensionReviewChange = 'permissions' | 'mcp' | 'classification' | 'source'

export type GithubExtensionInstalledState = {
  version: number
  sha?: string
  /** What differs from what was approved last time; empty means nothing new to approve. */
  changes: GithubExtensionReviewChange[]
}

export type GithubExtensionPreview = {
  id: string
  displayName: string
  version: number
  publisher: { name: string; verified: boolean }
  summary: string
  provides: MarketplaceComponentKind[]
  origin: GithubExtensionOrigin
  verify: MarketplacePluginVerifyResult & { classification: 'verified' | 'community' | 'unsigned' }
  installed?: GithubExtensionInstalledState
}

export type GithubExtensionResolveResult =
  | { ok: true; preview: GithubExtensionPreview; trustToken: string }
  | { ok: false; message: string; issues?: MarketplaceManifestIssue[]; skillSource?: boolean }

export type GithubExtensionInstallInput = MarketplaceInstallEnvelope & {
  trustToken: string
}

export type MarketplacePluginUninstallInput = MarketplaceInstallEnvelope & { pluginId: string }

export type MarketplacePluginInstalledComponent = {
  kind: MarketplaceComponentKind
  id: string
  message?: string
  serverIds?: string[]
  servers?: McpServerConfig[]
  harnesses?: SkillHarness[]
  installedDirName?: string
}

export type MarketplacePluginInstallResult =
  | {
      ok: true
      id: string
      displayName: string
      version: number
      trust: StudioModuleTrustStatus
      loadEligible: boolean
      installed: MarketplacePluginInstalledComponent[]
      mcpSettings?: McpSettings
      /** What a successful install left undone, said to the person. */
      notices?: string[]
    }
  | {
      ok: false
      message: string
      component?: MarketplaceComponentKind
      issues?: Array<{ path: string; message: string }>
      installed?: MarketplacePluginInstalledComponent[]
      trust?: StudioModuleTrustStatus
      loadEligible?: boolean
    }

export type MarketplacePluginRegistryInstallResult =
  | (Extract<MarketplacePluginInstallResult, { ok: true }> & {
      classification: Extract<MarketplacePluginTrustClassification, 'verified' | 'community' | 'unsigned'>
      sourceUrl: string
      updated: boolean
    })
  | (Extract<MarketplacePluginInstallResult, { ok: false }> & {
      classification?: MarketplacePluginTrustClassification
      sourceUrl?: string
      updated?: boolean
    })

export type MarketplacePluginUninstallResult =
  | {
      ok: true
      id: string
      removed: MarketplacePluginInstalledComponent[]
      mcpSettings?: McpSettings
    }
  | {
      ok: false
      message: string
      removed?: MarketplacePluginInstalledComponent[]
      mcpSettings?: McpSettings
    }

// ── The hosted feeds ────────────────────────────────────────────────────────

export type HostedSourceKind = 'claude-marketplace' | 'skills'

export type HostedSource = {
  /** Stable id for the row itself. */
  id: string
  /** `owner/name`: a repository, never a URL. */
  repo: string
  kind: HostedSourceKind
  description: string
}

export type HostedSourcesFeed = {
  schemaVersion: 1
  updatedAt: string
  sources: HostedSource[]
}

export type HostedSourcesFeedReadResult =
  | {
      ok: true
      state: 'ok' | 'degraded'
      feedUrl: string
      source: 'network' | 'cache' | 'seed'
      fetchedAt: string
      etag?: string
      notModified?: boolean
      changed: boolean
      feed: HostedSourcesFeed
      message?: string
    }
  | {
      ok: false
      state: 'offline' | 'fetch-error' | 'invalid-schema'
      feedUrl: string
      statusCode?: number
      message: string
    }

export type HostedCardKind = 'mcp' | 'skill' | 'plugin' | 'showcase'

export type HostedCard = {
  slug: string
  kind: HostedCardKind
  title: string
  dek: string
  credit?: string
  /** The name of an artwork the app ships, never a URL. */
  art: string
  publishedAt: string
  hero?: boolean
  /** What Go does, in order. */
  go: CardAction[]
}

export type HostedCardFeed = {
  schemaVersion: 1
  updatedAt: string
  cards: HostedCard[]
}

export type HostedCardFeedReadResult =
  | {
      ok: true
      state: 'ok' | 'degraded'
      feedUrl: string
      source: 'network' | 'cache' | 'seed'
      fetchedAt: string
      etag?: string
      notModified?: boolean
      /** This read wrote a different copy to the disk cache. */
      changed: boolean
      feed: HostedCardFeed
      /** Rows the schema gate refused inside an otherwise good body, and why. */
      dropped?: number
      dropReasons?: string[]
      message?: string
    }
  | {
      ok: false
      state: 'offline' | 'fetch-error' | 'invalid-schema'
      feedUrl: string
      statusCode?: number
      message: string
    }

// ── The agent CLIs' plugin catalogue ────────────────────────────────────────

export type PluginSource = 'bundled' | 'user'
export type PluginSkillSupport = 'native' | 'prompt-shim' | 'unsupported'
export type PluginSkillInstallScope = 'workspace' | 'user'
export type PluginSkillFormat = 'agent-skills-v1' | 'claude-code' | 'codex' | 'opencode' | 'generic'

export type PluginSkillInvocation = {
  fileDropTemplate?: string
  explicitTemplate?: string
  nativeSlashCommand?: boolean
  explicitMention?: boolean
  implicitInvocation?: boolean
  /** The character a person types to name a skill mid-prompt; absent for a CLI with no in-prompt form. */
  mentionPrefix?: string
  /** What a picked skill inserts at the caret; defaults to `{{mentionPrefix}}{{skillId}}`. */
  mentionTemplate?: string
}

export type PluginModelOption = { id: string; label?: string }
export type PluginReasoningOption = { id: string; label?: string }

/**
 * A CLI that takes a model id at launch, and whether a typed id is allowed. It
 * names no models: a picker's rows are what the CLI reports about itself and
 * the ids the person added in Settings.
 */
export type PluginModelSelection = {
  allowCustomId: boolean
}

/** A CLI's model choices, and whether a free-text id is allowed. */
export type PluginModelCatalog = {
  options: PluginModelOption[]
  allowCustomId: boolean
}

/** A CLI's reasoning levels, and which is its default. */
export type PluginReasoningCatalog = {
  levels: PluginReasoningOption[]
  default?: string
}

export type PluginSkillCatalogTarget = {
  scope: PluginSkillInstallScope
  path: string
  format: PluginSkillFormat
  restartRequired: boolean
}

export type PluginSkillCatalog = {
  support: PluginSkillSupport
  harnessId: string
  installTargets: PluginSkillCatalogTarget[]
  invocation?: PluginSkillInvocation
}

/** One of a CLI's permission modes under its own name. */
export type CliPermissionModeSpec = {
  /** Stable. A generic preset's name for the mode that stands for that preset. */
  id: string
  /** The CLI's own name for it. */
  label: string
  summary?: string
  description?: string
  level: CliPermissionPreset
  /** The CLI declares this mode read-only. */
  readOnly?: true
}

/** One registered agent CLI, as a client draws it: its argv stays the Studio's. */
export type PluginRegistryListEntry = {
  id: string
  displayName: string
  source: PluginSource
  version: number
  binary: string
  resumeSession: boolean
  sessionIdFromCaller: boolean
  /** Whether the CLI reports its agent state through hooks; a false one is not offered as an agent. */
  agentStateCapable: boolean
  modelSelection?: PluginModelSelection
  reasoningSelection?: PluginReasoningCatalog
  /** Another CLI's binary pointed at another provider's endpoint. */
  hostedVia?: 'claude-code'
  skillIntegration?: PluginSkillCatalog
  /** Present when the CLI takes a credential: the label of its key row, never the key. */
  auth?: { label: string }
  permissionPresets?: CliPermissionPreset[]
  permissionModes?: CliPermissionModeSpec[]
}

export type PluginRegistryListResult = { ok: true; plugins: PluginRegistryListEntry[] } | { ok: false; message: string }

/** Whether one agent CLI's binary is installed and runnable on the Studio's machine. */
export type CliAvailability = {
  cli: AgentCli
  installed: boolean
  resolvedPath: string | null
  version: string | null
}

export type AgentCliAvailabilityMap = Record<AgentCli, CliAvailability>

export type PluginAvailabilityResult =
  { ok: true; availability: AgentCliAvailabilityMap } | { ok: false; message: string }

/** Per-CLI runtime overrides a probe runs against; `force` skips the cache (after an install). */
export type PluginDetectAvailabilityInput = {
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
  force?: boolean
}

/** What a launch of a CLI at these settings would run, rendered by the launch's own function. */
export type AgentLaunchPreviewInput = {
  cli: AgentCli
  cliModel?: string
  cliReasoning?: string
  cliPermissionPreset?: CliPermissionPreset
  /** The CLI's own mode at that preset, when it is not the preset's own. */
  cliPermissionMode?: string
  cliRuntime?: CliRuntimeSettings
}

export type AgentLaunchPreview = {
  /** The resolved command: a path when the runtime override names one. */
  binary: string
  args: string[]
  /** Binary and args as one posix-quoted line. */
  display: string
}

export type AgentLaunchPreviewResult = { ok: true; preview: AgentLaunchPreview } | { ok: false; message: string }

/**
 * The catalogue's row for Studio's own plugin in a workspace: what this build
 * ships, and what the workspace holds ('' until installed there).
 */
export type StudioPluginStatus = {
  bundledVersion: string
  installedVersion: string
  skillDirNames: string[]
  claudePluginKey: string
  /** ISO timestamp the hooks acknowledgement was answered, '' when it has not been. */
  hooksAcknowledgedAt: string
}

// ── Building an extension ───────────────────────────────────────────────────

/**
 * What is at an extension's folder: `free` (nothing, or an empty folder),
 * `extension` (a project with a module manifest), `taken` (anything else,
 * never written over), `installed` (free, but an extension with that id is
 * installed), or `no_parent`.
 */
export type ExtensionScaffoldTargetState = 'free' | 'extension' | 'taken' | 'installed' | 'no_parent'

export type ExtensionScaffoldTargetInput = {
  /** The extension's own folder, picked by the person; its name is the id. */
  folder?: string
  /** The folder a new `<parentDir>/<id>` is made inside; with neither, the extensions home. */
  parentDir?: string
  /** The module id, and the new folder's name. */
  id: string
}

export type ExtensionScaffoldTarget = { state: ExtensionScaffoldTargetState; folder: string }

export type ExtensionScaffoldCreateInput = ExtensionScaffoldTargetInput & {
  /** Written as the project's IDEA.md. */
  ideaMarkdown?: string
}

export type ExtensionScaffoldCreateResult =
  | { ok: true; folder: string; existing: boolean; notes?: string[] }
  | {
      ok: false
      code:
        | 'invalid_input'
        | 'invalid_id'
        | 'no_parent'
        | 'dir_not_empty'
        | 'installed'
        | 'unknown_template'
        | 'io_error'
        | 'unknown_part'
        | 'already_present'
      message: string
    }
