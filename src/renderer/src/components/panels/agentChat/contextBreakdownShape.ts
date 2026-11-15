import type {
  ConversationContextBreakdown,
  ConversationContextCategory,
  ConversationContextItem,
} from '../../../../../shared/conversation-runtime'
import { formatTokenCount } from '../../../utils/tokenFormat'

// The breakdown's picture, worked out apart from its drawing so it can be
// tested: the bar's segments and their colours, the thin rows folded into one,
// and which category each list of items belongs under.

/** The bar's segments, in the agent's own order, each a share of the window. */
export type ContextSegment = {
  name: string
  tokens: number
  kind: 'used' | 'free' | 'buffer'
  /** 0–1 of the bar. */
  share: number
  /** The `--chart-*` slot a `used` row is drawn in; null for free space and the buffer, which are not content. */
  slot: number | 'other' | null
  /**
   * The rows folded into this one, heaviest first: each under 1% of the
   * window. Ten categories of which seven are slivers made a legend of ten
   * coloured rows and a bar of ten hairlines; the slivers are one segment
   * and one row, which opens to them.
   */
  members?: ContextSegment[]
}

// Slots run in the order the drawn rows do: the first content row takes
// `--chart-1`, the next `--chart-2`, and so on. The palette's colour-vision
// safety is between neighbouring slots, and the bar sets rows side by side in
// the agent's own order, so the only pairs that ever touch are pairs the
// palette was checked for. A fixed slot per row name would break that the
// moment a row between two others is empty (no custom agents puts MCP tools
// beside skills, a pair that reads alike under deuteranopia). A chat's rows
// rarely come and go, so in practice a row keeps its colour; where one does
// arrive, the legend beside every swatch still names it. The folded row is
// the neutral `--chart-other`: it is not one thing.
const SLOT_COUNT = 8

/** Under this share of the window a content row is a sliver, folded in with the others. */
const CONTEXT_SMALL_SHARE = 0.01

export function contextSegments(breakdown: ConversationContextBreakdown): ContextSegment[] {
  const rows = breakdown.categories.filter(
    (row): row is ConversationContextCategory & { kind: ContextSegment['kind'] } => row.kind !== 'deferred',
  )
  // Shares of the window, or of the rows' own sum where that is larger (a
  // window read over its limit), so the bar never runs past its end.
  const whole = Math.max(
    breakdown.windowTokens,
    rows.reduce((sum, row) => sum + row.tokens, 0),
  )
  if (whole <= 0) return []
  const small = (row: (typeof rows)[number]) => row.kind === 'used' && row.tokens / whole < CONTEXT_SMALL_SHARE
  // One sliver alone stays itself: a row that opens to one row says nothing.
  const fold = rows.filter(small).length >= 2
  const out: ContextSegment[] = []
  let folded: (ContextSegment & { members: ContextSegment[] }) | null = null
  for (const row of rows) {
    const segment: ContextSegment = {
      name: row.name,
      tokens: row.tokens,
      kind: row.kind,
      share: row.tokens / whole,
      slot: null,
    }
    if (fold && small(row)) {
      // Drawn where the first of them was, so the bar keeps the agent's order.
      if (!folded) {
        folded = { name: '', tokens: 0, kind: 'used', share: 0, slot: 'other', members: [] }
        out.push(folded)
      }
      folded.members.push(segment)
      folded.tokens += segment.tokens
      folded.share += segment.share
    } else out.push(segment)
  }
  if (folded) {
    folded.members.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
    folded.name = `${folded.members.length} more under 1%`
  }
  let next = 1
  for (const segment of out)
    if (segment.kind === 'used' && !segment.members) segment.slot = next <= SLOT_COUNT ? next++ : 'other'
  return out
}

/** The lists of items the breakdown carries, by what they are. */
export type ContextGroup = 'mcp' | 'skills' | 'memory' | 'agents'

/**
 * The list a category row opens to: its MCP servers, skills, memory files or
 * custom agents. By the row's name, which is all the agent gives to tie the
 * two together; a name this does not know leaves the row closed and its list
 * drawn after the rows instead, so a renamed category costs placement, never
 * the list.
 */
export function categoryGroup(name: string): ContextGroup | null {
  const key = name.trim().toLowerCase()
  if (key === 'mcp tools') return 'mcp'
  if (key === 'skills') return 'skills'
  if (key === 'memory files') return 'memory'
  if (key === 'custom agents') return 'agents'
  return null
}

/** The rows the window lists but does not hold: tool schemas loaded only when used. */
export function deferredRows(breakdown: ConversationContextBreakdown): ConversationContextCategory[] {
  return breakdown.categories.filter((row) => row.kind === 'deferred')
}

/**
 * The deferred rows as one line: "MCP tools 110k · System tools 26.7k". The
 * agent names each "… (deferred)", which the line's own words already say.
 */
export function deferredLabel(rows: ReadonlyArray<Pick<ConversationContextCategory, 'name' | 'tokens'>>): string {
  return rows
    .map((row) => `${row.name.replace(/\s*\(deferred\)\s*$/iu, '')} ${formatTokenCount(row.tokens)}`)
    .join(' · ')
}

/** "4%", "38%" for a share of the window worth a number; null under 1%, where the tokens say enough. */
export function contextPercentLabel(tokens: number, windowTokens: number): string | null {
  if (windowTokens <= 0 || tokens <= 0) return null
  const percent = (tokens / windowTokens) * 100
  return percent < 1 ? null : `${Math.round(percent)}%`
}

/** "4%", "<1%", "38%": a share of the window, whole percent. */
export function contextShareLabel(tokens: number, windowTokens: number): string {
  if (windowTokens <= 0 || tokens <= 0) return '0%'
  const percent = (tokens / windowTokens) * 100
  return percent < 1 ? '<1%' : `${Math.round(percent)}%`
}

/** A memory file's path cut to what tells two apart: its last two parts. */
export function memoryFileLabel(path: string): string {
  const parts = path.split(/[\\/]/u).filter(Boolean)
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`
}

/** A group's total, from its items. */
export function groupTokens(items: ReadonlyArray<Pick<ConversationContextItem, 'tokens'>>): number {
  return items.reduce((sum, item) => sum + item.tokens, 0)
}
