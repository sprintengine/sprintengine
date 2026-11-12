import {
  studioNoParams,
  studioParams,
  studioParamsRefused,
  type StudioMethodDefinition,
  type StudioMethodTable,
  type StudioParamsRefusal,
  type StudioParsed,
  type StudioTopicTable,
} from './contract.js'
import type {
  AgentCli,
  CliPermissionPreset,
  CliRuntimeSettings,
  ExecutionHostId,
  McpServerConfig,
  McpSettings,
} from './agents.js'
import { STUDIO_AGENT_RUNTIMES_CAPABILITY, STUDIO_AGENT_SETTINGS_CAPABILITY } from './handshake.js'

// How a Studio runs its agents' CLIs, and the settings every launch reads.
//
// Two capabilities, because two processes can hold them:
//
// - `agent-runtimes`: the CLIs on the Studio's machine and its WSL
//   distributions: detecting one, installing or updating it (`cliRuntimes.*`),
//   and whether each is behind its published version (`cliVersions.*`).
// - `agent-settings`: the launch settings (`launchSettings.*`), the models
//   each CLI reports about itself (`cliModels.*`), and the short texts a CLI
//   writes for Studio: a chat's title (`textGeneration.*`) and a commit
//   message (`commitMessage.*`).
//
// Grants. Reading what can run is `providers:read`; installing or updating a
// CLI keeps the machine, `environment:maintain`; a CLI's own `command` is an
// owner's to name, as everywhere on this protocol (a Studio refuses it from
// any other grant, by its params). The launch settings are an owner's: they
// hold the program each CLI and MCP server runs on the machine, the arguments
// a preset adds, and the MCP servers' environment, which carries their keys.
// A title and a commit message run one of this machine's agent CLIs outside
// any chat, for the window's own boxes (a chat's name, the commit message
// field), and a commit message reads a checkout on this disk: an owner's by
// declaration, under `conversation:operate`, and never a paired device's. An
// owner's connection held to known folders (a browser tab) names a checkout
// only inside the folders the Studio knows.
//
// `src/shared` re-exports each type under the name the app has always used.

// ── CLI runtimes ────────────────────────────────────────────────────────────

/** Whether an agent CLI is installed and runnable, as a probe found it. */
export type CliDetectResult = {
  cli: AgentCli
  binary: string
  installed: boolean
  version: string | null
  resolvedPath: string | null
  /** The machine the probe ran on (`local`, or a WSL distribution). */
  hostId: ExecutionHostId
  error: string | null
}

/**
 * One offered install path for a CLI on the machine. The command is the
 * Studio's own: `commandPreview` is shown before the person agrees to run it,
 * and a client never sends one.
 */
export type CliInstallMethodInfo = {
  id: string
  label: string
  /** Whether the method's prerequisite (`npm`, `brew`) is on PATH. */
  available: boolean
  unavailableReason: string | null
  recommended: boolean
  commandPreview: string
  /** The platform bucket this method was resolved from (`darwin`, `linux`, `win32`, `wsl`). */
  platform: string
}

export type CliInstallInput = { cli: AgentCli; methodId: string }

export type CliInstallResult = {
  ok: boolean
  cli: AgentCli
  installed: boolean
  version: string | null
  resolvedPath: string | null
  log: string
  error: string | null
}

/** Where one CLI's update stands. */
export type CliUpdateAllState = 'queued' | 'updating' | 'updated' | 'unchanged' | 'failed'

export type CliUpdateAllItem = {
  hostId: ExecutionHostId
  cli: AgentCli
  /** The version found before the update, and the one published. */
  from: string | null
  latest: string | null
  /** The version found after it, once it has run. */
  to?: string | null
  state: CliUpdateAllState
  error?: string
}

export type CliUpdateAllResult = { ok: true; items: CliUpdateAllItem[] } | { ok: false; message: string }

/**
 * The runtime a detection, an install or an update runs against: the program
 * (an owner's to name) and the machine. Absent, the CLI's own binary on this
 * machine.
 */
export type CliRuntimeTarget = Pick<Partial<CliRuntimeSettings>, 'command' | 'hostId'>

// ── CLI versions ────────────────────────────────────────────────────────────

/**
 * Whether an installed CLI is behind the newest version its registry
 * publishes. `unknown` (no package, an unparsable version, a registry that did
 * not answer) is never shown as up to date.
 */
export type CliVersionAdvisoryStatus = 'current' | 'behind_latest' | 'unknown'

/** What an Update runs, chosen by the Studio from the manifest and where the binary is; a client shows it. */
export type CliUpdateCommand = { kind: 'cli-updater' | 'brew' | 'npm' | 'install-method'; command: string }

export type CliVersionAdvisory = {
  cli: AgentCli
  /** The machine the installed version was found on. The same CLI can be current on one and behind on another. */
  hostId: ExecutionHostId
  status: CliVersionAdvisoryStatus
  currentVersion: string | null
  latestVersion: string | null
  updateCommand: CliUpdateCommand | null
  checkedAt: string
}

export type CliVersionAdvisoryMap = Partial<Record<AgentCli, CliVersionAdvisory>>

/** One map per machine the Studio checks. A machine absent here has not been detected yet. */
export type CliVersionHostAdvisories = Partial<Record<ExecutionHostId, CliVersionAdvisoryMap>>

export type CliVersionAdvisoriesInput = {
  /** Bypass the registry cache, and answer even while version checks are off. */
  force?: boolean
  /** Detect every CLI on every machine again first (Settings' Re-check). */
  detect?: boolean
}

export type CliVersionAdvisoriesResult =
  | {
      ok: true
      advisories: CliVersionHostAdvisories
      checkedAt: string
      /** Outdated CLIs not yet announced at this version: a toast fires once per machine, CLI and version. */
      newlyOutdated?: CliVersionAdvisory[]
    }
  | { ok: false; message: string }

// ── CLI models ──────────────────────────────────────────────────────────────

/** One model as a CLI described it. Only `id`, what `--model` takes, is certain. */
export type DiscoveredCliModel = {
  id: string
  displayName?: string
  description?: string
  /** The id the CLI says this alias resolves to: display only, never identity. */
  resolvedModel?: string
  contextWindow?: number
  effortLevels?: string[]
  defaultEffort?: string
  supportsFastMode?: boolean
  /** When a probe on this machine first listed the id (ISO), carried forward on every refresh. */
  firstSeenAt?: string
}

/** What one CLI last reported: by a subprocess (`argv-probe`) or the agent SDK (`agent-sdk`). */
export type DiscoveredCliModelCatalog = {
  models: DiscoveredCliModel[]
  fetchedAt: string
  source: 'argv-probe' | 'agent-sdk'
  /** The version that reported them, for diagnosing a stale catalog. */
  cliVersion?: string
}

export type CliModelDiscoveryInput = {
  /** Per-CLI command and machine overrides, so a probe runs the binary a launch would. */
  cliRuntimes?: Partial<Record<string, Partial<CliRuntimeSettings>>>
  /** Only these CLIs; every registered one when absent. */
  clis?: string[]
  /** Ignore the freshness window and probe again (Settings' Refresh models). */
  force?: boolean
  /** The catalogs the client holds, so a refresh carries each row's `firstSeenAt` forward. */
  previous?: Partial<Record<string, DiscoveredCliModelCatalog>>
}

export type CliModelDiscoverySkipReason = 'not-installed' | 'no-probe' | 'fresh'

export type CliModelDiscoveryEntry = {
  cli: string
  /** The catalog to store, or null when nothing changed or the probe was skipped. */
  catalog: DiscoveredCliModelCatalog | null
  skipped?: CliModelDiscoverySkipReason
  /** Plain words for Settings; a failed probe never empties the list. */
  error?: string
}

export type CliModelDiscoveryResult = { entries: CliModelDiscoveryEntry[]; startedAt: string; finishedAt: string }

// ── Text generation ─────────────────────────────────────────────────────────

/** The CLI, model and reasoning a short text is written with. */
export type TextGenerationEngine = { cli: string; model: string; reasoning?: string }

/**
 * `unsupported`: no backend for the CLI, or a request in no known shape;
 * `unavailable`: not installed; `transport`: the CLI failed or answered
 * nothing readable; `guardrail`: it answered, not with a usable text;
 * `cancelled`: the person called it off.
 */
export type TextGenerationFailureCode =
  'unsupported' | 'unavailable' | 'timeout' | 'transport' | 'guardrail' | 'cancelled'

export type TextGenerationFailure = { ok: false; code: TextGenerationFailureCode; message: string }

export type TextGenerationResult = { ok: true; value: string; ms: number } | TextGenerationFailure

/** Per-CLI command and machine overrides, as a launch would run it. */
export type TextGenerationCliRuntimeOverrides = Record<
  string,
  { command?: string; hostId?: ExecutionHostId } | undefined
>

export type ChatTitleRequest = {
  prompt: string
  engine: TextGenerationEngine
  cliRuntimes?: TextGenerationCliRuntimeOverrides
  timeoutMs?: number
}

export const WRITING_STYLE_MODES = ['repository', 'conventional', 'custom'] as const
export type WritingStyleMode = (typeof WRITING_STYLE_MODES)[number]

export type TextGenerationWritingStyle = {
  mode: WritingStyleMode
  /** The person's own guide, used under `custom`; kept while another mode is chosen. */
  instructions: string
}

export type TextGenerationSettings = {
  enabled: boolean
  engine: TextGenerationEngine | null
  writingStyle: TextGenerationWritingStyle
}

export type CommitMessageText = { subject: string; body: string; message: string }

export type CommitMessageResult = { ok: true; value: CommitMessageText; ms: number } | TextGenerationFailure

export type CommitMessageDraftRequest = {
  /** The checkout whose staged changes are described. */
  repoRoot: string
  engine: TextGenerationEngine
  cliRuntimes?: TextGenerationCliRuntimeOverrides
  /** What `commitMessage.cancel` names. */
  draftId?: string
  writingStyle?: TextGenerationWritingStyle
}

// ── Launch settings ─────────────────────────────────────────────────────────

/** The kinds a machine is drawn as. */
export const MACHINE_KINDS = [
  'laptop',
  'desktop',
  'mini',
  'tower',
  'server',
  'cloud',
  'container',
  'board',
  'wsl',
] as const
export type MachineKind = (typeof MACHINE_KINDS)[number]

export const MACHINE_COLOURS = ['blue', 'teal', 'cyan', 'orange', 'yellow', 'violet', 'red', 'neutral'] as const
export type MachineColour = (typeof MACHINE_COLOURS)[number]

/** A person's override for one machine. Absent fields read as the default. */
export type MachineMarkSetting = { kind?: MachineKind; colour?: MachineColour }
/** Overrides, keyed by machine id. */
export type MachineMarkSettings = Record<string, MachineMarkSetting>

/** One machine's settings other than this one's: its commands, environment and shell. */
export type ExecutionHostSettings = {
  /** WSL: offered as a machine for new chats. */
  enabled: boolean
  /** Per-CLI command override on this machine. Blank or absent uses the CLI's own binary name. */
  cliCommands: Record<string, string>
  /** Extra environment exported into every launch on this machine. */
  env: Record<string, string>
  /** The plain-terminal shell; absent uses the machine's default. */
  shell?: string
  /** WSL: whether its chats run in a Studio server inside the distribution. */
  chatServer?: 'on' | 'off'
  /** WSL: how Windows reaches that server. */
  serverTransport?: 'auto' | 'stdio'
}

/** One project's uses, folded into a running score. */
export type ProjectUsage = { score: number; scoredAt: number; lastUsedAt: number; useCount: number }
export type ProjectUsageMap = Record<string, ProjectUsage>

export type AgentLaunchCliRuntimeSettings = {
  command: string
  models?: string[]
  /** Ids the person took off this CLI's list; a refresh does not bring them back. */
  removedModels?: string[]
}

/** What every launch on the Studio reads. */
export type AgentLaunchSettings = {
  cliRuntimes: Record<string, AgentLaunchCliRuntimeSettings>
  /**
   * Per-machine settings, keyed by host id (`wsl:<distro>`). The local machine
   * has no entry in normal use: its commands live on `cliRuntimes`.
   */
  hosts: Partial<Record<ExecutionHostId, ExecutionHostSettings>>
  /**
   * The kind and colour a person chose for a machine (Settings › Machines),
   * keyed by its machine id (`shared/machine-identity`): a WSL host id,
   * `ssh:<host>` or `tailnet:<name>`. A machine with no entry wears its
   * defaults. Kept beside `hosts` and written the same way, per machine.
   */
  machineMarks: MachineMarkSettings
  mcp: McpSettings
  projectKnowledgeRoots: Record<string, string | null>
  /**
   * The CLI a spawn defaults to when the caller names none. `null` = never
   * chosen; the reader applies its own default rather than inventing one.
   */
  lastSelectedCli: string | null
  /** The permission preset an agent spawn defaults to. `null` = never chosen. */
  lastAgentSpawnPermissionPreset: CliPermissionPreset | null
  /**
   * The permission preset a spawn on each CLI launches with, keyed by CLI id:
   * what the spawn footer's picker last chose for that runtime. A CLI with no
   * entry falls back to `lastAgentSpawnPermissionPreset`. Per CLI and not per
   * model, because a person trusts a runtime in a repository, and skipping
   * Claude Code's prompts is not lifting Codex's sandbox (owner ruling
   * 2026-09-24). Main owns it so
   * a launch with no window open, and every window, read the same choice.
   */
  cliPermissionPresets: Record<string, CliPermissionPreset>
  /**
   * The CLI's own mode chosen with that preset, keyed by CLI id, for a CLI
   * whose choice is one of its modes other than the preset's own (Claude
   * Code's Accept edits, at Auto). A CLI with no entry runs the preset's own
   * mode. Read only beside the CLI's entry in `cliPermissionPresets`, which
   * stays the level everything else reasons with.
   */
  cliPermissionModes: Record<string, string>
  /**
   * Where chats were started, by project folder (`projectUsageKey`): each
   * project's frecency score, latest use and use count (`project-frecency.ts`).
   * Every project picker for a new chat lists by it, here and on a paired
   * phone through `workspace.list`. Kept beside `lastSelectedCli` because it is
   * the same kind of memory, of where launches went, and main records a chat
   * started from the phone with no window open.
   */
  projectUsage: ProjectUsageMap
  /**
   * What every worktree branch Studio names starts with (Settings ▸
   * Worktrees): `feat` names `feat/<name>`, and `''` names the branch `<name>`
   * alone. `null` = never chosen, which reads as `agent`, the prefix there
   * was before it could be chosen (`effectiveWorktreeBranchPrefix`). Kept
   * here because main names a launch's worktree with no window open, as it
   * reads every other launch input; held sanitized (`worktree-branch.ts`).
   */
  worktreeBranchPrefix: string | null
  /**
   * Whether a chat whose own menu leaves Auto compact unset (`autoCompactEnabled`
   * null) compacts by itself while it sits idle, just before its prompt cache
   * expires (Settings ▸ Settled chats). `null` = never chosen, which reads as
   * off. Kept here because main runs the compaction with no window open
   * (conversation-auto-compact.ts), as it reads every other launch input.
   */
  autoCompactChats: boolean | null
}

/** The schema of the record the Studio keeps. */
export const AGENT_LAUNCH_SETTINGS_SCHEMA_VERSION = 2 as const

/** Names the process boundary a write came through, never the human. */
export type AgentLaunchSettingsActor = 'ui' | 'system'

export type AgentLaunchSettingsRecord = {
  schemaVersion: typeof AGENT_LAUNCH_SETTINGS_SCHEMA_VERSION
  /** Monotonic: a follower ignores a record at or below the revision it holds. */
  revision: number
  settings: AgentLaunchSettings
  changedAt: number
  lastWrite: { actor: AgentLaunchSettingsActor; at: string }
}

/**
 * A partial write to the Studio's record. Each field is independent, so two windows
 * editing different CLIs, different MCP servers or different knowledge roots
 * never overwrite each other with a stale copy of the rest.
 *
 * - `cliRuntimes`: per CLI, an entry replaces that CLI's runtime whole and
 *   `null` removes it. CLIs the patch does not name are untouched.
 * - `hosts`: the same, per machine.
 * - `machineMarks`: the same, per machine id.
 * - `mcp.syncEnabled` sets the switch; `mcp.servers` upserts per server id,
 *   `null` removing that server.
 * - `projectKnowledgeRoots`: per project root, a string sets it and `null`
 *   removes the entry.
 * - `lastSelectedCli` and `lastAgentSpawnPermissionPreset` replace the value;
 *   `null` returns it to "never chosen".
 * - `cliPermissionPresets`: per CLI, a preset sets it and `null` removes the
 *   entry, so that CLI reads the app-wide default again. Either way the CLI's
 *   mode goes with it unless the same patch names one, so a window that knows
 *   only presets never leaves a mode behind under a preset it did not choose.
 * - `cliPermissionModes`: per CLI, a mode id sets it and `null` removes it.
 * - `projectUse` records one use of the project at that folder, at `at`
 *   (epoch milliseconds). It adds to what main holds rather than replacing it,
 *   so two windows and the phone each starting a chat all count.
 * - `worktreeBranchPrefix` replaces the prefix, sanitized; `null` returns it
 *   to "never chosen", which reads as `agent`.
 * - `autoCompactChats` replaces the default; `null` returns it to "never
 *   chosen", which reads as off.
 */
export type AgentLaunchSettingsPatch = {
  cliRuntimes?: Record<string, AgentLaunchCliRuntimeSettings | null>
  /** Per host id, an entry replaces that host's settings whole and `null` removes them. */
  hosts?: Partial<Record<ExecutionHostId, ExecutionHostSettings | null>>
  /** Per machine id, an entry replaces that machine's mark whole and `null` returns it to the defaults. */
  machineMarks?: Record<string, MachineMarkSetting | null>
  mcp?: {
    syncEnabled?: boolean
    servers?: Record<string, McpServerConfig | null>
  }
  projectKnowledgeRoots?: Record<string, string | null>
  lastSelectedCli?: string | null
  lastAgentSpawnPermissionPreset?: CliPermissionPreset | null
  cliPermissionPresets?: Record<string, CliPermissionPreset | null>
  cliPermissionModes?: Record<string, string | null>
  projectUse?: { folderPath: string; at: number }
  worktreeBranchPrefix?: string | null
  autoCompactChats?: boolean | null
}

/** What a client reads first: the record (null until anything was written) and what launches use either way. */
export type AgentLaunchSettingsSnapshot = {
  record: AgentLaunchSettingsRecord | null
  settings: AgentLaunchSettings
  /** Whether `record` is on disk. */
  persisted: boolean
}

/** A write's answer: the record the Studio now holds, which the caller adopts, and whether it is on disk. */
export type AgentLaunchSettingsWriteAck = {
  ok: true
  record: AgentLaunchSettingsRecord
  changed: boolean
  persisted: boolean
}

// ── Methods ─────────────────────────────────────────────────────────────────

type Commanded<T> = { commandId: string } & T

export type StudioAgentSettingsMethodMap = {
  /** Probe one CLI on one machine; the Studio's shared answer takes the result on. */
  'cliRuntimes.detect': { params: { cli: AgentCli; runtime?: CliRuntimeTarget }; result: CliDetectResult }
  'cliRuntimes.installMethods': {
    params: { cli: AgentCli; runtime?: CliRuntimeTarget }
    result: { methods: CliInstallMethodInfo[] }
  }
  /**
   * Install a CLI by one of the Studio's own methods. One install or update of
   * a CLI on a machine runs at a time: a second of the same kind joins it and
   * is answered the same; one of the other kind is answered `ok: false`. The
   * output streams on `cliRuntimes.output`.
   */
  'cliRuntimes.install': {
    params: Commanded<CliInstallInput & { runtime?: CliRuntimeTarget }>
    result: CliInstallResult
  }
  /** Update a CLI: its own updater where it has one, else its install again. As `install` for the rest. */
  'cliRuntimes.update': { params: Commanded<{ cli: AgentCli; runtime?: CliRuntimeTarget }>; result: CliInstallResult }
  /** Update every outdated CLI on every machine; asked while one runs, it joins it. Progress on `cliRuntimes.updateAllProgress`. */
  'cliRuntimes.updateAll': { params: Commanded<Record<never, never>>; result: CliUpdateAllResult }
  'cliVersions.advisories': { params: CliVersionAdvisoriesInput; result: CliVersionAdvisoriesResult }
  /** Turn the version check on or off; answers what it now is. */
  'cliVersions.setEnabled': { params: Commanded<{ enabled: boolean }>; result: { enabled: boolean } }
  /** Probe the CLIs for their models. Every catalog a probe produced is pushed on `cliModels.changed` too. */
  'cliModels.discover': { params: CliModelDiscoveryInput; result: CliModelDiscoveryResult }
  'launchSettings.get': { params: Record<string, never>; result: AgentLaunchSettingsSnapshot }
  /** A partial write, read by the Studio's own normalizer: what it does not know is dropped. */
  'launchSettings.update': {
    params: Commanded<{ patch: AgentLaunchSettingsPatch }>
    result: AgentLaunchSettingsWriteAck
  }
  /** A client's settings from before the Studio kept them, taken only while it holds no record (`changed: false` otherwise). */
  'launchSettings.migrate': {
    params: Commanded<{ settings: AgentLaunchSettings }>
    result: AgentLaunchSettingsWriteAck
  }
  /** The model-written titles setting, which the Studio titles its chats by. */
  'textGeneration.setSettings': {
    params: Commanded<{ settings: TextGenerationSettings }>
    result: Record<string, never>
  }
  /** A chat's title, from its first message. Never refused for what the CLI said: that is `ok: false`. */
  'textGeneration.chatTitle': { params: ChatTitleRequest; result: TextGenerationResult }
  /**
   * A commit message for a checkout's staged changes. Never refused for what
   * git or the CLI said; refused `not_found` for a folder this connection may
   * not name.
   */
  'commitMessage.draft': { params: CommitMessageDraftRequest; result: CommitMessageResult; errors: 'not_found' }
  /** Stop a draft this client started; its `draft` is answered `cancelled`. */
  'commitMessage.cancel': { params: { draftId: string }; result: Record<string, never> }
}

export type StudioAgentSettingsMethod = keyof StudioAgentSettingsMethodMap

export type StudioAgentSettingsTopicMap = {
  /** An install's or update's output, for one CLI on one machine (this one when `hostId` is absent). */
  'cliRuntimes.output': {
    params: { cli: AgentCli; hostId?: ExecutionHostId }
    payload: { chunk: string }
    stream: 'push'
  }
  /** Every item of an Update everything, each time one moves. */
  'cliRuntimes.updateAllProgress': {
    params: Record<string, never>
    payload: { items: CliUpdateAllItem[] }
    stream: 'push'
  }
  /** The advisories, when they moved. */
  'cliVersions.changed': { params: Record<string, never>; payload: CliVersionAdvisoriesResult; stream: 'push' }
  /** The catalogs a discovery pass produced, whoever started it. */
  'cliModels.changed': { params: Record<string, never>; payload: CliModelDiscoveryResult; stream: 'push' }
  /** The record after each write that changed it, whoever made it. */
  'launchSettings.changed': { params: Record<string, never>; payload: AgentLaunchSettingsRecord; stream: 'push' }
}

// ── Validation ──────────────────────────────────────────────────────────────

type Refusal = StudioParamsRefusal
const refuse = (message: string): Refusal => studioParamsRefused(message)

const COMMAND_ID = '"commandId" names this command: a string of 1 to 200 characters.'
const CLI = '"cli" names the CLI: a string of 1 to 200 characters.'
const HOST = '"hostId" is "local" or "wsl:<distribution>".'
const ENGINE = '"engine" is { cli, model, reasoning? }.'
const RUNTIMES = '"cliRuntimes" maps a CLI to { command?, hostId? }.'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}
function hostId(value: unknown): value is ExecutionHostId {
  return value === 'local' || (typeof value === 'string' && value.startsWith('wsl:') && value.length <= 300)
}

/** A command, a machine, or neither; anything else is dropped. */
function runtimeTarget(value: unknown): CliRuntimeTarget | null {
  if (value === undefined || value === null) return {}
  if (!record(value)) return null
  if (value.command !== undefined && !text(value.command, 4096)) return null
  if (value.hostId !== undefined && !hostId(value.hostId)) return null
  return {
    ...(value.command === undefined ? {} : { command: value.command as string }),
    ...(value.hostId === undefined ? {} : { hostId: value.hostId as ExecutionHostId }),
  }
}

function cliAndRuntime(value: Record<string, unknown>): StudioParsed<{ cli: AgentCli; runtime?: CliRuntimeTarget }> {
  if (!id(value.cli)) return refuse(CLI)
  const runtime = runtimeTarget(value.runtime)
  if (!runtime) return refuse('"runtime" is { command?, hostId? }.')
  return studioParams({ cli: value.cli, ...(Object.keys(runtime).length > 0 ? { runtime } : {}) })
}

function commanded<P>(
  read: (value: Record<string, unknown>) => StudioParsed<P>,
): (value: Record<string, unknown>) => StudioParsed<Commanded<P>> {
  return (value) => {
    if (!id(value.commandId)) return refuse(COMMAND_ID)
    const parsed = read(value)
    return parsed.ok ? studioParams({ commandId: value.commandId, ...parsed.params }) : parsed
  }
}

/** Per-CLI overrides: a command and a machine, each optional. */
function cliRuntimes(value: unknown): TextGenerationCliRuntimeOverrides | null {
  if (!record(value)) return null
  const out: TextGenerationCliRuntimeOverrides = {}
  for (const [cli, entry] of Object.entries(value)) {
    if (!id(cli)) return null
    if (entry === undefined || entry === null) continue
    const target = runtimeTarget(entry)
    if (!target) return null
    out[cli] = target
  }
  return out
}

function engine(value: unknown): TextGenerationEngine | null {
  if (!record(value) || !id(value.cli) || !text(value.model, 200)) return null
  if (value.reasoning !== undefined && !text(value.reasoning, 100)) return null
  return {
    cli: value.cli,
    model: value.model,
    ...(typeof value.reasoning === 'string' && value.reasoning ? { reasoning: value.reasoning } : {}),
  }
}

function writingStyle(value: unknown): TextGenerationWritingStyle | null {
  if (!record(value)) return null
  if (!(WRITING_STYLE_MODES as readonly unknown[]).includes(value.mode)) return null
  if (!text(value.instructions, 10_000)) return null
  return { mode: value.mode as WritingStyleMode, instructions: value.instructions }
}

/** The previous catalogs, reduced to what a refresh carries forward: each model's id and `firstSeenAt`. */
function previousCatalogs(value: unknown): Partial<Record<string, DiscoveredCliModelCatalog>> | null {
  if (!record(value)) return null
  const out: Partial<Record<string, DiscoveredCliModelCatalog>> = {}
  for (const [cli, catalog] of Object.entries(value)) {
    if (!id(cli)) return null
    if (!record(catalog) || !Array.isArray(catalog.models) || catalog.models.length > 2_000) return null
    const models: DiscoveredCliModel[] = []
    for (const model of catalog.models) {
      if (!record(model) || !id(model.id)) return null
      models.push({ id: model.id, ...(text(model.firstSeenAt, 100) ? { firstSeenAt: model.firstSeenAt } : {}) })
    }
    out[cli] = {
      models,
      fetchedAt: text(catalog.fetchedAt, 100) ? catalog.fetchedAt : '',
      source: catalog.source === 'agent-sdk' ? 'agent-sdk' : 'argv-probe',
    }
  }
  return out
}

function discovery(value: Record<string, unknown>): StudioParsed<CliModelDiscoveryInput> {
  const input: CliModelDiscoveryInput = {}
  if (value.clis !== undefined) {
    if (!Array.isArray(value.clis) || value.clis.length > 200 || !value.clis.every(id))
      return refuse('"clis" is a list of CLI ids.')
    input.clis = [...(value.clis as string[])]
  }
  if (value.cliRuntimes !== undefined) {
    const runtimes = cliRuntimes(value.cliRuntimes)
    if (!runtimes) return refuse(RUNTIMES)
    input.cliRuntimes = runtimes
  }
  if (value.force === true) input.force = true
  if (value.previous !== undefined) {
    const previous = previousCatalogs(value.previous)
    if (!previous) return refuse('"previous" maps a CLI to the catalog it holds.')
    input.previous = previous
  }
  return studioParams(input)
}

function chatTitle(value: Record<string, unknown>): StudioParsed<ChatTitleRequest> {
  if (!text(value.prompt, 100_000)) return refuse('"prompt" is the text to title.')
  const read = engine(value.engine)
  if (!read) return refuse(ENGINE)
  const runtimes = value.cliRuntimes === undefined ? undefined : cliRuntimes(value.cliRuntimes)
  if (runtimes === null) return refuse(RUNTIMES)
  if (
    value.timeoutMs !== undefined &&
    !(typeof value.timeoutMs === 'number' && value.timeoutMs > 0 && value.timeoutMs <= 600_000)
  )
    return refuse('"timeoutMs" is at most ten minutes.')
  return studioParams({
    prompt: value.prompt,
    engine: read,
    ...(runtimes ? { cliRuntimes: runtimes } : {}),
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs as number }),
  })
}

function commitDraft(value: Record<string, unknown>): StudioParsed<CommitMessageDraftRequest> {
  if (!(typeof value.repoRoot === 'string' && value.repoRoot.length > 0 && value.repoRoot.length <= 4096))
    return refuse('"repoRoot" is the checkout\'s folder.')
  const read = engine(value.engine)
  if (!read) return refuse(ENGINE)
  const runtimes = value.cliRuntimes === undefined ? undefined : cliRuntimes(value.cliRuntimes)
  if (runtimes === null) return refuse(RUNTIMES)
  if (value.draftId !== undefined && !id(value.draftId)) return refuse('"draftId" is a string of 1 to 200 characters.')
  const style = value.writingStyle === undefined ? undefined : writingStyle(value.writingStyle)
  if (style === null) return refuse('"writingStyle" is { mode, instructions }.')
  return studioParams({
    repoRoot: value.repoRoot,
    engine: read,
    ...(runtimes ? { cliRuntimes: runtimes } : {}),
    ...(value.draftId === undefined ? {} : { draftId: value.draftId as string }),
    ...(style ? { writingStyle: style } : {}),
  })
}

function textGenerationSettings(value: unknown): TextGenerationSettings | null {
  if (!record(value) || typeof value.enabled !== 'boolean') return null
  const read = value.engine === null || value.engine === undefined ? null : engine(value.engine)
  if (read === null && value.engine !== null && value.engine !== undefined) return null
  const style = writingStyle(value.writingStyle)
  if (!style) return null
  return { enabled: value.enabled, engine: read, writingStyle: style }
}

// ── The table ───────────────────────────────────────────────────────────────

const LAUNCH_SETTINGS_OWNER =
  "The launch settings hold the program each CLI and MCP server runs on this machine, a preset's arguments, and the MCP servers' environment, which carries their keys."

const runtimes = (scope: 'providers:read' | 'environment:maintain', mutation: boolean) =>
  ({ scope, mutation, capability: STUDIO_AGENT_RUNTIMES_CAPABILITY }) as const
const settings = (scope: 'providers:read' | 'settings:write' | 'workspaces:read', mutation: boolean) =>
  ({ scope, mutation, capability: STUDIO_AGENT_SETTINGS_CAPABILITY }) as const

const TEXT_GENERATION_OWNER =
  "Only an owner's connection runs an agent CLI on this machine outside a chat, to title a chat or draft a commit message from a checkout here."

// Writing a title or a commit message runs a CLI here, and a commit message
// reads a checkout: the window's, not a paired client's.
const drafting = {
  scope: 'conversation:operate',
  mutation: false,
  capability: STUDIO_AGENT_SETTINGS_CAPABILITY,
  owner: TEXT_GENERATION_OWNER,
} as const

const update: StudioMethodDefinition<StudioAgentSettingsMethodMap['cliRuntimes.update']> = {
  ...runtimes('environment:maintain', true),
  params: commanded(cliAndRuntime),
}

export const STUDIO_AGENT_SETTINGS_METHODS: StudioMethodTable<StudioAgentSettingsMethodMap> = {
  'cliRuntimes.detect': { ...runtimes('providers:read', false), params: cliAndRuntime },
  'cliRuntimes.installMethods': { ...runtimes('providers:read', false), params: cliAndRuntime },
  'cliRuntimes.install': {
    ...runtimes('environment:maintain', true),
    params: commanded((value) => {
      const parsed = cliAndRuntime(value)
      if (!parsed.ok) return parsed
      if (!id(value.methodId)) return refuse('"methodId" names one of cliRuntimes.installMethods.')
      return studioParams({ ...parsed.params, methodId: value.methodId })
    }),
  },
  'cliRuntimes.update': update,
  'cliRuntimes.updateAll': {
    ...runtimes('environment:maintain', true),
    params: commanded(() => studioParams({})),
  },
  'cliVersions.advisories': {
    ...runtimes('providers:read', false),
    params: (value) =>
      studioParams({
        ...(value.force === true ? { force: true } : {}),
        ...(value.detect === true ? { detect: true } : {}),
      }),
  },
  'cliVersions.setEnabled': {
    scope: 'settings:write',
    mutation: true,
    capability: STUDIO_AGENT_RUNTIMES_CAPABILITY,
    params: commanded((value) =>
      typeof value.enabled === 'boolean'
        ? studioParams({ enabled: value.enabled })
        : refuse('"enabled" is true or false.'),
    ),
  },
  'cliModels.discover': { ...settings('providers:read', false), params: discovery },
  'launchSettings.get': { ...settings('workspaces:read', false), owner: LAUNCH_SETTINGS_OWNER, params: studioNoParams },
  'launchSettings.update': {
    ...settings('settings:write', true),
    owner: LAUNCH_SETTINGS_OWNER,
    params: commanded((value) =>
      record(value.patch)
        ? studioParams({ patch: value.patch as AgentLaunchSettingsPatch })
        : refuse('"patch" is an object of the members to change.'),
    ),
  },
  'launchSettings.migrate': {
    ...settings('settings:write', true),
    owner: LAUNCH_SETTINGS_OWNER,
    params: commanded((value) =>
      record(value.settings)
        ? studioParams({ settings: value.settings as AgentLaunchSettings })
        : refuse('"settings" is the launch settings to adopt.'),
    ),
  },
  'textGeneration.setSettings': {
    ...settings('settings:write', true),
    params: commanded((value) => {
      const read = textGenerationSettings(value.settings)
      return read ? studioParams({ settings: read }) : refuse('"settings" is { enabled, engine, writingStyle }.')
    }),
  },
  'textGeneration.chatTitle': { ...drafting, params: chatTitle },
  'commitMessage.draft': { ...drafting, params: commitDraft },
  'commitMessage.cancel': {
    ...drafting,
    params: (value) =>
      id(value.draftId) ? studioParams({ draftId: value.draftId }) : refuse('"draftId" names the draft.'),
  },
}

export const STUDIO_AGENT_SETTINGS_TOPICS: StudioTopicTable<StudioAgentSettingsTopicMap> = {
  'cliRuntimes.output': {
    scope: 'environment:maintain',
    capability: STUDIO_AGENT_RUNTIMES_CAPABILITY,
    push: true,
    params: (value) => {
      if (!id(value.cli)) return refuse(CLI)
      if (value.hostId !== undefined && !hostId(value.hostId)) return refuse(HOST)
      return studioParams({
        cli: value.cli,
        ...(value.hostId === undefined ? {} : { hostId: value.hostId as ExecutionHostId }),
      })
    },
  },
  'cliRuntimes.updateAllProgress': {
    scope: 'environment:maintain',
    capability: STUDIO_AGENT_RUNTIMES_CAPABILITY,
    push: true,
    params: studioNoParams,
  },
  'cliVersions.changed': {
    scope: 'providers:read',
    capability: STUDIO_AGENT_RUNTIMES_CAPABILITY,
    push: true,
    params: studioNoParams,
  },
  'cliModels.changed': {
    scope: 'providers:read',
    capability: STUDIO_AGENT_SETTINGS_CAPABILITY,
    push: true,
    params: studioNoParams,
  },
  'launchSettings.changed': {
    scope: 'workspaces:read',
    owner: LAUNCH_SETTINGS_OWNER,
    capability: STUDIO_AGENT_SETTINGS_CAPABILITY,
    push: true,
    params: studioNoParams,
  },
}
