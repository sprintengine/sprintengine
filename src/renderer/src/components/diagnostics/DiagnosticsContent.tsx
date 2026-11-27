import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import type {
  ProcessMetricKind,
  ProcessMetricsSnapshot,
  TerminalReapEvent,
  WorkspaceMemorySample,
} from '../../../../shared/electron-api'
import { Badge, GhostButton, StatusDot } from '../ui'
import { Select } from '../ui/Select'
import { Table } from '../ui/Table'
import { Tabs, TabPanel, type TabItem } from '../ui/Tabs'
import {
  getLiveTerminalSessionsSnapshot,
  refreshTerminalSessions,
  useTerminalSessions,
} from '../../hooks/useTerminalSessions'
import { formatRelativeMsAgo } from '../../utils/relativeTime'
import {
  aggregateDiagnostics,
  LARGE_REPLAY_WARNING_BYTES,
  sortTerminalDiagnosticsRows,
  type TerminalDiagnosticsRow,
  type TerminalDiagnosticsSortKey,
  type TerminalDiagnosticsWarning,
} from '../../utils/diagnostics/aggregateDiagnostics'
import {
  getReplayProfiles,
  subscribeReplayProfiles,
  type ReplayProfileEntry,
} from '../../utils/diagnostics/replayProfileStore'
import { formatBytes, formatDiagnosticsReport } from '../../utils/diagnostics/formatDiagnosticsReport'
import { aggregatePerfEvents, getPerfEventSamples } from '../../utils/diagnostics/perfEventStore'
import { getLongTaskSamples, startLongTaskObserver, summarizeLongTasks } from '../../utils/diagnostics/longTaskStore'
import { getFrameSamples, startFrameMonitor, summarizeFrameStats } from '../../utils/diagnostics/frameStatsStore'
import { Sparkline } from './Sparkline'
import {
  appendMetricsSample,
  computeGrowthRates,
  deriveMetricsSample,
  getMetricsBaseline,
  getMetricsHistory,
  getMetricsPeaks,
  readRendererHeap,
  setMetricsBaseline,
} from '../../utils/diagnostics/metricsHistoryStore'
import { diffIpcSnapshots, type IpcThroughput } from '../../utils/diagnostics/ipcThroughputStore'
import { getTerminalWriteSamples, summarizeTerminalThroughput } from '../../utils/diagnostics/terminalThroughputStore'
import { collectScrollbackFootprint } from '../../utils/diagnostics/terminalInstanceRegistry'
import type { IpcStatsSnapshot } from '../../../../shared/electron-api'
import { workspaceSyncApi } from '../../studio/workspaceSync'
import { copy as appCopy } from '../../../../shared/copy'

// Poll process metrics once a second while the panel is mounted. Both surfaces
// (overlay + standalone window) mount this only while visible, so this interval
// — and the IPC traffic — exist only while the operator is looking.
const PROCESS_METRICS_POLL_MS = 1000

type Props = {
  // Surface-specific buttons rendered in the header (e.g. Pop-out, Close). The
  // Copy button is owned here so every surface gets it.
  headerActions?: React.ReactNode
}

const PROCESS_KIND_LABEL: Record<ProcessMetricKind, string> = {
  main: 'Main',
  renderer: 'Renderer',
  gpu: 'GPU',
  utility: 'Utility',
  agent: 'Agent',
  terminal: 'Terminal',
  helper: 'Helper',
  other: 'Other',
}

const WARNING_LABEL: Record<TerminalDiagnosticsWarning, string> = {
  'hidden-but-visible': 'Hidden workspace, runtime-visible',
  'large-replay': `Replay > ${formatBytes(LARGE_REPLAY_WARNING_BYTES)}`,
  'long-idle': 'Live > 6h and idle',
  stale: 'Not seen > 24h',
}

const WARNING_SHORT: Record<TerminalDiagnosticsWarning, string> = {
  'hidden-but-visible': 'HIDDEN-VISIBLE',
  'large-replay': 'BIG-REPLAY',
  'long-idle': 'IDLE-6H',
  stale: 'STALE-24H',
}

const SORT_OPTIONS: { key: TerminalDiagnosticsSortKey; label: string }[] = [
  { key: 'retained', label: appCopy.diagnostics.diagnosticsContent.retainedReplay },
  { key: 'warnings', label: appCopy.diagnostics.diagnosticsContent.warnings },
  { key: 'activity', label: appCopy.diagnostics.diagnosticsContent.activity },
  { key: 'lastOutput', label: appCopy.diagnostics.diagnosticsContent.lastOutput },
  { key: 'workspace', label: appCopy.diagnostics.diagnosticsContent.workspace },
]

const REAP_REASON_LABEL: Record<TerminalReapEvent['reason'], string> = {
  'idle-suspend': 'idle suspend',
  'idle-dispose': 'idle dispose',
  'stale-dispose': 'stale dispose',
}

// Coarse human duration for the idle/unseen window that triggered a reap.
function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const totalMinutes = Math.round(ms / 60_000)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
}

type SyncContext = {
  workspaceNames: Map<string, string>
  activeWorkspaceIds: Set<string>
}

const EMPTY_SYNC: SyncContext = { workspaceNames: new Map(), activeWorkspaceIds: new Set() }

function activityLabel(activity: TerminalDiagnosticsRow['activity']): string {
  switch (activity.kind) {
    case 'working':
      return 'active'
    case 'idle':
      return 'idle'
    case 'failed':
      return `failed (${activity.exitCode})`
    case 'exited':
      return `exited (${activity.exitCode})`
  }
}

function formatSignedBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  return `${bytes > 0 ? '+' : '−'}${formatBytes(Math.abs(bytes))}`
}

function formatPerMin(value: number | null): string {
  return value === null ? '—' : `${formatSignedBytes(value)}/min`
}

function msOrDash(value: number | null): string {
  return value === null ? '—' : String(Math.round(value))
}

// Local aliases onto the kit's table chrome. These were the app's
// third `<table>` styling and the only one with a sticky header; `ui/Table`
// promoted that behaviour, so what is left here is the one thing that was local
// to diagnostics — every cell is `whitespace-nowrap`, because a wrapped PID or
// byte count destroys the column scan these tables exist for.
function Th({ children, numeric }: { children: React.ReactNode; numeric?: boolean }) {
  return <Table.Head numeric={numeric}>{children}</Table.Head>
}

function Td({ children, numeric, title }: { children: React.ReactNode; numeric?: boolean; title?: string }) {
  return (
    <Table.Cell numeric={numeric} title={title} className="whitespace-nowrap">
      {children}
    </Table.Cell>
  )
}

// A flagged metric is DEGRADED, not failed: the app still runs, a number has
// crossed a threshold. So the warn tone (never the error red the `warn` prop
// used to paint), and a dot beside the figure so the state reads without
// colour — a number in red ink was colour alone.
function WarnMetric({
  flagged,
  label,
  className,
  children,
}: {
  flagged: boolean
  /** Accessible name for the dot; names the threshold that was crossed. */
  label: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 ${flagged ? 'text-[color:var(--tone-warn)]' : ''} ${className ?? ''}`}
    >
      {flagged ? <StatusDot tone="warn" label={label} /> : null}
      {children}
    </span>
  )
}

function SummaryStat({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className="flex min-w-[96px] flex-col gap-0.5">
      <span className="text-micro text-[color:var(--text-muted)]">{label}</span>
      <WarnMetric
        flagged={tone === 'warn'}
        label={appCopy.diagnostics.diagnosticsContent.needsAttention(label)}
        className={`text-sm font-semibold tabular-nums ${tone === 'warn' ? '' : 'text-[color:var(--text-strong)]'}`}
      >
        {value}
      </WarnMetric>
    </div>
  )
}

// Workspace names + per-window active ids come from the workspace-sync snapshot
// (IPC-broadcast to every window) rather than the renderer zustand store, so a
// standalone diagnostics window — which never mounts WorkspaceManager — sees the
// same truth as the in-app overlay, including which workspaces are on-screen.
function useWorkspaceSyncContext(): SyncContext {
  const [context, setContext] = useState<SyncContext>(EMPTY_SYNC)

  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      workspaceSyncApi
        .workspaceSyncGetSnapshot()
        .then((snapshot) => {
          if (cancelled) return
          const workspaceNames = new Map<string, string>()
          for (const workspace of snapshot.state.workspaces) workspaceNames.set(workspace.id, workspace.name)
          const activeWorkspaceIds = new Set<string>()
          for (const win of snapshot.state.workspaceWindows) {
            if (win.activeWorkspaceId) activeWorkspaceIds.add(win.activeWorkspaceId)
          }
          setContext({ workspaceNames, activeWorkspaceIds })
        })
        .catch(() => {})
    }
    refresh()
    // Workspace sync events are infrequent (window/workspace lifecycle, active
    // switches); refetch the compact snapshot on each rather than diffing, and
    // on each reconnect, which may be to a Studio that restarted.
    const unsubscribe = workspaceSyncApi.onWorkspaceSyncEvent(
      () => refresh(),
      () => refresh(),
    )
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return context
}

type DiagnosticTabId = 'dashboard' | 'memory' | 'rendering' | 'terminals' | 'workspaces' | 'subsystems'

const DIAGNOSTIC_TABS: TabItem<DiagnosticTabId>[] = [
  { id: 'dashboard', label: appCopy.diagnostics.diagnosticsContent.dashboard },
  { id: 'memory', label: appCopy.diagnostics.diagnosticsContent.memory },
  { id: 'rendering', label: appCopy.diagnostics.diagnosticsContent.rendering },
  { id: 'terminals', label: appCopy.diagnostics.diagnosticsContent.terminals },
  { id: 'workspaces', label: appCopy.diagnostics.diagnosticsContent.workspaces },
  { id: 'subsystems', label: appCopy.diagnostics.diagnosticsContent.subsystems },
]

const DIAGNOSTIC_TAB_STORAGE_KEY = 'sprintengine.diagnostics.activeTab'

function isDiagnosticTabId(value: string | null): value is DiagnosticTabId {
  return value !== null && DIAGNOSTIC_TABS.some((tab) => tab.id === value)
}

// One headline stat block for the Dashboard grid. `tone` flips to the error
// color so an at-risk metric reads as red without the operator parsing numbers.
function DashboardCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: string
  detail?: React.ReactNode
  tone?: 'warn'
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-sm border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 py-2">
      <span className="text-micro text-[color:var(--text-muted)]">{label}</span>
      <WarnMetric
        flagged={tone === 'warn'}
        label={appCopy.diagnostics.diagnosticsContent.needsAttention(label)}
        className={`text-title font-semibold tabular-nums ${tone === 'warn' ? '' : 'text-[color:var(--text-strong)]'}`}
      >
        {value}
      </WarnMetric>
      {detail ? <span className="text-micro tabular-nums text-[color:var(--text-muted)]">{detail}</span> : null}
    </div>
  )
}

export default function DiagnosticsContent({ headerActions }: Props) {
  // Keep lifecycle changes immediate through the semantic subscription, but do
  // not re-render Diagnostics for every high-churn live broadcast. The existing
  // one-second sample clock below reads the latest live snapshot, including the
  // retainedOutputBytes / visible / lastOutputAt fields omitted by the semantic
  // signature. Diagnostics remains current without becoming part of the hot path
  // it is trying to observe.
  useTerminalSessions()
  const sessions = getLiveTerminalSessionsSnapshot()
  const { workspaceNames, activeWorkspaceIds } = useWorkspaceSyncContext()

  const [metrics, setMetrics] = useState<ProcessMetricsSnapshot | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [sortKey, setSortKey] = useState<TerminalDiagnosticsSortKey>('retained')
  const [profiles, setProfiles] = useState<ReplayProfileEntry[]>(() => getReplayProfiles())
  const [copied, setCopied] = useState(false)
  // Bumped whenever the baseline is set/cleared so the trend memo recomputes.
  const [baselineNonce, setBaselineNonce] = useState(0)
  const [ipcThroughput, setIpcThroughput] = useState<IpcThroughput | null>(null)
  const prevIpcRef = useRef<IpcStatsSnapshot | null>(null)
  const tabsIdPrefix = useId()
  const [activeTab, setActiveTab] = useState<DiagnosticTabId>(() => {
    try {
      const stored = window.localStorage.getItem(DIAGNOSTIC_TAB_STORAGE_KEY)
      if (isDiagnosticTabId(stored)) return stored
    } catch {
      // localStorage can throw in restricted contexts; fall back to the default.
    }
    return 'dashboard'
  })
  const handleTabChange = (id: DiagnosticTabId) => {
    setActiveTab(id)
    try {
      window.localStorage.setItem(DIAGNOSTIC_TAB_STORAGE_KEY, id)
    } catch {
      // Persisting the last-active tab is best-effort.
    }
  }

  useEffect(() => {
    let cancelled = false
    const poll = () => {
      const ipcSnapshot = window.api.diagnosticsGetIpcStats?.()
      // The sessions broadcast carries only what changed, and output timing and
      // retained bytes are not a change worth a broadcast; this panel is where
      // they are read, so it asks for the full list on its own clock.
      void refreshTerminalSessions().catch(() => {})
      window.api
        .diagnosticsGetProcessMetrics()
        .then((snapshot) => {
          if (cancelled) return
          const sampledAt = Date.now()
          setMetrics(snapshot)
          setNow(sampledAt)
          // Feed the rolling history (with this renderer's JS heap) so the trend,
          // growth-rate, and baseline-diff all read from one append-only series.
          appendMetricsSample(deriveMetricsSample(snapshot, readRendererHeap()))
          if (ipcSnapshot) {
            setIpcThroughput(diffIpcSnapshots(prevIpcRef.current, ipcSnapshot))
            prevIpcRef.current = ipcSnapshot
          }
        })
        .catch(() => {
          if (!cancelled) setNow(Date.now())
        })
    }
    poll()
    const id = window.setInterval(poll, PROCESS_METRICS_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  // Rendering instrumentation is intentionally opt-in. Keeping a Performance
  // Observer and a continuous rAF callback alive on every Diagnostics tab makes
  // the panel perturb the workload it is measuring, especially on high-refresh
  // displays. Selecting Rendering starts both; leaving it disposes both.
  useEffect(() => {
    if (activeTab !== 'rendering') return
    return startLongTaskObserver()
  }, [activeTab])

  useEffect(() => {
    if (activeTab !== 'rendering') return
    return startFrameMonitor()
  }, [activeTab])

  useEffect(() => subscribeReplayProfiles(() => setProfiles(getReplayProfiles())), [])

  const perfRollup = useMemo(() => aggregatePerfEvents(getPerfEventSamples(), { now }), [now])
  const longTaskSummary = useMemo(() => summarizeLongTasks(getLongTaskSamples(), { now }), [now])
  const frameStats = useMemo(() => summarizeFrameStats(getFrameSamples(), { now }), [now])
  const scrollback = useMemo(() => collectScrollbackFootprint(), [now])
  // Series for the memory-trend sparklines, drawn from the same rolling history
  // the growth slope uses. Refreshed on the 1s tick.
  const memorySparklines = useMemo(() => {
    const history = getMetricsHistory()
    return {
      rendererRss: history.map((sample) => sample.rendererRssBytes),
      gpuRss: history.map((sample) => sample.gpuRssBytes),
      heap: history.map((sample) => sample.rendererHeapUsedBytes ?? 0),
    }
  }, [now])
  // Recent raw frame durations (ms) for the frames sparkline — spikes = stutter.
  const frameDurations = useMemo(() => getFrameSamples().map((sample) => sample.durationMs), [now])
  const metricsTrend = useMemo(() => {
    const history = getMetricsHistory()
    return {
      current: history.length > 0 ? history[history.length - 1] : null,
      baseline: getMetricsBaseline(),
      growth: computeGrowthRates(history, { now }),
      peaks: getMetricsPeaks(),
    }
    // baselineNonce participates so a baseline set/clear refreshes the diff.
  }, [now, baselineNonce])

  const handleToggleBaseline = () => {
    setMetricsBaseline(getMetricsBaseline() ? null : metricsTrend.current)
    setBaselineNonce((value) => value + 1)
  }

  const aggregation = useMemo(
    () => aggregateDiagnostics({ sessions, activeWorkspaceIds, workspaceNames, now }),
    [sessions, activeWorkspaceIds, workspaceNames, now],
  )

  // Real per-workspace process RSS, attributed in main from the pty subtrees.
  // Joined into the Workspaces tab by id; absent until the first sample lands.
  const workspaceMemoryById = useMemo(() => {
    const map = new Map<string, WorkspaceMemorySample>()
    for (const sample of metrics?.workspaceMemory ?? []) map.set(sample.workspaceId, sample)
    return map
  }, [metrics])

  // Workspaces ordered by real resident memory (heaviest first) — the triage
  // axis for "what's costing me RAM". Falls back to the aggregation's own order
  // (retained replay) before the first memory sample arrives.
  const workspacesByMemory = useMemo(() => {
    return [...aggregation.workspaces].sort(
      (a, b) =>
        (workspaceMemoryById.get(b.workspaceId)?.totalMemoryBytes ?? 0) -
        (workspaceMemoryById.get(a.workspaceId)?.totalMemoryBytes ?? 0),
    )
  }, [aggregation.workspaces, workspaceMemoryById])

  const sortedRows = useMemo(() => sortTerminalDiagnosticsRows(aggregation.rows, sortKey), [aggregation.rows, sortKey])

  // Terminals that are runtime-visible while their workspace is off-screen — the
  // set whose write throughput is "wasted" rendering work.
  const terminalThroughput = useMemo(() => {
    const hiddenSessionIds = new Set(aggregation.rows.filter((row) => row.hiddenButVisible).map((row) => row.sessionId))
    return summarizeTerminalThroughput(getTerminalWriteSamples(), { hiddenSessionIds, now })
  }, [aggregation.rows, now])

  const handleCopy = () => {
    // Snapshot `now` at copy time so the report's relative timestamps match what
    // the user saw when they clicked.
    const report = formatDiagnosticsReport({
      aggregation,
      metrics,
      profiles,
      perfEvents: perfRollup,
      longTasks: longTaskSummary,
      frameStats,
      metricsTrend,
      ipc: ipcThroughput,
      terminalThroughput,
      scrollback,
      now: Date.now(),
    })
    void window.api
      .clipboardWriteText(report)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch((error) => {
        console.error('[Diagnostics] Failed to copy report to clipboard:', error)
      })
  }

  const totals = aggregation.totals

  return (
    <div data-control-tab-scope className="flex h-full flex-col overflow-hidden font-mono text-meta">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[color:var(--border-subtle)] px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-[color:var(--text-strong)]">
            {appCopy.diagnostics.diagnosticsContent.performanceDiagnostics}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <GhostButton
            size="xs"
            onClick={handleToggleBaseline}
            aria-label={
              metricsTrend.baseline
                ? appCopy.diagnostics.diagnosticsContent.clearMemoryBaseline
                : appCopy.diagnostics.diagnosticsContent.markCurrentMetricsAsBaseline
            }
          >
            {metricsTrend.baseline ? 'Clear baseline' : 'Mark baseline'}
          </GhostButton>
          <GhostButton
            size="xs"
            onClick={handleCopy}
            aria-label={appCopy.diagnostics.diagnosticsContent.copyDiagnosticsReportToClipboard}
          >
            {copied ? 'Copied!' : 'Copy'}
          </GhostButton>
          {headerActions}
        </div>
      </div>

      {/* Global summary. Its raised ground is its edge; a rule under it as
          well drew the same boundary twice, one band under the header's. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 bg-[color:var(--bg-surface-raised)] px-4 py-2">
        <SummaryStat label={appCopy.diagnostics.diagnosticsContent.terminals} value={String(totals.terminalCount)} />
        <SummaryStat label={appCopy.diagnostics.diagnosticsContent.live} value={String(totals.liveTerminalCount)} />
        <SummaryStat
          label={appCopy.diagnostics.diagnosticsContent.runtimeVisible}
          value={String(totals.visibleTerminalCount)}
        />
        <SummaryStat
          label={appCopy.diagnostics.diagnosticsContent.hiddenVisible}
          value={String(totals.hiddenButVisibleCount)}
          tone={totals.hiddenButVisibleCount > 0 ? 'warn' : undefined}
        />
        <SummaryStat
          label={appCopy.diagnostics.diagnosticsContent.retainedReplay}
          value={formatBytes(totals.totalRetainedReplayBytes)}
        />
        <SummaryStat
          label={appCopy.diagnostics.diagnosticsContent.largestReplay}
          value={formatBytes(totals.largestRetainedReplayBytes)}
        />
        <SummaryStat
          label={appCopy.diagnostics.diagnosticsContent.warnings}
          value={String(totals.warningCount)}
          tone={totals.warningCount > 0 ? 'warn' : undefined}
        />
      </div>

      <Tabs
        ariaLabel={appCopy.diagnostics.diagnosticsContent.diagnosticsSections}
        items={DIAGNOSTIC_TABS}
        value={activeTab}
        onChange={handleTabChange}
        idPrefix={tabsIdPrefix}
        className="shrink-0 px-4"
      />

      <div className="flex flex-1 flex-col overflow-y-auto px-4 py-3">
        {/* Dashboard — headline health at a glance */}
        <TabPanel
          idPrefix={tabsIdPrefix}
          tabId="dashboard"
          active={activeTab === 'dashboard'}
          className="flex flex-col gap-3"
        >
          {metricsTrend.current ? (
            (() => {
              const c = metricsTrend.current
              const sys = c.systemMemory
              const peaks = metricsTrend.peaks
              const growth = metricsTrend.growth
              const cpu = Math.round((c.rendererCpuPercent + c.mainCpuPercent) * 10) / 10
              return (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  <DashboardCard
                    label={appCopy.diagnostics.diagnosticsContent.estimatedMemoryUtilization}
                    value={sys ? `${Math.round(sys.utilizationRatio * 100)}%` : '—'}
                    detail={
                      sys
                        ? appCopy.diagnostics.diagnosticsContent.estimatedNonReclaimable(formatBytes(sys.usedBytes))
                        : appCopy.diagnostics.diagnosticsContent.sampling
                    }
                  />
                  <DashboardCard
                    label={appCopy.diagnostics.diagnosticsContent.reportedProcessMemory}
                    value={formatBytes(c.totalRssBytes)}
                    detail={appCopy.diagnostics.diagnosticsContent.rendererMainChildren(
                      formatBytes(c.rendererRssBytes),
                      formatBytes(c.mainRssBytes),
                      formatBytes(c.childRssBytes),
                    )}
                  />
                  <DashboardCard
                    label={appCopy.diagnostics.diagnosticsContent.growthRSS}
                    value={formatPerMin(growth.rssBytesPerMin)}
                    tone={(growth.rssBytesPerMin ?? 0) > 0 ? 'warn' : undefined}
                    detail={appCopy.diagnostics.diagnosticsContent.overSSamples(
                      Math.round(growth.windowMs / 1000),
                      growth.sampleCount,
                    )}
                  />
                  <DashboardCard
                    label={appCopy.diagnostics.diagnosticsContent.peakThisSession}
                    value={peaks && peaks.totalRssBytes > 0 ? formatBytes(peaks.totalRssBytes) : '—'}
                    detail={
                      peaks && peaks.systemUtilizationRatio !== null
                        ? appCopy.diagnostics.diagnosticsContent.estimatedUtilization(
                            Math.round(peaks.systemUtilizationRatio * 100),
                          )
                        : peaks && peaks.totalRssAt
                          ? formatRelativeMsAgo(peaks.totalRssAt, now) || appCopy.diagnostics.diagnosticsContent.justNow
                          : undefined
                    }
                  />
                  <DashboardCard
                    label={appCopy.diagnostics.diagnosticsContent.cPU}
                    value={`${cpu}%`}
                    detail={appCopy.diagnostics.diagnosticsContent.rendererMain(c.rendererCpuPercent, c.mainCpuPercent)}
                  />
                  <DashboardCard
                    label={appCopy.diagnostics.diagnosticsContent.rendering}
                    value={frameStats.fps !== null ? `${frameStats.fps} fps last` : 'paused'}
                    detail={appCopy.diagnostics.diagnosticsContent.openRenderingTabToSample}
                  />
                  <DashboardCard
                    label={appCopy.diagnostics.diagnosticsContent.mainThreadStalls}
                    value={longTaskSummary.count > 0 ? `${longTaskSummary.count} last` : 'paused'}
                    detail={appCopy.diagnostics.diagnosticsContent.openRenderingTabToObserve}
                  />
                  <DashboardCard
                    label={appCopy.diagnostics.diagnosticsContent.terminals}
                    value={`${totals.liveTerminalCount} live`}
                    tone={totals.hiddenButVisibleCount > 0 ? 'warn' : undefined}
                    detail={appCopy.diagnostics.diagnosticsContent.visibleHiddenVisible(
                      totals.visibleTerminalCount,
                      totals.hiddenButVisibleCount,
                    )}
                  />
                  <DashboardCard
                    label={appCopy.diagnostics.diagnosticsContent.warnings}
                    value={String(totals.warningCount)}
                    tone={totals.warningCount > 0 ? 'warn' : undefined}
                    detail={totals.warningCount > 0 ? appCopy.diagnostics.diagnosticsContent.seeTerminalsTab : 'none'}
                  />
                </div>
              )
            })()
          ) : (
            <p className="text-[color:var(--text-muted)]">{appCopy.diagnostics.diagnosticsContent.collectingSamples}</p>
          )}
        </TabPanel>

        {/* Memory */}
        <TabPanel
          idPrefix={tabsIdPrefix}
          tabId="memory"
          active={activeTab === 'memory'}
          className="flex flex-col gap-4"
        >
          {/* Process metrics */}
          <section>
            <h2 className="mb-1 text-micro font-semibold text-[color:var(--text-muted)]">
              {appCopy.diagnostics.diagnosticsContent.processes}
            </h2>
            {metrics && metrics.processes.length > 0 ? (
              <Table>
                <thead>
                  <tr>
                    <Th>{appCopy.diagnostics.diagnosticsContent.kind}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.pID}</Th>
                    <Th>{appCopy.diagnostics.diagnosticsContent.typeName}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.cPU2}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.reportedMemory}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.threads}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.fDs}</Th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.processes.map((process) => (
                    <tr key={process.pid} className="border-b border-[color:var(--border-subtle)]">
                      <Td>{PROCESS_KIND_LABEL[process.kind]}</Td>
                      <Td numeric>{process.pid}</Td>
                      <Td title={process.name}>{process.name ? `${process.type} · ${process.name}` : process.type}</Td>
                      <Td numeric>{process.cpuPercent.toFixed(1)}</Td>
                      <Td numeric>{formatBytes(process.memoryBytes)}</Td>
                      <Td numeric>{process.threads ?? '—'}</Td>
                      <Td numeric>{process.fileDescriptors ?? '—'}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="text-[color:var(--text-muted)]">
                {appCopy.diagnostics.diagnosticsContent.processMetricsUnavailable}
              </p>
            )}
          </section>

          {/* Memory trend + baseline diff */}
          <section>
            <h2 className="mb-1 text-micro font-semibold text-[color:var(--text-muted)]">
              {appCopy.diagnostics.diagnosticsContent.memoryTrend}
            </h2>
            {metricsTrend.current ? (
              <div className="flex flex-col gap-1 text-micro text-[color:var(--text-default)]">
                <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
                  <span>
                    {appCopy.diagnostics.diagnosticsContent.reportedProcessMemory2}
                    <strong>{formatBytes(metricsTrend.current.totalRssBytes)}</strong>
                  </span>
                  <span>renderer {formatBytes(metricsTrend.current.rendererRssBytes)}</span>
                  <span>main {formatBytes(metricsTrend.current.mainRssBytes)}</span>
                  <span>gpu {formatBytes(metricsTrend.current.gpuRssBytes)}</span>
                  <span>children {formatBytes(metricsTrend.current.childRssBytes)}</span>
                  {metricsTrend.current.rendererHeapUsedBytes !== null && (
                    <span>
                      {appCopy.diagnostics.diagnosticsContent.rendererJSHeap}
                      {formatBytes(metricsTrend.current.rendererHeapUsedBytes)}
                    </span>
                  )}
                </div>
                {metricsTrend.current.systemMemory && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
                    <span>
                      {appCopy.diagnostics.diagnosticsContent.estimatedSystemUtilization}{' '}
                      <strong>{Math.round(metricsTrend.current.systemMemory.utilizationRatio * 100)}%</strong> (
                      {formatBytes(metricsTrend.current.systemMemory.usedBytes)} /{' '}
                      {formatBytes(metricsTrend.current.systemMemory.totalBytes)}
                      {appCopy.diagnostics.diagnosticsContent.estimatedNonReclaimable2}
                    </span>
                    <span>
                      {appCopy.diagnostics.diagnosticsContent.estimatedAvailable}
                      {formatBytes(metricsTrend.current.systemMemory.availableBytes)}
                    </span>
                    {metricsTrend.current.systemMemory.compressedBytes > 0 && (
                      <span>compressed {formatBytes(metricsTrend.current.systemMemory.compressedBytes)}</span>
                    )}
                    {metricsTrend.current.systemMemory.swapUsedBytes > 0 && (
                      <span>swap {formatBytes(metricsTrend.current.systemMemory.swapUsedBytes)}</span>
                    )}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-[color:var(--text-subtle)]">
                  <span className="flex items-center gap-1 text-[color:var(--text-muted)]">
                    renderer
                    <Sparkline
                      values={memorySparklines.rendererRss}
                      title={appCopy.diagnostics.diagnosticsContent.rendererRSSOverRecentSamples}
                    />
                  </span>
                  <span className="flex items-center gap-1 text-[color:var(--text-muted)]">
                    gpu
                    <Sparkline
                      values={memorySparklines.gpuRss}
                      title={appCopy.diagnostics.diagnosticsContent.gPURSSOverRecentSamples}
                    />
                  </span>
                  {metricsTrend.current.rendererHeapUsedBytes !== null && (
                    <span className="flex items-center gap-1 text-[color:var(--text-muted)]">
                      heap
                      <Sparkline
                        values={memorySparklines.heap}
                        title={appCopy.diagnostics.diagnosticsContent.rendererJSHeapOverRecent}
                      />
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums text-[color:var(--text-muted)]">
                  <span>
                    {appCopy.diagnostics.diagnosticsContent.growth}
                    {Math.round(metricsTrend.growth.windowMs / 1000)}
                    {appCopy.diagnostics.diagnosticsContent.sRSS}{' '}
                    <WarnMetric
                      flagged={(metricsTrend.growth.rssBytesPerMin ?? 0) > 0}
                      label={appCopy.diagnostics.diagnosticsContent.rSSIsGrowing}
                    >
                      {formatPerMin(metricsTrend.growth.rssBytesPerMin)}
                    </WarnMetric>
                  </span>
                  <span>heap {formatPerMin(metricsTrend.growth.heapBytesPerMin)}</span>
                  <span className="text-[color:var(--text-subtle)]">{metricsTrend.growth.sampleCount} samples</span>
                </div>
                {metricsTrend.peaks && metricsTrend.peaks.totalRssBytes > 0 && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums text-[color:var(--text-muted)]">
                    <span>
                      {appCopy.diagnostics.diagnosticsContent.peakThisSessionReportedMemory}
                      {formatBytes(metricsTrend.peaks.totalRssBytes)}
                    </span>
                    <span>children {formatBytes(metricsTrend.peaks.childRssBytes)}</span>
                    {metricsTrend.peaks.systemUtilizationRatio !== null && (
                      <span>
                        {appCopy.diagnostics.diagnosticsContent.estimatedUtilization2}
                        {Math.round(metricsTrend.peaks.systemUtilizationRatio * 100)}%
                      </span>
                    )}
                  </div>
                )}
                {metricsTrend.baseline && (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums text-[color:var(--text-strong)]">
                    {(() => {
                      const b = metricsTrend.baseline
                      const c = metricsTrend.current
                      const dTotal = c.totalRssBytes - b.totalRssBytes
                      const dRenderer = c.rendererRssBytes - b.rendererRssBytes
                      const dHeap =
                        c.rendererHeapUsedBytes !== null && b.rendererHeapUsedBytes !== null
                          ? c.rendererHeapUsedBytes - b.rendererHeapUsedBytes
                          : null
                      return (
                        <>
                          <span>
                            {appCopy.diagnostics.diagnosticsContent.vsBaseline}
                            {formatRelativeMsAgo(b.sampledAt, now) || 'just now'}):
                          </span>
                          <span>
                            {appCopy.diagnostics.diagnosticsContent.total}
                            {formatSignedBytes(dTotal)}
                          </span>
                          <span>
                            {appCopy.diagnostics.diagnosticsContent.renderer}
                            {formatSignedBytes(dRenderer)}
                          </span>
                          <span>
                            {appCopy.diagnostics.diagnosticsContent.heap}
                            {dHeap === null ? '—' : formatSignedBytes(dHeap)}
                          </span>
                        </>
                      )
                    })()}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[color:var(--text-muted)]">
                {appCopy.diagnostics.diagnosticsContent.collectingSamples}
              </p>
            )}
          </section>
        </TabPanel>

        {/* Rendering */}
        <TabPanel
          idPrefix={tabsIdPrefix}
          tabId="rendering"
          active={activeTab === 'rendering'}
          className="flex flex-col gap-4"
        >
          {/* Long tasks */}
          <section>
            <h2 className="mb-1 text-micro font-semibold text-[color:var(--text-muted)]">
              {appCopy.diagnostics.diagnosticsContent.longTasksMainThreadStalls}
              {Math.round(longTaskSummary.windowMs / 1000)}s)
            </h2>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-micro tabular-nums text-[color:var(--text-default)]">
              <WarnMetric
                flagged={longTaskSummary.count > 0}
                label={appCopy.diagnostics.diagnosticsContent.longTasksRecorded}
              >
                {appCopy.diagnostics.diagnosticsContent.count}
                <strong>{longTaskSummary.count}</strong>
              </WarnMetric>
              <span>
                {appCopy.diagnostics.diagnosticsContent.blocking}
                {longTaskSummary.totalBlockingMs} ms
              </span>
              <span>
                {appCopy.diagnostics.diagnosticsContent.max}
                {msOrDash(longTaskSummary.maxMs)} ms
              </span>
              <span>p95 {msOrDash(longTaskSummary.p95Ms)} ms</span>
              <span className="text-[color:var(--text-subtle)]">
                {longTaskSummary.lastAt ? `last ${formatRelativeMsAgo(longTaskSummary.lastAt, now)}` : 'none'}
              </span>
            </div>
          </section>

          {/* Frame cadence (rAF) — per-frame jank the longtask observer misses */}
          <section>
            <h2 className="mb-1 text-micro font-semibold text-[color:var(--text-muted)]">
              {appCopy.diagnostics.diagnosticsContent.renderingCadenceFramesLast}
              {Math.round(frameStats.windowMs / 1000)}s)
            </h2>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-micro tabular-nums text-[color:var(--text-default)]">
              <WarnMetric
                flagged={frameStats.fps !== null && frameStats.fps < 50}
                label={appCopy.diagnostics.diagnosticsContent.frameRateBelow50}
              >
                {appCopy.diagnostics.diagnosticsContent.fPS}
                <strong>{frameStats.fps ?? '—'}</strong>
              </WarnMetric>
              <WarnMetric
                flagged={frameStats.longFrameCount > 0}
                label={appCopy.diagnostics.diagnosticsContent.longFramesRecorded}
              >
                {appCopy.diagnostics.diagnosticsContent.longFrames}
                {frameStats.longFrameCount} ({frameStats.longFramePercent}%)
              </WarnMetric>
              <span>p95 {msOrDash(frameStats.p95Ms)} ms</span>
              <span>worst {msOrDash(frameStats.maxMs)} ms</span>
              <span className="text-[color:var(--text-subtle)]">{frameStats.frameCount} frames</span>
              <span className="text-[color:var(--text-muted)]">
                <Sparkline values={frameDurations} title={appCopy.diagnostics.diagnosticsContent.frameDurationsMs} />
              </span>
            </div>
          </section>

          {/* Perf events rollup */}
          <section>
            <h2 className="mb-1 text-micro font-semibold text-[color:var(--text-muted)]">
              {appCopy.diagnostics.diagnosticsContent.perfEvents}
              {perfRollup.length})
            </h2>
            {perfRollup.length > 0 ? (
              <Table>
                <thead>
                  <tr>
                    <Th>{appCopy.diagnostics.diagnosticsContent.scope}</Th>
                    <Th>{appCopy.diagnostics.diagnosticsContent.event}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.count2}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.p50Ms}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.p95Ms}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.maxMs}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.lastMs}</Th>
                  </tr>
                </thead>
                <tbody>
                  {perfRollup.map((row) => (
                    <tr key={`${row.scope}-${row.event}`} className="border-b border-[color:var(--border-subtle)]">
                      <Td>{row.scope}</Td>
                      <Td>{row.event}</Td>
                      <Td numeric>{row.count}</Td>
                      <Td numeric>{msOrDash(row.p50Ms)}</Td>
                      <Td numeric>{msOrDash(row.p95Ms)}</Td>
                      <Td numeric>{msOrDash(row.maxMs)}</Td>
                      <Td numeric>{msOrDash(row.lastMs)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="text-[color:var(--text-muted)]">{appCopy.diagnostics.diagnosticsContent.noPerfEventsYet}</p>
            )}
          </section>
        </TabPanel>

        {/* Terminals */}
        <TabPanel
          idPrefix={tabsIdPrefix}
          tabId="terminals"
          active={activeTab === 'terminals'}
          className="flex flex-col gap-4"
        >
          {/* Terminal table */}
          <section>
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-micro font-semibold text-[color:var(--text-muted)]">
                {appCopy.diagnostics.diagnosticsContent.terminals2}
                {aggregation.rows.length})
              </h2>
              <div className="flex items-center gap-1.5 text-micro text-[color:var(--text-muted)]">
                <span>{appCopy.diagnostics.diagnosticsContent.sort}</span>
                <Select<TerminalDiagnosticsSortKey>
                  ariaLabel={appCopy.diagnostics.diagnosticsContent.sortTerminalsBy}
                  items={SORT_OPTIONS.map((option) => ({ value: option.key, label: option.label }))}
                  value={sortKey}
                  onChange={setSortKey}
                />
              </div>
            </div>
            {sortedRows.length > 0 ? (
              <Table>
                <thead>
                  <tr>
                    <Th>{appCopy.diagnostics.diagnosticsContent.workspace}</Th>
                    <Th>{appCopy.diagnostics.diagnosticsContent.agentTerm}</Th>
                    <Th>{appCopy.diagnostics.diagnosticsContent.kind}</Th>
                    <Th>{appCopy.diagnostics.diagnosticsContent.alive}</Th>
                    <Th>{appCopy.diagnostics.diagnosticsContent.activity}</Th>
                    <Th>{appCopy.diagnostics.diagnosticsContent.vis}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.retained}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.limit}</Th>
                    <Th>{appCopy.diagnostics.diagnosticsContent.tier}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.lastOutput}</Th>
                    <Th>{appCopy.diagnostics.diagnosticsContent.warnings}</Th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => (
                    <tr
                      key={row.sessionId}
                      // The warning badges in the last cell carry the row's
                      // state; a tinted row ground said it a second time.
                      className="border-b border-[color:var(--border-subtle)]"
                    >
                      <Td title={row.workspaceId ?? undefined}>{row.workspaceName ?? row.workspaceId ?? '—'}</Td>
                      <Td title={row.sessionId}>{row.agentId ?? row.terminalId ?? row.sessionId}</Td>
                      <Td>{row.cli ? `${row.kind}·${row.cli}` : row.kind}</Td>
                      <Td>{row.processAlive ? 'yes' : 'no'}</Td>
                      <Td>{activityLabel(row.activity)}</Td>
                      <Td>
                        {row.hiddenButVisible ? (
                          <WarnMetric
                            flagged
                            label={appCopy.diagnostics.diagnosticsContent.runtimeVisibleButWorkspaceIs}
                          >
                            hidden
                          </WarnMetric>
                        ) : row.visible ? (
                          'yes'
                        ) : (
                          'no'
                        )}
                      </Td>
                      <Td numeric>{formatBytes(row.retainedOutputBytes)}</Td>
                      <Td numeric>{row.replayLimitBytes !== null ? formatBytes(row.replayLimitBytes) : '—'}</Td>
                      <Td>{row.historyTier ?? '—'}</Td>
                      <Td numeric>{formatRelativeMsAgo(row.lastOutputAt, now) || '—'}</Td>
                      <Td>
                        {row.warnings.length > 0 ? (
                          <span className="flex flex-wrap gap-1">
                            {row.warnings.map((warning) => (
                              <Badge key={warning} tone="warn" ariaLabel={WARNING_LABEL[warning]}>
                                {WARNING_SHORT[warning]}
                              </Badge>
                            ))}
                          </span>
                        ) : (
                          <span className="text-[color:var(--text-subtle)]">—</span>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="text-[color:var(--text-muted)]">
                {appCopy.diagnostics.diagnosticsContent.noTerminalSessions}
              </p>
            )}
          </section>

          {/* Reaped terminals — audit trail of what the main-process reaper
            suspended/disposed this session, and from which workspace. */}
          <section>
            <h2 className="mb-1 text-micro font-semibold text-[color:var(--text-muted)]">
              {appCopy.diagnostics.diagnosticsContent.reapedTerminals}
              {metrics?.reapEvents?.length ?? 0})
            </h2>
            {metrics?.reapEvents && metrics.reapEvents.length > 0 ? (
              <Table>
                <thead>
                  <tr>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.reaped}</Th>
                    <Th>{appCopy.diagnostics.diagnosticsContent.workspace}</Th>
                    <Th>{appCopy.diagnostics.diagnosticsContent.agentTerm}</Th>
                    <Th>{appCopy.diagnostics.diagnosticsContent.kind}</Th>
                    <Th>{appCopy.diagnostics.diagnosticsContent.reason}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.idleUnseen}</Th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.reapEvents.map((event: TerminalReapEvent) => (
                    <tr
                      key={`${event.sessionId}-${event.reapedAt}`}
                      className="border-b border-[color:var(--border-subtle)]"
                    >
                      <Td numeric>{formatRelativeMsAgo(event.reapedAt, now) || 'just now'}</Td>
                      <Td title={event.workspaceId ?? undefined}>
                        {(event.workspaceId ? workspaceNames.get(event.workspaceId) : null) ?? event.workspaceId ?? '—'}
                      </Td>
                      <Td title={event.sessionId}>{event.agentId ?? event.terminalId ?? event.sessionId}</Td>
                      <Td>{event.cli ? `${event.kind}·${event.cli}` : event.kind}</Td>
                      <Td>{REAP_REASON_LABEL[event.reason]}</Td>
                      <Td numeric>
                        {event.idleMs !== undefined
                          ? formatDurationMs(event.idleMs)
                          : event.unseenMs !== undefined
                            ? formatDurationMs(event.unseenMs)
                            : '—'}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="text-[color:var(--text-muted)]">
                {appCopy.diagnostics.diagnosticsContent.nothingReapedYetThisSession}
              </p>
            )}
          </section>
        </TabPanel>

        {/* Workspaces — per-workspace resident memory + terminal rollup */}
        <TabPanel
          idPrefix={tabsIdPrefix}
          tabId="workspaces"
          active={activeTab === 'workspaces'}
          className="flex flex-col gap-4"
        >
          <section>
            <h2 className="mb-1 text-micro font-semibold text-[color:var(--text-muted)]">
              {appCopy.diagnostics.diagnosticsContent.workspaces2}
              {workspacesByMemory.length})
            </h2>

            {workspacesByMemory.length > 0 ? (
              <Table>
                <thead>
                  <tr>
                    <Th>{appCopy.diagnostics.diagnosticsContent.workspace}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.memory}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.live}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.active}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.idle}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.hiddenVis}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.retained}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.liveFor}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.lastOutput}</Th>
                  </tr>
                </thead>
                <tbody>
                  {workspacesByMemory.map((workspace) => {
                    const mem = workspaceMemoryById.get(workspace.workspaceId)
                    return (
                      <tr key={workspace.workspaceId} className="border-b border-[color:var(--border-subtle)]">
                        <Td title={workspace.workspaceId}>
                          {mem?.resident ? <span aria-hidden="true">● </span> : null}
                          {workspace.workspaceName ?? workspace.workspaceId}
                        </Td>
                        <Td numeric>{mem ? formatBytes(mem.totalMemoryBytes) : '—'}</Td>
                        <Td numeric>{workspace.liveTerminalCount}</Td>
                        <Td numeric>{workspace.activeCount}</Td>
                        <Td numeric>{workspace.idleCount}</Td>
                        <Td numeric>
                          {workspace.hiddenButVisibleCount > 0 ? (
                            <WarnMetric
                              flagged
                              label={appCopy.diagnostics.diagnosticsContent.terminalsVisibleWhileTheWorkspace}
                            >
                              {workspace.hiddenButVisibleCount}
                            </WarnMetric>
                          ) : (
                            0
                          )}
                        </Td>
                        <Td numeric>{formatBytes(workspace.totalRetainedReplayBytes)}</Td>
                        <Td numeric>{mem?.becameLiveAt ? formatRelativeMsAgo(mem.becameLiveAt, now) || '—' : '—'}</Td>
                        <Td numeric>{formatRelativeMsAgo(workspace.lastOutputAt, now) || '—'}</Td>
                      </tr>
                    )
                  })}
                </tbody>
              </Table>
            ) : (
              <p className="text-[color:var(--text-muted)]">
                {appCopy.diagnostics.diagnosticsContent.noWorkspaceTerminals}
              </p>
            )}
          </section>
        </TabPanel>

        {/* Subsystems */}
        <TabPanel
          idPrefix={tabsIdPrefix}
          tabId="subsystems"
          active={activeTab === 'subsystems'}
          className="flex flex-col gap-4"
        >
          {/* Terminal scrollback + write throughput */}
          <section>
            <h2 className="mb-1 text-micro font-semibold text-[color:var(--text-muted)]">
              {appCopy.diagnostics.diagnosticsContent.terminalSubsystem}
            </h2>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-micro tabular-nums text-[color:var(--text-default)]">
              <span>
                {appCopy.diagnostics.diagnosticsContent.scrollback}
                <strong>{scrollback.instanceCount}</strong>
                {appCopy.diagnostics.diagnosticsContent.instances} {scrollback.totalLines.toLocaleString()}
                {appCopy.diagnostics.diagnosticsContent.lines}
                {formatBytes(scrollback.estimatedBytes)} est.
              </span>
              <span>
                {appCopy.diagnostics.diagnosticsContent.writeTotal}
                {formatBytes(terminalThroughput.totalBytesPerSec)}/s
              </span>
              <WarnMetric
                flagged={terminalThroughput.hiddenBytesPerSec > 0}
                label={appCopy.diagnostics.diagnosticsContent.hiddenTerminalsAreWriting}
              >
                hidden {formatBytes(terminalThroughput.hiddenBytesPerSec)}/s
              </WarnMetric>
              <span>visible {formatBytes(terminalThroughput.visibleBytesPerSec)}/s</span>
            </div>
          </section>

          {/* IPC throughput */}
          <section>
            <h2 className="mb-1 text-micro font-semibold text-[color:var(--text-muted)]">
              {appCopy.diagnostics.diagnosticsContent.iPCThroughput}
              {ipcThroughput ? `(${ipcThroughput.channels.length} channels)` : ''}
            </h2>
            {ipcThroughput && ipcThroughput.channels.length > 0 ? (
              <Table>
                <thead>
                  <tr>
                    <Th>{appCopy.diagnostics.diagnosticsContent.channel}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.callsS}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.outS}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.eventsS}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.inS}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.totalCalls}</Th>
                  </tr>
                </thead>
                <tbody>
                  {ipcThroughput.channels.slice(0, 12).map((channel) => (
                    <tr key={channel.name} className="border-b border-[color:var(--border-subtle)]">
                      <Td title={channel.name}>{channel.name}</Td>
                      <Td numeric>{channel.callsPerSec}</Td>
                      <Td numeric>{formatBytes(channel.outBytesPerSec)}</Td>
                      <Td numeric>{channel.inEventsPerSec}</Td>
                      <Td numeric>{formatBytes(channel.inBytesPerSec)}</Td>
                      <Td numeric>{channel.totalCalls}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="text-[color:var(--text-muted)]">
                {appCopy.diagnostics.diagnosticsContent.iPCAccountingNeedsDiagnosticsOn}
              </p>
            )}
          </section>

          {/* Replay profiles */}
          <section>
            <h2 className="mb-1 text-micro font-semibold text-[color:var(--text-muted)]">
              {appCopy.diagnostics.diagnosticsContent.recentReplayProfiles}
              {profiles.length})
            </h2>
            {profiles.length > 0 ? (
              <Table>
                <thead>
                  <tr>
                    <Th>{appCopy.diagnostics.diagnosticsContent.when}</Th>
                    <Th>{appCopy.diagnostics.diagnosticsContent.session}</Th>
                    <Th>{appCopy.diagnostics.diagnosticsContent.kind}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.payload}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.writes}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.totalMs}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.maxWriteMs}</Th>
                    <Th numeric>{appCopy.diagnostics.diagnosticsContent.liveBuffered}</Th>
                  </tr>
                </thead>
                <tbody>
                  {profiles.map((profile, index) => (
                    <tr
                      key={`${profile.sessionId}-${profile.recordedAt}-${index}`}
                      className="border-b border-[color:var(--border-subtle)]"
                    >
                      <Td numeric>{formatRelativeMsAgo(profile.recordedAt, now) || 'now'}</Td>
                      <Td title={profile.sessionId}>{profile.agentId ?? profile.terminalId ?? profile.sessionId}</Td>
                      <Td>{profile.kind}</Td>
                      <Td numeric>{formatBytes(profile.payloadBytes)}</Td>
                      <Td numeric>{profile.writeCount}</Td>
                      <Td numeric>{profile.totalReplayMs}</Td>
                      <Td numeric>{profile.maxWriteMs}</Td>
                      <Td numeric>{profile.liveBufferedCount}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="text-[color:var(--text-muted)]">
                {appCopy.diagnostics.diagnosticsContent.noReplayProfilesHereThey}
              </p>
            )}
          </section>
        </TabPanel>
      </div>
    </div>
  )
}
