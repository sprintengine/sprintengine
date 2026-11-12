// Part of the IPC contract: terminals, agent sessions, activity, process metrics and IPC stats.
// ../electron-api.ts re-exports everything here. A terminal session's own
// shapes are the Studio protocol's (`packages/studio-protocol/src/terminals.ts`),
// re-exported here under the names the app has always used.

export type {
  AgentPhase,
  AgentSessionIdentity,
  AgentSessionMetadata,
  AgentSessionSystem,
  AgentStateSource,
  SessionActivity,
  SessionContextUsage,
  SessionFileChange,
  SessionPrompt,
  TerminalAgentState as AgentState,
  TerminalKind,
  TerminalPathStyle,
  TerminalPromptUndelivered,
  TerminalSessionDeltaEntry,
  TerminalSessionSnapshot,
  TerminalSessionsDelta,
  TerminalSpawnMetadata,
  TerminalSpawnResult,
  TerminalVisibilityOptions,
} from '../../../packages/studio-protocol/src/public'
import type { TerminalKind } from '../../../packages/studio-protocol/src/public'
import type { AgentCli } from './conversations'

/** Main's answer to a window's one-time registry hydration offer. */
export type WorkspaceRegistryHydrateResult = {
  changed: boolean
  reason: 'seeded' | 'already_present' | 'refused_dangerous_empty' | 'seeded_empty_intent'
  classification?: string
  seededWorkspaceCount?: number
  droppedRecordIds?: string[]
}

// One process row from Electron's app.getAppMetrics() plus throttled child
// process tree sampling. `kind` maps Electron's process type and known spawned
// child categories to the roles operators reason about: 'main' (Browser),
// 'renderer' (Tab), 'gpu', 'utility', terminal/agent/helper children, and
// 'other'. `cpuPercent` is the rolling CPU share since the previous metrics
// sample for Electron rows, and best-effort OS CPU% for child rows. `threads` is
// populated from a throttled, off-poll OS sample (macOS `ps -M`, Linux /proc) —
// not on the 1s poll, since per-poll ps/lsof would add the overhead the panel
// exists to measure. `fileDescriptors` remains undefined (same per-poll-cost
// reason).
export type ProcessMetricKind = 'main' | 'renderer' | 'gpu' | 'utility' | 'agent' | 'terminal' | 'helper' | 'other'

export type ProcessMetricSample = {
  pid: number
  kind: ProcessMetricKind
  // Electron's raw process type ('Browser' | 'Tab' | 'GPU' | 'Utility' | …) and
  // the utility/service name when present, so the panel can disambiguate
  // multiple renderers/utilities without guessing.
  type: string
  name?: string
  cpuPercent: number
  // Reported process memory in bytes. Electron rows use Electron working set
  // (reported in KB and converted by main); spawned child rows use OS RSS. On
  // macOS neither should be treated as Activity Monitor physical footprint.
  memoryBytes: number
  threads?: number
  fileDescriptors?: number
  // V8 heap detail, currently populated only for the main process (from
  // process.memoryUsage() in the IPC handler). getAppMetrics does not expose
  // per-renderer heap; the renderer's own heap is sampled separately via
  // performance.memory in the metrics-history store.
  heapUsedBytes?: number
  heapTotalBytes?: number
}

// OS-wide memory, sampled out-of-band (getAppMetrics only covers Electron's own
// processes). This is what actually predicts system exhaustion across every app.
// `availableBytes`/`utilizationRatio` are best-effort availability estimates;
// they are not the operating system's memory-pressure signal. `source` records
// how they were derived ('vm_stat' macOS, 'proc' linux, 'os' fallback).
export type SystemMemorySample = {
  totalBytes: number
  availableBytes: number
  usedBytes: number
  compressedBytes: number
  swapUsedBytes: number
  // 0..1 estimated utilization: 1 - available/total. On Darwin, available
  // includes free + speculative + inactive + purgeable pages, so usedBytes is
  // an estimated non-reclaimable amount rather than Activity Monitor "Memory
  // Used" and this ratio must never be labelled OS memory pressure.
  utilizationRatio: number
  source: 'vm_stat' | 'proc' | 'os'
}

// One terminal/agent's real process cost, attributed to its workspace. The
// memory is the RSS of the pty's whole subtree (the CLI plus any MCP/dev-server
// children), summed in the main process where pids and sessions meet.
export type WorkspaceTerminalMemorySample = {
  sessionId: string
  kind: TerminalKind
  cli: AgentCli | null
  agentId: string | null
  terminalId: string | null
  activityKind: string
  processAlive: boolean
  memoryBytes: number
  startedAt: number
}

// Per-workspace rollup of resident agent/terminal memory. Only live sessions
// contribute; shared overhead (main/renderer/GPU) is intentionally not
// attributed, so the sum is "what this workspace's terminals cost", not the
// whole app.
export type WorkspaceMemorySample = {
  workspaceId: string
  // At least one live agent PTY — the same "hot" signal the sidebar bolds.
  resident: boolean
  totalMemoryBytes: number
  // Earliest startedAt across the workspace's live terminals ("live for …").
  becameLiveAt: number | null
  terminals: WorkspaceTerminalMemorySample[]
}

// One terminal the main-process reaper acted on, kept in a bounded ring buffer
// so the diagnostics panel can show an audit trail of what was reaped and from
// which workspace. `idle-suspend` is the memory-bounded sweep
// (`runIdleAgentReapSweep`) suspending an idle agent outside the hot set;
// `idle-dispose` is the same sweep DISPOSING an idle module-driven agent (it
// leaves → revives via dispatch rather than freezing the view);
// `stale-dispose` is the 24h backstop (`reapStaleTerminals`). The
// suspend reasons preserve the agent's resume flags so it relaunches with
// `--resume` on reopen.
export type TerminalReapReason = 'idle-suspend' | 'idle-dispose' | 'stale-dispose'

export type TerminalReapEvent = {
  reapedAt: number
  reason: TerminalReapReason
  sessionId: string
  workspaceId: string | null
  agentId: string | null
  terminalId: string | null
  cli: string | null
  kind: string
  // Idle window (ms since last real interaction) that triggered an idle-suspend.
  idleMs?: number
  // Unseen window (ms since last seen) that triggered a stale-dispose.
  unseenMs?: number
}

export type ProcessMetricsSnapshot = {
  sampledAt: number
  // Best-effort: empty when app.getAppMetrics() is unavailable in the current
  // runtime rather than throwing, so the panel degrades to "unavailable".
  processes: ProcessMetricSample[]
  // Best-effort: omitted until the first out-of-band sample lands.
  systemMemory?: SystemMemorySample
  // Best-effort: per-workspace RSS attribution; omitted until the first sample.
  workspaceMemory?: WorkspaceMemorySample[]
  // Most-recent-first audit trail of terminals the reaper suspended/disposed
  // this session (bounded). Omitted when nothing has been reaped yet.
  reapEvents?: TerminalReapEvent[]
}

// Per-api-method IPC accounting, accumulated in the preload (see preload/ipcStats).
// Counts are monotonic since process start; the renderer diffs consecutive
// snapshots to derive per-second rates.
export type IpcChannelStat = {
  name: string
  calls: number
  outBytes: number
  inEvents: number
  inBytes: number
}

export type IpcStatsSnapshot = {
  sampledAt: number
  channels: IpcChannelStat[]
}

export type GitFileStatus = 'new' | 'modified' | 'deleted' | 'renamed' | 'conflicted'
