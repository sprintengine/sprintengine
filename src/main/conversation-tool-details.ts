import { basename, dirname } from 'node:path'

import type { StudioDatabase } from '../server/db/database'
import { readConversationStorage } from './conversation-persistence'
import type {
  ConversationToolDetail,
  ConversationToolDetailResult,
  ConversationJsonValue,
} from '../shared/conversation-runtime'
import { normalizeApiKeySource } from '../shared/conversation/apiKeySource'

const MAX_DETAIL_BYTES = 5 * 1024 * 1024
const HEAD_BYTES = 1024 * 1024
// What a clipped streamed output keeps from its end, beside the head.
const TAIL_BYTES = MAX_DETAIL_BYTES - HEAD_BYTES - 1024
/** Characters of output an event carries as its row preview. */
export const TOOL_PREVIEW_CHARS = 4000

/** Where builds before the database kept a tool's streamed output, beside its detail: read once, by the import. */
function legacyOutputPath(detailPath: string): string {
  return detailPath.replace(/\.json$/, '.output')
}

/**
 * A detail's name in the database, from the path builds before it kept the
 * detail at (`<chat>/<agent>.tools/<tool use>.json`): `<chat>/<agent>/<tool
 * use>`, its log's name and the tool use's.
 */
function detailKey(path: string): { detail: string; log: string } {
  const log = `${basename(dirname(dirname(path)))}/${basename(dirname(path)).replace(/\.tools$/u, '')}`
  return { detail: `${log}/${basename(path).replace(/\.json$/u, '')}`, log }
}

/**
 * The same key-based redaction applies to transcript envelopes and tool details.
 * `apiKeySource` names where a credential came from, never the credential.
 * Redacted, it read back from disk as a source the chat did not know, and the
 * API-key warning showed on every session reloaded from its transcript.
 */
export function redactConversationValue<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, entry) => {
      // A count of tokens is a number and never a credential: usage and the
      // compaction row's before/after sizes all end in `Tokens`.
      if (/tokens$/i.test(key) && typeof entry === 'number') return entry
      if (key === 'apiKeySource') return normalizeApiKeySource(entry) ?? '[redacted]'
      return /secret|token|api[-_]?key|authorization/i.test(key) ? '[redacted]' : entry
    }),
  ) as T
}

/**
 * A tool's details in the data folder's database: its JSON detail
 * (`tool_details`) and the output it streamed (`tool_outputs`, in parts), read
 * by Studio when a tool row is expanded. Builds before the database kept them
 * as files beside the transcript; a detail asked for that the database does
 * not have is imported from its file once, if it is there.
 */
export class ToolDetailStore {
  constructor(private readonly database?: StudioDatabase) {}

  /** A tool's detail, with the output that streamed in joined to it. */
  async read(workspaceRoot: string, path: string): Promise<ConversationToolDetailResult> {
    const database = this.database
    if (!database) return { ok: false, code: 'not_found', message: 'Tool detail is unavailable.' }
    try {
      const key = detailKey(path)
      let row = await database.get<{ body: string }>('SELECT body FROM tool_details WHERE detail_key = ?', [key.detail])
      if (!row && (await this.importLegacy(workspaceRoot, path)))
        row = await database.get<{ body: string }>('SELECT body FROM tool_details WHERE detail_key = ?', [key.detail])
      if (!row) return { ok: false, code: 'not_found', message: 'Tool detail is unavailable.' }
      const detail = JSON.parse(row.body) as ConversationToolDetail
      if (detail.output === '') {
        const streamed = await this.output(key.detail)
        if (streamed !== null) detail.output = streamed
      }
      return { ok: true, detail }
    } catch {
      return { ok: false, code: 'unavailable', message: 'Tool detail is unavailable.' }
    }
  }

  /** Keep a tool's detail, redacted and clipped to the budget a detail keeps. */
  async write(_workspaceRoot: string, path: string, value: ConversationToolDetail): Promise<void> {
    if (!this.database) return
    const key = detailKey(path)
    await this.database.run(
      `INSERT INTO tool_details (detail_key, log_key, body) VALUES (?, ?, ?)
       ON CONFLICT (detail_key) DO UPDATE SET body = excluded.body`,
      [key.detail, key.log, clippedDetail(value)],
    )
  }

  /** A stream of the output a running tool appends. */
  stream(path: string): ToolOutputStream {
    return new ToolOutputStream(this, path)
  }

  /** Forget a tool's streamed output: its final output carries everything. */
  async removeOutput(path: string): Promise<void> {
    await this.database?.run('DELETE FROM tool_outputs WHERE detail_key = ?', [detailKey(path).detail])
  }

  /** Keep a tool's detail under another chat's name (a fork's copy), its streamed output included. */
  async copy(from: string, to: string): Promise<void> {
    if (!this.database) return
    const source = detailKey(from)
    const target = detailKey(to)
    await this.database.batch([
      {
        sql: `INSERT OR REPLACE INTO tool_details (detail_key, log_key, body)
              SELECT ?, ?, body FROM tool_details WHERE detail_key = ?`,
        params: [target.detail, target.log, source.detail],
      },
      { sql: 'DELETE FROM tool_outputs WHERE detail_key = ?', params: [target.detail] },
      {
        sql: `INSERT INTO tool_outputs (detail_key, part, log_key, bytes)
              SELECT ?, part, ?, bytes FROM tool_outputs WHERE detail_key = ?`,
        params: [target.detail, target.log, source.detail],
      },
    ])
  }

  /** @internal The stream's parts, as it appends them. */
  async appendOutput(path: string, part: number, bytes: Buffer): Promise<void> {
    const key = detailKey(path)
    await this.database?.run('INSERT OR REPLACE INTO tool_outputs (detail_key, part, log_key, bytes) VALUES (?, ?, ?, ?)', [
      key.detail,
      part,
      key.log,
      bytes,
    ])
  }

  /** @internal Replace a stream's parts with one (its clipped head and tail). */
  async replaceOutput(path: string, bytes: Buffer): Promise<void> {
    const key = detailKey(path)
    await this.database?.batch([
      { sql: 'DELETE FROM tool_outputs WHERE detail_key = ?', params: [key.detail] },
      {
        sql: 'INSERT INTO tool_outputs (detail_key, part, log_key, bytes) VALUES (?, 0, ?, ?)',
        params: [key.detail, key.log, bytes],
      },
    ])
  }

  /** @internal The first `limit` bytes of a stream's output, or null when it streamed none. */
  async outputHead(path: string, limit: number): Promise<Buffer | null> {
    const text = await this.outputBytes(detailKey(path).detail, limit)
    return text
  }

  private async output(detail: string): Promise<string | null> {
    const bytes = await this.outputBytes(detail, MAX_DETAIL_BYTES + 1024)
    return bytes === null ? null : bytes.toString('utf8')
  }

  private async outputBytes(detail: string, limit: number): Promise<Buffer | null> {
    const rows = await this.database!.all<{ bytes: Uint8Array }>(
      'SELECT bytes FROM tool_outputs WHERE detail_key = ? ORDER BY part',
      [detail],
    )
    if (rows.length === 0) return null
    const parts: Buffer[] = []
    let size = 0
    for (const row of rows) {
      if (size >= limit) break
      const bytes = Buffer.from(row.bytes)
      parts.push(bytes)
      size += bytes.length
    }
    return Buffer.concat(parts).subarray(0, limit)
  }

  /** Bring in a detail builds before the database kept as a file, once; whether there was one. */
  private async importLegacy(workspaceRoot: string, path: string): Promise<boolean> {
    const database = this.database!
    const key = detailKey(path)
    const source = `tool:${key.detail}`
    if (await database.get('SELECT 1 FROM imports WHERE source = ?', [source])) return false
    const read = (file: string, limit: number) =>
      readConversationStorage(workspaceRoot, file, limit).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
    const detail = await read(path, MAX_DETAIL_BYTES)
    const output = detail ? await read(legacyOutputPath(path), MAX_DETAIL_BYTES + 1024) : null
    await database.batch([
      ...(detail
        ? [
            {
              sql: 'INSERT OR IGNORE INTO tool_details (detail_key, log_key, body) VALUES (?, ?, ?)',
              params: [key.detail, key.log, detail.toString('utf8')],
            },
          ]
        : []),
      ...(output
        ? [
            {
              sql: 'INSERT OR IGNORE INTO tool_outputs (detail_key, part, log_key, bytes) VALUES (?, 0, ?, ?)',
              params: [key.detail, key.log, output],
            },
          ]
        : []),
      {
        sql: 'INSERT OR IGNORE INTO imports (source, imported_at, records, skipped) VALUES (?, ?, ?, 0)',
        params: [source, Date.now(), detail ? 1 : 0],
      },
    ])
    return detail !== null
  }
}

/** A detail as it is kept: redacted, and clipped to the budget with its JSON still valid. */
function clippedDetail(value: ConversationToolDetail): string {
  const detail = redactConversationValue(value)
  let serialized = JSON.stringify(detail)
  if (Buffer.byteLength(serialized) > MAX_DETAIL_BYTES) {
    detail.clipped = true
    // Keep JSON valid: clip the largest field, including escaped-string overhead,
    // and preserve both the beginning and the most recent output.
    let budget = MAX_DETAIL_BYTES - 1024
    while (Buffer.byteLength(serialized) > MAX_DETAIL_BYTES) {
      const field =
        Buffer.byteLength(JSON.stringify(detail.output)) >= Buffer.byteLength(JSON.stringify(detail.input))
          ? 'output'
          : 'input'
      detail[field] = clipValue(detail[field], budget)
      serialized = JSON.stringify(detail)
      budget = Math.floor(budget * 0.8)
    }
  }
  return serialized
}

function clipValue(value: ConversationJsonValue, budget: number): string {
  const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
  const head = Math.min(HEAD_BYTES, Math.floor(budget / 5))
  return (
    bytes.subarray(0, head).toString('utf8') +
    '\n[clipped]\n' +
    bytes.subarray(-Math.max(1, budget - head)).toString('utf8')
  )
}

/**
 * A tool's output as it streams: each chunk is kept once, as a part, and the
 * row preview is the latest text. Re-sending and re-writing the whole output
 * per chunk made a long command quadratic in its own output; chunks that come
 * while a part is being written go together in the next. Past the detail
 * budget the parts keep their head, and `finish` replaces them once with head
 * plus the most recent output, the way a clipped detail always reads.
 */
export class ToolOutputStream {
  tail = ''
  chars = 0
  totalBytes = 0
  clipped = false
  private keptBytes = 0
  private recent: Buffer[] = []
  private recentBytes = 0
  private queued: Buffer[] = []
  private writing = false
  private part = 0
  private writes: Promise<void> = Promise.resolve()
  private failed = false

  constructor(
    private readonly store: ToolDetailStore,
    readonly path: string,
  ) {}

  append(text: string): void {
    if (!text) return
    this.chars += text.length
    this.tail = (this.tail + text).slice(-TOOL_PREVIEW_CHARS)
    const bytes = Buffer.from(text)
    this.totalBytes += bytes.length
    this.recent.push(bytes)
    this.recentBytes += bytes.length
    while (this.recent.length > 1 && this.recentBytes - this.recent[0].length >= TAIL_BYTES)
      this.recentBytes -= this.recent.shift()!.length
    const room = MAX_DETAIL_BYTES - this.keptBytes
    if (room < bytes.length) this.clipped = true
    if (room <= 0) return
    const chunk = bytes.length > room ? bytes.subarray(0, room) : bytes
    this.keptBytes += chunk.length
    this.queued.push(chunk)
    if (this.writing) return
    this.writing = true
    this.writes = this.writes.then(async () => {
      this.writing = false
      const parts = this.queued.splice(0)
      if (this.failed || parts.length === 0) return
      try {
        await this.store.appendOutput(this.path, this.part++, Buffer.concat(parts))
      } catch {
        // The preview still streams; only the full output is lost.
        this.failed = true
      }
    })
  }

  /** Every chunk appended so far is kept. */
  settled(): Promise<void> {
    return this.writes
  }

  /** Done: clipped to head and tail if it overflowed. */
  async finish(): Promise<void> {
    await this.writes
    if (!this.clipped || this.failed) return
    const head = ((await this.store.outputHead(this.path, MAX_DETAIL_BYTES)) ?? Buffer.alloc(0)).subarray(0, HEAD_BYTES)
    const tail = Buffer.concat(this.recent).subarray(-TAIL_BYTES)
    await this.store.replaceOutput(this.path, Buffer.from(`${head.toString('utf8')}\n[clipped]\n${tail.toString('utf8')}`))
  }
}

/**
 * How long a running tool's replaced output may wait before its detail file is
 * rewritten. Updates inside the window fold into the one write at its end.
 */
export const TOOL_DETAIL_WRITE_WINDOW_MS = 250

type WaitingToolDetailWrite = {
  workspaceRoot: string
  detail: ConversationToolDetail
  mergeInput: boolean
  write: Promise<void>
  /** Start it now (once the write ahead of it has landed) rather than at the window's end. */
  release: () => void
}

/**
 * Detail files, each written behind any earlier write for the same tool. A
 * detail whose input was never seen this run (the tool started before a
 * restart) keeps the input already on disk.
 *
 * A write that has not started yet takes the newer detail instead of a second
 * write queueing behind it: a provider that re-sends a running tool's whole
 * output on every update would otherwise rewrite the file once per update,
 * each copy larger than the last, and only the newest is read. On a fast disk
 * each write lands before the next update arrives, so that alone still wrote
 * once per update; a coalesced update (`coalesce`, a running tool's replaced
 * output) also waits out a short window, from the first update it holds, and
 * every update inside it joins the one write. It is the window's end, not its
 * start, that writes: the tool's start has already put a detail on disk, and
 * nothing reads the file without `flush`ing it first, so a reader never sees
 * an update older than the newest. Anything else (a start, a final output)
 * releases a waiting write at once.
 */
export class ToolDetailWriteQueue {
  private readonly writes = new Map<string, Promise<void>>()
  private readonly waiting = new Map<string, WaitingToolDetailWrite>()

  constructor(
    private readonly deps: {
      read: ToolDetailStore['read']
      write: ToolDetailStore['write']
      windowMs?: number
    },
  ) {}

  queue(
    workspaceRoot: string,
    path: string,
    detail: ConversationToolDetail,
    options: { mergeInput?: boolean; coalesce?: boolean } = {},
  ): Promise<void> {
    const waiting = this.waiting.get(path)
    if (waiting) {
      waiting.detail = detail
      waiting.mergeInput ||= options.mergeInput === true
      if (!options.coalesce) waiting.release()
      return waiting.write
    }
    let open!: () => void
    const windowEnd = new Promise<void>((resolve) => (open = resolve))
    let timer: ReturnType<typeof setTimeout> | null = null
    const entry: WaitingToolDetailWrite = {
      workspaceRoot,
      detail,
      mergeInput: options.mergeInput === true,
      write: Promise.resolve(),
      release: () => {
        if (timer) clearTimeout(timer)
        timer = null
        open()
      },
    }
    const windowMs = this.deps.windowMs ?? TOOL_DETAIL_WRITE_WINDOW_MS
    if (options.coalesce && windowMs > 0) {
      timer = setTimeout(entry.release, windowMs)
      timer.unref?.()
    } else open()
    const write = (this.writes.get(path) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => windowEnd)
      .then(async () => {
        // Started: a newer detail now queues behind this write.
        if (this.waiting.get(path) === entry) this.waiting.delete(path)
        if (entry.mergeInput) {
          const previous = await this.deps.read(entry.workspaceRoot, path)
          if (previous.ok) entry.detail.input = previous.detail.input
        }
        await this.deps.write(entry.workspaceRoot, path, entry.detail)
      })
    entry.write = write
    this.waiting.set(path, entry)
    this.writes.set(path, write)
    void write
      .finally(() => {
        if (this.writes.get(path) === write) this.writes.delete(path)
      })
      .catch(() => undefined)
    return write
  }

  /** Start a write still waiting out its window, and wait until every write of the file has landed. */
  async flush(path: string): Promise<void> {
    this.waiting.get(path)?.release()
    await this.writes.get(path)?.catch(() => undefined)
  }

  /** Every file's, for a shutdown: nothing is left waiting on a timer. */
  async flushAll(): Promise<void> {
    await Promise.all(Array.from(new Set([...this.waiting.keys(), ...this.writes.keys()]), (path) => this.flush(path)))
  }
}
