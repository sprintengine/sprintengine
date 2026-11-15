import React, { useCallback, useEffect, useId, useRef, useState, type JSX } from 'react'

import type {
  ConversationContextBreakdown,
  ConversationContextBreakdownResult,
} from '../../../../../shared/conversation-runtime'
import { formatTokenCount } from '../../../utils/tokenFormat'
import { formatTimeOfDay } from '../../../utils/clockFormat'
import {
  CONTEXT_RING_WARN_PERCENTAGE,
  ContextRing,
  contextRingLabel,
  contextRingTokensLabel,
  GhostButton,
  IconButton,
  Popover,
  RefreshIcon,
  Tooltip,
} from '../../ui'
import { Meter } from '../../ui/Meter'
import { ChevronRightGlyph } from './toolRows/ToolKindGlyph'
import {
  categoryGroup,
  contextPercentLabel,
  contextSegments,
  contextShareLabel,
  deferredLabel,
  deferredRows,
  groupTokens,
  memoryFileLabel,
  type ContextGroup,
  type ContextSegment,
} from './contextBreakdownShape'
import { ConversationFileLink } from './conversationLinks'

// What fills the context window, opened from the composer strip's ring. The
// ring says how full; this says with what — the system prompt, the tools, the
// MCP servers and skills a person chose to load, the memory files, the
// conversation itself. One list under the bar, numbers in columns: what is big
// reads first, the slivers wait behind one row, and each category opens to
// the items in it, heaviest first, a memory file opening in the editor.
//
// The rows are the agent's own reading (Claude Code's `/context`), asked for
// when the panel opens and again when a turn ends while it is open, never on
// a timer: nothing moves the window between turns. An agent that gives no
// reading — Codex reports a total and nothing under it — gets the total
// alone, said as such, rather than a breakdown guessed for it.

export type ContextBreakdownSource = {
  /** Ask the chat's agent; null where it gives no breakdown, and the panel then shows the total alone. */
  load: (() => Promise<ConversationContextBreakdownResult>) | null
  /** The agent's name, for the total-only note. */
  agentName: string
  /** Why there is no breakdown, where it is not the agent's doing (a window that cannot ask); said instead of the agent's. */
  unavailable?: string
  /** What the last reading is kept under between opens: the chat's session. */
  cacheKey: string | null
  /** Changes as a turn ends; an open panel reads again then. */
  refreshKey: string | number
}

// The last reading of each chat, so the panel opens on it rather than on
// nothing while the new one comes. In memory only: a reading is about a
// child process, and a restarted app has none.
const lastReadings = new Map<string, ConversationContextBreakdownResult>()
const LAST_READINGS_KEPT = 24

function remember(key: string, result: ConversationContextBreakdownResult): void {
  lastReadings.delete(key)
  lastReadings.set(key, result)
  while (lastReadings.size > LAST_READINGS_KEPT) lastReadings.delete(lastReadings.keys().next().value!)
}

/** Forget every kept reading; for tests. */
export function resetContextBreakdownCache(): void {
  lastReadings.clear()
}

type Reading = { result: ConversationContextBreakdownResult | null; loading: boolean }

/** Reads the breakdown while `open`: on opening, and again each time `refreshKey` moves. */
export function useContextBreakdown(
  source: ContextBreakdownSource | null,
  open: boolean,
): Reading & { refresh: () => void } {
  const key = source?.cacheKey ?? null
  // Tagged with the chat it is of, so a reading never outlives a change of
  // chat under the panel, nor is kept as the next one's.
  const [reading, setReading] = useState<Reading & { of: string | null }>(() => ({
    result: key ? (lastReadings.get(key) ?? null) : null,
    loading: false,
    of: key,
  }))
  const loadRef = useRef(source?.load ?? null)
  loadRef.current = source?.load ?? null
  // Each read is numbered, so an answer that arrives after a newer read was
  // started, or after the chat changed under the panel, is dropped.
  const generation = useRef(0)
  const refresh = useCallback(() => {
    const load = loadRef.current
    if (!load) return
    const mine = ++generation.current
    setReading((current) => ({ ...current, loading: true }))
    load()
      .catch((error: unknown): ConversationContextBreakdownResult => ({
        ok: false,
        reason: 'failed',
        message: error instanceof Error ? error.message : 'The breakdown could not be read.',
      }))
      .then((result) => {
        if (generation.current !== mine) return
        // A failed read keeps a breakdown already drawn, marked old, rather
        // than trading it for an error about a moment.
        setReading((current) => ({
          result: !result.ok && current.result?.ok ? { ...current.result, stale: true as const } : result,
          loading: false,
          of: current.of,
        }))
      })
  }, [])
  useEffect(() => {
    generation.current += 1
    setReading((current) =>
      current.of === key ? current : { result: key ? (lastReadings.get(key) ?? null) : null, loading: false, of: key },
    )
  }, [key])
  const { result: kept, of } = reading
  useEffect(() => {
    if (of && kept) remember(of, kept)
  }, [of, kept])
  const hasLoad = source?.load != null
  const refreshKey = source?.refreshKey
  useEffect(() => {
    if (open && hasLoad) refresh()
  }, [open, hasLoad, refreshKey, refresh])
  const current = reading.of === key ? reading : { result: null, loading: false }
  return { result: current.result, loading: current.loading, refresh }
}

// Static class names, one per slot: Tailwind emits a rule only for a
// candidate it can read as text.
const SLOT_FILL: Record<number | 'other', string> = {
  1: 'bg-[color:var(--chart-1)]',
  2: 'bg-[color:var(--chart-2)]',
  3: 'bg-[color:var(--chart-3)]',
  4: 'bg-[color:var(--chart-4)]',
  5: 'bg-[color:var(--chart-5)]',
  6: 'bg-[color:var(--chart-6)]',
  7: 'bg-[color:var(--chart-7)]',
  8: 'bg-[color:var(--chart-8)]',
  other: 'bg-[color:var(--chart-other)]',
}

// Free space is the track the bar is drawn on, as a meter's is; the buffer
// is held back rather than filled, so it takes the track's own edge colour,
// a neutral one step darker — not a series colour, because it is not content.
function segmentFill(segment: ContextSegment): string {
  if (segment.kind === 'free') return 'bg-[color:var(--bg-active)] shadow-[inset_0_0_0_1px_var(--border-default)]'
  if (segment.kind === 'buffer') return 'bg-[color:var(--border-strong)]'
  return SLOT_FILL[segment.slot ?? 'other']
}

// A key the shape of the bar's own segments, a short upright block, rather
// than a disc: the app draws no status dots, and a coloured bullet beside a
// name reads as one.
function Swatch({ segment }: { segment: ContextSegment }): JSX.Element {
  return <span aria-hidden="true" className={`h-2.5 w-1 shrink-0 ${segmentFill(segment)}`} />
}

function ContextBar({
  segments,
  label,
  total,
}: {
  segments: ContextSegment[]
  label: string
  total: number
}): JSX.Element {
  return (
    // The whole bar is one picture with one name; the rows under it are its
    // table, and say every number the segments draw.
    // A grid rather than a flex row because each segment's tooltip wraps it
    // in a span of its own, and that span is what has to take the share. A
    // row too small to see keeps a sliver, so the swatch beside its name
    // always has a mark in the bar to match.
    <div
      role="img"
      aria-label={label}
      style={{ gridTemplateColumns: segments.map((segment) => `minmax(2px, ${segment.share}fr)`).join(' ') }}
      className="grid h-2.5 w-full gap-0.5 overflow-hidden rounded-xs"
    >
      {segments.map((segment, index) => (
        <Tooltip
          key={`${segment.name}-${index}`}
          content={`${segment.name} · ${formatTokenCount(segment.tokens)} · ${contextShareLabel(segment.tokens, total)}`}
          placement="top"
          openDelayMs={0}
          wrapperClassName="flex min-w-0"
          wrapperRole="presentation"
        >
          <span
            aria-hidden="true"
            data-context-segment={segment.kind}
            className={`block h-full w-full ${segmentFill(segment)}`}
          />
        </Tooltip>
      ))}
    </div>
  )
}

// Every row is one grid of the same four columns — key, name, tokens, share —
// so the numbers line up down the list whichever row they are on, and a row
// that opens is the same height as one that does not.
const ROW_CLASS = 'flex h-control-xs w-full min-w-0 items-center gap-2 px-2 text-meta'
const TOKENS_CLASS = 'w-12 shrink-0 text-right tabular-nums'
const SHARE_CLASS = 'w-9 shrink-0 text-right tabular-nums text-[color:var(--text-subtle)]'

// design-tokens-allow: structure, not rhythm — a row inside another starts just past its parent's name (the row's 8px inset, the 4px key and its 8px gap put that name at 20px; `pl-6` is 24px), and one level further in is one more step (`pl-10`).
const INDENT_CLASS = ['', 'pl-6', 'pl-10'] as const

type RowProps = {
  /** The swatch at the top level; nothing below it, where the row is part of one above. */
  segment?: ContextSegment
  name: React.ReactNode
  detail?: string
  tokens: number
  /** The top level says each row's share of the window; a row inside one says only its tokens. */
  share?: string | null
  level: 0 | 1 | 2
  /** Listed but not in the window (an MCP tool loaded only when used). */
  outside?: boolean
  children?: React.ReactNode
  data?: Record<string, string>
}

function LegendRow({ segment, name, detail, tokens, share, level, outside = false, children, data }: RowProps) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  // Under 1% is there to be found, not to be read first: the name steps down
  // a tone with its number.
  const quiet = outside || level > 0 || (segment !== undefined && share === null)
  const inner = (
    <>
      {segment ? <Swatch segment={segment} /> : null}
      <span
        className={`min-w-0 truncate ${quiet ? 'text-[color:var(--text-muted)]' : 'text-[color:var(--text-default)]'}`}
      >
        {name}
      </span>
      {detail ? (
        <span className="min-w-0 shrink truncate text-micro text-[color:var(--text-subtle)]">{detail}</span>
      ) : null}
      {children ? (
        <ChevronRightGlyph className={`icon-xs shrink-0 text-[color:var(--text-subtle)] ${open ? 'rotate-90' : ''}`} />
      ) : null}
      <span className="min-w-2 flex-1" />
      <span className={`${TOKENS_CLASS} text-[color:var(--text-subtle)]`}>
        {outside ? 'not loaded' : formatTokenCount(tokens)}
      </span>
      {/* Empty below the top level, and still there, so the tokens stay in their column. */}
      <span className={SHARE_CLASS}>{level === 0 ? (share ?? '') : ''}</span>
    </>
  )
  return (
    <li className="flex flex-col" {...data}>
      {children ? (
        <GhostButton
          size="xs"
          tone="subtle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((was) => !was)}
          className={`${ROW_CLASS} justify-start ${INDENT_CLASS[level]}`}
        >
          {inner}
        </GhostButton>
      ) : (
        <div className={`${ROW_CLASS} ${INDENT_CLASS[level]}`}>{inner}</div>
      )}
      {children && open ? (
        <ul id={bodyId} className="flex flex-col">
          {children}
        </ul>
      ) : null}
    </li>
  )
}

/**
 * A memory file's name, opening the file where the chat's other file links
 * do: the transcript's link, in Studio's own editor. Where that link is text
 * (a chat whose disk this window does not reach), so is this, with the whole
 * path one hover away.
 */
export function ContextMemoryFile({ path }: { path: string }): JSX.Element {
  return (
    <span title={path} className="min-w-0 truncate">
      <ConversationFileLink token={path} label={memoryFileLabel(path)} ink="quiet" />
    </span>
  )
}

/** The rows a category opens to: its servers, skills, memory files or agents. */
function groupRows(group: ContextGroup, breakdown: ConversationContextBreakdown, level: 1 | 2): React.ReactNode {
  if (group === 'mcp') {
    if (breakdown.mcpServers.length === 0) return null
    return breakdown.mcpServers.map((server) => {
      const loaded = server.tools.filter((tool) => tool.loaded).length
      // Which of its tools are in the window: a deferred one is listed but
      // not loaded until the agent reaches for it.
      const detail =
        loaded < server.tools.length
          ? `${loaded} of ${server.tools.length} loaded`
          : `${loaded} ${loaded === 1 ? 'tool' : 'tools'}`
      return (
        <LegendRow
          key={server.name}
          name={server.name}
          detail={detail}
          tokens={server.tokens}
          level={level}
          data={{ 'data-context-mcp-server': server.name }}
        >
          {level < 2
            ? server.tools.map((tool) => (
                <LegendRow key={tool.name} name={tool.name} tokens={tool.tokens} outside={!tool.loaded} level={2} />
              ))
            : null}
        </LegendRow>
      )
    })
  }
  const items = group === 'skills' ? breakdown.skills : group === 'memory' ? breakdown.memoryFiles : breakdown.agents
  if (items.length === 0) return null
  return items.map((item) => (
    <LegendRow
      key={item.name}
      name={group === 'memory' ? <ContextMemoryFile path={item.name} /> : item.name}
      {...(item.detail ? { detail: item.detail } : {})}
      tokens={item.tokens}
      level={level}
      data={{ 'data-context-item': group }}
    />
  ))
}

const GROUP_TITLES: Record<ContextGroup, string> = {
  mcp: 'MCP servers',
  skills: 'Skills',
  memory: 'Memory files',
  agents: 'Custom agents',
}

/**
 * The breakdown itself: the bar, and under it one list that is the bar's key
 * and its detail at once — a row per segment, the slivers folded into one, and
 * each category opening to the servers, skills, files or agents it holds.
 */
export function ContextBreakdownView({ breakdown }: { breakdown: ConversationContextBreakdown }): JSX.Element {
  const segments = contextSegments(breakdown)
  const deferred = deferredRows(breakdown)
  const window = breakdown.windowTokens
  const barLabel = segments.map((segment) => `${segment.name} ${contextShareLabel(segment.tokens, window)}`).join(', ')
  const placed = new Set<ContextGroup>()
  const categoryRow = (segment: ContextSegment, level: 0 | 1, index: number): JSX.Element => {
    const group = segment.kind === 'used' ? categoryGroup(segment.name) : null
    const opens = group ? groupRows(group, breakdown, (level + 1) as 1 | 2) : null
    if (group && opens) placed.add(group)
    return (
      <LegendRow
        key={`${segment.name}-${index}`}
        segment={level === 0 ? segment : undefined}
        name={segment.name}
        tokens={segment.tokens}
        share={level === 0 ? contextPercentLabel(segment.tokens, window) : undefined}
        level={level}
        data={{ 'data-context-category': segment.members ? 'folded' : segment.kind }}
      >
        {segment.members ? segment.members.map((member, at) => categoryRow(member, 1, at)) : opens}
      </LegendRow>
    )
  }
  const rows = segments.map((segment, index) => categoryRow(segment, 0, index))
  // A list whose category the agent named in words this does not know is
  // still drawn, after the rows, rather than lost.
  const unplaced = (['mcp', 'skills', 'memory', 'agents'] as const).filter((group) => !placed.has(group))
  return (
    <div className="flex flex-col gap-3">
      <ContextBar segments={segments} label={`What fills the window: ${barLabel}`} total={window} />
      <ul className="-mx-1 flex flex-col" aria-label="By category">
        {rows}
        {unplaced.map((group) => {
          const opens = groupRows(group, breakdown, 1)
          if (!opens) return null
          const tokens =
            group === 'mcp'
              ? breakdown.mcpServers.reduce((sum, server) => sum + server.tokens, 0)
              : groupTokens(
                  group === 'skills' ? breakdown.skills : group === 'memory' ? breakdown.memoryFiles : breakdown.agents,
                )
          return (
            <LegendRow
              key={group}
              name={GROUP_TITLES[group]}
              tokens={tokens}
              share={contextPercentLabel(tokens, window)}
              level={0}
              data={{ 'data-context-group': group }}
            >
              {opens}
            </LegendRow>
          )
        })}
      </ul>
      {deferred.length > 0 ? (
        <p className="px-1 text-micro text-[color:var(--text-subtle)]" data-context-deferred="">
          Loaded only when used: {deferredLabel(deferred)}
        </p>
      ) : null}
    </div>
  )
}

/** "Claude Code's estimate · 3:12 PM", and that it is the last reading where the agent is not running now. */
export function contextReadingNote(breakdown: ConversationContextBreakdown, stale: boolean, agentName: string): string {
  const source = breakdown.estimated ? `${agentName}’s estimate` : `Counted by ${agentName}`
  const at = formatTimeOfDay(new Date(breakdown.measuredAt))
  return stale ? `${source} · last read at ${at}` : `${source} · ${at}`
}

/** The panel the ring opens: the window's totals, and the breakdown where the agent gives one. */
export function ContextBreakdownPanel({
  context,
  source,
  reading,
  onRefresh,
}: {
  context: { used: number; total: number }
  source: ContextBreakdownSource | null
  reading: Reading
  onRefresh: () => void
}): JSX.Element {
  const headingId = useId()
  const result = reading.result
  const breakdown = result?.ok ? result.breakdown : null
  // The breakdown's own totals where it has them, so the header and the bar
  // under it add up; the ring's turn reading otherwise.
  const used = breakdown?.usedTokens ?? context.used
  const total = breakdown?.windowTokens ?? context.total
  const percent = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
  const agentName = source?.agentName ?? 'This agent'
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3" data-context-breakdown="">
      <div className="flex items-center gap-3">
        <h3 id={headingId} className="text-meta font-medium text-[color:var(--text-strong)]">
          Context window
        </h3>
        <span className="ml-auto shrink-0 tabular-nums text-meta text-[color:var(--text-subtle)]">
          <span className="font-medium text-[color:var(--text-strong)]">{percent}%</span> · {formatTokenCount(used)} of{' '}
          {formatTokenCount(total)}
        </span>
        {/* Always here while there is an agent to ask, busy while it
            answers: the one control the dialog is sure to hold, so focus
            has somewhere to land as it opens. */}
        {source?.load ? (
          <Tooltip content="Read again" placement="top">
            <IconButton size="xs" tone="subtle" aria-label="Read again" busy={reading.loading} onClick={onRefresh}>
              <RefreshIcon className="icon-xs" />
            </IconButton>
          </Tooltip>
        ) : null}
      </div>
      {breakdown ? (
        <ContextBreakdownView breakdown={breakdown} />
      ) : (
        <>
          <Meter
            value={percent}
            warn={percent >= CONTEXT_RING_WARN_PERCENTAGE}
            ariaLabelledBy={headingId}
            ariaValueText={`${percent}% used`}
          />
          <p className="text-meta text-[color:var(--text-subtle)]" data-context-breakdown-note="">
            {!source?.load
              ? (source?.unavailable ?? `${agentName} reports how full the window is, not what fills it.`)
              : reading.loading && !result
                ? 'Reading what fills the window…'
                : result && !result.ok
                  ? result.message
                  : null}
          </p>
        </>
      )}
      {breakdown ? (
        <p className="px-1 text-micro text-[color:var(--text-subtle)]" data-context-reading-note="">
          {contextReadingNote(breakdown, result?.ok === true && result.stale === true, agentName)}
        </p>
      ) : null}
    </section>
  )
}

// A dialog owes its content the keyboard: focus moves in as it opens, to its
// first control, and Escape gives it back to the ring. A frame later, because
// the surface stays hidden until it has been measured, and a hidden element
// cannot take focus. A dialog with nothing to operate (the total alone)
// leaves focus on the ring, which still names everything it says.
function focusIntoDialog(surface: HTMLElement): void {
  requestAnimationFrame(() => {
    if (surface.isConnected) surface.querySelector<HTMLElement>('button:not([disabled])')?.focus()
  })
}

/**
 * The composer's ring as a button, beside the model picker: the tooltip says
 * the counts, as the bare ring's does, and a click or Enter opens what fills
 * the window.
 */
export function ContextComposerButton({
  context,
  source,
}: {
  context: { used: number; total: number }
  source: ContextBreakdownSource | null
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const reading = useContextBreakdown(source, open)
  if (context.total <= 0) return null
  const percentage = (context.used / context.total) * 100
  const label = contextRingLabel(percentage, context)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Context window"
      popupRole="dialog"
      placement="top-end"
      surfaceClassName="w-[360px] max-h-[min(560px,70vh)] overflow-y-auto p-3"
      onOpenAutoFocus={focusIntoDialog}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        // The tooltip says the counts, as the bare ring's does: the sweep
        // already shows the share.
        <Tooltip content={contextRingTokensLabel(context.used, context.total)} placement="top" wrapperClassName="flex">
          <IconButton
            ref={ref}
            size="xs"
            tone="subtle"
            onClick={togglePopover}
            {...triggerProps}
            aria-label={`${label} — show what fills it`}
            data-composer-context=""
          >
            <ContextRing usedPercentage={percentage} decorative />
          </IconButton>
        </Tooltip>
      )}
    >
      <ContextBreakdownPanel context={context} source={source} reading={reading} onRefresh={reading.refresh} />
    </Popover>
  )
}
