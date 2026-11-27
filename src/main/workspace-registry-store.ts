/**
 * Persistence for the main-owned workspace registry (shapes and record
 * math in `src/shared/workspace-registry.ts`).
 *
 * In the data folder's database: a row per chat record (`chats`) and one row
 * for the rest of the registry (`chat_registry`: its revision, windows, the
 * active chat, tombstones). A mutation that spans several records (closing a
 * window re-homes every workspace it held) is one transaction, and each write
 * changes only the rows that changed, so a settle or a snooze is a few hundred
 * bytes rather than the whole registry, and it is committed within the
 * transaction's own round trip instead of after a debounce.
 *
 * Writes go one at a time; one asked for while another is being written
 * waits, and only the newest of those waiting is written. A failed write
 * degrades to a warning diagnostic, memory still authoritative for the
 * session, and the next write writes every row that differs again.
 */
import type { SqlStatement, StudioDatabase } from '../server/db/database'
import { rowChangeStatements } from '../server/db/record-table'
import { parseWorkspaceRegistryFile, type WorkspaceRegistryFile } from '../shared/workspace-registry'

/** The file builds before the database kept the registry in, under the data folder; read once, by the import. */
export const WORKSPACE_REGISTRY_FILE_NAME = 'workspace-registry.json'

type WorkspaceRegistryStoreDiagnostic = {
  level: 'warning'
  title: string
  message: string
  details?: string
}

export type WorkspaceRegistryStoreDeps = {
  database: StudioDatabase
  logDiagnostic?: (diagnostic: WorkspaceRegistryStoreDiagnostic) => void
}

export type WorkspaceRegistryReadOutcome =
  | { status: 'loaded'; file: WorkspaceRegistryFile; droppedRecords: { id: string; reason: string }[] }
  | { status: 'missing' }
  | { status: 'unreadable'; details: string }

export type WorkspaceRegistryStore = {
  read(): WorkspaceRegistryReadOutcome
  write(file: WorkspaceRegistryFile): void
  whenWritten(): Promise<void>
  flush(): Promise<void>
}

/** The registry without its records: the `chat_registry` row's body. */
function headOf(file: WorkspaceRegistryFile): string {
  const { workspaces: _workspaces, ...head } = file
  return JSON.stringify(head)
}

export function createWorkspaceRegistryStore(deps: WorkspaceRegistryStoreDeps): WorkspaceRegistryStore {
  const db = deps.database
  // What the database holds now, row by row: a write changes only what differs,
  // and one that differs in nothing is no write.
  let writtenHead: string | null = null
  let writtenRows = new Map<string, { position: number; body: string }>()
  // Whether `writtenRows` is known to be every row there is: only once the
  // registry loaded or a write replaced them all. Until then (none read, or
  // one that did not read) the first write replaces every row, so a record
  // left from the registry that did not read never comes back at a restart.
  let rowsKnown = false
  let waiting: WorkspaceRegistryFile | null = null
  let writing: Promise<void> = Promise.resolve()
  let busy = false

  /**
   * Read the registry as the database has it. `missing` and `unreadable` are
   * kept apart because they lead to different recovery: none is a fresh data
   * folder, unreadable is damage that must not present as an empty workspace
   * list.
   */
  function read(): WorkspaceRegistryReadOutcome {
    let head: Array<{ body: string }>
    let rows: Array<{ id: string; position: number; body: string }>
    try {
      head = db.readNow<{ body: string }>('SELECT body FROM chat_registry WHERE id = 1')
      rows = db.readNow<{ id: string; position: number; body: string }>(
        'SELECT id, position, body FROM chats ORDER BY position',
      )
    } catch (error) {
      const details = error instanceof Error ? error.message : 'unknown_read_error'
      deps.logDiagnostic?.({
        level: 'warning',
        title: 'Workspace registry read failed',
        message: 'Unable to read the workspace registry; falling back to the recovery order.',
        details,
      })
      return { status: 'unreadable', details }
    }
    if (head.length === 0) {
      // None, because the file the import found did not read: that is damage,
      // not a fresh folder, and the file is still there as it was.
      const skipped = importSkipped()
      if (skipped) {
        deps.logDiagnostic?.({
          level: 'warning',
          title: 'Workspace registry parse failed',
          message: `${WORKSPACE_REGISTRY_FILE_NAME} did not read when it was imported, and is kept as it was; falling back to the recovery order.`,
          details: 'import_skipped',
        })
        return { status: 'unreadable', details: 'import_skipped' }
      }
      return { status: 'missing' }
    }
    let parsed: ReturnType<typeof parseWorkspaceRegistryFile>
    try {
      const workspaces = rows.flatMap((row) => {
        try {
          return [JSON.parse(row.body) as unknown]
        } catch {
          // A row that does not read is the record parser's to drop, named.
          return [{ id: row.id }]
        }
      })
      parsed = parseWorkspaceRegistryFile({ ...(JSON.parse(head[0]!.body) as object), workspaces })
    } catch (error) {
      const details = error instanceof Error ? error.message : 'unknown_parse_error'
      deps.logDiagnostic?.({
        level: 'warning',
        title: 'Workspace registry parse failed',
        message: 'The workspace registry does not read; falling back to the recovery order.',
        details,
      })
      return { status: 'unreadable', details }
    }
    if (!parsed) {
      deps.logDiagnostic?.({
        level: 'warning',
        title: 'Workspace registry schema not recognised',
        message: 'The workspace registry is not a current-schema registry; falling back to the recovery order.',
      })
      return { status: 'unreadable', details: 'unrecognised_schema' }
    }
    for (const dropped of parsed.droppedRecords) {
      deps.logDiagnostic?.({
        level: 'warning',
        title: 'Workspace registry record dropped',
        message: `Workspace "${dropped.id}" was dropped from the registry; the remaining workspaces loaded normally.`,
        details: `failing_field=${dropped.reason}`,
      })
    }
    writtenHead = head[0]!.body
    writtenRows = new Map(rows.map((row) => [row.id, { position: row.position, body: row.body }]))
    rowsKnown = true
    return { status: 'loaded', file: parsed.file, droppedRecords: parsed.droppedRecords }
  }

  function importSkipped(): boolean {
    try {
      const [imported] = db.readNow<{ records: number; skipped: number }>(
        'SELECT records, skipped FROM imports WHERE source = ?',
        [WORKSPACE_REGISTRY_FILE_NAME],
      )
      return imported !== undefined && imported.skipped > 0 && imported.records === 0
    } catch {
      return false
    }
  }

  async function persist(file: WorkspaceRegistryFile): Promise<void> {
    try {
      const head = headOf(file)
      const rows = new Map(
        file.workspaces.map((record, position) => [record.id, { position, body: JSON.stringify(record) }]),
      )
      const statements: SqlStatement[] = []
      if (head !== writtenHead)
        statements.push({
          sql: 'INSERT INTO chat_registry (id, body) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body',
          params: [head],
        })
      statements.push(...rowChangeStatements('chats', rowsKnown ? writtenRows : null, rows))
      if (statements.length === 0) return
      await db.batch(statements)
      writtenHead = head
      writtenRows = rows
      rowsKnown = true
    } catch (error) {
      // Never a silent success: in-memory state stays authoritative for the
      // session, and the next write writes every row that differs again.
      deps.logDiagnostic?.({
        level: 'warning',
        title: 'Workspace registry not persisted',
        message:
          'The workspace registry could not be written; in-memory workspaces still apply until the app restarts.',
        details: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Write the newest file waiting, then whatever came while it was written. */
  function drain(): Promise<void> {
    busy = true
    writing = (async () => {
      try {
        while (waiting) {
          const file = waiting
          waiting = null
          await persist(file)
        }
      } finally {
        busy = false
      }
    })()
    return writing
  }

  return {
    read,
    /**
     * Write a file: committed in its own transaction, behind any write in
     * flight. Only the rows that differ from what was written are written, so
     * an unchanged registry is no write; nothing serializes the whole file to
     * find that out.
     */
    write(file) {
      waiting = file
      if (!busy) void drain()
    },
    /**
     * Settles once every change accepted so far is committed. What answers a
     * change it was asked for waits on this, so an answer never promises what
     * a crash could still take back. A write that fails settles it too: the
     * failure is reported, and memory stays authoritative.
     */
    whenWritten: () => writing,
    /** Everything accepted so far, committed: the quit's last write. */
    flush: () => writing,
  }
}

/**
 * The registry the file builds before the database wrote holds, rows and
 * head apart (the import), read with the store's own parser: a record it
 * drops as malformed is counted in `skipped` (one of a retired mode is left
 * out without being counted, as a load leaves it out quietly). Null when the
 * file does not read.
 */
export function readWorkspaceRegistryFile(
  raw: string,
): { head: string; records: Array<{ id: string; body: string }>; skipped: number } | null {
  let parsed: ReturnType<typeof parseWorkspaceRegistryFile>
  try {
    parsed = parseWorkspaceRegistryFile(JSON.parse(raw))
  } catch {
    return null
  }
  if (!parsed) return null
  return {
    head: headOf(parsed.file),
    records: parsed.file.workspaces.map((record) => ({ id: record.id, body: JSON.stringify(record) })),
    skipped: parsed.droppedRecords.length,
  }
}

/**
 * An in-memory store with the same contract, for tests that exercise the bus or
 * the authority without a database. `write` is synchronous here on purpose: a
 * test asserting a mutation landed should not have to await a write it does
 * not care about.
 */
export function createInMemoryWorkspaceRegistryStore(
  initial?: WorkspaceRegistryFile,
): WorkspaceRegistryStore & { current(): WorkspaceRegistryFile | null } {
  let current: WorkspaceRegistryFile | null = initial ?? null
  return {
    read: (): WorkspaceRegistryReadOutcome =>
      current ? { status: 'loaded', file: current, droppedRecords: [] } : { status: 'missing' },
    write: (file) => {
      current = file
    },
    whenWritten: async () => undefined,
    flush: async () => undefined,
    current: () => current,
  }
}
