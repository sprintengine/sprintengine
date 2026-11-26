import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'

import { StudioDatabaseDamagedError, StudioDatabaseError, StudioDatabaseFolderError, errorText } from './errors'
import { migrate, type Migration } from './migrations'
import {
  CONNECTION_PRAGMAS,
  isDamagedSqliteError,
  sqliteErrorCode,
  SQLITE_WORKER_SOURCE,
  SyncConnection,
  type SqlParams,
  type SqlRow,
  type SqlRunResult,
} from './sqlite'

// A data folder's database: `<data>/studio.sqlite`, opened only by the server
// that holds the folder's run lock (`core/data-dir.ts`), so it is the one
// writer. Desktop, each WSL distribution, each SSH machine, each standalone
// server and each profile has its own.
//
// `node:sqlite` is synchronous, so nothing runs on the server's event loop:
// one writer and a small pool of readers, each a worker thread. Writes queue
// on the writer, one at a time; a transaction holds it from BEGIN to COMMIT.
// Reads go to the readers and see what was committed when they started, so a
// long read never holds up a commit (WAL). The file is opened, checked and
// migrated once, on the calling thread, before the workers start.

export const STUDIO_DATABASE_FILENAME = 'studio.sqlite'

/** The database's own file and the two SQLite keeps beside it in WAL mode. */
export function studioDatabaseFiles(dataDir: string): string[] {
  const path = join(dataDir, STUDIO_DATABASE_FILENAME)
  return [path, `${path}-wal`, `${path}-shm`]
}

export type SqlStatement = { sql: string; params?: SqlParams }

/** What a transaction's work may do, on the writer, inside it. */
export type StudioTransaction = {
  all<T = SqlRow>(sql: string, params?: SqlParams): Promise<T[]>
  get<T = SqlRow>(sql: string, params?: SqlParams): Promise<T | undefined>
  run(sql: string, params?: SqlParams): Promise<SqlRunResult>
}

export type StudioDatabase = {
  readonly path: string
  /** Rows, read on a reader: what was committed when the read began. */
  all<T = SqlRow>(sql: string, params?: SqlParams): Promise<T[]>
  get<T = SqlRow>(sql: string, params?: SqlParams): Promise<T | undefined>
  /** One write, committed on its own. */
  run(sql: string, params?: SqlParams): Promise<SqlRunResult>
  /** Several writes in one transaction and one round trip: all of them land, or none. */
  batch(statements: readonly SqlStatement[]): Promise<SqlRunResult[]>
  /**
   * `work` in one transaction on the writer, for a write that reads first.
   * Committed when it resolves, rolled back when it throws. Only `tx` may be
   * used inside it: a call on the database itself would wait for this
   * transaction, which waits for it.
   */
  transaction<T>(work: (tx: StudioTransaction) => Promise<T>): Promise<T>
  /** Finish what is queued, checkpoint and close. Calls after it are refused. */
  close(): Promise<void>
}

export type OpenStudioDatabaseOptions = {
  /** Reader threads; 2 by default. */
  readers?: number
  /** The layout to bring the file to; this build's own by default. */
  migrations?: readonly Migration[]
}

/**
 * Open the folder's database, making it on the first start: checked (a
 * damaged file is refused, named), in WAL mode or refused, migrated, then
 * handed to the workers. Throws a `StudioDatabaseError` the server says and
 * exits on.
 */
export function openStudioDatabase(dataDir: string, options: OpenStudioDatabaseOptions = {}): StudioDatabase {
  const path = join(dataDir, STUDIO_DATABASE_FILENAME)
  prepareStudioDatabase(path, options.migrations).close()
  return new WorkerDatabase(path, Math.max(1, options.readers ?? 2))
}

/**
 * The file at `path`, made if missing, checked, in WAL mode and migrated, as
 * a connection on this thread: for the start-up steps (a format step's
 * import), which close it when done.
 */
export function prepareStudioDatabase(path: string, migrations?: readonly Migration[]): SyncConnection {
  let connection: SyncConnection
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    connection = new SyncConnection(path)
  } catch (error) {
    throw opening(path, error)
  }
  try {
    // Reads the header: a file that is not a database fails here.
    const tables = connection.get<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table'")
    // Only a new file: an existing one would need a whole VACUUM to change it.
    if (!tables?.n) connection.exec('PRAGMA auto_vacuum = INCREMENTAL')
    let mode: unknown
    try {
      mode = connection.get<{ journal_mode: string }>('PRAGMA journal_mode = WAL')?.journal_mode
    } catch (error) {
      if (isDamagedSqliteError(error)) throw error
      throw new StudioDatabaseFolderError(path, `it cannot use write-ahead logging there (${errorText(error)})`, error)
    }
    if (String(mode).toLowerCase() !== 'wal')
      throw new StudioDatabaseFolderError(
        path,
        `it keeps the database in journal mode "${String(mode)}" there, not write-ahead logging`,
      )
    connection.exec(CONNECTION_PRAGMAS)
    // A person's verbatim typing and their approval rules: the owner's alone.
    // SQLite gives the -wal and -shm files the same mode.
    if (process.platform !== 'win32') chmodSync(path, 0o600)
    migrate(connection, migrations)
    return connection
  } catch (error) {
    connection.close()
    throw opening(path, error)
  }
}

// SQLITE_IOERR and SQLITE_CANTOPEN: the file system refused SQLite's own
// files (its WAL and shared-memory files among them), as a network share does.
const FOLDER_CODES = new Set([10, 14])

function opening(path: string, error: unknown): Error {
  const cause = (error as { cause?: unknown } | null)?.cause
  if (isDamagedSqliteError(error) || isDamagedSqliteError(cause)) return new StudioDatabaseDamagedError(path, error)
  if (error instanceof StudioDatabaseError) return error
  const code = sqliteErrorCode(error)
  if (code !== null && FOLDER_CODES.has(code & 0xff))
    return new StudioDatabaseFolderError(
      path,
      `SQLite could not read or write its files there, so it cannot use write-ahead logging (${errorText(error)})`,
      error,
    )
  return new StudioDatabaseError(`Studio could not open its database at ${path}: ${errorText(error)}`, { cause: error })
}

/** An error a worker sent back, with SQLite's code on it as `node:sqlite` gives it. */
class StudioSqlError extends Error {
  readonly code?: string
  readonly errcode?: number
  readonly errstr?: string
  constructor(failure: WorkerFailure) {
    super(failure.message)
    this.name = 'StudioSqlError'
    if (typeof failure.code === 'string') this.code = failure.code
    if (typeof failure.errcode === 'number') this.errcode = failure.errcode
    if (typeof failure.errstr === 'string') this.errstr = failure.errstr
  }
}

type WorkerFailure = { message: string; code?: unknown; errcode?: unknown; errstr?: unknown }
type WorkerRequest =
  | { kind: 'all' | 'get' | 'run'; sql: string; params: SqlParams }
  | { kind: 'exec'; sql: string }
  | { kind: 'batch'; statements: Array<{ sql: string; params: SqlParams }> }
type WorkerReply = { id: number; value?: unknown; error?: WorkerFailure }
type WorkerStartup = { ready: boolean; error?: WorkerFailure }

const CLOSE_WAIT_MS = 10_000

/**
 * One worker thread with one connection. Started on first use, and again
 * after it stops (a request then fails, never a later one); `generation`
 * tells a transaction that its connection is not the one it began on.
 */
class WorkerConnection {
  generation = 0
  private worker: Worker | null = null
  private started: Promise<void> | null = null
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  private nextId = 0
  private starting = 0
  private closing: Promise<void> | null = null

  constructor(
    private readonly path: string,
    private readonly role: 'writer' | 'reader',
  ) {}

  get load(): number {
    return this.pending.size
  }

  /** Send a request; with `generation`, only to the connection that number names. */
  async call(request: WorkerRequest, generation?: number): Promise<unknown> {
    if (this.closing) throw new StudioDatabaseError('The database is closed.')
    if (generation !== undefined && (generation !== this.generation || !this.worker))
      throw new StudioDatabaseError('The database writer stopped during this transaction, so it was not committed.')
    const worker = this.start()
    // Held while it starts, too: a request waiting on it keeps the process up.
    this.starting += 1
    worker.ref()
    try {
      await this.started
    } catch (error) {
      throw opening(this.path, error)
    } finally {
      this.starting -= 1
      this.idle(worker)
    }
    if (this.worker !== worker)
      throw new StudioDatabaseError('The database connection stopped before the request was sent.')
    const id = ++this.nextId
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.ref()
      worker.postMessage({ id, ...request })
    })
  }

  private start(): Worker {
    if (this.worker) return this.worker
    this.generation += 1
    const worker = new Worker(SQLITE_WORKER_SOURCE, {
      eval: true,
      workerData: { path: this.path, readOnly: this.role === 'reader', pragmas: CONNECTION_PRAGMAS },
    })
    this.worker = worker
    this.started = new Promise<void>((resolve, reject) => {
      const onStartup = (message: WorkerStartup | WorkerReply) => {
        if (!('ready' in message)) return
        worker.off('message', onStartup)
        if (message.ready) {
          resolve()
          return
        }
        reject(failure(this.path, message.error ?? { message: 'the database worker did not start' }))
        // Ended, so the next request starts a fresh one and says why it could not.
        if (this.worker === worker) this.worker = null
        void worker.terminate()
      }
      worker.on('message', onStartup)
      worker.once('exit', () => reject(new StudioDatabaseError('The database worker stopped before it was ready.')))
    })
    // Said to the caller that waits on it; here only so it is never unhandled.
    this.started.catch(() => undefined)
    worker.on('message', (message: WorkerReply | WorkerStartup) => {
      if ('id' in message) this.settle(message.id, message)
    })
    const stopped = (error: Error) => {
      if (this.worker !== worker) return
      this.worker = null
      for (const [id] of [...this.pending]) this.settle(id, { id, error: { message: error.message } })
    }
    worker.on('error', (error: unknown) => stopped(error instanceof Error ? error : new Error(String(error))))
    worker.on('exit', (code) => stopped(new StudioDatabaseError(`The database ${this.role} stopped (exit ${code}).`)))
    worker.unref()
    return worker
  }

  private settle(id: number, reply: WorkerReply): void {
    const waiting = this.pending.get(id)
    if (!waiting) return
    this.pending.delete(id)
    if (this.worker) this.idle(this.worker)
    if (reply.error) waiting.reject(new StudioSqlError(reply.error))
    else waiting.resolve(reply.value)
  }

  /** Let the process exit past the thread once nothing waits on it. */
  private idle(worker: Worker): void {
    if (this.pending.size === 0 && this.starting === 0) worker.unref()
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      const worker = this.worker
      if (!worker) return
      worker.ref()
      const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()))
      worker.postMessage({ close: true })
      let timer: NodeJS.Timeout | undefined
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), CLOSE_WAIT_MS)
      })
      if ((await Promise.race([exited, late])) === 'late') await worker.terminate()
      clearTimeout(timer)
    })()
    return this.closing
  }
}

function failure(path: string, error: WorkerFailure): Error {
  const sqlError = new StudioSqlError(error)
  if (isDamagedSqliteError(sqlError)) return new StudioDatabaseDamagedError(path, sqlError)
  if (error.code === 'STUDIO_NOT_WAL') return new StudioDatabaseFolderError(path, error.message, sqlError)
  return sqlError
}

class WorkerDatabase implements StudioDatabase {
  private readonly writer: WorkerConnection
  private readonly readers: WorkerConnection[]
  // Writes, one at a time: each statement, batch and transaction in turn.
  private queue: Promise<unknown> = Promise.resolve()
  private closed: Promise<void> | null = null

  constructor(
    readonly path: string,
    readers: number,
  ) {
    this.writer = new WorkerConnection(path, 'writer')
    this.readers = Array.from({ length: readers }, () => new WorkerConnection(path, 'reader'))
  }

  private reader(): WorkerConnection {
    return this.readers.reduce((least, reader) => (reader.load < least.load ? reader : least))
  }

  private refuseClosed(): void {
    if (this.closed) throw new StudioDatabaseError('The database is closed.')
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new StudioDatabaseError('The database is closed.'))
    const next = this.queue.then(work)
    this.queue = next.catch(() => undefined)
    return next
  }

  async all<T = SqlRow>(sql: string, params: SqlParams = []): Promise<T[]> {
    this.refuseClosed()
    return (await this.reader().call({ kind: 'all', sql, params: [...params] })) as T[]
  }

  async get<T = SqlRow>(sql: string, params: SqlParams = []): Promise<T | undefined> {
    this.refuseClosed()
    return ((await this.reader().call({ kind: 'get', sql, params: [...params] })) ?? undefined) as T | undefined
  }

  run(sql: string, params: SqlParams = []): Promise<SqlRunResult> {
    return this.exclusive(
      async () => (await this.writer.call({ kind: 'run', sql, params: [...params] })) as SqlRunResult,
    )
  }

  batch(statements: readonly SqlStatement[]): Promise<SqlRunResult[]> {
    if (statements.length === 0) return Promise.resolve([])
    return this.exclusive(
      async () =>
        (await this.writer.call({
          kind: 'batch',
          statements: statements.map((statement) => ({ sql: statement.sql, params: [...(statement.params ?? [])] })),
        })) as SqlRunResult[],
    )
  }

  transaction<T>(work: (tx: StudioTransaction) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      await this.writer.call({ kind: 'exec', sql: 'BEGIN IMMEDIATE' })
      const generation = this.writer.generation
      let open = true
      const step = async (request: WorkerRequest) => {
        if (!open) throw new StudioDatabaseError('This transaction is over.')
        return this.writer.call(request, generation)
      }
      const tx: StudioTransaction = {
        all: async <R>(sql: string, params: SqlParams = []) =>
          (await step({ kind: 'all', sql, params: [...params] })) as R[],
        get: async <R>(sql: string, params: SqlParams = []) =>
          ((await step({ kind: 'get', sql, params: [...params] })) ?? undefined) as R | undefined,
        run: async (sql: string, params: SqlParams = []) =>
          (await step({ kind: 'run', sql, params: [...params] })) as SqlRunResult,
      }
      try {
        const result = await work(tx)
        await this.writer.call({ kind: 'exec', sql: 'COMMIT' }, generation)
        return result
      } catch (error) {
        await this.writer.call({ kind: 'exec', sql: 'ROLLBACK' }, generation).catch(() => undefined)
        throw error
      } finally {
        open = false
      }
    })
  }

  close(): Promise<void> {
    this.closed ??= (async () => {
      // Queued writes land first; then the readers, and the writer last, so
      // its close checkpoints the WAL into the file and removes it.
      await this.queue
      await Promise.all(this.readers.map((reader) => reader.close()))
      await this.writer.close()
    })()
    return this.closed
  }
}
