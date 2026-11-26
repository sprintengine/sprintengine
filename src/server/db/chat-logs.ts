import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

import type { StudioDatabase, StudioTransaction } from './database'
import type { SqlParams } from './sqlite'

// A chat's history in the data folder's database: one log per agent of a
// chat (`chat_logs`), its events in order (`chat_events`, keyed by the log
// and the sequence number the event was published under), and its command
// receipts (`chat_receipts`), written in the same transaction as what the
// command committed. A merged run of deltas is one row, keyed by its last
// delta's number, with its first's beside it, as it was one line on disk.
//
// A log is named as the transcript builds before the database wrote was:
// `<store>/<chat>/<agent>`, the store being the project's
// (`~/.sprintengine/workspaces/<store>/conversations/<chat>/<agent>.jsonl`).
// A chat moved to another project has its rows renamed with it
// (`moveChatLogs`). That file, where it is, is the log's history from
// before the upgrade: it is imported the first time the log is taken up (a
// read, an append, a receipt lookup) or by the background pass, once, in one
// transaction, and never read again (owner decision 2026-11-25). An import
// that a stop cuts short is rolled back and runs again.

/** One stored record: an event, or a merged run of deltas as one. */
export type ChatRecord = {
  /** Its last sequence number: a merged run's last delta's, or the event's own. */
  seq: number
  firstSeq: number
  /** Its length as a line of the old transcript would have been, for the byte budgets of pages. */
  bytes: number
  /** The event as stored, a merged run with its `parts`. */
  body: string
}

/** A row to append: an event (or a merged run) serialized, numbered and typed. */
export type ChatRow = { seq: number; firstSeq: number; type: string; turnId: string | null; body: string }

/** A receipt line as the log writes it (`receiptRecord`): its fields are merged with what was known. */
export type ChatReceiptRow = { id: string; at: number; fp?: string; turnId?: string; answer?: unknown }

/** What the database knows of a log; null for one that has no history yet. */
export type ChatLogInfo = { generation: string; lastSeq: number }

/** The generation of a log nothing was written to yet (the reader's word for it). */
export const EMPTY_CHAT_GENERATION = 'empty'

/** A chat's identity in the database, from its store folder (`<store>/conversations/<chat>`): `<store>/<chat>`. */
export function chatKey(chatFolder: string): string {
  return `${basename(dirname(dirname(chatFolder)))}/${basename(chatFolder)}`
}

/** A log's identity in the database, from the path a transcript of it was kept at: `<store>/<chat>/<agent>`. */
export function chatLogKey(path: string): string {
  return `${chatKey(dirname(path))}/${basename(path).replace(/\.jsonl$/u, '')}`
}

/**
 * The statements that rename a chat's rows from one store's name to
 * another's (`<from>/…` to `<to>/…`): what moving its store folder to
 * another project was for its files. One transaction.
 */
export function moveChatStatements(from: string, to: string): Array<{ sql: string; params: SqlParams }> {
  const prefix = `${from}/`
  const range = [prefix, `${from}0`] as const
  const renamed = (column: string) => `? || substr(${column}, ${prefix.length + 1})`
  const statements: Array<{ sql: string; params: SqlParams }> = []
  for (const table of ['chat_logs', 'chat_events', 'chat_receipts', 'chat_threads', 'chat_search_docs', 'tool_outputs'])
    statements.push({
      sql: `UPDATE ${table} SET log_key = ${renamed('log_key')} WHERE log_key >= ? AND log_key < ?`,
      params: [`${to}/`, ...range],
    })
  for (const table of ['chat_threads', 'chat_search_docs'])
    statements.push({ sql: `UPDATE ${table} SET chat_key = ? WHERE chat_key = ?`, params: [to, from] })
  statements.push({
    sql: `UPDATE tool_details SET log_key = ${renamed('log_key')}, detail_key = ${renamed('detail_key')}
          WHERE log_key >= ? AND log_key < ?`,
    params: [`${to}/`, `${to}/`, ...range],
  })
  statements.push({
    sql: `UPDATE tool_outputs SET detail_key = ${renamed('detail_key')} WHERE detail_key >= ? AND detail_key < ?`,
    params: [`${to}/`, ...range],
  })
  // What was imported stays imported under its new name: the files move too.
  for (const kind of ['transcript', 'tool'])
    statements.push({
      sql: `UPDATE imports SET source = ? || substr(source, ${kind.length + 1 + prefix.length + 1})
            WHERE source >= ? AND source < ?`,
      params: [`${kind}:${to}/`, `${kind}:${prefix}`, `${kind}:${from}0`],
    })
  return statements
}

/**
 * A log's generation: a hash of its first record as a line, the way the
 * reader named a transcript's. The first record carries an event id unique
 * to the run that created the log, so a log deleted and begun again never
 * matches a cursor from the old one; and a log imported from its file keeps
 * the generation clients saw before the upgrade.
 */
export function chatGeneration(firstLine: Buffer | string): string {
  return createHash('sha256').update(firstLine).digest('base64url').slice(0, 22)
}

const IMPORT_BATCH_ROWS = 400
const IMPORT_YIELD_BYTES = 4 * 1024 * 1024
// One line longer than this (a pathological tool output) is skipped, as the reader skipped it.
const MAX_LINE_BYTES = 16 * 1024 * 1024

export type ChatLogs = ReturnType<typeof createChatLogs>

export function createChatLogs(options: {
  database: StudioDatabase
  log?: (message: string) => void
}) {
  const db = options.database
  // The import (or the look that finds there is none) for each log, once a run.
  const taken = new Map<string, Promise<void>>()

  /**
   * Take up a log: import its old transcript at `path` when there is one and
   * the database has not imported it yet. Resolves once that is done.
   */
  function ensure(path: string, root: string): Promise<void> {
    const key = chatLogKey(path)
    let pending = taken.get(key)
    if (!pending) {
      pending = importOnce(key, path, root)
      taken.set(key, pending)
      // A failed import is tried again next time, not remembered.
      pending.catch(() => {
        if (taken.get(key) === pending) taken.delete(key)
      })
    }
    return pending
  }

  async function importOnce(key: string, path: string, root: string): Promise<void> {
    if (await db.get('SELECT 1 FROM imports WHERE source = ?', [importSource(key)])) return
    await importTranscript(db, key, path, root, options.log)
  }

  async function info(path: string, root: string): Promise<ChatLogInfo | null> {
    await ensure(path, root)
    const row = await db.get<{ generation: string; last_seq: number }>(
      'SELECT generation, last_seq FROM chat_logs WHERE log_key = ?',
      [chatLogKey(path)],
    )
    return row ? { generation: row.generation, lastSeq: row.last_seq } : null
  }

  return {
    ensure,
    info,
    /**
     * Append rows and receipts to a log, in one transaction: all of them or
     * none. A log's first rows begin it, its generation named by the first.
     */
    async append(path: string, root: string, rows: readonly ChatRow[], receipts: readonly ChatReceiptRow[]): Promise<void> {
      await ensure(path, root)
      const key = chatLogKey(path)
      await db.transaction(async (tx) => {
        await writeRows(tx, key, root, rows, receipts)
      })
    },
    /** Records newest first, older than `beforeSeq` when given, `limit` at most. */
    async newest(path: string, root: string, beforeSeq: number | null, limit: number): Promise<ChatRecord[]> {
      await ensure(path, root)
      const params: SqlParams = beforeSeq === null ? [chatLogKey(path), limit] : [chatLogKey(path), beforeSeq, limit]
      return db.all<ChatRecord>(
        `SELECT seq, first_seq AS firstSeq, bytes, body FROM chat_events
         WHERE log_key = ? ${beforeSeq === null ? '' : 'AND seq < ?'} ORDER BY seq DESC LIMIT ?`,
        params,
      )
    },
    /** Records oldest first, newer than `afterSeq`, `limit` at most. */
    async oldest(path: string, root: string, afterSeq: number, limit: number): Promise<ChatRecord[]> {
      await ensure(path, root)
      return db.all<ChatRecord>(
        `SELECT seq, first_seq AS firstSeq, bytes, body FROM chat_events
         WHERE log_key = ? AND seq > ? ORDER BY seq LIMIT ?`,
        [chatLogKey(path), afterSeq, limit],
      )
    },
    /** Every receipt of a log, oldest first. */
    async receipts(path: string, root: string): Promise<ChatReceiptRow[]> {
      await ensure(path, root)
      const rows = await db.all<{ body: string }>('SELECT body FROM chat_receipts WHERE log_key = ? ORDER BY at, rowid', [
        chatLogKey(path),
      ])
      return rows.flatMap((row) => {
        try {
          return [JSON.parse(row.body) as ChatReceiptRow]
        } catch {
          return []
        }
      })
    },
    /** Whether a log has any history, its old transcript included. */
    async exists(path: string, root: string): Promise<boolean> {
      return (await info(path, root)) !== null
    },
    /**
     * Delete a log and everything kept with it, in one transaction. Its old
     * transcript, if there was one, stays imported: it is never taken up again.
     */
    async remove(path: string, root: string): Promise<void> {
      await ensure(path, root)
      const key = chatLogKey(path)
      await db.batch(removeStatements(key))
    },
  }
}

/** Where `imports` notes a log's old transcript: once there, the database is the log's whole history. */
export function importSource(key: string): string {
  return `transcript:${key}`
}

/** The statements that delete a log and what is kept with it. */
export function removeStatements(key: string): Array<{ sql: string; params: SqlParams }> {
  return ['chat_events', 'chat_receipts', 'chat_threads', 'chat_search_docs', 'tool_details', 'tool_outputs', 'chat_logs'].map(
    (table) => ({ sql: `DELETE FROM ${table} WHERE log_key = ?`, params: [key] }),
  )
}

async function writeRows(
  tx: StudioTransaction,
  key: string,
  root: string,
  rows: readonly ChatRow[],
  receipts: readonly ChatReceiptRow[],
): Promise<void> {
  if (rows.length > 0) {
    const first = rows[0]!
    await tx.run(
      `INSERT INTO chat_logs (log_key, workspace_root, generation, last_seq) VALUES (?, ?, ?, 0)
       ON CONFLICT (log_key) DO UPDATE SET workspace_root = excluded.workspace_root`,
      [key, root, chatGeneration(first.body)],
    )
    for (let index = 0; index < rows.length; index += IMPORT_BATCH_ROWS) {
      const batch = rows.slice(index, index + IMPORT_BATCH_ROWS)
      await tx.run(
        `INSERT INTO chat_events (log_key, seq, first_seq, type, turn_id, bytes, body) VALUES ${batch
          .map(() => '(?, ?, ?, ?, ?, ?, ?)')
          .join(', ')}`,
        batch.flatMap((row) => [key, row.seq, row.firstSeq, row.type, row.turnId, Buffer.byteLength(row.body) + 1, row.body]),
      )
    }
    await tx.run('UPDATE chat_logs SET last_seq = MAX(last_seq, ?) WHERE log_key = ?', [rows.at(-1)!.seq, key])
  }
  for (const receipt of receipts) {
    const known = await tx.get<{ body: string }>('SELECT body FROM chat_receipts WHERE log_key = ? AND command_id = ?', [
      key,
      receipt.id,
    ])
    let merged: ChatReceiptRow = receipt
    if (known) {
      try {
        const before = JSON.parse(known.body) as ChatReceiptRow
        merged = {
          id: receipt.id,
          at: receipt.at,
          ...((receipt.fp ?? before.fp) ? { fp: receipt.fp ?? before.fp } : {}),
          ...((receipt.turnId ?? before.turnId) ? { turnId: receipt.turnId ?? before.turnId } : {}),
          ...((receipt.answer ?? before.answer) ? { answer: receipt.answer ?? before.answer } : {}),
        }
      } catch {
        merged = receipt
      }
    }
    await tx.run(
      `INSERT INTO chat_receipts (log_key, command_id, at, body) VALUES (?, ?, ?, ?)
       ON CONFLICT (log_key, command_id) DO UPDATE SET at = excluded.at, body = excluded.body`,
      [key, receipt.id, receipt.at, JSON.stringify(merged)],
    )
  }
}

type DeltaPart = [string, number, number, number?]
type StoredEvent = { type?: unknown; seq?: unknown; parts?: unknown; payload?: Record<string, unknown> } & Record<
  string,
  unknown
>

/**
 * Import an old transcript into the log, numbered as the reader numbered
 * it: an event keeps the number it was stored with while the numbers rise;
 * one without (a transcript from before sequence numbers) or out of order is
 * numbered by position, a merged run of such deltas split into its deltas
 * first. A line that does not read (torn by a crash, damaged) is skipped and
 * counted. Receipt lines become receipts. One transaction: a stop part way
 * leaves nothing, and the import runs again.
 */
async function importTranscript(
  db: StudioDatabase,
  key: string,
  path: string,
  root: string,
  log?: (message: string) => void,
): Promise<void> {
  const firstLine = await readFirstLine(path)
  let records = 0
  let skipped = 0
  await db.transaction(async (tx) => {
    // Imported meanwhile by another run of this (a second Studio on the same folder cannot be: the lock).
    if (await tx.get('SELECT 1 FROM imports WHERE source = ?', [importSource(key)])) return
    if (firstLine !== null) {
      const rows: ChatRow[] = []
      const receipts: ChatReceiptRow[] = []
      let seq = 0
      let begun = false
      const flush = async () => {
        if (rows.length === 0 && receipts.length === 0) return
        if (!begun && rows.length > 0) {
          await tx.run(
            `INSERT INTO chat_logs (log_key, workspace_root, generation, last_seq) VALUES (?, ?, ?, 0)
             ON CONFLICT (log_key) DO NOTHING`,
            [key, root, chatGeneration(firstLine)],
          )
          begun = true
        }
        await writeRows(tx, key, root, rows.splice(0), receipts.splice(0))
      }
      let sinceYield = 0
      for await (const line of readLines(path)) {
        if (!Buffer.isBuffer(line)) {
          skipped += 1
          continue
        }
        sinceYield += line.length
        if (line.length > MAX_LINE_BYTES) {
          skipped += 1
          continue
        }
        const text = line.toString('utf8').trim()
        if (!text) continue
        let value: unknown
        try {
          value = JSON.parse(text)
        } catch {
          skipped += 1
          continue
        }
        if (!value || typeof value !== 'object') {
          skipped += 1
          continue
        }
        const receipt = readReceipt(value)
        if (receipt) {
          receipts.push(receipt)
        } else if (typeof (value as StoredEvent).type === 'string') {
          for (const row of numbered(value as StoredEvent, seq)) {
            rows.push(row)
            seq = row.seq
          }
        } else skipped += 1
        records += 1
        if (rows.length >= IMPORT_BATCH_ROWS) await flush()
        if (sinceYield >= IMPORT_YIELD_BYTES) {
          sinceYield = 0
          await new Promise((resolve) => setImmediate(resolve))
        }
      }
      await flush()
      // A log whose transcript held only receipts still begins here.
      if (!begun && seq === 0 && records > 0)
        await tx.run(
          `INSERT INTO chat_logs (log_key, workspace_root, generation, last_seq) VALUES (?, ?, ?, 0)
           ON CONFLICT (log_key) DO NOTHING`,
          [key, root, chatGeneration(firstLine)],
        )
    }
    await tx.run('INSERT INTO imports (source, imported_at, records, skipped) VALUES (?, ?, ?, ?)', [
      importSource(key),
      Date.now(),
      records,
      skipped,
    ])
  })
  if (skipped > 0) log?.(`The history of ${key} was moved into the database; ${skipped} damaged lines were skipped.`)
}

/** The rows one stored line becomes, numbered after `seq`. */
function numbered(event: StoredEvent, seq: number): ChatRow[] {
  const own = typeof event.seq === 'number' && Number.isSafeInteger(event.seq) ? event.seq : null
  const parts = Array.isArray(event.parts) ? (event.parts as unknown[]) : null
  const partSeqs = parts?.map((part) => (Array.isArray(part) ? part[3] : undefined))
  const numberedParts = partSeqs?.every((value) => typeof value === 'number') ?? true
  if (own !== null && own > seq && numberedParts) {
    const last = partSeqs?.length ? Math.max(own, ...(partSeqs as number[])) : own
    return [row(event, own, last)]
  }
  // By position: a merged run split back into its deltas, each numbered.
  return expand(event).map((single, index) => {
    const at = typeof single.seq === 'number' && single.seq > seq + index ? single.seq : seq + index + 1
    return row({ ...single, seq: at }, at, at)
  })
}

function row(event: StoredEvent, firstSeq: number, seq: number): ChatRow {
  const turnId = typeof event.payload?.turnId === 'string' ? event.payload.turnId : null
  return { seq, firstSeq, type: String(event.type), turnId, body: JSON.stringify(event) }
}

/** A merged run of deltas as the deltas it was built from; anything else as it is. */
function expand(record: StoredEvent): StoredEvent[] {
  const { parts, ...event } = record
  if (!Array.isArray(parts) || parts.length === 0) return [record]
  const text = typeof event.payload?.text === 'string' ? event.payload.text : null
  if (text === null || !parts.every(isDeltaPart)) return [event]
  if ((parts as DeltaPart[]).reduce((sum, part) => sum + part[2], 0) !== text.length) return [event]
  let offset = 0
  return (parts as DeltaPart[]).map(([id, createdAt, length, seq]) => {
    const single: StoredEvent = {
      ...event,
      id,
      createdAt,
      ...(typeof seq === 'number' ? { seq } : {}),
      payload: { ...event.payload, text: text.slice(offset, offset + length) },
    }
    offset += length
    return single
  })
}

function isDeltaPart(value: unknown): value is DeltaPart {
  return (
    Array.isArray(value) &&
    (value.length === 3 || value.length === 4) &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'number' &&
    typeof value[2] === 'number' &&
    Number.isInteger(value[2]) &&
    value[2] >= 0
  )
}

/** A receipt line (`{"receipt": {...}}`, no `type`), or null. */
function readReceipt(value: unknown): ChatReceiptRow | null {
  const line = (value as { receipt?: unknown; type?: unknown }).receipt
  if ((value as { type?: unknown }).type !== undefined || !line || typeof line !== 'object') return null
  const { id, at } = line as { id?: unknown; at?: unknown }
  if (typeof id !== 'string' || !id || typeof at !== 'number') return null
  return line as ChatReceiptRow
}

/** The first line of a file, as bytes (up to 64 KiB, as the reader hashed it); null when there is no file. */
async function readFirstLine(path: string): Promise<Buffer | null> {
  let file: Awaited<ReturnType<typeof open>>
  try {
    file = await open(path, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const head = buffer.subarray(0, bytesRead)
    const newline = head.indexOf(0x0a)
    return newline < 0 ? head : head.subarray(0, newline)
  } finally {
    await file.close()
  }
}

/**
 * A file's complete lines, as bytes. What follows the last newline is an
 * append a stop cut short (every write ended with one), whose events were
 * never published; it comes back as `torn`.
 */
async function* readLines(path: string): AsyncGenerator<Buffer | { torn: true }> {
  let carry: Buffer[] = []
  let carried = 0
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 }) as AsyncIterable<Buffer>) {
    let start = 0
    for (let end = chunk.indexOf(0x0a, start); end !== -1; end = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, end)
      if (carry.length > 0) {
        carry.push(piece)
        yield Buffer.concat(carry, carried + piece.length)
        carry = []
        carried = 0
      } else yield piece
      start = end + 1
    }
    if (start < chunk.length) {
      // Kept to its length only, past the longest line read: the line is skipped whole.
      if (carried <= MAX_LINE_BYTES) carry.push(Buffer.from(chunk.subarray(start)))
      carried += chunk.length - start
    }
  }
  if (carried > 0) yield { torn: true }
}
