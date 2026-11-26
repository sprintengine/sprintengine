import type { StudioDatabase } from './database'

// A small list of records kept whole in memory by its store (paired devices,
// browser sessions, embeds), one row per record in a table of its own. The
// store reads its rows once as it is built and is the authority after that:
// each change saves the list as it now stands, in one transaction, behind
// the save before it. A save still waiting when the next change comes takes
// the newer list instead, so a burst of changes is one write.
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

export type RecordRow = { id: string; body: string }

export type RecordTable = {
  /** The rows as saved, in the order saved: read at once, as the store is built. */
  loadNow(): RecordRow[]
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

export function createRecordTable(
  database: StudioDatabase,
  table: RecordTableName,
  log?: (message: string) => void,
): RecordTable {
  let waiting: { rows: readonly RecordRow[]; done: Promise<boolean> } | null = null
  let tail: Promise<unknown> = Promise.resolve()

  const write = (rows: readonly RecordRow[]) =>
    database.batch([
      { sql: `DELETE FROM ${table}` },
      ...rows.map((row, position) => ({
        sql: `INSERT OR REPLACE INTO ${table} (id, position, body) VALUES (?, ?, ?)`,
        params: [row.id, position, row.body],
      })),
    ])

  return {
    loadNow: () =>
      database.readNow<RecordRow>(`SELECT id, body FROM ${table} ORDER BY position`).map((row) => ({
        id: String(row.id),
        body: String(row.body),
      })),
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
