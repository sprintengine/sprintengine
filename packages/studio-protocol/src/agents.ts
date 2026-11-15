import type { StudioPullRequestForge, StudioPullRequestState, StudioPullRequestWatch } from './pull-requests.js'

// The vocabulary a terminal agent's session is described in, defined once for
// every end of the protocol: what a launch decided, the MCP servers it was
// given, the machine it runs on, the checkout its hooks last saw it in, and the
// pull requests its conversation has. `src/shared` re-exports each under the
// name the app has always used.

/** An agent CLI runtime id (`claude`, `codex`, …). Open: plugins add their own. */
export type AgentCli = string

export type AgentExecutionMode = 'current_workspace' | 'worktree'

/**
 * How much an agent may do before it stops to ask (`src/shared/cli-permission-preset.ts`
 * says what each means to each runtime).
 */
export type CliPermissionPreset = 'none' | 'manual' | 'auto' | 'bypass'

/** The machine a session runs on: this one, or a WSL distribution on Windows. */
export type ExecutionHostId = 'local' | `wsl:${string}`

/** How one agent CLI is run: the command, and the models a person added to or took off its list. */
export type CliRuntimeSettings = {
  command: string
  /**
   * The machine this runtime is resolved for, when it is not this one: a
   * detection, install or command run for a WSL distribution names it here,
   * with `command` already that machine's own override. Absent means this
   * machine. Never stored: the settings keep a machine's commands on the
   * machine.
   */
  hostId?: ExecutionHostId
  // User-added model ids for this CLI, shown in pickers alongside the plugin
  // manifest's seed options. Terminal CLIs expose no live model catalog, so
  // this list is how users keep pace with new models.
  models?: string[]
  // Ids the person took off this CLI's list. They stay off when a refresh lists
  // them again, until Settings puts them back.
  removedModels?: string[]
}

// ── MCP servers ─────────────────────────────────────────────────────────────

export type McpClientTarget = AgentCli
export type McpTransport = 'stdio' | 'http' | 'sse'
export type McpScope = 'workspace' | 'user'
// 'source' is a server a *source* installed: it is neither bundled with the
// app nor typed by hand, and Sync owns it. The distinction is what lets a sync
// overwrite exactly what it wrote and nothing else, the rule skills follow too.
export type McpServerSource = 'bundled' | 'custom' | 'source'
export type McpRiskLevel = 'low' | 'network' | 'local-command' | 'secrets'

/**
 * Which source installed a server, which of its items it is, and the commit its
 * declaration was read at. A config carrying this is `source: 'source'`; one
 * without it can never be, so nothing a person typed is ever taken over by a
 * sync.
 */
export type McpServerSourceRef = {
  sourceId: string
  /** The `ScannedMcpServer.id` in that source's scan. */
  itemId: string
  commitSha: string
  /**
   * Set by a sync that re-read the source and no longer found `itemId`. The
   * entry stays and keeps working; the surface says it is no longer in its
   * source rather than deleting a server someone is using.
   */
  missing?: boolean
  /**
   * Where the declaring plugin's own files landed in this workspace, for a
   * server whose command was `${CLAUDE_PLUGIN_ROOT}`-relative. Absent for every
   * other server.
   *
   * Kept on the entry, not looked up: MCP settings are app-level and a sync
   * runs with no workspace open, so this is the only place the re-read knows
   * what to resolve the variable to. Without it the next sync would write the
   * literal token back over a working path.
   */
  pluginRoot?: string
}

export type McpServerConfig = {
  id: string
  name: string
  category?: string
  description?: string
  transport: McpTransport
  command?: string
  args?: string[]
  url?: string
  /** Secrets live here and in `headers`: never sent to a client but the app's own window. */
  env?: Record<string, string>
  envVarNames?: string[]
  headers?: Record<string, string>
  enabled: boolean
  required?: boolean
  clients: McpClientTarget[]
  scope: McpScope
  source: McpServerSource
  /** Present exactly when `source` is 'source'; see McpServerSourceRef. */
  sourceRef?: McpServerSourceRef
  riskLevel: McpRiskLevel
  auth?: string
  capabilities?: string[]
  sourceUrl?: string
}

export type McpSettings = {
  syncEnabled: boolean
  servers: Record<string, McpServerConfig>
}

// ── A launch's decisions ────────────────────────────────────────────────────

/** The agent that asked for a launch through a tool. */
export type AgentLaunchCaller = { workspaceId: string; agentId?: string }

/**
 * The launch-time decisions the Studio made, in the agent record's vocabulary.
 *
 * Everything here is something a window could not re-derive from the raw
 * session snapshot: the snapshot knows the cli and cwd, but not which permission
 * preset was rendered into the launch argv, or which connector config was
 * written into the worktree. A projection missing those fields would look right
 * and behave wrong on the first relaunch.
 */
export type AgentLaunchRecord = {
  agentId: string
  name: string
  cli: AgentCli
  cliModel?: string
  cliPermissionPreset: CliPermissionPreset
  /** The CLI's own mode at that preset, when one other than the preset's own was chosen. */
  cliPermissionMode?: string
  /** Carries the connector's secrets: left out for every client but the app's own window. */
  connectorMcpSettings?: McpSettings
  spawnSkillId?: string
  /**
   * The worktree the agent runs in, when the launch created or was handed one.
   * Projected onto the agent record's execution so a reopened tab resolves the
   * same cwd instead of falling back to the workspace root.
   */
  worktreePath?: string
  /** The machine the launch ran on, so the agent resumes on the same one. */
  hostId?: ExecutionHostId
  /** The agent that asked for this launch through a tool, as the request named it. */
  launchedBy?: AgentLaunchCaller
}

// ── Where a session is ──────────────────────────────────────────────────────

/**
 * Where an agent session actually IS, as reported by its CLI's lifecycle
 * hooks, resolved through git into the checkout that contains it. Kept apart
 * from launch intent (`cwd`, `worktreePath`): those say where the app PUT the
 * agent; this says where the agent's hooks last saw it.
 */
export type ObservedCheckout = {
  /** The cwd exactly as the hook payload reported it (verbatim, untrusted-but-shape-checked). */
  cwd: string
  /** Epoch ms of the frame that carried the cwd. */
  at: number
  /**
   * False until git has answered for this cwd. While false every git-derived
   * field below is null/false and a consumer should fall back to launch intent
   * rather than read "not a checkout" into the nulls.
   */
  resolved: boolean
  /** Top level of the checkout containing `cwd` (realpath, from git); null when not inside a git work tree. */
  gitRoot: string | null
  /**
   * Root of the PRIMARY checkout this working tree belongs to: for a linked
   * worktree, the checkout that owns the common git dir; for a primary
   * checkout, `gitRoot` itself. Null when unknown (bare/odd layouts, not a repo).
   */
  repoRoot: string | null
  /** Current branch, or null on a detached HEAD / not a repo. */
  branch: string | null
  /** True when `gitRoot` is a linked worktree (`git worktree add`), false for a primary checkout or a non-repo. */
  isLinkedWorktree: boolean
  /**
   * True when the observed cwd no longer exists on disk (a worktree pruned out
   * from under the agent). Only meaningful with `resolved: true` and no
   * `gitRoot`; distinguishes "removed" from a plain folder.
   */
  missing?: boolean
}

// ── A conversation's pull requests ──────────────────────────────────────────

/** A pull request as a session's snapshot carries it: `StudioPullRequest`'s facts and the record's own. */
export type BranchPullRequest = {
  /** Canonical URL, as the app's pull request URL reader normalises it. */
  url: string
  /**
   * The repository the pull request is IN: `host/owner/name`, the key every
   * clone of it shares. Not always the repository the conversation sits in: an
   * agent can open a pull request in another repository, and the URL is what
   * says where.
   */
  repoKey: string
  /** The repository's short name, for the rows and tooltips that must say which repo. */
  repoName: string
  number: number
  title: string
  state: StudioPullRequestState
  /** A draft is still `open`; this only changes the tooltip's word. */
  isDraft: boolean
  /** When its host says it was opened (until then, when it was recorded), ms epoch. */
  openedAt: number
  /** When `state` was last read from its host, ms epoch; 0 when it never has been. */
  stateAt: number
  /**
   * When it merged, or closed without merging, as GitHub says, ms epoch.
   * Absent while open, and on an entry read before this was kept. What says
   * whether the person went on with the chat after it landed, which decides
   * whether a merge settles the chat.
   */
  endedAt?: number
  /**
   * The forge the pull request is on, when it is not GitHub (GitHub Enterprise
   * included). The app reads a pull request's state through `gh` only, so one
   * on another forge is shown as opened, and its `state` stays `open`.
   */
  forge?: StudioPullRequestForge
  /**
   * The conversation that opened it: its agent ran a create command or tool
   * whose output named this pull request, or called the Studio gateway's
   * `pull_request.link`. Written once, by the first conversation to claim it,
   * and never by a branch lookup. A record written before the agent was known
   * carries the workspace alone, and is worn by every conversation in it.
   */
  openedByWorkspaceId?: string
  openedByAgentId?: string
  /** The branch the pull request is from, once its host has said; the record stamps `onSessionBranch` from it. */
  headRefName?: string
  /** The commit its head was at, from a branch lookup; never stored on the record. */
  headRefOid?: string
  /**
   * True when this pull request is from the branch the conversation's own
   * checkout is on. Only the ones from its own branch may say anything about
   * the state of that branch (the sidebar's "landed" reading reads this and
   * nothing else). Absent on any other entry and on a fixture-built snapshot.
   */
  onSessionBranch?: boolean
  /**
   * Present while the conversation's agent has Studio watching it
   * (`pull_request.watch`): what it waits on, as the last read left it. Set
   * by the record on what it answers, never stored on the entry itself.
   */
  watch?: StudioPullRequestWatch
}
