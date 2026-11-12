import {
  studioNoParams,
  studioParams,
  studioParamsRefused,
  type StudioMethodTable,
  type StudioParamsRefusal,
  type StudioParsed,
  type StudioTopicTable,
} from './contract.js'
import type { CliPermissionPreset, ExecutionHostId, McpServerConfig } from './agents.js'
import type { SkillHarness } from './agent-setup.js'
import { STUDIO_AGENT_SKILLS_CAPABILITY } from './handshake.js'

// The skills, design systems and cards a Studio's agents are given, offered as
// `agent-skills` by every Studio, about its own machine:
//
// - Skill sources and what they hold (`skillSources.*`, `skills.*`,
//   `skillPlugins.*`): the repositories and folders skills are read from, a
//   skill installed into a workspace or the home folder, a source's plugins.
// - What each workspace's agents have (`workspaceSkills.list`,
//   `installedSkills.*`, `agentCapabilities.resolve`, `agentSkills.attach`).
// - Design systems (`designSystem.*`): the library of bundle folders, a
//   bundle read for the Design door, seeded, linted, attached to a workspace
//   and detached again.
// - A card's Go on the Extensions home (`cards.run`).
//
// Grants. Reading what can be installed, and what a workspace's agents have,
// is `providers:read`; reading a bundle is `files:read`. Changing the list of
// sources or the design library is `settings:write`; installing or removing a
// skill is `environment:maintain`, as installing a CLI is; seeding, attaching
// and detaching a bundle is `files:write`. Owner-only, each with its reason in
// the table: a plugin's install and uninstall (it writes the hooks and MCP
// servers the CLIs run), a bundle's lint (it runs the bundle's own script)
// and a card's Go (it installs modules, plugins and MCP servers in one press).
//
// Folders. A client that is not an owner names folders only inside the ones
// the Studio knows, checked on the path each one resolves to (a design library
// entry's registered folder included); a library listing shows it only those.
// A folder on an SSH machine is refused in words for now.
//
// `src/shared` re-exports each type under the name the app has always used.

// ── From shared/ipc/skills.ts ──
// One entry in the unified workspace skill inventory: built-ins, skills
// installed from a source, and hand-dropped custom skill dirs, deduped by skill
// id across harness dirs. Name/description come from the installed SKILL.md
// frontmatter when present, falling back to BUILTIN_SKILLS metadata, then the
// directory name.
export type WorkspaceSkillSource = 'builtin' | 'custom' | 'plugin'

export type WorkspaceSkillInstallState = 'installed' | 'available' | 'update-available'

export type WorkspaceSkill = {
  id: string
  name: string
  description?: string
  source: WorkspaceSkillSource
  harnesses: SkillHarness[]
  installState: WorkspaceSkillInstallState
  version?: string
  /** The skill source a copy was installed from, by its provenance marker; it is how the skill wears its owner's face. */
  sourceId?: string
  /** That source's GitHub repository (`owner/name`), for a skill listed by another machine, whose sources are not here. */
  sourceRepo?: string
}

export type WorkspaceSkillsListInput = {
  /** Null lists only what is installed for every project (needs `includeGlobal`). */
  workspaceRoot: string | null
  /**
   * Also list the skills installed in the home folder's harness directories —
   * the copies every agent reads in every project, with or without a folder.
   */
  includeGlobal?: boolean
}

export type WorkspaceSkillsListResult = { ok: true; skills: WorkspaceSkill[] } | { ok: false; message: string }

/**
 * What happened at one harness directory. Attach reaches several at once, so
 * three successes and one permission error must render as three successes and
 * one error — never as a bare "failed", and never as a success that quietly
 * wrote nothing.
 */
export type AgentSkillTargetStatus = 'written' | 'unchanged' | 'removed' | 'skipped' | 'failed'

/**
 * `not-ours` is a skill the user wrote by hand under that name: reported, never
 * overwritten or deleted. `absent` is a remove target that held nothing.
 */
export type AgentSkillSkipReason = 'not-ours' | 'absent'

export type AgentSkillTarget = {
  harnessId: string
  /** Every installed CLI that reads this directory — `.claude` serves three. */
  pluginIds: string[]
  /** Workspace-relative, e.g. `.claude/skills/backlog`. */
  path: string
  /** Whether the CLIs reading it pick the change up only after a restart. */
  restartRequired: boolean
  status: AgentSkillTargetStatus
  reason?: AgentSkillSkipReason
  /** Present on `failed`, naming what the filesystem said. */
  message?: string
}

export type AgentSkillWriteInput = {
  /** Null writes into the home folder's harness directories, for every project. */
  workspaceRoot: string | null
  skillId: string
}

/**
 * `ok: false` is reserved for a request that could not be attempted at all — no
 * workspace, an unusable skill id, no installed CLI that reads skills, or
 * nothing to copy. Anything that reached the directories reports per target.
 */
export type AgentSkillWriteResult =
  { ok: true; skillId: string; targets: AgentSkillTarget[] } | { ok: false; message: string }

// Skill sources (src/shared/skills.ts owns the shapes; these are the IPC
// envelopes). Sources are app-level; installing is workspace-level, so
// skillsInstall is the only call here that needs a workspace root.
export type SkillSourcesResult =
  | {
      ok: true
      sources: SkillSource[]
      /**
       * How this build reads repositories: 'git' when a git reader is wired,
       * 'api' on the GitHub-REST fallback (git-transport ruling, owner
       * 2026-09-08). The copy about cadences and unread plugins changes with
       * it, so it travels with the list rather than being guessed at.
       */
      transport: SkillRepoTransport
      /**
       * False only when this machine has no git at all, which is the one thing
       * an 'api' reader's shortfall can actually name as the remedy. Absent
       * means yes.
       */
      gitInstalled?: boolean
    }
  | { ok: false; message: string }

export type SkillAddSourceInput = {
  /** `owner/name`, a repository URL on github.com or a self-hosted GitHub, or a /tree/<ref> deep link. */
  repo: string
  /** Re-scan a source already in the list instead of refusing it. */
  replace?: boolean
}

export type SkillAddSourceResult =
  | {
      ok: true
      source: SkillSource
      scan: ScanResult
      /**
       * The pasted repository IS one of the always-present sources
       * (`anthropics/claude-plugins-official`, `sprintengine/studio-releases`),
       * so it was merged into that tab rather than added beside it. The add
       * succeeded — the tab's listing is freshly read — but nothing new
       * appeared in the list, and a surface that said "added" would be lying
       * about the one thing the person is looking for.
       */
      mergedIntoBuiltin?: boolean
    }
  | { ok: false; message: string }

/**
 * A folder on this machine, added as a source. Separate from
 * `skillsAddSource` because the two take different identities — a repository
 * reference and an absolute path — and a single field taking either would be
 * a string the caller has to hope is parsed the way it meant.
 */
export type SkillAddLocalSourceInput = {
  /** Absolute path to the folder to scan. */
  path: string
  /** Re-scan a folder already in the list instead of refusing it. */
  replace?: boolean
}

export type SkillRemoveSourceInput = { sourceId: string }

export type SkillRemoveSourceResult = { ok: true; sourceId: string } | { ok: false; message: string }

export type SkillScanInput = { sourceId: string }

export type SkillScanOutcome = { ok: true; source: SkillSource; scan: ScanResult } | { ok: false; message: string }

export type SkillReadFileInput = { sourceId: string; skillId: string; path: string }

export type SkillReadFileResult = { ok: true; path: string; content: string } | { ok: false; message: string }

/**
 * Where an install lands. `global` is the home folder's harness directories,
 * which every agent reads in every chat and project; `workspace` is the open
 * folder's, which only agents working in that folder read.
 */
export type SkillInstallScope = 'global' | 'workspace'

export type SkillInstallInput = {
  sourceId: string
  skillId: string
  /** Required for a `workspace` install; ignored for a `global` one. */
  workspaceRoot?: string | null
  /** Omitted means `workspace` when a folder is given, else `global`. */
  scope?: SkillInstallScope
}

export type SkillInstallOutcome =
  | {
      ok: true
      dirName: string
      harnesses: SkillHarness[]
      paths: string[]
      fileCount: number
      scope: SkillInstallScope
    }
  | { ok: false; message: string }

/**
 * Uninstalling is by directory name, not by source: a skill installed from a
 * source that has since been removed is still a directory in the workspace, and
 * the user must still be able to take it back out.
 */
export type SkillUninstallInput = {
  /**
   * The folder whose copy also goes. Null takes out only the copy installed
   * for every project; the global copy is always swept, because a Remove that
   * left an agent still reading the skill would not be a removal.
   */
  workspaceRoot: string | null
  dirName: string
}

export type SkillUninstallOutcome =
  { ok: true; dirName: string; removedPaths: string[] } | { ok: false; message: string }

/** The workspace whose installed copies get re-copied; null with no workspace open. */
export type SkillSyncSourceInput = {
  sourceId: string
  workspaceRoot: string | null
  /**
   * The MCP servers this machine has configured. Sent in because MCP settings
   * live in the renderer's store, not on disk in main: the sync rewrites the
   * ones this source installed and hands them back for the surface to apply
   * (backlog/2026-09-06-mcp-installs-carry-source-provenance.md). Omitted by a
   * caller that has none, which refreshes skills and nothing else.
   */
  mcpServers?: McpServerConfig[]
}

export type SkillSyncFailure = { skillId: string; message: string }

/**
 * What a sync did, in counts. What changed *inside* a skill is not derivable
 * here and is not guessed at: the repository's own commit history answers that,
 * which is why the surface links to it instead of rendering a diff.
 */
export type SkillSyncSourceOutcome =
  | {
      ok: true
      source: SkillSource
      scan: ScanResult
      /** Skills the refreshed scan holds that the cached one did not. */
      added: number
      /** Skills the cached scan held that the repository no longer does. */
      removed: number
      /** Installed skills re-copied from the refreshed scan. */
      refreshed: number
      /** Installed skills whose re-copy failed; the list still refreshed. */
      failures: SkillSyncFailure[]
      /**
       * The source-installed MCP servers as they now stand: `updated` is what
       * to write back, `changed` the ones whose declaration really moved, and
       * `missing` the ones this source no longer declares (their entries stay,
       * marked, and go on working).
       */
      mcpServers: { updated: McpServerConfig[]; changed: string[]; missing: string[] }
    }
  | { ok: false; message: string }

/**
 * Discover. Both calls answer with `{ results, rateLimit, degraded }` and no
 * ok flag: a failed or limited query is a stated condition on the same shape,
 * so a caller can never mistake it for "GitHub had no match".
 */
export type SkillSearchInput = { query: string }

export type SkillSearchOutcome = SkillDiscoveryResult<SkillSearchHit>

export type SkillPopularReposOutcome = SkillDiscoveryResult<SkillRepoHit>

export type SkillPluginScanLinkedInput = { sourceId: string; pluginId: string }

export type SkillPluginScanLinkedOutcome =
  { ok: true; source: SkillSource; scan: ScanResult; plugin: ScannedPlugin } | { ok: false; message: string }

export type SkillPluginInstallInput = {
  sourceId: string
  pluginId: string
  workspaceRoot: string
  /** Required true when the plugin declares hooks — they run shell commands. */
  acknowledgedHooks?: boolean
  /**
   * Install only these skills. Omit both this and `mcpServerIds` to install
   * everything the plugin ships (the palette's single-skill shortcut). Passing
   * either field means the other kind is not installed — a plugin is a
   * catalogue, and one press takes one item.
   */
  skillIds?: string[]
  /** Install only these MCP servers. Same rule as `skillIds`. */
  mcpServerIds?: string[]
}

export type SkillPluginInstallHarness = {
  harness: SkillHarness
  /** `skills` — skill directories copied; `nothing` — the plugin has nothing this harness reads. */
  mode: 'skills' | 'nothing'
  skillDirNames: string[]
  message: string
}

export type SkillPluginInstallOutcome =
  | {
      ok: true
      plugin: ScannedPlugin
      harnesses: SkillPluginInstallHarness[]
      /** MCP servers the plugin declares, shaped for the MCP settings store. */
      mcpServers: McpServerConfig[]
      /**
       * `name@marketplace` written into the workspace's Claude settings, '' when
       * none was. An extra for `claude plugin install`, never what delivered the
       * plugin — see src/main/skills/install-plugin.ts.
       */
      claudePluginKey: string
      /** Where the plugin's own files landed, '' when it needed none. */
      pluginRoot: string
      /** Files copied there; 0 when nothing was. */
      pluginFileCount: number
      warnings: string[]
    }
  | { ok: false; message: string; needsHookAcknowledgement?: boolean }

export type SkillPluginUninstallInput = {
  sourceId: string
  pluginId: string
  workspaceRoot: string
  /**
   * Drop only this MCP server from the plugin's receipt. Skills stay. Omit it
   * to take the whole plugin back — every copied skill, every server it added,
   * and the plugin's own files.
   */
  mcpServerId?: string
}

export type SkillPluginUninstallOutcome =
  | {
      ok: true
      removedPaths: string[]
      disabledClaudePluginKey: string
      mcpServerIds: string[]
      /** The copies went; the Claude settings file refused its edit. */
      warnings: string[]
    }
  | { ok: false; message: string }

/** One installed plugin, as this app recorded it. */
export type InstalledPluginRecord = {
  workspaceRoot: string
  sourceId: string
  pluginId: string
  pluginName: string
  marketplaceName: string
  claudePluginKey: string
  skillDirNames: string[]
  /**
   * The plugin's own directory under `claude-plugins` in the workspace's store, when its MCP
   * server runs out of one. Absent on a receipt from before plugin directories
   * existed, and on every plugin that needs none.
   */
  pluginDirName?: string
  mcpServerIds: string[]
  /** The commit the bytes were read at; '' for a registry plugin. */
  commitSha: string
  installedAt: string
}

export type SkillInstalledPluginsInput = { workspaceRoot: string }

export type SkillInstalledPluginsOutcome =
  { ok: true; plugins: InstalledPluginRecord[] } | { ok: false; message: string }

/** One repository source, as the hourly update check saw it. */
export type SkillSourceUpdateEntry = {
  sourceId: string
  /** `owner/name`. */
  name: string
  headSha: string
  /** The head differs from the commit the source was scanned at. */
  changed: boolean
  /**
   * False when this check did not ask GitHub, because the source was checked
   * inside its cadence window. `headSha` and `changed` then repeat
   * what the last real check recorded, so the rails keep their mark.
   */
  checked: boolean
}

/**
 * What an update check found. `newlyChanged` is the drift THIS check
 * discovered (worth a toast); `changed` is every source currently behind its
 * head (what the rails mark). Broadcast on `skills:sources-updated`.
 *
 * `skipped` names the sources this check left alone because their cadence
 * window had not elapsed, each with the sentence to show a person who pressed
 * Check now — a manual check counts against the same window as the scheduled
 * one, and has to say so rather than look like it did nothing.
 */
export type SkillSourceUpdateCheck = {
  checkedAt: string
  sources: SkillSourceUpdateEntry[]
  changed: string[]
  newlyChanged: string[]
  failures: { sourceId: string; message: string }[]
  skipped: { sourceId: string; message: string }[]
}

// ── From shared/skills.ts ──
// `builtin` is gone: the app's own catalogue used to be a folder on disk, and
// since the studio-marketplace ruling (2026-09-06) it is the repository we
// publish, read like any other (STUDIO_SKILL_SOURCE_ID below). `connectors`
// went the same way in the frozen-snapshots retirement (2026-09-06): it was a
// folder scan of a snapshot of `anthropics/claude-plugins-official`, which is
// now an always-present source read live.
export type SkillSourceKind = 'github' | 'local'

/**
 * How this machine reads repositories: over git's own protocol, or over
 * GitHub's REST API (git-transport ruling, owner 2026-09-08).
 *
 * It lives here rather than beside the reader interface because the copy is
 * what most needs it — a cadence line and a shortfall clause both change
 * wording with the transport, and neither Settings nor the Extensions door can
 * import main. `src/main/skills/repo-reader.ts` re-exports it, so the reader
 * contract stays one file.
 */
export type SkillRepoTransport = 'git' | 'api'

/** A place skills come from. `repo` is where its repository lives (`./skill-repo.ts`), '' for any other kind. */
export type SkillSource = {
  id: string
  kind: SkillSourceKind
  name: string
  repo: string
  /**
   * Absolute folder path for a `local` source, '' for every other kind. A
   * folder on this machine is a source you can point at (the source-tabs
   * ruling, 2026-09-05: the plus offers "Add from folder…" beside "Add from
   * GitHub…"), and the path is the only identity it has — there is no
   * repository to name it by.
   */
  path?: string
  /** 1-2 character badge shown in the source rail. */
  monogram: string
  blurb: string
  /** Commit the cached scan was taken at; '' for sources with no git identity. */
  commitSha: string
  /** ISO timestamp of the cached scan; '' when never scanned. */
  scannedAt: string
  /**
   * The repository's head the last update check resolved, when it ran. A head
   * that differs from `commitSha` is an update the person can apply with Sync
   * (backlog/2026-09-05-plugin-sources.md, "Update notifications").
   */
  headSha?: string
  headCheckedAt?: string
}

/**
 * One file inside a skill. `path` is skill-relative with forward slashes, so
 * `agents/openai.yaml` keeps its shape when installed. `blobSha` is the git
 * blob id from the tree listing, and is '' for sources with no git identity.
 */
export type SkillFileRef = {
  path: string
  size: number
  blobSha: string
  isEntry: boolean
}

export type ScannedSkill = {
  /** Source-relative directory path — the skill's identity within its source. */
  id: string
  name: string
  description: string
  /** Group name, or '' when the source carries no grouping signal. */
  group: string
  files: SkillFileRef[]
  allowedTools: string[]
  hasExecutables: boolean
  /**
   * The optional Agent Skills fields, read from the entry document alongside
   * the description (https://agentskills.io/specification, fetched
   * 2026-09-06). Optional on the type because a scan cached before 2026-09-06
   * carries none, and because most skills declare none.
   */
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
}

export type SkillGroupingSignal = 'manifest' | 'folders' | 'none'

export type ScanResult = {
  skills: ScannedSkill[]
  groups: string[]
  groupingSignal: SkillGroupingSignal
  fileCount: number
  commitSha: string
  /**
   * Entry documents that were read and declared no `description`, and so are
   * not skills at all (https://agentskills.io/specification, fetched
   * 2026-09-06). They are dropped from `skills`, and counted here so the
   * surface can say a source held something it did not list. Absent on scans
   * cached before this was counted, which is not the same as zero.
   */
  skippedNoDescription?: number
  /**
   * What the repository turned out to be, and the plugins and MCP servers it
   * declares (backlog/2026-09-05-plugin-sources.md). Optional because scans
   * cached before plugins existed carry none; read them through
   * `scanPlugins()` / `scanMcpServers()` / `scanShape()`, never directly.
   */
  shape?: SourceShape
  /** The `name` a `.claude-plugin/marketplace.json` gives itself; '' without one. */
  marketplaceName?: string
  plugins?: ScannedPlugin[]
  mcpServers?: ScannedMcpServer[]
  /**
   * The marketplace's top-level `renames`: old plugin name → the name it is
   * listed under now. Read through `scanPluginRenames()`, never directly.
   */
  pluginRenames?: Record<string, string>
  /**
   * True when this scan is the copy that SHIPPED WITH THE APP rather than a
   * read of the repository — the seed our own marketplace falls back to when
   * the network is not there (studio-marketplace ruling, 2026-09-06), the same
   * bundled-or-remote distinction `registry-client.ts` draws for the signed
   * index. The surface says so, because "12 skills" read from a repository and
   * "12 skills" read from the build are different claims about how current the
   * list is. Never persisted: a seed cached as though it were a scan would
   * stop the next launch from going and getting the real one.
   */
  bundled?: boolean
}

export type SourceShape = 'claude-marketplace' | 'claude-plugin' | 'mcp-server' | 'skills' | 'mixed' | 'empty'

/** Where a plugin's bytes live, which is also where its skills are read from. */
export type ScannedPluginOrigin =
  /** A directory in the source's own tree, '' for the root. */
  | { kind: 'in-tree'; path: string }
  /**
   * A marketplace entry pointing at another repository. `sha` is the commit
   * the marketplace pinned ('' when it pinned none), `path` the directory
   * inside that repository ('' for the root). Its components are unknown until
   * the plugin is opened and that repository is read.
   */
  | { kind: 'linked'; repo: string; ref: string; sha: string; path: string; url: string }
  /** A marketplace-registry entry (the studio source). */
  | { kind: 'registry'; entryId: string; sourceUrl: string }

export type ScannedPluginHook = {
  /** `PreToolUse`, `Stop`, … — the event as the plugin names it. */
  event: string
  /** The tool matcher, '' when the hook fires on every tool. */
  matcher: string
  /** The shell command, verbatim. This is what the trust prompt shows. */
  command: string
}

/**
 * An MCP server a source declares, in the shape `McpServerConfig` takes once
 * installed. `declaredIn` is the repo-relative path of the file that declared
 * it; `declaredBy` the plugin id when a plugin ships it, '' otherwise.
 */
export type ScannedMcpServer = {
  id: string
  name: string
  description: string
  transport: 'stdio' | 'http' | 'sse'
  command: string
  args: string[]
  url: string
  env: Record<string, string>
  envVarNames: string[]
  headers: Record<string, string>
  declaredIn: string
  declaredBy: string
}

/**
 * A language server a plugin declares. Claude Code starts it for the file
 * extensions the manifest maps, so those are what the surface can honestly say
 * the plugin covers — the twelve `*-lsp` plugins in
 * `anthropics/claude-plugins-official` are nothing BUT this declaration, their
 * directories holding a LICENSE and a README and no manifest at all.
 * `startupTimeout` is milliseconds and 0 when the manifest states none.
 */
export type ScannedLspServer = {
  /** The key the declaration is filed under: `clangd`, `rust-analyzer`, … */
  id: string
  command: string
  args: string[]
  /** `.ts` → `typescript`, verbatim from the manifest. */
  extensionToLanguage: Record<string, string>
  startupTimeout: number
  /** Repo-relative path of the file that declared it. */
  declaredIn: string
  /** The plugin id, '' when nothing named one. */
  declaredBy: string
}

export type ScannedPluginComponents = {
  /** The plugin's skills, whole: read from wherever the plugin's bytes live. */
  skills: ScannedSkill[]
  /** Command names (`commands/<name>.md`). */
  commands: string[]
  /** Agent names (`agents/<name>.md`). */
  agents: string[]
  hooks: ScannedPluginHook[]
  mcpServers: ScannedMcpServer[]
  /**
   * Language servers, a component kind of its own rather than a footnote on the
   * MCP servers: an LSP server is started per file extension by the editor
   * integration and is not an MCP endpoint at all, and a plugin can consist of
   * nothing else.
   */
  lspServers: ScannedLspServer[]
  /** Skills the entry names but that shipped with no readable directory. */
  missingSkills: string[]
}

export type ScannedPlugin = {
  /** The marketplace name, or the manifest name, or the directory name. */
  id: string
  name: string
  description: string
  version: string
  category: string
  author: string
  homepage: string
  origin: ScannedPluginOrigin
  /**
   * Whether the marketplace requires this entry to validate strictly. Absent in
   * a manifest means true, which is the marketplace schema's own default, so
   * only `strict: false` is ever written — and it is written by fourteen of the
   * official marketplace's entries, which is why dropping it made those look
   * like every other entry.
   */
  strict: boolean
  /** Curation labels the marketplace applies, e.g. `community-managed`. */
  tags: string[]
  /** Search words the entry gives itself; distinct from `tags`, which curate. */
  keywords: string[]
  /**
   * False for a linked plugin whose repository has not been read yet: its
   * components are unknown, not empty, and the surface must say so.
   */
  componentsKnown: boolean
  components: ScannedPluginComponents
  /**
   * How completely this plugin has been read, and why not when it has not been
   * (linked-plugins ruling, 2026-09-06). Absent on a scan cached before the
   * scan followed anything — which is why `componentsKnown` stays the
   * authority on whether the components are known and this only ever explains
   * it.
   */
  readState?: PluginReadState
  /**
   * The commit a read of a LINKED plugin actually used. Distinct from
   * `origin.sha`, which is what the marketplace pinned and is '' when it
   * pinned nothing: writing a resolved commit back into `origin.sha` made an
   * entry the publisher deliberately left floating look pinned, and quietly
   * moved installs onto whatever commit a scan happened to see (linked-plugins
   * review, 2026-09-06).
   */
  readCommit?: string
  /**
   * The glyph the entry gives itself — an emoji, or one or two characters of
   * text. Optional twice over: most entries declare none, and every scan
   * cached before this was read carries none either.
   */
  icon?: string
  /** An https image URL the entry gives itself. Same two absences as `icon`. */
  logo?: string
}

/**
 * How completely a plugin has been read.
 *
 * A scan follows linked plugins within a budget (`MAX_LINKED_REPOSITORY_READS`
 * in src/main/skills/scan-plugins.ts), so "not read" is several very different
 * facts: one a later scan fixes by itself, one opening the plugin fixes, and
 * one no amount of either will. Saying which is the whole point — 238 rows
 * reading "Read when opened" told a person nothing about whether opening one
 * would work.
 */
export type PluginReadState =
  /** Components read, and every skill's entry document read with them. */
  | { status: 'read' }
  /**
   * Components read from the repository's tree, but the skills' entry
   * documents were not: the follow proves what a plugin ships without spending
   * a request per skill across 238 repositories. Opening the plugin reads
   * them. `componentsKnown` is true — the components really are known.
   */
  | { status: 'listed' }
  /**
   * Files the tree listed could not be fetched, so what was read is not the
   * whole plugin. `componentsKnown` is FALSE for this: a hooks file lost to
   * throttling would otherwise be cached as a plugin with no hooks, and the
   * install gate would wave through the very commands it exists to disclose.
   */
  | { status: 'partial'; unread: string[] }
  /**
   * Nothing was fetched for it, for a reason about this moment rather than
   * about the plugin: the pass's budget ran out, GitHub's rate limit did, or
   * the network was not there. The next scan resumes where this one stopped,
   * because every plugin already read is cached against its pinned sha and
   * costs nothing. `blocked` marks the one repository whose reply stopped the
   * pass, so the next pass can put it last instead of halting on it again.
   */
  | { status: 'pending'; reason: 'budget' | 'rate-limited' | 'offline'; blocked?: true }
  /** Reading it was refused or failed in a way a retry will not change. */
  | { status: 'unreadable'; message: string }

/**
 * Why a Discover query could not answer in full. Always stated: an empty list
 * with no condition means "GitHub has no match", and nothing else may borrow
 * that meaning.
 */
export type SkillDiscoveryCondition = {
  reason: 'needs_token' | 'rate_limited' | 'query_too_short' | 'unavailable'
  message: string
  /** Seconds until the limit resets; 0 when GitHub did not say, or not a limit. */
  retryAfterSeconds: number
}

/** What GitHub reported about the budget the query spent from. */
export type SkillRateLimit = {
  limit: number
  remaining: number
  /** ISO timestamp the window resets at; '' when GitHub did not say. */
  resetAt: string
}

/** One skill found inside a repository — a candidate to scan, not a source. */
export type SkillSearchHit = {
  /** `owner/name`. */
  repo: string
  /** Repo-relative path of the matched SKILL.md. */
  path: string
  /** Directory holding the skill — its id once the repo is scanned; '' at the root. */
  skillId: string
  /** From the matched frontmatter, falling back to the directory name. */
  name: string
  /** From the matched frontmatter; '' when the fragment carried none. */
  description: string
  htmlUrl: string
}

/**
 * A repository Discover offers to scan. It carries no skill count on purpose:
 * the count is unknown until the repo is scanned, and stars do not predict it —
 * one 52k-star repo holds a single skill while a 4.9k-star one holds 103.
 */
export type SkillRepoHit = {
  repo: string
  description: string
  /** null when the result did not come with a star count — never shown as 0. */
  stars: number | null
  htmlUrl: string
  /** Carries `.claude-plugin/marketplace.json`: someone curated the contents. */
  curated: boolean
}

export type SkillDiscoveryResult<T> = {
  results: T[]
  rateLimit: SkillRateLimit | null
  degraded: SkillDiscoveryCondition | null
}

/** Where an installed skill directory came from, read from its provenance marker. */
export type AgentSkillSource = 'builtin' | 'source' | 'local'

export type AgentSkill = {
  /** Directory name, which is the skill's identity to every CLI that reads it. */
  id: string
  name: string
  /** '' when the SKILL.md carries no description; never invented copy. */
  description: string
  /** How to invoke it in this CLI, rendered from the plugin's own template. */
  invocation: string
  source: AgentSkillSource
  /** The skill source it was installed from, when a source installed it. */
  sourceId?: string
  /**
   * Every CLI bound to this harness. The skill lives in one directory, and each
   * of these can read it — this is the attribution that stops a shared skill
   * being counted once per CLI.
   */
  pluginIds: string[]
}

/**
 * An MCP server a CLI is configured with, read from that CLI's own config file
 * by the format adapter its manifest declares. Configured, not necessarily
 * loaded: a config that marks a server disabled still declares it, and both
 * CLIs that express that state list it as disabled rather than omitting it, so
 * dropping it here would hide something the user wrote.
 */
/** A server's connection as the running CLI last reported it. */
export type AgentMcpServerStatus = 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'

export type AgentMcpServer = {
  id: string
  transport: string
  /** Absent unless the config states it — a count is never guessed. */
  toolCount?: number
  /**
   * Which of the CLI's two declared config files this entry won from, or
   * `session` for a server only a running CLI reported (one from its own user
   * settings, a plugin, or its account), which has no file of ours to name.
   */
  scope: 'workspace' | 'user' | 'session'
  /** Absent for a `session` server. */
  configPath?: string
  /** Absent until a chat on this CLI in this folder has reported it. */
  status?: AgentMcpServerStatus
  /** Why it failed, in the CLI's words, when it did. */
  error?: string
}

/**
 * Why one path could not be read, or could not be kept true. A union, not a
 * boolean: `malformed` (a file that opened but could not be parsed) is a
 * different fault from one that could not be opened at all, and the likeliest
 * real-world one for a config file. `watch_unavailable` is not a read failure
 * at all — the answer is correct as of the read and may go stale.
 */
export type CapabilityDiagnosticReason = 'unreadable' | 'malformed' | 'watch_unavailable'

/**
 * Which half of the answer a fault belongs to, or `freshness` for one that
 * belongs to neither: a path that could not be watched leaves both halves
 * readable but possibly stale, which a surface must say differently from a
 * half that failed to read.
 */
export type CapabilityKind = 'skills' | 'servers' | 'freshness'

export type CapabilityDiagnostic = {
  /**
   * A surface that renders one half must not be blanked by the other half's
   * fault: an unparseable `.mcp.json` is not a reason to stop listing skills.
   */
  capability: CapabilityKind
  reason: CapabilityDiagnosticReason
  /** The path that failed, so the surface can name it. */
  path: string
  message: string
}

export type AgentCapabilitiesInput = {
  /** Null asks only about what the CLI reads from the home folder (needs `includeGlobal`). */
  workspaceRoot: string | null
  pluginId: string
  /**
   * Also list the skills in this CLI's home-folder skills directory — what it
   * reads in every project. Servers are still the workspace's alone.
   */
  includeGlobal?: boolean
}

/**
 * `ok: false` is reserved for a question that could not be asked (no workspace).
 * A CLI with no skill support, and a harness directory that was never created,
 * are both `ok: true` with a stated `support` — an unavailable capability is a
 * result, never an empty list.
 */
export type AgentCapabilitiesResult =
  | {
      ok: true
      support: 'native' | 'prompt-shim' | 'unsupported'
      /** '' when the plugin declares no skill integration at all. */
      harnessId: string
      skills: AgentSkill[]
      servers: AgentMcpServer[]
      diagnostics: CapabilityDiagnostic[]
    }
  | { ok: false; message: string }

// ── From shared/ipc/cards.ts ──
// Running a card's actions — `cards:run`, the one press the Extensions home
// offers (backlog/2026-09-06-go-runs-a-cards-actions.md, item 2469). The
// executor is `src/main/cards/run-card.ts`; these are the envelopes.
//
// Nothing in the request comes from the feed except `actions` and `slug`. The
// workspace, the place clones go and the MCP servers this machine has
// configured are all the app's own facts, sent in because a card carries no
// workspace by design and because MCP settings live in the renderer's store
// rather than on disk in main.
export type CardRunInput = {
  /** The card's slug, for the messages. Never used as a path or an id. */
  slug: string
  actions: CardAction[]
  /** The workspace the person is in; null when none is open. */
  workspaceRoot: string | null
  /** Where this app puts projects — `clone.repo`'s parent directory. */
  cloneParentDir: string | null
  mcpServers: McpServerConfig[]
  /**
   * The app's MCP sync switch as it currently stands. Carried rather than
   * assumed: the executor used to sync with `syncEnabled: true` hardcoded,
   * which turned a setting back on for somebody who had turned it off. It flips
   * to true only when a card ADDS a server, because that is what the settings
   * store does with that same server (`upsertMcpServer`).
   */
  mcpSyncEnabled: boolean
  /**
   * The model row the person chose in the picker `Go` opens (owner ruling R4b,
   * 2026-09-06, item 2473). Choosing a row is what starts the run, so the row's
   * own axes travel with it: the model id (null is the runtime's own default
   * model), the reasoning effort where the CLI declares one, and the permission
   * preset stored against that row (`modelFavouriteKey`, falling back to
   * `appSettings.lastAgentSpawnPermissionPreset`).
   *
   * They are carried here rather than kept in a renderer closure so that ONE
   * object describes the launch on the way back: `CardChatHandoff` already
   * carries the cli a `require.cli` verified, and a launch whose runtime came
   * from the hand-off while its model came from a variable captured minutes
   * earlier is a pair that drifts. Main does not interpret any of the three; it
   * checks their shape and hands them back on the chat.
   *
   * All three are optional because a caller that has not opened a picker (a
   * test, a future headless run) is a caller with no row to describe, and an
   * absent field must mean "the app's own default" rather than "no model".
   */
  model?: string | null
  reasoning?: string | null
  permissionPreset?: CliPermissionPreset
}

/** `already` is a no-op that succeeded; `skipped` is an action a failure before it stopped. */
export type CardActionStatus = 'done' | 'already' | 'failed' | 'skipped'

export type CardActionOutcome = {
  index: number
  verb: CardActionVerb
  status: CardActionStatus
  /** One sentence, in the words a toast can show. */
  message: string
}

/**
 * What the renderer must do once every install before it has succeeded. Main
 * can neither open a chat nor move a door, so both verbs are validated in the
 * executor's switch and performed on the other side of the wire.
 */
export type CardChatHandoff = {
  prompt: string
  send: boolean
  /** Installed skill directory names. */
  skills: string[]
  /**
   * The agent CLI a `require.cli` in the same card verified, or null when it
   * required none. The chat launches on this one so the harness the card's
   * skills were installed into is the harness the chat runs in.
   *
   * There is no `mcpServers` here. The first cut carried one and neither
   * renderer path read it: for a server the card installed it worked by
   * accident, because the CLI reads the `.mcp.json` the install just wrote, and
   * for one the card only named it silently attached nothing. The invariant is
   * now real instead — `refuseCardActions` refuses a card whose chat names a
   * server no earlier action installs — so the field had nothing left to say.
   */
  cli: string | null
  /**
   * The rest of the row the person chose in the picker (item 2473), echoed back
   * beside the cli so the hand-off describes the WHOLE launch rather than half
   * of it. `model` is null for the runtime's own default model, `reasoning` is
   * null where the CLI declares no effort axis, and `permissionPreset` is null
   * when the request carried none — the spawn then resolves the row's preset
   * itself, exactly as every other spawn in the app does.
   */
  model: string | null
  reasoning: string | null
  permissionPreset: CliPermissionPreset | null
}

export type CardSurfaceHandoff = { view: CardSurfaceView; installed: boolean }

export type CardRunResult = {
  ok: boolean
  /** One entry per action, in the card's own order. */
  outcomes: CardActionOutcome[]
  /** The workspace the run ended in — `clone.repo` moves it. */
  workspaceRoot: string | null
  /**
   * The servers this run ADDED, for the surface to write back — not the merged
   * list. `upsertMcpServer` turns MCP sync on for every server it is handed,
   * and handing it servers the person already had would flip that switch on
   * their behalf for a server they did not just install.
   */
  mcpServers: McpServerConfig[]
  chat: CardChatHandoff | null
  surface: CardSurfaceHandoff | null
  /** The sentence a failure toast leads with; absent on success. */
  message?: string
}

// ── From shared/hosted-card-feed.ts ──
// The doors a card may open. `plugins` and `skills` are VIEWS OF THE EXTENSIONS
// DOOR — exactly `EXTENSIONS_DRAWER_VIEWS` in the renderer's
// extensionsSurfaceTarget.ts — and `home` is the card feed's own page beside
// them. The renderer latches the view and then opens the door.
//
// `agent-clis` named a third view until the owner moved agent CLIs to Settings ▸
// Agents (2026-09-25). It stays in the union because the union is a permanent
// contract and published cards still name it: the renderer now opens Settings ▸
// Agents on this machine for it, which is where that view's list went.
//
// The rule is the wide one: **every door the app has, whether or not it lives
// under Extensions**, may be named here. Adding one is additive and safe,
// because a build that does not know a view drops the card and counts it rather
// than opening nothing.
//
// Restated here rather than imported because src/shared may not reach into the
// renderer. Added to, never renamed: this union is a permanent contract.
export type CardSurfaceView = 'home' | 'plugins' | 'skills' | 'agent-clis'

// The closed verb set, and it is closed against the call sites rather than
// against an imagination of them. The first cut of this union carried thirteen
// verbs, nine of which no installer in this repository could execute:
// `add.source`, `seed.backlog`, `create.workflow`,
// `create.automation` and `design.import` named nothing, and the four that
// remained were shaped wrong — `install.mcp` carried a source the catalogue does
// not have, `clone.repo` a `ref` git-clone does not take, `open.chat` one
// attachment list where the composer keeps two, and `open.surface` a
// surface/tab pair the door stopped speaking in September. A schema is a
// permanent forward-compatible contract, so shipping a fictional vocabulary is
// worse than shipping a small true one: adding a verb later is cheap and
// additive, while un-shipping one is a breaking change to every build in the
// field. Each verb below is a call this repository already makes.
//
// **No action carries a workspace, deliberately.** A card runs in the workspace
// the person is already in, and the executor supplies it — a card that could
// name a workspace could reach into a project the person was not looking at.
// `clone.repo` is the one verb that makes a new one, and everything after it in
// the same card runs in that.
export type CardAction =
  // Make sure an agent CLI is there — and say which one is missing rather than
  // installing it. Installing a CLI runs a shell command on the person's
  // machine, and `CliInstallMethodInfo` exists so that command is shown before
  // anybody consents to it; a card may not answer that disclosure on somebody's
  // behalf, so the executor refuses and points at Settings → Agents — the app's
  // one install route (and see `openChat`'s neighbour in
  // src/main/cards/run-card.ts for why a card's refusal names it rather than the
  // Agent CLIs view the card is standing in). This comment said "and install it
  // if not" until 2026-09-06, which described behaviour the executor
  // deliberately does not have. `cli` is a plugin id under `resources/plugins/`
  // (`claude-code`, `codex`), never a vendor name or a binary path.
  | { verb: 'require.cli'; cli: string }
  // An MCP server by its id. The bundled catalogue this used to resolve against
  // was retired with the third-party ruling (2026-09-08) — sixteen
  // servers nobody here wrote — and no bundled list replaced it: an MCP server
  // arrives inside a plugin now, which `install.plugin` installs. The verb stays
  // in the schema because it is a published contract every build in the field
  // parses, but the executor can only honour an id the workspace already holds
  // in its MCP settings; any other id is refused by name
  // (`src/main/cards/run-card.ts`).
  | { verb: 'install.mcp'; id: string }
  // A skill and a plugin each name a source the app already holds and an id
  // within it. `source` is a source id as src/shared/skills.ts mints them:
  // `github:owner/name` or `local:<absolute path>` — `builtin` is gone. For a
  // skill, `id` is a `ScannedSkill.id`, which is the skill directory's path
  // relative to its source (`skills/engineering/prototype`).
  | { verb: 'install.skill'; source: string; id: string }
  // For a plugin, `id` is the plugin's name in its source's marketplace
  // manifest. The card carries nothing else: `installPlugin` also wants
  // `marketplaceName`, `marketplaceRepo` and `commitSha`, and the executor
  // resolves all three from that source's scan at run time. A card that carried
  // them would be carrying facts that go stale the moment the marketplace is
  // republished, and a stale commitSha installs the wrong bytes.
  | { verb: 'install.plugin'; source: string; id: string }
  // A capability module from the app's OWN signed marketplace registry — the
  // one `readMarketplaceRegistry` reads, not a Claude marketplace a source
  // points at. `id` is the registry entry's id, and the executor resolves it
  // there before anything is downloaded.
  //
  // It carries no `source` for the reason `install.plugin` carries one: there
  // is exactly one registry, it ships with the app, and a card that could name
  // another would be a card choosing where this machine's code comes from.
  //
  // A module is code that runs in-process, so the executor honours this verb
  // ONLY for a `verified` entry — signed by a publisher in
  // `trusted-publishers.json`. Everything else needs the trust prompt, which is
  // a disclosure a person reads and answers; R4's "Go goes" removes the card's
  // own ceremony and does not repeal somebody else's gate (the same rule
  // `require.cli` follows). Such a card is refused by name, pointing at
  // Extensions → Plugins where the disclosure lives.
  | { verb: 'install.module'; id: string }
  // Open a chat with the named tools attached and the prompt sent. Two lists and
  // not one because the composer draft keeps them apart (newChatDraft.ts:
  // `skills: WorkspaceSkill[]` beside `mcpServers: AgentComposerConnector[]`),
  // and a flat list could not say which an entry was. `skills` names installed
  // skills by directory name — a `WorkspaceSkill.id`; `mcpServers` names
  // MCP server ids. `send` is required rather than optional: R4 is "Go goes", and
  // an unstated `send` leaves the reader guessing whether the card meant to park
  // its prompt in the composer for somebody to approve.
  //
  // **`mcpServers` is an assertion, not an attachment** — read this before you
  // write one (2026-09-06,
  // backlog/2026-09-06-the-seams-that-lead-nowhere.md §2). Listing a server here
  // does not put it on the chat: the executor's `openChat`
  // (src/main/cards/run-card.ts) deliberately carries nothing across, because
  // the card's servers reach the chat by already being in the workspace's
  // `.mcp.json`, which the `install.mcp` earlier in the same card wrote on the
  // way past. What the field does is bound what the card may CLAIM —
  // `refuseCardActions` below refuses a card whose chat names a server the card
  // does not install itself — so it is the place a card states its own
  // dependency and is held to it, not a way to reach a server it never
  // installed. `skills` is the opposite shape and that asymmetry is real: the
  // renderer attaches skills by name because a chip in the composer is the only
  // way a skill shows up, while an MCP server is already there in the file.
  //
  // Kept rather than deleted for the reason at the head of this file: the schema
  // is a permanent contract, and a field years-old builds parse cannot be
  // withdrawn just because the executor stopped forwarding it.
  | { verb: 'open.chat'; prompt: string; skills?: string[]; mcpServers?: string[]; send: boolean }
  // A door, on one of the Extensions views. Mirrors `ExtensionsSurfaceTarget`
  // exactly: a view, and optionally its Installed tab. The pair it replaces
  // (`surface` + `tab`) was the vocabulary of a surface that no longer exists.
  | { verb: 'open.surface'; view: CardSurfaceView; installed?: boolean }
  // Clone a public GitHub repository and open it. `repo` is `owner/name`: a card
  // names a repository, never a URL, so no card can point git at a host of its
  // choosing, and the owner must be one of `CARD_CLONE_OWNERS` below.
  // `folderName` is the single directory name to clone into, and the executor
  // supplies `parentDir` — where this app keeps projects is the app's business,
  // not a card's. There is no `ref`: the clone takes a branch now, but a
  // schema field is a permanent contract, and no card has needed anything but
  // the default branch — it is added when one does, not before.
  | { verb: 'clone.repo'; repo: string; folderName?: string }

export type CardActionVerb = CardAction['verb']

// ── From shared/installed-skills.ts ──
/** A physical installation, never deduplicated by its display name. */
export type InstalledSkill = {
  id: string
  name: string
  description: string
  path: string
  scope: 'project' | 'global'
  origin: string
  linked: boolean
  removable: boolean
  removalNote?: string
}

export type InstalledSkillsInput = {
  workspaceRoot: string | null
  pluginId: string
  /**
   * `wsl` when the CLI runs inside WSL on Windows, so its user folders are read
   * from the Linux home rather than the Windows profile. Absent means the CLI
   * runs on this machine's own filesystem.
   */
  pathStyle?: 'wsl'
  /** With `pathStyle: 'wsl'`, the machine (`wsl:<distro>`); absent is the default distribution. */
  hostId?: ExecutionHostId
}

export type InstalledSkillsResult =
  { ok: true; skills: InstalledSkill[]; diagnostics: string[] } | { ok: false; message: string }

export type InstalledSkillRemoveInput = InstalledSkillsInput & { installationId: string }

export type InstalledSkillRemoveResult = { ok: true } | { ok: false; message: string }

// ── From shared/design-system/bundle-lint-run.ts ──
// Result shape for running a bundle's own scripts/lint.mjs on demand
// (main-process runner ↔ preload ↔ renderer). A bundle author runs it
// as its validating preview — `findings` is the lint report the UI renders
// inline; `error` means the lint could not run at all (missing script,
// misconfiguration), which reads differently to the user.
export type DesignSystemBundleLintRunResult =
  { ok: true } | { ok: false; kind: 'findings'; findings: string } | { ok: false; kind: 'error'; message: string }

// ── From shared/design-system/bundle-scaffold.ts ──
export interface DesignSystemScaffoldResult {
  /** False when the layout could not be written; `message` explains why. */
  ok: boolean
  /** Absolute path of the bundle directory (set on success). */
  bundleDir?: string
  /**
   * True when a bundle already existed at the target (its manifest is
   * present). The scaffold never overwrites an existing bundle — reopening a
   * design-system workspace resumes it instead.
   */
  alreadyExisted?: boolean
  /** Human-readable failure summary when ok is false. */
  message?: string
}

// ── From shared/design-system/arrivals.ts ──
/** One bundle's arrival dates: its registration id, its folder, and entry key → ISO date. */
export type DesignSystemBundleArrivals = {
  /** `designSystemRegistrationId(path)` — the key `appSettings.designSystemSeen` stamps. */
  bundleId: string
  path: string
  addedAt: Record<string, string>
}

/** What the arrivals IPC returns: one row per readable registered bundle. */
export type DesignSystemArrivalsResult = { bundles: DesignSystemBundleArrivals[] }

// ── From shared/design-system/bundle-view.ts ──
/**
 * Why a bundle directory could not be read. Distinct cases, because a folder we
 * cannot read must never render identically to a system with no components —
 * the rail names which one it is, with the path visible.
 */
export type DesignSystemBundleReadFailure =
  /** The path is gone, or is not a directory (moved, renamed, unmounted). */
  | 'missing'
  /** The directory exists but carries no `design-system.json`. */
  | 'no-manifest'
  /** The manifest is present and does not parse against schema v1. */
  | 'invalid-manifest'
  /** Permission denied, or an I/O error. */
  | 'unreadable'

/** A bundle's identity, as a rail row shows it. */
export interface DesignSystemBundleIdentity {
  /** Absolute path of the bundle directory — the row's stable identity. */
  path: string
  name: string
  version: string
  summary: string
  /**
   * The bundle's own `sem.color.accent.primary`, resolved from
   * `foundations/tokens.tokens.json` per mode. Null when the bundle declares no
   * accent or its alias chain is broken — the row then shows no identity chip
   * rather than a fabricated colour.
   */
  accent: { light: string | null; dark: string | null }
}

/** One swatch of the specimen's colour bar. */
export interface DesignSystemRampSwatch {
  /** Dotted token path, e.g. `ref.color.green.600`. */
  path: string
  light: string
  dark: string
}

/**
 * One resolved token, per mode — the shape every specimen row on the Colour,
 * Type and Spacing tabs is drawn from.
 *
 * Both modes are carried for the same reason the ramp carries both: the door
 * paints whichever the app is in, and a shadow (the one family that really does
 * differ) would otherwise be drawn in the light value on a dark ground. A token
 * with no dark override simply repeats its light value.
 */
export interface DesignSystemTokenView {
  /** Dotted token path, e.g. `sem.space.md` — the only string the tab prints. */
  path: string
  light: string
  dark: string
}

/**
 * The `sem` families the door draws as specimens, beside the colour ramp.
 *
 * Resolved by the reader through the same `resolveTokenValue` the ramp uses, so
 * the renderer never re-parses `tokens.tokens.json` — the door has one source
 * for what a token is worth, and it is the reader.
 *
 * Each list is in the token document's own order (the author's), empty when the
 * bundle declares no such family. A bundle is not required to ship any of them.
 */
export interface DesignSystemTokenFamiliesView {
  /** `sem.font.size.*` */
  fontSize: DesignSystemTokenView[]
  /** `sem.font.weight.*` */
  fontWeight: DesignSystemTokenView[]
  /** `sem.font.line.*` */
  fontLine: DesignSystemTokenView[]
  /** `sem.font.tracking.*` */
  fontTracking: DesignSystemTokenView[]
  /** `sem.space.*` */
  space: DesignSystemTokenView[]
  /** `sem.size.control.*` */
  size: DesignSystemTokenView[]
  /** `sem.radius.*` */
  radius: DesignSystemTokenView[]
  /** `sem.shadow.*` */
  shadow: DesignSystemTokenView[]
}

export interface DesignSystemSpecimenView {
  /**
   * The emitted `:root` / `[data-mode="dark"]` block, shared by the specimen and
   * every component preview. Emitted from the token SOURCE, so a stale
   * `foundations/tokens.css` cannot make the door draw the wrong colours.
   */
  tokensCss: string
  /** The raw colour ramp, in document order — the specimen's one continuous bar. */
  ramp: DesignSystemRampSwatch[]
  /**
   * The bundle's own faces. A specimen set in OUR font is not a specimen, so the
   * display line uses these; null falls back to app chrome and must stay legible.
   */
  fontFamilyUi: string | null
  fontFamilyMono: string | null
  /**
   * The non-colour token families the Type and Spacing tabs draw.
   *
   * Beside the ramp rather than inside it: the ramp is the palette — the one
   * thing a system is recognised by — and these are the measurements. Both are
   * resolved the same way and neither is derived in the renderer.
   */
  tokens: DesignSystemTokenFamiliesView
  /** Token problems, surfaced rather than swallowed (see emitTokensCss). */
  problems: string[]
}

/** `component.md`'s five fixed sections, as authored. */
export interface DesignSystemComponentDoc {
  anatomy: string
  variants: string
  states: string
  usage: string
  accessibility: string
}

/** One top-level stage in a component's demo document. */
export interface DesignSystemStage {
  /** The stage's `data-mode`, when it declares one. */
  mode: string | null
  html: string
}

export interface DesignSystemComponentView {
  /** Directory name under `components/` — the component's id and its name. */
  name: string
  /** `component.css`, with bundle-relative `url()` refs inlined as data URIs. */
  css: string
  /** `<style>` blocks lifted from `component.html`, in document order. */
  inlineStyles: string[]
  /** Top-level `<body>` children of `component.html`, in order. */
  stages: DesignSystemStage[]
  /**
   * Counts read from `component.md`'s fixed Variants/States sections. Null when
   * the section is absent or unparseable — the tile then shows no count line
   * rather than a wrong number. The bundle format declares no variant MARKUP
   * contract, so prose is the only honest source.
   */
  variantCount: number | null
  stateCount: number | null
  doc: DesignSystemComponentDoc | null
  /** Bundle-relative refs that could not be inlined; reported, never silent. */
  unresolvedRefs: string[]
}

/** A pattern: one HTML file, rendered whole. */
export interface DesignSystemPatternView {
  name: string
  html: string
  inlineStyles: string[]
  unresolvedRefs: string[]
}

/** A glyph: one SVG file, inlined. `currentColor` by convention. */
export interface DesignSystemGlyphView {
  name: string
  svg: string
}

/** One section of the canvas, mirroring one `manifest.contents` key. */
export interface DesignSystemGroupView {
  /** The manifest `contents` key, preserving manifest (JSON) order. */
  key: string
  /** Sentence-case heading derived from the key. */
  label: string
  /** The entries the manifest declares for this group. */
  entries: string[]
  count: number
}

export interface DesignSystemBundleView {
  identity: DesignSystemBundleIdentity
  manifest: DesignSystemManifest
  specimen: DesignSystemSpecimenView
  /** One per NON-EMPTY declared `contents` key, in manifest order. */
  groups: DesignSystemGroupView[]
  components: DesignSystemComponentView[]
  patterns: DesignSystemPatternView[]
  glyphs: DesignSystemGlyphView[]
  /**
   * When each declared entry ARRIVED in this bundle: entry key
   * (`designSystemEntryKey(groupKey, manifestEntry)`) → ISO date. What the
   * door's "New since you last looked" marker reads.
   *
   * DERIVED, never declared. `design-system.json` gains no field for it — the
   * schema is a contract user-authored bundles already satisfy, and a marker
   * that needed a new manifest key would only ever light up for bundles we
   * generated. The reader resolves it from the bundle's git history, or from
   * file birthtime outside a repo.
   *
   * Optional, and sparse: an entry with no resolvable date is simply absent, and
   * a bundle with no dates at all carries an empty map. An unknown date is never
   * rendered as new (`shared/design-system/new-entries.ts`).
   */
  addedAt?: Record<string, string>
  /**
   * True when the data-URI inlining budget was exhausted, so some refs were
   * dropped for size rather than because they were missing. Said out loud —
   * a preview that silently lost its assets would look like a broken component.
   */
  assetBudgetExhausted: boolean
}

export type DesignSystemBundleReadResult =
  | { ok: true; view: DesignSystemBundleView }
  | {
      ok: false
      reason: DesignSystemBundleReadFailure
      /** Always carried, so a broken row can name the path it was pointed at. */
      path: string
      message: string
    }

// ── From shared/design-system/manifest.ts ──
export interface DesignSystemContents extends Record<string, unknown> {
  foundations: string[]
  components: string[]
  patterns: string[]
  glyphs: string[]
  assets: string[]
}

export interface DesignSystemProvenance extends Record<string, unknown> {
  authoredBy?: string | null
  sourceLibraryId?: string | null
  sourceLibraryVersion?: string | null
  releasedAt?: string | null
  attachedAt?: string | null
}

export interface DesignSystemManifest extends Record<string, unknown> {
  schemaVersion: number
  name: string
  version: string
  summary: string
  modes: string[]
  namingGrammar: Record<string, string>
  contents: DesignSystemContents
  derived: Record<string, string>
  provenance: DesignSystemProvenance
}

// ── From shared/design-system/library.ts ──
/**
 * Why a registered folder cannot be read right now.
 *
 * Distinct states, because a folder that moved, a folder that never was a
 * bundle, a bundle whose manifest broke, and a folder we lack permission for are
 * four different problems with four different fixes. A row shows which one it
 * is, with its path — never a disappeared row and never a generic error.
 */
export type DesignSystemSourceState = 'ok' | 'missing' | 'no-manifest' | 'invalid-manifest' | 'unreadable'

/** One design system in the library, as the rail lists it. */
export interface DesignSystemLibraryEntry {
  /** The registration id — the entry's stable identity. */
  id: string
  /** Absolute path of the bundle directory. */
  path: string
  /** From the manifest when readable, else the last cached value, else null. */
  name: string | null
  version: string | null
  summary: string
  /** The bundle manifest's own `provenance.releasedAt`, when it carries one.
   *  A field of the bundle format we read, not an app-owned release record. */
  releasedAt: string | null
  /** Whether this folder can be read, and if not, how it is broken. */
  sourceState: DesignSystemSourceState
  addedAt: string
}

export interface DesignSystemLibraryListResult {
  /** Sorted by display name (cached for a broken entry), then by path. */
  entries: DesignSystemLibraryEntry[]
}

export type DesignSystemRegisterResult = { ok: true; entry: DesignSystemLibraryEntry } | { ok: false; message: string }

// ── From shared/design-system/attach.ts ──
/**
 * Where the bundle comes from: an entry in the user-global library
 * (name+version resolve under the library root), or any browsed folder as the
 * escape hatch (validated as a bundle before anything is copied).
 */
export type DesignSystemAttachSource =
  /** A folder registered in the library, addressed by its registration id. */
  | { kind: 'library'; id: string }
  /** Any folder on disk, addressed directly (the new-workspace browse row). */
  | { kind: 'folder'; path: string }

/**
 * Stage that refused the attach. Nothing is written into the workspace on any
 * failure: `source` is an unreadable/invalid bundle, `target` a missing
 * workspace root, `conflict` an existing design-system/ in the workspace.
 */
export type DesignSystemAttachFailureStage = 'request' | 'source' | 'target' | 'conflict' | 'copy'

export type DesignSystemAttachResult =
  | {
      ok: true
      name: string
      version: string
      /** ISO timestamp stamped into the attached copy's provenance. */
      attachedAt: string
      /** Absolute path of the attached copy (<workspace>/design-system). */
      path: string
    }
  | {
      ok: false
      stage: DesignSystemAttachFailureStage
      message: string
    }

/**
 * Result of removing `<workspace>/design-system/`. `removed: false` means
 * there was nothing to remove — detach is idempotent, so that is still ok.
 */
export type DesignSystemDetachResult = { ok: true; removed: boolean } | { ok: false; message: string }

// ── The methods ─────────────────────────────────────────────────────────────

type Commanded<T> = { commandId: string } & T

/** A workspace by its folder, or null for the home folder's (every project's). */
type AtFolder = { workspaceFolder: string | null }

export type StudioAgentSkillsMethodMap = {
  'skillSources.list': { params: Record<string, never>; result: SkillSourcesResult }
  /** The manual Check now, under the poller's per-source cadence window. */
  'skillSources.checkUpdates': { params: Record<string, never>; result: SkillSourceUpdateCheck }
  'skillSources.add': { params: Commanded<SkillAddSourceInput>; result: SkillAddSourceResult }
  /** A folder on the Studio's machine, read as a source. */
  'skillSources.addLocal': {
    params: Commanded<{ folder: string; replace?: boolean }>
    result: SkillAddSourceResult
    errors: 'not_found'
  }
  'skillSources.remove': { params: Commanded<SkillRemoveSourceInput>; result: SkillRemoveSourceResult }
  /** Re-read a source and refresh every copy installed from it. */
  'skillSources.sync': {
    params: Commanded<AtFolder & { sourceId: string; mcpServers?: McpServerConfig[] }>
    result: SkillSyncSourceOutcome
    errors: 'not_found'
  }
  'skills.scan': { params: SkillScanInput; result: SkillScanOutcome }
  'skills.readFile': { params: SkillReadFileInput; result: SkillReadFileResult }
  'skills.install': {
    params: Commanded<{ sourceId: string; skillId: string; workspaceFolder?: string | null; scope?: SkillInstallScope }>
    result: SkillInstallOutcome
    errors: 'not_found'
  }
  'skills.uninstall': {
    params: Commanded<AtFolder & { dirName: string }>
    result: SkillUninstallOutcome
    errors: 'not_found'
  }
  'skills.search': { params: SkillSearchInput; result: SkillSearchOutcome }
  'skills.popularRepos': { params: Record<string, never>; result: SkillPopularReposOutcome }
  /** The folder skills a person writes by hand are kept in, made if it is not there yet. */
  'skills.ensureUserFolder': { params: { commandId: string }; result: { folder: string } }
  'skillPlugins.scanLinked': { params: SkillPluginScanLinkedInput; result: SkillPluginScanLinkedOutcome }
  'skillPlugins.install': {
    params: Commanded<SkillPluginInstallInput>
    result: SkillPluginInstallOutcome
    errors: 'not_found'
  }
  'skillPlugins.uninstall': {
    params: Commanded<SkillPluginUninstallInput>
    result: SkillPluginUninstallOutcome
    errors: 'not_found'
  }
  'skillPlugins.listInstalled': {
    params: { workspaceFolder: string }
    result: SkillInstalledPluginsOutcome
    errors: 'not_found'
  }
  'workspaceSkills.list': {
    params: AtFolder & { includeGlobal?: boolean }
    result: WorkspaceSkillsListResult
    errors: 'not_found'
  }
  /** Every physical copy of a skill one CLI reads, in a workspace and the home folder. */
  'installedSkills.list': {
    params: AtFolder & { pluginId: string; pathStyle?: 'wsl'; hostId?: ExecutionHostId }
    result: InstalledSkillsResult
    errors: 'not_found'
  }
  /** One of those copies, moved to the Trash where the Studio's machine has one. */
  'installedSkills.remove': {
    params: Commanded<
      AtFolder & { pluginId: string; pathStyle?: 'wsl'; hostId?: ExecutionHostId; installationId: string }
    >
    result: InstalledSkillRemoveResult
    errors: 'not_found'
  }
  'agentCapabilities.resolve': {
    params: AtFolder & { pluginId: string; includeGlobal?: boolean }
    result: AgentCapabilitiesResult
    errors: 'not_found'
  }
  /** A built-in skill written into (or out of) the harness folders the installed CLIs read. */
  'agentSkills.attach': {
    params: Commanded<AtFolder & { skillId: string }>
    result: AgentSkillWriteResult
    errors: 'not_found'
  }
  'designSystem.library': { params: Record<string, never>; result: DesignSystemLibraryListResult }
  'designSystem.arrivals': { params: Record<string, never>; result: DesignSystemArrivalsResult }
  'designSystem.register': {
    params: Commanded<{ folder: string }>
    result: DesignSystemRegisterResult
    errors: 'not_found'
  }
  'designSystem.forget': { params: Commanded<{ id: string }>; result: { ok: true; forgotten: boolean } }
  'designSystem.read': { params: { bundleFolder: string }; result: DesignSystemBundleReadResult; errors: 'not_found' }
  /** A new bundle in `targetFolder`, seeded from `sourceFolder` or bare from the shipped templates. */
  'designSystem.seed': {
    params: Commanded<{ sourceFolder: string | null; targetFolder: string; name: string; summary: string }>
    result: DesignSystemScaffoldResult
    errors: 'not_found'
  }
  /** The bundle's own `scripts/lint.mjs`, run in a process of its own. */
  'designSystem.lint': {
    params: Commanded<{ bundleFolder: string }>
    result: DesignSystemBundleLintRunResult
    errors: 'not_found'
  }
  'designSystem.attach': {
    params: Commanded<DesignSystemAttachRequest>
    result: DesignSystemAttachResult
    errors: 'not_found'
  }
  'designSystem.detach': {
    params: Commanded<{ workspaceFolder: string }>
    result: DesignSystemDetachResult
    errors: 'not_found'
  }
  /** Go on a card: its actions, re-read by the Studio's own parser, run in order. */
  'cards.run': { params: Commanded<CardRunInput>; result: CardRunResult }
}

/** Where an attach takes its bundle from, and the workspace it goes into. */
export type DesignSystemAttachRequest = {
  source: { kind: 'library'; id: string } | { kind: 'folder'; folder: string }
  workspaceFolder: string
}

export type StudioAgentSkillsMethod = keyof StudioAgentSkillsMethodMap

export type StudioAgentSkillsTopicMap = {
  /** What a check of the skill sources found, the poller's and Check now's alike. */
  'skillSources.updated': { params: Record<string, never>; payload: SkillSourceUpdateCheck; stream: 'push' }
}

// ── Validation ──────────────────────────────────────────────────────────────

type Refusal = StudioParamsRefusal
const refuse = (message: string): Refusal => studioParamsRefused(message)
const COMMAND_ID = '"commandId" names this command: a string of 1 to 200 characters.'
const PRESETS: readonly CliPermissionPreset[] = ['none', 'manual', 'auto', 'bypass']

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 500
}
function text(value: unknown, max = 4096): value is string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0')
}
function folder(value: unknown): value is string {
  return text(value) && value.length > 0
}
function ids(value: unknown, max = 500): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(id)
}
function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean'
}

function commanded<P>(
  read: (value: Record<string, unknown>) => StudioParsed<P>,
): (value: Record<string, unknown>) => StudioParsed<Commanded<P>> {
  return (value) => {
    if (typeof value.commandId !== 'string' || value.commandId.length === 0 || value.commandId.length > 200)
      return refuse(COMMAND_ID)
    const parsed = read(value)
    return parsed.ok ? studioParams({ commandId: value.commandId, ...parsed.params }) : parsed
  }
}

function atFolder(value: Record<string, unknown>): StudioParsed<AtFolder> {
  if (value.workspaceFolder === null || value.workspaceFolder === undefined)
    return studioParams({ workspaceFolder: null })
  return folder(value.workspaceFolder)
    ? studioParams({ workspaceFolder: value.workspaceFolder })
    : refuse('"workspaceFolder" is the workspace\'s folder, or null for the home folder\'s.')
}

function workspace(value: Record<string, unknown>): StudioParsed<{ workspaceFolder: string }> {
  return folder(value.workspaceFolder)
    ? studioParams({ workspaceFolder: value.workspaceFolder })
    : refuse('"workspaceFolder" is the workspace\'s folder.')
}

/** The workspace an owner's write names, in the shape its service takes. */
function ownersWorkspace(value: Record<string, unknown>): StudioParsed<{ workspaceRoot: string }> {
  return folder(value.workspaceRoot)
    ? studioParams({ workspaceRoot: value.workspaceRoot })
    : refuse('"workspaceRoot" is the workspace\'s folder.')
}

function source(value: Record<string, unknown>): StudioParsed<{ sourceId: string }> {
  return id(value.sourceId) ? studioParams({ sourceId: value.sourceId }) : refuse('"sourceId" names a skill source.')
}

/** The MCP servers the person has, read by the Studio's own normalizer: here, only their shape. */
function mcpServers(value: unknown): value is McpServerConfig[] {
  return Array.isArray(value) && value.length <= 500 && value.every(record)
}

function oneCli(
  value: Record<string, unknown>,
): StudioParsed<{ pluginId: string; pathStyle?: 'wsl'; hostId?: ExecutionHostId }> {
  if (!id(value.pluginId)) return refuse('"pluginId" names an agent CLI.')
  if (value.pathStyle !== undefined && value.pathStyle !== 'wsl') return refuse('"pathStyle" is "wsl" or absent.')
  if (value.hostId !== undefined && !(typeof value.hostId === 'string' && /^wsl:[^\0]{1,200}$/u.test(value.hostId)))
    return refuse('"hostId" names a WSL machine ("wsl:<distribution>").')
  return studioParams({
    pluginId: value.pluginId,
    ...(value.pathStyle === 'wsl' ? { pathStyle: 'wsl' as const } : {}),
    ...(typeof value.hostId === 'string' ? { hostId: value.hostId as ExecutionHostId } : {}),
  })
}

function pluginTarget(
  value: Record<string, unknown>,
): StudioParsed<{ sourceId: string; pluginId: string; workspaceRoot: string }> {
  const from = source(value)
  if (!from.ok) return from
  if (!id(value.pluginId)) return refuse('"pluginId" names a plugin in that source.')
  const at = ownersWorkspace(value)
  return at.ok ? studioParams({ ...from.params, pluginId: value.pluginId, ...at.params }) : at
}

function cardRun(value: Record<string, unknown>): StudioParsed<CardRunInput> {
  if (!id(value.slug)) return refuse('"slug" names the card.')
  // Each action is read again by the Studio's own card parser, which refuses
  // the whole card for one it cannot read; here, only that they are records.
  if (!Array.isArray(value.actions) || value.actions.length > 100 || !value.actions.every(record))
    return refuse('"actions" is the card\'s list of actions.')
  for (const key of ['workspaceRoot', 'cloneParentDir'] as const)
    if (value[key] !== null && !folder(value[key])) return refuse(`"${key}" is a folder, or null.`)
  if (!mcpServers(value.mcpServers)) return refuse('"mcpServers" is the list of MCP servers this Studio has.')
  if (typeof value.mcpSyncEnabled !== 'boolean') return refuse('"mcpSyncEnabled" is true or false.')
  for (const key of ['model', 'reasoning'] as const)
    if (value[key] !== undefined && value[key] !== null && !text(value[key], 200))
      return refuse(`"${key}" is a string, or null.`)
  if (value.permissionPreset !== undefined && !(PRESETS as readonly unknown[]).includes(value.permissionPreset))
    return refuse('"permissionPreset" is one of none, manual, auto and bypass.')
  return studioParams({
    slug: value.slug,
    actions: value.actions as CardRunInput['actions'],
    workspaceRoot: value.workspaceRoot as string | null,
    cloneParentDir: value.cloneParentDir as string | null,
    mcpServers: value.mcpServers,
    mcpSyncEnabled: value.mcpSyncEnabled,
    ...(value.model === undefined ? {} : { model: value.model as string | null }),
    ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning as string | null }),
    ...(value.permissionPreset === undefined
      ? {}
      : { permissionPreset: value.permissionPreset as CliPermissionPreset }),
  })
}

// ── The table ───────────────────────────────────────────────────────────────

const WRITES_PLUGIN =
  'It writes a plugin into the agent CLIs on this machine: hooks and MCP servers they run on their own.'
const RUNS_BUNDLE_SCRIPT = "It runs the bundle's own script on this machine."
const RUNS_A_CARD =
  'It installs modules, plugins, skills and MCP servers on this machine and clones repositories, in one press.'

type Scope = 'providers:read' | 'files:read' | 'files:write' | 'settings:write' | 'environment:maintain'
const held = (scope: Scope, mutation = false) =>
  ({ scope, mutation, capability: STUDIO_AGENT_SKILLS_CAPABILITY }) as const
const changes = (scope: Scope) => held(scope, true)
const owners = (scope: Scope, owner: string) => ({ ...held(scope, true), owner }) as const

export const STUDIO_AGENT_SKILLS_METHODS: StudioMethodTable<StudioAgentSkillsMethodMap> = {
  'skillSources.list': { ...held('providers:read'), params: studioNoParams },
  'skillSources.checkUpdates': { ...held('providers:read'), params: studioNoParams },
  'skillSources.add': {
    ...changes('settings:write'),
    params: commanded((value) => {
      if (!text(value.repo, 2048) || value.repo.trim().length === 0)
        return refuse('"repo" is owner/name or a repository URL.')
      if (!optionalBoolean(value.replace)) return refuse('"replace" is true, false or absent.')
      return studioParams({ repo: value.repo, ...(value.replace === true ? { replace: true } : {}) })
    }),
  },
  'skillSources.addLocal': {
    ...changes('settings:write'),
    params: commanded((value) => {
      if (!folder(value.folder)) return refuse('"folder" is a folder on the Studio\'s machine.')
      if (!optionalBoolean(value.replace)) return refuse('"replace" is true, false or absent.')
      return studioParams({ folder: value.folder, ...(value.replace === true ? { replace: true } : {}) })
    }),
  },
  'skillSources.remove': { ...changes('settings:write'), params: commanded(source) },
  'skillSources.sync': {
    ...changes('environment:maintain'),
    params: commanded((value) => {
      const from = source(value)
      if (!from.ok) return from
      const at = atFolder(value)
      if (!at.ok) return at
      if (value.mcpServers !== undefined && !mcpServers(value.mcpServers))
        return refuse('"mcpServers" is the list of MCP servers this Studio has.')
      return studioParams({
        ...from.params,
        ...at.params,
        ...(value.mcpServers === undefined ? {} : { mcpServers: value.mcpServers as McpServerConfig[] }),
      })
    }),
  },
  'skills.scan': { ...held('providers:read'), params: source },
  'skills.readFile': {
    ...held('providers:read'),
    params: (value) => {
      const from = source(value)
      if (!from.ok) return from
      if (!id(value.skillId)) return refuse('"skillId" names a skill in that source.')
      if (!folder(value.path)) return refuse('"path" is a file inside that skill.')
      return studioParams({ ...from.params, skillId: value.skillId, path: value.path })
    },
  },
  'skills.install': {
    ...changes('environment:maintain'),
    params: commanded((value) => {
      const from = source(value)
      if (!from.ok) return from
      if (!id(value.skillId)) return refuse('"skillId" names a skill in that source.')
      const at = atFolder(value)
      if (!at.ok) return at
      if (value.scope !== undefined && value.scope !== 'global' && value.scope !== 'workspace')
        return refuse('"scope" is "global" or "workspace".')
      return studioParams({
        ...from.params,
        skillId: value.skillId,
        ...at.params,
        ...(value.scope === undefined ? {} : { scope: value.scope as SkillInstallScope }),
      })
    }),
  },
  'skills.uninstall': {
    ...changes('environment:maintain'),
    params: commanded((value) => {
      const at = atFolder(value)
      if (!at.ok) return at
      return id(value.dirName)
        ? studioParams({ ...at.params, dirName: value.dirName })
        : refuse('"dirName" names an installed skill.')
    }),
  },
  'skills.search': {
    ...held('providers:read'),
    params: (value) =>
      text(value.query, 500) ? studioParams({ query: value.query }) : refuse('"query" is the search.'),
  },
  'skills.popularRepos': { ...held('providers:read'), params: studioNoParams },
  'skills.ensureUserFolder': { ...changes('environment:maintain'), params: commanded(() => studioParams({})) },
  'skillPlugins.scanLinked': {
    ...held('providers:read'),
    params: (value) => {
      const from = source(value)
      if (!from.ok) return from
      return id(value.pluginId)
        ? studioParams({ ...from.params, pluginId: value.pluginId })
        : refuse('"pluginId" names a plugin in that source.')
    },
  },
  'skillPlugins.install': {
    ...owners('environment:maintain', WRITES_PLUGIN),
    params: commanded((value) => {
      const target = pluginTarget(value)
      if (!target.ok) return target
      if (!optionalBoolean(value.acknowledgedHooks)) return refuse('"acknowledgedHooks" is true, false or absent.')
      if (value.skillIds !== undefined && !ids(value.skillIds)) return refuse('"skillIds" is a list of skill ids.')
      if (value.mcpServerIds !== undefined && !ids(value.mcpServerIds))
        return refuse('"mcpServerIds" is a list of ids.')
      return studioParams({
        ...target.params,
        ...(value.acknowledgedHooks === true ? { acknowledgedHooks: true } : {}),
        ...(value.skillIds === undefined ? {} : { skillIds: [...(value.skillIds as string[])] }),
        ...(value.mcpServerIds === undefined ? {} : { mcpServerIds: [...(value.mcpServerIds as string[])] }),
      })
    }),
  },
  'skillPlugins.uninstall': {
    ...owners('environment:maintain', WRITES_PLUGIN),
    params: commanded((value) => {
      const target = pluginTarget(value)
      if (!target.ok) return target
      if (value.mcpServerId !== undefined && !id(value.mcpServerId)) return refuse('"mcpServerId" names an MCP server.')
      return studioParams({
        ...target.params,
        ...(value.mcpServerId === undefined ? {} : { mcpServerId: value.mcpServerId as string }),
      })
    }),
  },
  'skillPlugins.listInstalled': { ...held('providers:read'), params: workspace },
  'workspaceSkills.list': {
    ...held('providers:read'),
    params: (value) => {
      const at = atFolder(value)
      if (!at.ok) return at
      if (!optionalBoolean(value.includeGlobal)) return refuse('"includeGlobal" is true, false or absent.')
      return studioParams({ ...at.params, ...(value.includeGlobal === true ? { includeGlobal: true } : {}) })
    },
  },
  'installedSkills.list': {
    ...held('providers:read'),
    params: (value) => {
      const at = atFolder(value)
      if (!at.ok) return at
      const cli = oneCli(value)
      return cli.ok ? studioParams({ ...at.params, ...cli.params }) : cli
    },
  },
  'installedSkills.remove': {
    ...changes('environment:maintain'),
    params: commanded((value) => {
      const at = atFolder(value)
      if (!at.ok) return at
      const cli = oneCli(value)
      if (!cli.ok) return cli
      return id(value.installationId)
        ? studioParams({ ...at.params, ...cli.params, installationId: value.installationId })
        : refuse('"installationId" names one installed copy.')
    }),
  },
  'agentCapabilities.resolve': {
    ...held('providers:read'),
    params: (value) => {
      const at = atFolder(value)
      if (!at.ok) return at
      if (!id(value.pluginId)) return refuse('"pluginId" names an agent CLI.')
      if (!optionalBoolean(value.includeGlobal)) return refuse('"includeGlobal" is true, false or absent.')
      return studioParams({
        ...at.params,
        pluginId: value.pluginId,
        ...(value.includeGlobal === true ? { includeGlobal: true } : {}),
      })
    },
  },
  'agentSkills.attach': {
    ...changes('environment:maintain'),
    params: commanded((value) => {
      const at = atFolder(value)
      if (!at.ok) return at
      return id(value.skillId)
        ? studioParams({ ...at.params, skillId: value.skillId })
        : refuse('"skillId" names a built-in skill.')
    }),
  },
  'designSystem.library': { ...held('files:read'), params: studioNoParams },
  'designSystem.arrivals': { ...held('files:read'), params: studioNoParams },
  'designSystem.register': {
    ...changes('settings:write'),
    params: commanded((value) =>
      folder(value.folder) ? studioParams({ folder: value.folder }) : refuse('"folder" is the bundle\'s folder.'),
    ),
  },
  'designSystem.forget': {
    ...changes('settings:write'),
    params: commanded((value) =>
      id(value.id) ? studioParams({ id: value.id }) : refuse('"id" names a library entry.'),
    ),
  },
  'designSystem.read': {
    ...held('files:read'),
    params: (value) =>
      folder(value.bundleFolder)
        ? studioParams({ bundleFolder: value.bundleFolder })
        : refuse('"bundleFolder" is the bundle\'s folder.'),
  },
  'designSystem.seed': {
    ...changes('files:write'),
    params: commanded((value) => {
      if (value.sourceFolder !== null && !folder(value.sourceFolder))
        return refuse('"sourceFolder" is the bundle to seed from, or null for the shipped templates.')
      if (!folder(value.targetFolder)) return refuse('"targetFolder" is where the new bundle goes.')
      if (!text(value.name, 200) || !text(value.summary, 2000)) return refuse('"name" and "summary" are text.')
      return studioParams({
        sourceFolder: value.sourceFolder as string | null,
        targetFolder: value.targetFolder,
        name: value.name,
        summary: value.summary,
      })
    }),
  },
  'designSystem.lint': {
    ...owners('files:read', RUNS_BUNDLE_SCRIPT),
    params: commanded((value) =>
      folder(value.bundleFolder)
        ? studioParams({ bundleFolder: value.bundleFolder })
        : refuse('"bundleFolder" is the bundle\'s folder.'),
    ),
  },
  'designSystem.attach': {
    ...changes('files:write'),
    params: commanded((value): StudioParsed<DesignSystemAttachRequest> => {
      const at = workspace(value)
      if (!at.ok) return at
      const from = value.source
      if (record(from) && from.kind === 'library' && id(from.id))
        return studioParams({ source: { kind: 'library' as const, id: from.id }, ...at.params })
      if (record(from) && from.kind === 'folder' && folder(from.folder))
        return studioParams({ source: { kind: 'folder' as const, folder: from.folder }, ...at.params })
      return refuse('"source" is { kind: "library", id } or { kind: "folder", folder }.')
    }),
  },
  'designSystem.detach': { ...changes('files:write'), params: commanded(workspace) },
  'cards.run': { ...owners('environment:maintain', RUNS_A_CARD), params: commanded(cardRun) },
}

export const STUDIO_AGENT_SKILLS_TOPICS: StudioTopicTable<StudioAgentSkillsTopicMap> = {
  'skillSources.updated': {
    scope: 'providers:read',
    capability: STUDIO_AGENT_SKILLS_CAPABILITY,
    push: true,
    params: studioNoParams,
  },
}
