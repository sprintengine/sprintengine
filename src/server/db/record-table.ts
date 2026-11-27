import type { SqlStatement, StudioDatabase } from './database'

// A list of records kept whole in memory by its store (paired devices,
// browser sessions, embeds, the pull request record), one row per record in a
// table of its own. The store reads its rows once as it is built and is the
// authority after that: each change saves the list as it now stands, in one
// transaction, behind the save before it. A save still waiting when the next
// change comes takes the newer list instead, so a burst of changes is one
// write. A save writes only the rows that changed since the last one, so a
// list of thousands costs a change's rows, not the whole list.
//
// A row's body is the record as the store's file kept it, read back with the
// store's own parser, so record shapes and their checks do not change.

/** The tables kept this way. */
export type RecordTableName =
  | 'devices'
  | 'mesh_links'
  | 'web_sessions'
  | 'embeds'
  | 'linked_servers'
  | 'client_toolsets'
  | 'file_views'
  | 'extension_approvals'
  | 'pull_requests'

export type RecordRow = { id: string; body: string }

type StoredRow = { id: unknown; position: unknown; body: unknown }

export type RecordTable = {
  /** The rows as saved, in the order saved: read at once, as the store is built. */
  loadNow(): RecordRow[]
  /** The rows as saved, for a store that loads after it is built. */
  load(): Promise<RecordRow[]>
  /**
   * Keep exactly these rows; resolves true once they are committed, false
   * when the write failed (logged; the next save writes the whole list again).
   */
  save(rows: readonly RecordRow[]): Promise<boolean>
  /** Resolves once every save asked for so far is committed (or failed). */
  flush(): Promise<void>
}

/** `CREATE TABLE` for one record table (migrations.ts). */
export function recordTableSql(table: RecordTableName): string {
  return `CREATE TABLE ${table} (id TEXT PRIMARY KEY, position INTEGER NOT NULL, body TEXT NOT NULL);`
}

/** A table's rows as written: by id, with the position and body each was written with. */
export type WrittenRows = ReadonlyMap<string, { position: number; body: string }>

/**
 * The statements that bring `table` from `before` to `rows`: the rows gone
 * deleted, the rows new or changed (in body or position) written, the rest
 * left alone. `before` null (not known what the table holds) empties it first.
 */
export function rowChangeStatements(
  table: RecordTableName | 'chats',
  before: WrittenRows | null,
  rows: WrittenRows,
): SqlStatement[] {
  const statements: SqlStatement[] = []
  if (before === null) statements.push({ sql: `DELETE FROM ${table}` })
  for (const id of before?.keys() ?? [])
    if (!rows.has(id)) statements.push({ sql: `DELETE FROM ${table} WHERE id = ?`, params: [id] })
  for (const [id, row] of rows) {
    const was = before?.get(id)
    if (was && was.body === row.body && was.position === row.position) continue
    statements.push({
      sql: `INSERT INTO ${table} (id, position, body) VALUES (?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET position = excluded.position, body = excluded.body`,
      params: [id, row.position, row.body],
    })
  }
  return statements
}

/** `rows` as a table holds them: by id, each at its place in the list. */
function writtenRowsOf(rows: readonly RecordRow[]): Map<string, { position: number; body: string }> {
  return new Map(rows.map((row, position) => [row.id, { position, body: row.body }]))
}

export function createRecordTable(
  database: StudioDatabase,
  table: RecordTableName,
  log?: (message: string) => void,
): RecordTable {
  let waiting: { rows: readonly RecordRow[]; done: Promise<boolean> } | null = null
  let tail: Promise<unknown> = Promise.resolve()
  // What the table holds, as last loaded or saved; null when that is not known
  // (nothing loaded yet, or a save failed), and the next save then writes the
  // whole list again.
  let written: WrittenRows | null = null

  const selectAll = `SELECT id, position, body FROM ${table} ORDER BY position`
  const loaded = (stored: StoredRow[]): RecordRow[] => {
    const rows = stored.map((row) => ({ id: String(row.id), position: Number(row.position), body: String(row.body) }))
    written = new Map(rows.map((row) => [row.id, { position: row.position, body: row.body }]))
    return rows.map(({ id, body }) => ({ id, body }))
  }

  const write = async (rows: readonly RecordRow[]) => {
    const next = writtenRowsOf(rows)
    const statements = rowChangeStatements(table, written, next)
    written = null
    if (statements.length > 0) await database.batch(statements)
    written = next
  }

  return {
    loadNow: () => loaded(database.readNow<StoredRow>(selectAll)),
    load: async () => loaded(await database.all<StoredRow>(selectAll)),
    save(rows) {
      if (waiting) {
        waiting.rows = rows
        return waiting.done
      }
      const entry: { rows: readonly RecordRow[]; done: Promise<boolean> } = { rows, done: Promise.resolve(true) }
      entry.done = tail.then(async () => {
        if (waiting === entry) waiting = null
        try {
          await write(entry.rows)
          return true
        } catch (error) {
          log?.(`Could not save ${table}: ${error instanceof Error ? error.message : String(error)}`)
          return false
        }
      })
      waiting = entry
      tail = entry.done
      return entry.done
    },
    flush: async () => {
      await tail
    },
  }
}
