// The words on one CLI's model list in Settings ▸ Agents: where the list came
// from, and what went wrong when a Refresh could not read it. Pure: the panel
// hands in the stored catalog, the last outcome and the clock, this hands back
// the sentences and the test holds the table. Plain words only; the probe's
// source names never reach the screen.
import type { DiscoveredCliModelCatalog } from '../../../../shared/cli-model-catalog'
import type { CliModelDiscoverySkipReason } from '../../../../shared/ipc/cli-model-discovery'
import { formatRelativeMsAgo } from '../../utils/relativeTime'

/** What the last Refresh of one CLI found, when it did not bring back a list. */
export type CliModelRefreshOutcome = {
  error?: string
  skipped?: CliModelDiscoverySkipReason
  /** When the Refresh finished, so a list that arrives later clears it. */
  at: number
}

export function modelDiscoveryLine(input: {
  /** The CLI's display name, "Claude Code". */
  name: string
  catalog: DiscoveredCliModelCatalog | null | undefined
  refreshing?: boolean
  now: number
}): string {
  if (input.refreshing) return `Asking ${input.name} for its models…`
  const catalog = input.catalog
  // An empty answer is shown as the manifest seed (mergeCliModelCatalog), so it
  // reads as the built-in list here too.
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) {
    return `Built-in list. ${input.name} has not reported its own.`
  }
  const version = bareVersion(catalog.cliVersion, input.name)
  const from = version ? `${input.name} ${version}` : input.name
  const when = formatRelativeMsAgo(Date.parse(catalog.fetchedAt), input.now)
  return when ? `From ${from}, checked ${when}` : `From ${from}`
}

// A CLI's `--version` line often names the CLI again ("2.1.296 (Claude Code)"),
// and beside its own name that reads as a stutter.
function bareVersion(version: string | undefined, name: string): string {
  const trimmed = version?.trim() ?? ''
  const suffix = ` (${name})`
  return trimmed.endsWith(suffix) ? trimmed.slice(0, -suffix.length).trim() : trimmed
}

export type CliModelRefreshProblem = { title: string; hint: string; detail?: string }

/**
 * The notice over the list after a Refresh that brought nothing back. Null when
 * there is nothing to say, including when a list has arrived since.
 */
export function modelRefreshProblem(input: {
  name: string
  outcome: CliModelRefreshOutcome | null
  catalog: DiscoveredCliModelCatalog | null | undefined
  /** Whether the list still has rows on it, which decides what the failure cost. */
  hasRows: boolean
}): CliModelRefreshProblem | null {
  const { name, outcome, catalog, hasRows } = input
  if (!outcome) return null
  // The skip that means nothing went wrong: the list was fresh.
  if (outcome.skipped === 'fresh') return null
  if (!outcome.error && !outcome.skipped) return null
  const fetchedAt = catalog ? Date.parse(catalog.fetchedAt) : Number.NaN
  if (Number.isFinite(fetchedAt) && fetchedAt >= outcome.at) return null
  const typeIt = hasRows
    ? 'The list below stays as it was. To use another model, type its id.'
    : 'Type a model id below to add one.'
  if (outcome.skipped === 'not-installed') {
    return { title: `${name} is not installed on this machine.`, hint: typeIt }
  }
  if (outcome.skipped === 'no-probe') {
    return { title: `${name} has no way to report its models.`, hint: typeIt }
  }
  return { title: `${name} did not list its models.`, hint: typeIt, detail: cleanDetail(outcome.error, name) }
}

// The reason arrives in the probe's words, which restate what the title says.
// A managed install's own message is the useful part; keep that.
function cleanDetail(error: string | undefined, name: string): string | undefined {
  const text = error?.trim()
  if (!text) return undefined
  const lead = `${name} did not list its models: `
  const stripped = text.startsWith(lead) ? text.slice(lead.length) : text
  if (stripped === `${name} listed no models.`) return undefined
  // "process exited with code 1. stderr: <what it said>": what it said is the reason.
  return stripped.replace(/^.*?\bstderr:\s*/s, '').replace(/\s+/g, ' ')
}
