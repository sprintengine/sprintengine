import type { DatabaseSync } from 'node:sqlite'

// The one module that touches `node:sqlite`, which Node still marks
// experimental: an API change touches this file and nothing else. It holds
// the connection the start-up steps use on the main thread (`SyncConnection`)
// and the source of the worker threads every later query runs on
// (`SQLITE_WORKER_SOURCE`, inlined so a bundle needs no file beside it).
//
// The driver is built into Node (22.13 and later without a flag), so the
// desktop's utility process, a standalone server and the self-contained tree a
// WSL distribution or an SSH machine runs all have it with no native module.

/** What a statement binds and a row holds. */
export type SqlValue = null | number | bigint | string | Uint8Array
export type SqlParams = readonly SqlValue[]
export type SqlRow = Record<string, SqlValue>
export type SqlRunResult = { changes: number; lastInsertRowid: number }

// Every connection's settings, the start-up one and each worker's.
//
// - `busy_timeout`: the writer's commits and a reader's snapshot wait for
//   each other briefly rather than fail with SQLITE_BUSY.
// - `synchronous = NORMAL` in WAL: an app crash loses nothing committed; a
//   power cut can lose the last moments but never leaves half a record.
// - `checkpoint_fullfsync`: macOS's fsync stops at the drive's cache; this
//   flushes it at checkpoints, and is ignored elsewhere.
// - `temp_store = MEMORY`: sorts and statement journals stay off the disk.
// - `journal_size_limit`: a WAL a burst grew is cut back after a checkpoint.
export const CONNECTION_PRAGMAS = [
  'PRAGMA busy_timeout = 5000',
  'PRAGMA foreign_keys = ON',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA checkpoint_fullfsync = ON',
  'PRAGMA temp_store = MEMORY',
  `PRAGMA journal_size_limit = ${128 * 1024 * 1024}`,
].join(';\n')

// SQLITE_CORRUPT and SQLITE_NOTADB. node:sqlite reports the extended code,
// whose low byte is the primary one.
const DAMAGED_CODES = new Set([11, 26])

/** The SQLite result code an error from `node:sqlite` (or a worker's copy of one) carries; null for any other error. */
export function sqliteErrorCode(error: unknown): number | null {
  const code = (error as { errcode?: unknown } | null)?.errcode
  return typeof code === 'number' ? code : null
}

/** Whether the error says the file is damaged or is not a SQLite database. */
export function isDamagedSqliteError(error: unknown): boolean {
  const code = sqliteErrorCode(error)
  return code !== null && DAMAGED_CODES.has(code & 0xff)
}

const EXPERIMENTAL_WARNING = /SQLite is an experimental feature/u

let driver: typeof import('node:sqlite') | null = null

/**
 * The driver, loaded on first use with Node 22's one experimental warning
 * left unsaid: it would print on every start of a standalone server, and says
 * nothing the person can act on. Every other warning is said as before.
 */
function sqlite(): typeof import('node:sqlite') {
  if (driver) return driver
  const emitWarning = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning?.message
    if (EXPERIMENTAL_WARNING.test(String(text))) return
    ;(emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest)
  }) as typeof process.emitWarning
  try {
    driver = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')
  } finally {
    process.emitWarning = emitWarning
  }
  if (!driver) throw new Error(`This Node (${process.versions.node}) has no node:sqlite; Studio needs Node 22.13 or later.`)
  return driver
}

/**
 * A connection on the calling thread, for the steps that run once at start
 * before anything is served: opening the file, its migrations, a format
 * step's import and copy. Everything after start goes through the workers.
 */
export class SyncConnection {
  private readonly db: DatabaseSync
  private open = true

  constructor(
    readonly path: string,
    options: { readOnly?: boolean } = {},
  ) {
    const { DatabaseSync } = sqlite()
    this.db = new DatabaseSync(path, { readOnly: options.readOnly === true })
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  all<T = SqlRow>(sql: string, params: SqlParams = []): T[] {
    return this.db.prepare(sql).all(...params) as T[]
  }

  get<T = SqlRow>(sql: string, params: SqlParams = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined
  }

  run(sql: string, params: SqlParams = []): SqlRunResult {
    const result = this.db.prepare(sql).run(...params)
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
  }

  /** `work` in one transaction: committed when it returns, rolled back when it throws. */
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // Already rolled back by SQLite itself (a full disk, an interrupt).
      }
      throw error
    }
  }

  close(): void {
    if (!this.open) return
    this.open = false
    this.db.close()
  }
}

/**
 * The worker thread each connection after start runs on: one writer, a few
 * readers. Evaluated from this string (`eval: true`), so the bundles carry it
 * inline. It answers `{ id, value }` or `{ id, error }` for each request.
 *
 * - `all`, `get`, `run`: one statement, prepared once and cached.
 * - `batch`: several `run`s in one transaction, in one round trip.
 * - `exec`: SQL with no rows (BEGIN, COMMIT, a pragma).
 *
 * A reader is opened read-only, so a write sent to one fails rather than
 * taking the writer's place; and every connection refuses a database not in
 * WAL mode, where a reader's lock would hold up the writer's commits.
 */
export const SQLITE_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
const emitWarning = process.emitWarning
process.emitWarning = (warning, ...rest) => {
  if (/SQLite is an experimental feature/.test(String(warning && warning.message ? warning.message : warning))) return
  return emitWarning.call(process, warning, ...rest)
}
const { DatabaseSync } = require('node:sqlite')
process.emitWarning = emitWarning
const describe = (error) => ({
  message: String(error && error.message ? error.message : error),
  code: error && error.code,
  errcode: error && error.errcode,
  errstr: error && error.errstr,
})
let db
try {
  db = new DatabaseSync(workerData.path, { readOnly: workerData.readOnly })
  db.exec(workerData.pragmas)
  const mode = String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase()
  if (mode !== 'wal') throw Object.assign(new Error('the database is in journal mode ' + mode + ', not wal'), { code: 'STUDIO_NOT_WAL' })
  parentPort.postMessage({ ready: true })
} catch (error) {
  db = undefined
  parentPort.postMessage({ ready: false, error: describe(error) })
}
const cache = new Map()
const prepare = (sql) => {
  let statement = cache.get(sql)
  if (statement) {
    cache.delete(sql)
  } else {
    statement = db.prepare(sql)
    if (cache.size >= 200) cache.delete(cache.keys().next().value)
  }
  cache.set(sql, statement)
  return statement
}
const run = (sql, params) => {
  const result = prepare(sql).run(...params)
  return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
}
parentPort.on('message', (request) => {
  if (request.close) {
    // Closing checkpoints the WAL and removes it, which ending the thread would skip.
    try {
      if (db) db.close()
    } catch {}
    db = undefined
    parentPort.postMessage({ closed: true })
    parentPort.close()
    return
  }
  const { id, kind, sql, params, statements } = request
  try {
    if (!db) throw new Error('the database connection is not open')
    let value
    if (kind === 'all') value = prepare(sql).all(...params)
    else if (kind === 'get') value = prepare(sql).get(...params)
    else if (kind === 'run') value = run(sql, params)
    else if (kind === 'exec') value = (db.exec(sql), null)
    else if (kind === 'batch') {
      db.exec('BEGIN IMMEDIATE')
      try {
        value = statements.map((statement) => run(statement.sql, statement.params))
        db.exec('COMMIT')
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {}
        throw error
      }
    } else throw new Error('unknown request ' + kind)
    parentPort.postMessage({ id, value })
  } catch (error) {
    // A statement that threw mid-step may stay active; a fresh one is prepared next time.
    if (sql) cache.delete(sql)
    parentPort.postMessage({ id, error: describe(error) })
  }
})
`
