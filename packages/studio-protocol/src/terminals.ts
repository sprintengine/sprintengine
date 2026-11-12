import {
  studioNoParams,
  studioParams,
  studioParamsRefused,
  type StudioMethodTable,
  type StudioParamsRefusal,
  type StudioParsed,
  type StudioTopicTable,
} from './contract.js'
import type { PromptCacheReading } from './conversation.js'
import { STUDIO_TERMINALS_CAPABILITY } from './handshake.js'
import type {
  AgentCli,
  AgentExecutionMode,
  AgentLaunchRecord,
  BranchPullRequest,
  CliPermissionPreset,
  CliRuntimeSettings,
  ExecutionHostId,
  McpSettings,
  ObservedCheckout,
} from './agents.js'

// Terminals on a Studio's machine: the shells and agent CLIs its server runs
// in a pty, and the agent state their lifecycle hooks report.
//
// A client lists the sessions (`terminal.list`, then `terminal.sessions` for
// what changes) and drives one through its pane: it subscribes to the
// session's `terminal.output`, opens it (`terminal.open` starts it, or
// attaches to it when it runs, and the output is replayed), and then types,
// resizes and acknowledges what it parsed. The output goes to one pane at a
// time: the last to open or show the terminal takes it over, as a terminal
// moved between windows always has. The acknowledgements pace the process, so
// a flood pauses the pty rather than outgrowing the connection.
//
// `terminal:read` lists and asks; `terminal:operate` (which carries read) is a
// shell on the machine, so nothing finer than the grant itself (a folder, a
// command) is held back from it. The reaper's machine-wide policy and the
// prompts a person wrote are an owner's.

export type TerminalKind = 'agent' | 'terminal'
export type TerminalPathStyle = 'posix' | 'windows' | 'wsl'
/**
 * Which runtime owns an agent session. `manual` is a session the app itself
 * launched; a capability module that runs its own agents names itself here.
 */
export type AgentSessionSystem = 'manual' | (string & {})

export type AgentSessionIdentity = {
  sessionId: string
  executionId: string
  system: AgentSessionSystem
  workspaceId: string
  workspaceRoot: string
  displayName: string
}

export type AgentSessionMetadata = Omit<AgentSessionIdentity, 'sessionId'> & {
  sessionId?: string
}

export type TerminalSpawnMetadata = {
  kind?: TerminalKind
  workspaceId?: string
  // The machine this terminal runs on: the workspace's (`local`, or a WSL
  // distribution on Windows). Absent resolves from the folder — a folder
  // inside a distribution runs there — and otherwise this machine. A session
  // already bound to a host keeps it on resume whatever this says.
  hostId?: ExecutionHostId
  agentId?: string
  // The agent's session id within its CLI/harness, used as the resume token.
  // Distinct from the terminal-tracking `sessionId`; supplied on resume so the
  // CLI reattaches its own conversation. See TerminalSpawnPayload.cliSessionId.
  cliSessionId?: string
  // Agent display name, exposed to the session as SPRINTENGINE_AGENT_NAME for the
  // typed-handoff Backlog link label. See agentIdentityEnv (terminal-launch).
  agentName?: string
  terminalId?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  cliPermissionPreset?: CliPermissionPreset
  // The CLI's own permission mode chosen at that preset (Claude Code's Accept
  // edits), rendered in its place when the CLI's manifest has it. Absent, the
  // preset's own mode.
  cliPermissionMode?: string
  // Model id passed to the agent CLI when its plugin declares modelSelection;
  // undefined means the CLI's own default model.
  cliModel?: string
  // Reasoning-effort level passed to the agent CLI when its plugin declares
  // reasoningSelection; undefined means the CLI's own default effort, which
  // passes no flag. Travels with cliModel from the spawning surface.
  cliReasoning?: string
  memoryRootPath?: string
  memoryRelativeRoot?: string
  agentSession?: AgentSessionMetadata
  visible?: boolean
  mcpSettings?: McpSettings
  // True when `mcpSettings` is a connector launch's isolated single-server
  // config: the spawn prunes any other MCP server from the worktree config and
  // git-excludes it.
  // Undefined/false for ordinary spawns (workspace MCP merges as usual).
  connectorLaunch?: boolean
  // Skill-at-spawn (the composer's "+ Skill" attachment, or a scheduled
  // automation's skill): the builtin skill to ensure-install into the working
  // directory at spawn so the prefilled invocation resolves to a present skill.
  // Generalizes the debug-skill install; best-effort at the launch boundary and
  // carries none of the connector MCP coupling (no prune, no worktree .mcp.json
  // exclude). The invocation itself is prefilled renderer-side, never auto-sent.
  spawnSkillId?: string
}

export type SessionActivity =
  | { kind: 'working'; since: number }
  | { kind: 'idle'; since: number }
  | { kind: 'exited'; at: number; exitCode: number }
  | { kind: 'failed'; at: number; exitCode: number; message?: string }

// Authoritative agent phase, reported by the agent CLI's own lifecycle hooks
// This is the
// richer, less ambiguous companion to `SessionActivity`: it can tell
// `awaiting_input` (blocked on a permission/prompt) apart from `idle` (turn
// finished) — a distinction output-scraping structurally cannot make.
export type AgentPhase =
  'starting' | 'thinking' | 'tool_use' | 'awaiting_input' | 'idle' | 'exited' | 'failed' | 'stalled'

// Provenance for a phase. `hook` means the phase came from an authoritative
// lifecycle-hook frame; `lifecycle` means a lifecycle stamp: `starting` at
// spawn, `stalled` from the watchdog, `exited`/`failed` from the pty. Nothing
// ever guesses a phase from output recency.
export type AgentStateSource = 'hook' | 'lifecycle'

export type TerminalAgentState = {
  phase: AgentPhase
  since: number
  source: AgentStateSource
}

// The last prompt a person submitted to an agent session, captured from the
// CLI's `UserPromptSubmit` lifecycle hook. `text` is their verbatim typing,
// truncated to MAX_AGENT_PROMPT_LENGTH; `at` is when the hook reported it.
//
// Only CLIs whose reporter forwards the prompt supply this (Claude Code, Codex,
// Grok Build). A hookless or unsupported CLI simply never sets it, and every
// consumer treats absence as "nothing to show" rather than an error.
export type SessionPrompt = {
  text: string
  at: number
}

// One file this agent session has changed, as its own PostToolUse hooks
// reported it (Edit / Write / MultiEdit / NotebookEdit). The counts are
// CUMULATIVE sums of the hook's own diff hunks: a line edited twice counts
// twice, because the ledger answers "how much did this agent do", not "how far
// has the tree moved" — that second question is git's, and git is deliberately
// not consulted here. `edits` is the number of
// tool calls that touched the path, so a file rewritten ten times is
// distinguishable from one touched once.
//
// A subagent's edits count for the session that spawned it: the work is the
// session's. (Unlike the observed cwd, which a subagent's isolated worktree
// would falsify — see the reporter.)
export type SessionFileChange = {
  // Absolute path as the tool reported it. Never a patch or file content: the
  // ledger crosses a 64KB-per-frame socket and is broadcast to every window.
  path: string
  additions: number
  deletions: number
  edits: number
  lastEditedAt: number
}

// How much of the model's context window this session has consumed, as its own
// status line reports it. `at` is the moment the whole percent LAST MOVED, not
// the moment of the last reading — the CLI refreshes its status line after
// every assistant message, and a timestamp that advanced on each one would be
// a repaint per message for a number that had not changed.
//
// `contextWindowSize` is the window the percentage is OF, in tokens, when the
// CLI has said. It is what turns "42%" into "84k / 200k" on the peek card, and
// it moves only when the model does, so carrying it costs no extra repaints.
export type SessionContextUsage = {
  usedPercentage: number
  at: number
  contextWindowSize?: number
}

export type TerminalSessionSnapshot = {
  sessionId: string
  processAlive: boolean
  kind: TerminalKind
  pathStyle?: TerminalPathStyle
  // The machine the session runs on. Absent on sessions from before hosts
  // existed, which ran on this machine or, for a `wsl` path style, in WSL.
  hostId?: ExecutionHostId
  workspaceId?: string
  // The workspace the process was launched with, which its hooks, MCP calls and
  // tours go on naming after the agent is moved to another chat (`workspaceId`
  // follows the move). Absent on sessions from before it was recorded.
  launchWorkspaceId?: string
  agentId?: string
  // Display name from spawn metadata. The session-manager label for agent
  // sessions whose agentId has no workspace.agents record (e.g. an agent main
  // spawned without this window's knowledge).
  agentName?: string
  terminalId?: string
  // The agent's session id within its own CLI/harness (the id used to resume the
  // conversation), captured from lifecycle hooks. Distinct from `sessionId`,
  // which is the studio's own terminal-tracking id. Equal to it for Claude (we mint
  // and pass the id); minted by the harness and learned post-launch for Codex etc.
  cliSessionId?: string
  cli?: AgentCli
  cwd?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  // Where the session's own hooks last saw it, resolved through git into the
  // checkout containing that cwd. Distinct from the launch-intent
  // fields above (`cwd`, `worktreePath`): an agent that creates a worktree and
  // moves into it, or is launched by hand into one the app did not make, is
  // only describable here. Absent for plain terminals and for CLIs whose hooks
  // carry no cwd; `resolved: false` until git has answered.
  observedCheckout?: ObservedCheckout
  agentSession?: AgentSessionIdentity
  // Present only on sessions the main-process AgentLaunchService composed:
  // the launch decisions main made — name, CLI, model, permission
  // preset, connector environment. The renderer projects these into
  // an AgentState so a headless-launched agent gets a tab it never created, and
  // so a window opened after the launch sees the same agent the launch made.
  // Absent for renderer-launched agents (which already own their record) and
  // for plain terminals.
  agentRecord?: AgentLaunchRecord
  visible: boolean
  // Freeze-the-view: agent process killed to reclaim memory, scrollback kept
  // painted, resumable on keystroke. `processAlive` is false while suspended.
  suspended: boolean
  // User lock ("keep running"): the reaper never suspends or disposes this
  // session while set. Session-scoped — toggled from the terminal's lock
  // control; does not survive an app restart (the process it protects doesn't
  // either).
  reapExempt: boolean
  startedAt: number
  lastOutputAt: number | null
  lastInputAt: number | null
  // `lastInputAt` without the focus reports and query answers the terminal
  // sends on its own: when something was last typed or pasted. Absent from a
  // main that predates it.
  lastKeyInputAt?: number | null
  lastVisibleAt: number | null
  // When the agent's last turn ended — the hook-reported Stop, epoch ms. Kept
  // apart from `activity`, which the reaper's suspend and the quit path
  // overwrite with the moment the PROCESS died, so a parked chat can say when
  // it actually finished. Survives suspend, resume and an app restart (carried
  // in the snapshot sidecar). Absent for plain terminals and before the first
  // turn end.
  lastTurnEndedAt?: number | null
  activity: SessionActivity
  // Authoritative phase from lifecycle hooks, when available. Absent for
  // sessions whose CLI emits no hooks (the legacy idle-timer `activity` above
  // remains the floor). `source` distinguishes hook truth from inference.
  agentState?: TerminalAgentState
  // The last prompt submitted to this session. Absent for plain terminals and
  // for CLIs whose reporter does not forward one.
  lastPrompt?: SessionPrompt
  // What this session has edited, newest-edited first (by the order the edits
  // were observed, which differs from their timestamps only by socket delivery
  // skew). Fed by the CLI's own
  // PostToolUse hooks, so it is empty for plain terminals, for hookless CLIs,
  // and for an agent that has not written anything yet — never absent, so a
  // consumer can count without a guard. Bounded (see MAX_SESSION_FILE_CHANGES);
  // survives an app restart with the session parked, and starts over when the
  // pty is respawned.
  fileChanges: SessionFileChange[]
  // The pull requests this conversation has, newest first: the union of the ones on every branch
  // its agent worked on, its own checkout's and those in other repositories it
  // changed files in, de-duplicated by URL. The Studio server owns the fact —
  // see `src/server/pull-requests/` — and the shell puts the list it answers
  // here (`main/terminal-pull-requests.ts`). It is empty for a plain terminal,
  // for a session whose checkout is not resolved yet, and for a branch GitHub
  // says has none. Nothing is ever drawn from an absent answer: a lookup that
  // could not be made leaves the last known list standing rather than emptying
  // it.
  //
  // Optional on the wire only because fixtures across the app build a snapshot
  // literal; every snapshot main sends carries the array. A later phase can
  // tighten it once those fixtures name the field.
  pullRequests?: BranchPullRequest[]
  // Subagents this session started and has not seen stop — the count main
  // already keeps to hold a turn end open while background work runs, surfaced
  // so a row can say "3 running" instead of a bare spinner. Zero for plain
  // terminals and for CLIs that report no subagent events.
  activeSubagents: number
  // Context-window usage, from the session's own status line. Null for a plain
  // terminal, for a CLI with no status line, for one whose person's status line
  // could not be wrapped, and for a session that has not made an API call yet —
  // never a guess. A /compact does NOT clear it: the CLI reports no percentage
  // for a moment afterwards, and "not known right now" is not "empty", so the
  // last known reading stands until a real one replaces it.
  contextUsage: SessionContextUsage | null
  // The main conversation's prompt cache, from the same status line: when it
  // goes cold and what a cold resume re-caches. Null (or absent, from a main
  // that predates it) for a session whose CLI reports none; surfaces derive
  // warm / expiring / cold from it and a clock (shared/prompt-cache.ts).
  promptCache?: PromptCacheReading | null
  exitedAt: number | null
  outputBufferLength: number
  retainedOutputBytes: number
  historyTier?: 'standard' | 'recent'
  replayLimitBytes?: number
}

/**
 * One changed session on `terminal.sessions`: its snapshot, with the two
 * lists present only when they moved since the session was last broadcast. An
 * absent list means "unchanged — keep the one you have", never "empty".
 */
export type TerminalSessionDeltaEntry = Omit<TerminalSessionSnapshot, 'fileChanges' | 'pullRequests'> & {
  fileChanges?: SessionFileChange[]
  pullRequests?: BranchPullRequest[]
}

/**
 * What changed among the sessions since the last broadcast: the sessions that
 * changed, and the ids of those that are gone. The full list is
 * `terminal.list`, which a client reads once when it subscribes and on its
 * recovery poll.
 */
export type TerminalSessionsDelta = {
  upserts: TerminalSessionDeltaEntry[]
  removed: string[]
}

/**
 * A first message main was to type into an agent CLI once it was ready, and did
 * not (`src/main/deferred-prompt-delivery.ts`): the CLI exited first, the
 * terminal stopped taking input, or the CLI never showed the screen its
 * manifest says it is ready on. `text` is the message as the person wrote it,
 * handed back so it is not lost.
 */
export type TerminalPromptUndelivered = {
  sessionId: string
  workspaceId?: string
  agentId?: string
  agentName?: string
  cli?: string
  text: string
  reason: 'exited' | 'write-failed' | 'not-ready'
}

// One process row from Electron's app.getAppMetrics() plus throttled child

/**
 * How a pane reports its visibility. `freshPane` says the xterm was just built
 * and holds nothing, so the Studio must paint it in full when it is shown
 * rather than send only what an earlier pane in its place missed.
 */
export type TerminalVisibilityOptions = {
  freshPane?: boolean
}

export type TerminalSpawnResult =
  { ok: true; sessionId: string } | { ok: false; sessionId: string; message: string; exitCode: number }

// ── The contract ────────────────────────────────────────────────────────────

/** The most UTF-16 units one `terminal.write` carries: a paste longer than this goes as numbered pieces. */
export const STUDIO_TERMINAL_MAX_WRITE_UNITS = 64 * 1024
/** The most units one `terminal.ack` may report. */
export const STUDIO_TERMINAL_MAX_ACK_UNITS = 64 * 1024 * 1024
/** The largest terminal, in columns or rows. */
export const STUDIO_TERMINAL_MAX_CELLS = 2000

/** What `terminal.open` and `terminal.resume` take: the session, its size, and how to start it if it is not running. */
export type TerminalOpenParams = TerminalSpawnMetadata & {
  sessionId: string
  cols: number
  rows: number
  cwd?: string
  /** Resume the CLI's own conversation (`--resume`), rather than start a new one. */
  resume?: boolean
  cli?: AgentCli
  initialPrompt?: string
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
  shellOnly?: boolean
}

/**
 * One message of a session's `terminal.output`: the screen so far, when the
 * subscriber opens or shows the terminal (`replay`, which replaces whatever
 * it painted); what the process printed since (`data`); that it exited; or
 * why it could not start.
 */
export type TerminalOutputEvent =
  | { type: 'replay'; data: string }
  | { type: 'data'; data: string }
  | { type: 'exit'; exitCode: number }
  | { type: 'error'; message: string }

type SessionId = { sessionId: string }
type Command = { commandId: string }

export type StudioTerminalsMethodMap = {
  /** Every live session's snapshot. A client other than the app's own window is sent it projected (`projectTerminalSession`). */
  'terminal.list': { params: Record<string, never>; result: { sessions: TerminalSessionSnapshot[] } }
  /** Whether its process runs, and whether it is suspended. Asking may bring a suspended session back from its sidecar. */
  'terminal.status': { params: SessionId; result: { processAlive: boolean; suspended: boolean } }
  /**
   * Start the session, or attach to it when it runs: the caller's
   * `terminal.output` subscription for it takes the output over and is sent a
   * replay. A command: a start can wait a minute on its folder's hold, and a
   * retry under the same id is the same start.
   */
  'terminal.open': { params: TerminalOpenParams & Command; result: TerminalSpawnResult }
  /** Start a suspended session's process again, from its CLI's own session where it has one. */
  'terminal.resume': { params: TerminalOpenParams & Command; result: TerminalSpawnResult }
  /**
   * Type into the session. `writer` names the client's pane and `seq` counts
   * its writes from 1, so a write the client sends again after a reconnect is
   * dropped rather than typed twice; `written` is false for one dropped so.
   * At most `STUDIO_TERMINAL_MAX_WRITE_UNITS` units: a longer paste is split
   * into pieces, each its own `seq`.
   */
  'terminal.write': {
    params: SessionId & { data: string; writer: string; seq: number }
    result: { written: boolean }
  }
  /** Flow control: the subscriber's pane has parsed this many units of the output it was sent. */
  'terminal.ack': { params: SessionId & { units: number }; result: Record<string, never> }
  'terminal.resize': { params: SessionId & { cols: number; rows: number }; result: Record<string, never> }
  /**
   * The pane is shown or hidden. Shown, the caller's subscription becomes the
   * one the output goes to; `freshPane` says it painted nothing yet, so it is
   * sent a full replay.
   */
  'terminal.setVisible': {
    params: SessionId & { visible: boolean; freshPane?: boolean }
    result: Record<string, never>
  }
  /** End the process to free its memory and keep the screen; the next `terminal.resume` starts it again. */
  'terminal.suspend': { params: SessionId; result: Record<string, never> }
  /** End the process and forget the session. */
  'terminal.close': { params: SessionId & Command; result: Record<string, never> }
  /** While set, the idle reaper never suspends or ends the session. */
  'terminal.setReapExempt': { params: SessionId & { exempt: boolean }; result: Record<string, never> }
  /** The first messages that could not be typed into their agent, handed over once. */
  'terminal.takeUndeliveredPrompts': { params: Record<string, never>; result: { prompts: TerminalPromptUndelivered[] } }
  /** The machine's reaper policy: after how long idle terminals are suspended, and how many recent ones always run. */
  'terminal.configure': {
    params: { idleSuspendMs?: number; keepRecentAlive?: number }
    result: Record<string, never>
  }
}

export type StudioTerminalsMethod = keyof StudioTerminalsMethodMap

export type StudioTerminalsTopicMap = {
  /**
   * One session's output, for the pane that shows it. Subscribing does not
   * take the output over: `terminal.open` or `terminal.setVisible` does, and
   * is answered with a `replay` here. Nothing is replayed on (re)subscribing;
   * a client opens the terminal again after a reconnect, as after a reload.
   */
  'terminal.output': { params: SessionId; payload: TerminalOutputEvent; stream: 'push' }
  /** What changed among the sessions. Call `terminal.list` after (re)subscribing. */
  'terminal.sessions': { params: Record<string, never>; payload: TerminalSessionsDelta; stream: 'push' }
  /** A first message could not be typed in: call `terminal.takeUndeliveredPrompts`. */
  'terminal.promptUndelivered': { params: Record<string, never>; payload: Record<string, never>; stream: 'push' }
}

// ── What a client other than the app's own window is sent ───────────────────

/**
 * A session as a client other than the app's own window sees it. The prompt
 * a person typed and a connector launch's MCP settings (their env and headers
 * carry secrets) are left out for every such client; a client that may only
 * read terminals is not told the folders the session works in either.
 */
export function projectTerminalSession<S extends TerminalSessionDeltaEntry>(
  session: S,
  access: { operate: boolean },
): S {
  const { lastPrompt: _prompt, ...rest } = session
  const projected = { ...rest } as S
  if (session.agentRecord) {
    const { connectorMcpSettings: _mcp, ...record } = session.agentRecord
    projected.agentRecord = record
  }
  if (access.operate) return projected
  delete projected.cwd
  delete projected.worktreePath
  delete projected.observedCheckout
  if (projected.agentRecord) {
    const { worktreePath: _path, ...record } = projected.agentRecord
    projected.agentRecord = record
  }
  if (projected.agentSession) projected.agentSession = { ...projected.agentSession, workspaceRoot: '' }
  if (projected.fileChanges) projected.fileChanges = []
  return projected
}

// ── Validation ──────────────────────────────────────────────────────────────

const refuse = (message: string): StudioParamsRefusal => studioParamsRefused(message)

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}
function cells(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= STUDIO_TERMINAL_MAX_CELLS
}
function count(value: unknown, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max
}

const PATH_CHARS = 4096
const PROMPT_CHARS = 200_000

// What each optional member of an open is, so one in any other shape is refused and an unknown one dropped.
const OPEN_STRINGS = {
  cwd: PATH_CHARS,
  cli: 200,
  initialPrompt: PROMPT_CHARS,
  workspaceId: 200,
  hostId: 300,
  agentId: 200,
  cliSessionId: 200,
  agentName: 500,
  terminalId: 200,
  worktreeId: 200,
  worktreePath: PATH_CHARS,
  cliPermissionMode: 200,
  cliModel: 200,
  cliReasoning: 200,
  memoryRootPath: PATH_CHARS,
  memoryRelativeRoot: PATH_CHARS,
  spawnSkillId: 200,
} as const
const OPEN_BOOLEANS = ['resume', 'shellOnly', 'visible', 'connectorLaunch'] as const
const OPEN_RECORDS = ['cliRuntimes', 'mcpSettings', 'agentSession'] as const

function parseOpen(value: Record<string, unknown>): StudioParsed<TerminalOpenParams & Command> {
  if (!id(value.sessionId)) return refuse('"sessionId" names the terminal session.')
  if (!id(value.commandId)) return refuse('"commandId" is the client\'s id for this command.')
  if (!cells(value.cols) || !cells(value.rows))
    return refuse(`"cols" and "rows" are whole numbers from 1 to ${STUDIO_TERMINAL_MAX_CELLS}.`)
  const params: Record<string, unknown> = {
    sessionId: value.sessionId,
    commandId: value.commandId,
    cols: value.cols,
    rows: value.rows,
  }
  for (const [name, max] of Object.entries(OPEN_STRINGS)) {
    const member = value[name]
    if (member === undefined) continue
    if (typeof member !== 'string' || member.length > max)
      return refuse(`"${name}" is a string of at most ${max} characters.`)
    params[name] = member
  }
  if (params.hostId !== undefined && params.hostId !== 'local' && !String(params.hostId).startsWith('wsl:'))
    return refuse('"hostId" is "local" or "wsl:<distribution>".')
  for (const name of OPEN_BOOLEANS) {
    const member = value[name]
    if (member === undefined) continue
    if (typeof member !== 'boolean') return refuse(`"${name}" is true or false.`)
    params[name] = member
  }
  for (const name of OPEN_RECORDS) {
    const member = value[name]
    if (member === undefined) continue
    if (!record(member)) return refuse(`"${name}" is an object.`)
    params[name] = member
  }
  if (value.kind !== undefined) {
    if (value.kind !== 'agent' && value.kind !== 'terminal') return refuse('"kind" is "agent" or "terminal".')
    params.kind = value.kind
  }
  if (value.executionMode !== undefined) {
    if (value.executionMode !== 'current_workspace' && value.executionMode !== 'worktree')
      return refuse('"executionMode" is "current_workspace" or "worktree".')
    params.executionMode = value.executionMode
  }
  if (value.cliPermissionPreset !== undefined) {
    if (!['none', 'manual', 'auto', 'bypass'].includes(value.cliPermissionPreset as string))
      return refuse('"cliPermissionPreset" is "none", "manual", "auto" or "bypass".')
    params.cliPermissionPreset = value.cliPermissionPreset
  }
  return studioParams(params as TerminalOpenParams & Command)
}

function parseSessionId(value: Record<string, unknown>): StudioParsed<SessionId> {
  return id(value.sessionId)
    ? studioParams({ sessionId: value.sessionId })
    : refuse('"sessionId" names the terminal session.')
}

function withSession<P extends object>(
  more: (value: Record<string, unknown>) => StudioParsed<P>,
): (value: Record<string, unknown>) => StudioParsed<SessionId & P> {
  return (value) => {
    const session = parseSessionId(value)
    if (!session.ok) return session
    const rest = more(value)
    return rest.ok ? studioParams({ ...session.params, ...rest.params }) : rest
  }
}

const read = { scope: 'terminal:read', mutation: false, capability: STUDIO_TERMINALS_CAPABILITY } as const
const operate = { ...read, scope: 'terminal:operate' } as const
// A start or an end is a command: it carries an id, is audited, and is never given up on by a read timeout.
const command = { ...operate, mutation: true } as const

export const STUDIO_TERMINALS_METHODS: StudioMethodTable<StudioTerminalsMethodMap> = {
  'terminal.list': { ...read, params: studioNoParams },
  'terminal.status': { ...read, params: parseSessionId },
  'terminal.open': { ...command, params: parseOpen },
  'terminal.resume': { ...command, params: parseOpen },
  'terminal.write': {
    ...operate,
    params: withSession((value) => {
      if (typeof value.data !== 'string' || value.data.length > STUDIO_TERMINAL_MAX_WRITE_UNITS)
        return studioParamsRefused(
          `"data" is a string of at most ${STUDIO_TERMINAL_MAX_WRITE_UNITS} units: send a longer one in pieces.`,
          value.data === undefined || typeof value.data === 'string' ? 'too_large' : 'invalid_params',
        )
      if (!id(value.writer)) return refuse('"writer" names the pane that writes.')
      if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1)
        return refuse('"seq" counts the writer\'s writes from 1.')
      return studioParams({ data: value.data, writer: value.writer, seq: value.seq as number })
    }),
  },
  'terminal.ack': {
    ...operate,
    params: withSession((value) =>
      count(value.units, STUDIO_TERMINAL_MAX_ACK_UNITS) && value.units > 0
        ? studioParams({ units: value.units })
        : refuse('"units" is how many units of output the pane parsed.'),
    ),
  },
  'terminal.resize': {
    ...operate,
    params: withSession((value) =>
      cells(value.cols) && cells(value.rows)
        ? studioParams({ cols: value.cols, rows: value.rows })
        : refuse(`"cols" and "rows" are whole numbers from 1 to ${STUDIO_TERMINAL_MAX_CELLS}.`),
    ),
  },
  'terminal.setVisible': {
    ...operate,
    params: withSession((value) => {
      if (typeof value.visible !== 'boolean') return refuse('"visible" is true or false.')
      if (value.freshPane !== undefined && typeof value.freshPane !== 'boolean')
        return refuse('"freshPane" is true or false.')
      return studioParams({ visible: value.visible, ...(value.freshPane === true ? { freshPane: true } : {}) })
    }),
  },
  'terminal.suspend': { ...operate, params: parseSessionId },
  'terminal.close': {
    ...command,
    params: withSession((value) =>
      id(value.commandId)
        ? studioParams({ commandId: value.commandId })
        : refuse('"commandId" is the client\'s id for this command.'),
    ),
  },
  'terminal.setReapExempt': {
    ...operate,
    params: withSession((value) =>
      typeof value.exempt === 'boolean' ? studioParams({ exempt: value.exempt }) : refuse('"exempt" is true or false.'),
    ),
  },
  // The text a person wrote for an agent: the app's own, as its prompts are.
  'terminal.takeUndeliveredPrompts': { ...operate, owner: true, params: studioNoParams },
  // A policy for the whole machine, not one terminal.
  'terminal.configure': {
    ...operate,
    owner: true,
    params: (value) => {
      const params: { idleSuspendMs?: number; keepRecentAlive?: number } = {}
      if (value.idleSuspendMs !== undefined) {
        if (!count(value.idleSuspendMs, Number.MAX_SAFE_INTEGER)) return refuse('"idleSuspendMs" is milliseconds.')
        params.idleSuspendMs = value.idleSuspendMs
      }
      if (value.keepRecentAlive !== undefined) {
        if (!count(value.keepRecentAlive, 1000)) return refuse('"keepRecentAlive" is a count of terminals.')
        params.keepRecentAlive = value.keepRecentAlive
      }
      return studioParams(params)
    },
  },
}

export const STUDIO_TERMINALS_TOPICS: StudioTopicTable<StudioTerminalsTopicMap> = {
  'terminal.output': {
    scope: 'terminal:operate',
    capability: STUDIO_TERMINALS_CAPABILITY,
    push: true,
    params: parseSessionId,
  },
  'terminal.sessions': {
    scope: 'terminal:read',
    capability: STUDIO_TERMINALS_CAPABILITY,
    push: true,
    params: studioNoParams,
  },
  'terminal.promptUndelivered': {
    scope: 'terminal:operate',
    capability: STUDIO_TERMINALS_CAPABILITY,
    owner: true,
    push: true,
    params: studioNoParams,
  },
}
