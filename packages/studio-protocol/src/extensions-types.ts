import type { AgentCli, CliPermissionPreset, CliRuntimeSettings } from './agents.js'
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
  /** A detached signature over the manifest, when one was published. */
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
export type ExtensionSyntaxContributionView = {
  id: string
  title: string
  scopeName: string
  path: string
  configuration?: string
  extensions?: string[]
  filenames?: string[]
}
/** A custom editor: a surface that opens the files it names (`extension-editors`). */
export type ExtensionCustomEditorContributionView = ExtensionSurfaceContributionView & {
  extensions?: string[]
  filenames?: string[]
  priority?: 'default' | 'option'
  contentKind?: 'text' | 'bytes'
}
export type ExtensionKeybindingContributionView = { command: string; key: string; when?: 'global' | 'workspace' }
export type ExtensionStatusBarItemContributionView = {
  id: string
  text?: string
  icon?: string
  tooltip?: string
  command?: string
}
export type ExtensionSettingValueView = string | number | boolean
export type ExtensionSettingContributionView = {
  key: string
  title: string
  description?: string
  type: 'string' | 'number' | 'integer' | 'boolean'
  default?: ExtensionSettingValueView
  enum?: ExtensionSettingValueView[]
  enumLabels?: string[]
  minimum?: number
  maximum?: number
  maxLength?: number
  multiline?: boolean
  placeholder?: string
}
/** A point the extension's worker hooks, and whether its failure refuses the action. */
export type ExtensionHookContributionView = { point: string; onError?: 'pass' | 'deny' }
/** A Studio event an extension's worker hears (`workspace.created`, `agent.status.changed`, …). */
export type ExtensionEventContributionView = { on: string }
/** A skill an extension hands agents: a folder holding a SKILL.md. */
export type ExtensionSkillContributionView = { id: string; path: string }
/** An MCP server an extension hands agents: a local command (`stdio`) or a hosted server (`http`). */
export type ExtensionMcpServerContributionView = {
  id: string
  name: string
  description?: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Array<{ name: string; value: string }>
  url?: string
}
/** An OpenAI-compatible model provider an extension adds to chats. */
export type ExtensionProviderContributionView = {
  id: string
  name: string
  baseUrl: string
  chatCompletionsPath?: string
  modelsPath?: string
  models: Array<{ id: string; name?: string }>
  apiKey?: { label: string }
}
export type ExtensionContributionsView = {
  commands: ExtensionCommandContributionView[]
  menus: ExtensionMenuContributionView[]
  topBarItems: ExtensionTopBarItemContributionView[]
  panels: ExtensionSurfaceContributionView[]
  doors: ExtensionSurfaceContributionView[]
  settingsSections: ExtensionSurfaceContributionView[]
  mcpTools: ExtensionMcpToolContributionView[]
  hooks: ExtensionHookContributionView[]
  events: ExtensionEventContributionView[]
  syntaxes: ExtensionSyntaxContributionView[]
  customEditors: ExtensionCustomEditorContributionView[]
  keybindings: ExtensionKeybindingContributionView[]
  statusBarItems: ExtensionStatusBarItemContributionView[]
  settings: ExtensionSettingContributionView[]
  skills: ExtensionSkillContributionView[]
  mcpServers: ExtensionMcpServerContributionView[]
  providers: ExtensionProviderContributionView[]
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
  /** The kill list holds this version: it is switched off and what it added is retracted. */
  | 'killed'
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
  /** Whether this server run holds its worker (`main`), running or ready to start; absent reads as not. */
  mainLoaded?: boolean
  /** Why its worker waits to start (too many run at once), while it does. */
  waiting?: string
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
  /**
   * By skill id, the frontmatter keys its SKILL.md holds that agents are not
   * handed (anything but `name` and `description`), for the install review to
   * list as ignored. Absent when there are none.
   */
  ignoredSkillKeys?: Record<string, string[]>
  /**
   * A development folder the owner registered: loaded from where it is and
   * read again on every save (`extension.devLoad`). `folder` is its place on
   * that disk for a connection that may name any path, its name otherwise;
   * `overrides` when it stands in for an installed extension with its key,
   * and `waiting` while that waits for the person's approval (the installed
   * one runs until then).
   */
  development?: { folder: string; overrides: boolean; waiting?: boolean }
  /** Where it came from, and the trust label that says so. */
  origin?: StudioExtensionOrigin
  /** The kill list holds this version: it never runs here. */
  killed?: { reason: string; advisoryUrl?: string }
  /** A newer release the catalogue it came from lists: to install, or held for review and why. */
  update?: StudioExtensionUpdate
}

/**
 * Where an installed extension came from. The label is decided by that,
 * never by the extension's own words: `Official` for Studio's catalogue,
 * `Community · <owner>` for the community catalogue, the catalogue's name and
 * the owner in its git URL for one the person added, `Unverified` for a git
 * URL, `Local` for a folder and `Dev` for a development folder.
 */
export type StudioExtensionOrigin = {
  kind: 'official' | 'community' | 'catalogue' | 'git' | 'folder' | 'development'
  label: string
  /** The catalogue it updates from (`official`, `community`, `git:<url>`). */
  catalogue?: string
  catalogueName?: string
  /** The git source it was checked out from, and the commit. */
  source?: StudioCatalogueSource
  commit?: string
}

/**
 * A newer release than the installed one. `held`: it was left uninstalled
 * for the person to review, because it asks for more access (`growth`), moved
 * to another repository or folder, or its owner was renamed or changed hands
 * (updates pause until it is installed again).
 */
export type StudioExtensionUpdate = {
  version: string
  held?: 'access' | 'repository' | 'owner'
  growth?: string[]
}

export type StudioCatalogueSource = { url: string; ref: string; path?: string }

export type StudioCatalogueImage = { path: string; sha256: string; alt: string }

/** One extension a catalogue lists, as Browse shows it. */
export type StudioCatalogueListing = {
  /** Its install key, `<publisher>.<id>`. */
  id: string
  name: string
  publisher: string
  description?: string
  categories: string[]
  /** The release this Studio would install, or the one needing the least newer Studio. */
  version: string
  installable: boolean
  /** The Studio the offered release needs, when this one is older. */
  needsStudio?: string
  tier: 'content' | 'declarative' | 'ui' | 'worker'
  permissions: string[]
  contributes: Array<{ kind: string; name: string }>
  /** The trust label from the catalogue's address. */
  label: string
  icon?: StudioCatalogueImage
  /** Installed here: its version, and whether from this catalogue. */
  installed?: { version: string; fromHere: boolean }
  killed?: { reason: string; advisoryUrl?: string }
}

/** One catalogue, as Browse lists it: its last copy, and why it could not be read now. */
export type StudioCatalogueView = {
  /** `official`, `community`, or `git:<url>` for one the person added. */
  id: string
  kind: 'official' | 'community' | 'added'
  name: string
  url?: string
  fetchedAt?: number
  error?: string
  entries: StudioCatalogueListing[]
}

/** One extension's page: the listing, and what the page shows beyond it. */
export type StudioCatalogueEntryView = StudioCatalogueListing & {
  catalogue: string
  catalogueName: string
  source: StudioCatalogueSource
  commit: string
  /** The release's content hash: Install names it, with the commit, source and owner id shown here. */
  contentHash: string
  /** The owner's numeric id the catalogue (or its owner records) names now. */
  ownerId?: number
  license?: string
  repository?: string
  homepage?: string
  updatedAt?: string
  changelog?: string
  images?: { cover?: StudioCatalogueImage; screenshots?: StudioCatalogueImage[] }
  releases: Array<{ version: string; minimumStudio: string; updatedAt?: string }>
  /** Other catalogues listing the same id. An install stays with the catalogue it came from. */
  alsoListedBy: Array<{ id: string; name: string }>
  /** Installed here from another source: what it was installed from. */
  installedFrom?: StudioExtensionOrigin
}

/** One development folder, as `extension.devFolders` lists it: the extension in it, or why there is none. */
export type StudioExtensionDevFolder = {
  /** Its real path on the Studio's disk. */
  path: string
  moduleId?: string
  name?: string
  approval?: StudioExtensionApproval
  /** It stands in for an installed extension with its key. */
  overrides?: boolean
  /**
   * It waits for the person to approve it in place of the installed extension
   * with its key, which runs until then.
   */
  waiting?: boolean
  /** Why it holds no extension Studio loads. */
  error?: string
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
  /**
   * The content identity of its files as served now: it moves with every
   * change to them (a development folder's save, an update), so a client
   * draws its open surfaces again.
   */
  revision?: string
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

// ── What a content extension adds ───────────────────────────────────────────

/** What `extension.content` serves. */
export type StudioExtensionContentKind = 'syntax'

/** `extension.content`'s params: an extension, a kind, and the contribution's id in its extension.json. */
export type StudioExtensionContentRequest = { moduleId: string; kind: StudioExtensionContentKind; id: string }

/** A language configuration, as the editor reads it. */
export type LanguageConfigurationView = {
  comments?: { lineComment?: string; blockComment?: [string, string] }
  brackets?: Array<[string, string]>
  autoClosingPairs?: Array<{ open: string; close: string }>
  surroundingPairs?: Array<{ open: string; close: string }>
}

/**
 * One piece of a content extension, checked on the server that serves it: a
 * syntax's TextMate grammar (only the keys a TextMate engine reads) and its
 * language configuration.
 */
export type ExtensionContent = {
  kind: 'syntax'
  grammar: Record<string, unknown> & { scopeName: string }
  configuration?: LanguageConfigurationView
}

/** `extension.settings`: an extension's declared settings' values here, each its default until set. */
export type ExtensionSettingValues = { values: Record<string, ExtensionSettingValueView> }

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

/** What a marketplace install puts in place: a Claude Code plugin's skills. */
export type MarketplaceComponentKind = 'skills'

/** What a registry entry may say it provides: a Claude Code plugin's skills, or `cli` for an agent CLI the app ships. */
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
 * A registry entry: a Claude Code plugin (has `source`, tagged
 * `claude-plugin`) or an agent CLI the app ships (has `cli`).
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
 * Where an install writes: the workspace its skill copies go into (one the
 * Studio has open), and the skill harnesses.
 */
export type MarketplaceInstallEnvelope = {
  workspaceRoot?: string
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
  manifestSha256: string
  componentDigests: Record<string, string>
}

export type MarketplacePluginTrustClassification = 'verified' | 'community' | 'unsigned' | 'invalid'

export type MarketplacePluginVerifyResult = {
  classification: MarketplacePluginTrustClassification
  permissions: string[]
  sourceUrl: string
  issues?: MarketplaceManifestIssue[]
  message?: string
  /** The files a skill payload installs, disclosed at the review. */
  files?: string[]
  /** The signer's key fingerprint (sha256 of the public key), when signed. */
  keyFingerprint?: string
  /** What was disclosed, and the one-time token that installs exactly that; absent when nothing may be approved. */
  pin?: MarketplaceTrustPin
  trustToken?: string
}

export type MarketplacePluginUninstallInput = MarketplaceInstallEnvelope & { pluginId: string }

export type MarketplacePluginInstalledComponent = {
  kind: MarketplaceComponentKind
  id: string
  message?: string
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
    }
  | {
      ok: false
      message: string
      removed?: MarketplacePluginInstalledComponent[]
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

/** Where a CLI or a provider comes from: the app itself, or an installed extension (providers only). */
export type PluginSource = 'bundled' | 'extension'
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
