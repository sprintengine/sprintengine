import type { ChatLogs, ChatRecord } from '../server/db/chat-logs'
import { EMPTY_CHAT_GENERATION } from '../server/db/chat-logs'
import { expandCoalescedDeltas } from './conversation-event-log'
import { MAX_CONVERSATION_TRANSCRIPT_BYTES } from './conversation-persistence'
import { inferConversationToolKind } from '../shared/conversation/toolKind'
import type { ConversationEvent, ConversationPage } from '../shared/conversation-runtime'

/**
 * Bounded reads of a chat's log, from the end backwards, out of the data
 * folder's database (`server/db/chat-logs.ts`).
 *
 * Everything a client asks of a log is about its end: the last few turns to
 * show, the events after the last one it saw, the page just before the
 * oldest one it holds. Each question reads only as far back as its answer
 * reaches, a page of rows at a time, by sequence number, with a byte budget
 * per question (each record counted as the line it was on disk).
 *
 * Records are read as they are stored: one row per event, or one row for a
 * run of deltas that carries each delta's sequence number in `parts`. Pages
 * and catch-up keep a merged run as one event whose `seq` is the run's last,
 * rather than one event per token, so a snapshot of a streamed answer is a
 * few records instead of thousands of envelopes.
 */

export type ConversationTranscriptLimits = {
  /** Largest read that holds a transcript in memory: the whole of a legacy one, or the tail of `readTranscript`. */
  fullReadBytes: number
  /** Byte budget of one snapshot or earlier page; it ends early, turn-aligned where it can be. */
  pageBytes: number
  /**
   * A reconnect further behind than either of these gets a fresh snapshot
   * instead of the missed events. The bytes are the wire's page budget
   * (`CONVERSATION_WIRE_PAGE_BYTES`, which a test holds this to), as stored:
   * a catch-up crosses a wire projected, which is never larger, so a replay
   * is bounded as a snapshot is.
   */
  catchUpEvents: number
  catchUpBytes: number
}

export const DEFAULT_TRANSCRIPT_LIMITS: ConversationTranscriptLimits = {
  fullReadBytes: MAX_CONVERSATION_TRANSCRIPT_BYTES,
  pageBytes: 8 * 1024 * 1024,
  catchUpEvents: 2000,
  catchUpBytes: 2 * 1024 * 1024,
}

/** Rows fetched at a time, newest first. */
const PAGE_ROWS = 256

type DeltaPart = [string, number, number, number?]

type TranscriptRecord = {
  event: ConversationEvent & { parts?: DeltaPart[] }
  firstSeq: number
  lastSeq: number
  bytes: number
}

type Records = AsyncIterable<TranscriptRecord>

export type TranscriptSyncResult =
  | { kind: 'events'; events: ConversationEvent[]; head: number; generation: string }
  | { kind: 'snapshot'; page: ConversationPage; head: number; generation: string }

export class ConversationTranscriptReader {
  private readonly limits: ConversationTranscriptLimits

  constructor(
    private readonly history: Pick<ChatLogs, 'info' | 'newest' | 'oldest'>,
    limits: Partial<ConversationTranscriptLimits> = {},
  ) {
    this.limits = { ...DEFAULT_TRANSCRIPT_LIMITS, ...limits }
  }

  /**
   * What a subscriber needs to join: the events after `afterSeq` when the
   * cursor provably belongs to this log (same generation, not ahead of it, not
   * too far behind), otherwise the last `turnLimit` turns to replace whatever
   * it holds.
   */
  sync(
    root: string,
    path: string,
    input: { afterSeq?: number; generation?: string; turnLimit?: number },
  ): Promise<TranscriptSyncResult> {
    return this.read(root, path, async (records, generation) => {
      const { afterSeq } = input
      if (
        afterSeq !== undefined &&
        Number.isSafeInteger(afterSeq) &&
        afterSeq >= 0 &&
        input.generation === generation
      ) {
        const caught = await this.after(records, afterSeq)
        if (caught) return { kind: 'events' as const, ...caught, generation }
      }
      const { page, head } = await this.page(records, input.turnLimit)
      return { kind: 'snapshot' as const, page, head, generation }
    })
  }

  /** The `turnLimit` turns that end just before `beforeCursor`. */
  before(root: string, path: string, beforeCursor: number, turnLimit?: number): Promise<ConversationPage> {
    return this.read(root, path, async (records) => (await this.page(records, turnLimit)).page, beforeCursor)
  }

  /**
   * The newest events, oldest first: expanded to one per sequence number, or
   * with `compact`, as stored, a merged run of deltas as one event carrying
   * the run's text, for a reader that only folds the text.
   */
  tail(
    root: string,
    path: string,
    limit: { events?: number; bytes?: number; compact?: boolean } = {},
  ): Promise<ConversationEvent[]> {
    return this.read(root, path, async (records) => {
      const maxBytes = limit.bytes ?? this.limits.fullReadBytes
      const maxEvents = limit.events ?? Number.POSITIVE_INFINITY
      const newest: ConversationEvent[][] = []
      let bytes = 0
      let count = 0
      for await (const record of records) {
        bytes += record.bytes
        if (bytes > maxBytes && newest.length > 0) break
        const expanded = limit.compact ? [compact(record)] : expandCoalescedDeltas({ ...record.event })
        newest.push(expanded)
        count += expanded.length
        if (count >= maxEvents) break
      }
      const events = newest.reverse().flat()
      return Number.isFinite(maxEvents) ? events.slice(-maxEvents) : events
    })
  }

  /**
   * The event a page, a catch-up or the live stream gave out under `seq` and
   * `id`, as stored. Within a merged run of deltas that is the span from the
   * delta `id` names (the run's first, or where a catch-up's cursor fell)
   * through the one numbered `seq` (the run's last, or a live delta's own).
   * Read back from the end as far as it takes. Undefined when the log has no
   * such event.
   */
  eventAt(root: string, path: string, seq: number, id: string): Promise<ConversationEvent | undefined> {
    return this.read(root, path, async (records) => {
      for await (const record of records) {
        if (record.lastSeq < seq) return undefined
        if (record.firstSeq > seq) continue
        return spanOf(record, seq, id)
      }
      return undefined
    })
  }

  /**
   * The newest turn as stored, oldest first: the events back to and including
   * the newest user message, a merged run of deltas as one event. A turn
   * longer than `bytes` comes back as its newest part, without the message.
   */
  lastTurn(root: string, path: string, bytes: number): Promise<ConversationEvent[]> {
    return this.read(root, path, async (records) => {
      const newest: ConversationEvent[] = []
      let read = 0
      for await (const record of records) {
        read += record.bytes
        if (read > bytes && newest.length > 0) break
        newest.push(compact(record))
        if (record.event.type === 'user_message') break
      }
      return newest.reverse()
    })
  }

  /**
   * The newest stored event matching `predicate`, scanning back as far as it
   * takes, or with `maxBytes`, no further back than that many bytes.
   */
  findLast(
    root: string,
    path: string,
    predicate: (event: ConversationEvent) => boolean,
    maxBytes = Number.POSITIVE_INFINITY,
  ): Promise<ConversationEvent | undefined> {
    return this.read(root, path, async (records) => {
      let read = 0
      for await (const record of records) {
        if (predicate(record.event)) return { ...record.event }
        read += record.bytes
        if (read > maxBytes) break
      }
      return undefined
    })
  }

  /** The oldest stored event matching `predicate` within the first `maxBytes` of the log. */
  async findFirst(
    root: string,
    path: string,
    predicate: (event: ConversationEvent) => boolean,
    maxBytes = 1024 * 1024,
  ): Promise<ConversationEvent | undefined> {
    let read = 0
    let after = 0
    for (;;) {
      const rows = await this.history.oldest(path, root, after, PAGE_ROWS)
      for (const row of rows) {
        read += row.bytes
        if (read > maxBytes) return undefined
        const record = toRecord(row)
        if (record && predicate(record.event)) return { ...record.event }
        after = row.seq
      }
      if (rows.length < PAGE_ROWS) return undefined
    }
  }

  private async after(
    records: Records,
    afterSeq: number,
  ): Promise<{ events: ConversationEvent[]; head: number } | null> {
    const newer: TranscriptRecord[] = []
    let head: number | null = null
    let bytes = 0
    let reachedCursor = false
    for await (const record of records) {
      head ??= record.lastSeq
      if (afterSeq > head || head - afterSeq > this.limits.catchUpEvents) return null
      if (record.lastSeq <= afterSeq) {
        reachedCursor = true
        break
      }
      bytes += record.bytes
      if (bytes > this.limits.catchUpBytes) return null
      newer.push(record)
      if (record.firstSeq <= afterSeq) {
        reachedCursor = true
        break
      }
    }
    head ??= 0
    if (afterSeq > head) return null
    // Every record is newer than a non-zero cursor: this log begins after it,
    // so it is not the log the cursor came from.
    if (!reachedCursor && afterSeq > 0) return null
    const events = newer.reverse().map((record, index) => compact(record, index === 0 ? afterSeq : undefined))
    return { events, head }
  }

  private async page(records: Records, requested = 10): Promise<{ page: ConversationPage; head: number }> {
    const limit = Math.max(1, Math.min(100, Math.floor(requested) || 10))
    const page: TranscriptRecord[] = []
    const prefix: TranscriptRecord[] = []
    let turns = 0
    let bytes = 0
    let hasMore = false
    let head: number | null = null
    for await (const record of records) {
      head ??= record.lastSeq
      if (turns === limit) {
        // Enough turns; what is left before the oldest belongs to this page
        // only if no earlier turn exists (the session's opening events).
        bytes += record.bytes
        if (record.event.type === 'user_message' || bytes > this.limits.pageBytes) {
          hasMore = true
          break
        }
        prefix.push(record)
        continue
      }
      if (page.length > 0 && bytes + record.bytes > this.limits.pageBytes) {
        hasMore = true
        break
      }
      bytes += record.bytes
      page.push(record)
      if (record.event.type === 'user_message') turns++
    }
    const kept = hasMore ? page : [...page, ...prefix]
    const oldest = kept.at(-1)
    return {
      page: {
        events: kept.reverse().map((record) => compact(record)),
        hasMore,
        beforeCursor: oldest?.firstSeq ?? null,
      },
      head: head ?? 0,
    }
  }

  /**
   * Run `work` over the log's records, newest first (older than `beforeSeq`
   * when given), with its generation. A log nothing was written to has none.
   */
  private async read<T>(
    root: string,
    path: string,
    work: (records: Records, generation: string) => Promise<T>,
    beforeSeq?: number,
  ): Promise<T> {
    const info = await this.history.info(path, root)
    if (!info) return work(emptyRecords(), EMPTY_CHAT_GENERATION)
    return work(this.records(root, path, beforeSeq ?? null), info.generation)
  }

  /** The log's records newest first, a page of rows at a time, as far back as the reader goes. */
  private async *records(root: string, path: string, beforeSeq: number | null): Records {
    let before = beforeSeq
    for (;;) {
      const rows = await this.history.newest(path, root, before, PAGE_ROWS)
      for (const row of rows) {
        const record = toRecord(row)
        if (record) yield record
        before = row.seq
      }
      if (rows.length < PAGE_ROWS) return
    }
  }
}

/** A row as the record a reader folds; null for one whose body does not read. */
function toRecord(row: ChatRecord): TranscriptRecord | null {
  const event = parseRecordEvent(row.body) as TranscriptRecord['event'] | null
  if (!event) return null
  return { event, firstSeq: row.firstSeq, lastSeq: row.seq, bytes: row.bytes }
}

function parseRecordEvent(line: string): ConversationEvent | null {
  try {
    const parsed = JSON.parse(line) as ConversationEvent
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') return null
    if (parsed.type === 'tool_started' && parsed.payload && !parsed.payload.kind)
      parsed.payload.kind = inferConversationToolKind(String(parsed.payload.name ?? parsed.payload.tool ?? ''))
    return parsed
  } catch {
    return null
  }
}

async function* emptyRecords(): Records {}

/**
 * One record as one event: a merged run of deltas stays merged, numbered with
 * its last delta's sequence. With `afterSeq`, only the deltas after it are
 * kept — a reconnect can land in the middle of a run.
 */
/** The span of a record from the event `id` names through the one numbered `seq`, or undefined. */
function spanOf(record: TranscriptRecord, seq: number, id: string): ConversationEvent | undefined {
  const { parts, ...event } = record.event
  const text = typeof event.payload?.text === 'string' ? event.payload.text : null
  if (!Array.isArray(parts) || parts.length === 0 || text === null)
    return event.id === id && record.lastSeq === seq ? { ...event, seq } : undefined
  const first = parts.findIndex((part) => part[0] === id)
  const last = seq === record.lastSeq ? parts.length - 1 : parts.findIndex((part) => part[3] === seq)
  if (first === -1 || last < first) return undefined
  let start = 0
  for (let index = 0; index < first; index++) start += parts[index][2]
  let end = start
  for (let index = first; index <= last; index++) end += parts[index][2]
  return {
    ...event,
    id,
    createdAt: parts[first][1],
    seq,
    payload: { ...event.payload, text: text.slice(start, end) },
  }
}

function compact(record: TranscriptRecord, afterSeq?: number): ConversationEvent {
  const { parts, ...event } = record.event
  if (!Array.isArray(parts) || parts.length === 0) return { ...event, seq: record.lastSeq }
  const text = typeof event.payload?.text === 'string' ? event.payload.text : null
  if (afterSeq === undefined || record.firstSeq > afterSeq || text === null) return { ...event, seq: record.lastSeq }
  let offset = 0
  let index = 0
  while (index < parts.length && (parts[index][3] ?? 0) <= afterSeq) offset += parts[index++][2]
  const first = parts[index]
  return {
    ...event,
    id: first?.[0] ?? event.id,
    createdAt: first?.[1] ?? event.createdAt,
    seq: record.lastSeq,
    payload: { ...event.payload, text: text.slice(offset) },
  }
}
