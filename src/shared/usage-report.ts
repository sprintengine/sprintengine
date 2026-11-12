import { cliForConversationProvider } from './conversation-harness'

// The usage dashboard's contract: what a window asks its Studio for (`usage.report`)
// and the answer, already priced. Main reads every agent's session logs on
// this machine (src/main/usage) and folds them, with what each machine paired
// over the tailnet answered for its own (usage-mesh.ts); the window draws, and
// buckets the hourly series into its own local days, so a day is the reader's day.

export { LOCAL_USAGE_MACHINE_ID } from '../../packages/studio-protocol/src/public'
export type {
  UsageAgentId,
  UsageMachineStatus,
  UsagePeerMode,
  UsagePricingSource,
  UsageReport,
  UsageReportAgent,
  UsageReportMachine,
  UsageReportModel,
  UsageReportPoint,
  UsageReportRequest,
  UsageReportResult,
  UsageReportSource,
  UsageReportTokens,
} from '../../packages/studio-protocol/src/public'
import type { UsageAgentId, UsageReportTokens } from '../../packages/studio-protocol/src/public'

/** Every token the window processed: fresh input, cache reads and writes, and output. */
export function usageTokenTotal(tokens: UsageReportTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
}

/**
 * The agent a usage row's provider id stands for. A chat's provider
 * (`claude-agent`) and the CLI's own logs read as the same agent, so a
 * person's Claude Code is one line whether it ran in a chat or a terminal.
 */
export function usageAgentOf(providerId: string): UsageAgentId {
  return cliForConversationProvider(providerId) ?? (providerId || 'other')
}

const AGENT_LABELS: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  grok: 'Grok',
  gemini: 'Gemini',
  other: 'Other',
}

export function usageAgentLabel(agent: UsageAgentId): string {
  return AGENT_LABELS[agent] ?? agent
}

/**
 * The chart slot an agent's series takes (1..8), fixed by agent so a filter
 * never repaints the others; an agent past the table folds into the neutral
 * "other" colour. Claude Code takes the rust slot and OpenCode the teal, the
 * nearest the palette has to their own marks.
 */
const AGENT_CHART_SLOTS: Readonly<Record<string, number>> = {
  codex: 1,
  'claude-code': 2,
  opencode: 3,
  cursor: 4,
  grok: 5,
  gemini: 7,
}

export function usageAgentChartSlot(agent: UsageAgentId): number | null {
  return AGENT_CHART_SLOTS[agent] ?? null
}

// ── Formatting ───────────────────────────────────────────────────────────────

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
const USD_WHOLE = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

/** "$3,691.59"; "<$0.01" for a cost too small to show as cents. */
export function formatUsageUsd(value: number): string {
  if (value > 0 && value < 0.005) return '<$0.01'
  return USD.format(value)
}

/** An axis tick: "$1,200", and cents only below ten dollars ("$2.50"). */
export function formatUsageUsdAxis(value: number): string {
  if (value === 0) return '$0'
  return value >= 10 ? USD_WHOLE.format(value) : USD.format(value)
}

/** "11.9B", "584M", "68.8K", "436": three significant figures at most. */
export function formatUsageTokens(value: number): string {
  const abs = Math.abs(value)
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (const [size, unit] of units) {
    // A value that rounds to a thousand of the unit below takes this one, so
    // 999,999 reads "1M" rather than "1000K".
    if (abs >= size * 0.9995) {
      const scaled = value / size
      const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2
      return `${Number(scaled.toFixed(digits))}${unit}`
    }
  }
  return String(Math.round(value))
}

/** "65.9%", "<0.1%", "100%". */
export function formatUsageShare(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return '0%'
  const share = (part / whole) * 100
  if (share < 0.1) return '<0.1%'
  return `${Number(share.toFixed(1))}%`
}
