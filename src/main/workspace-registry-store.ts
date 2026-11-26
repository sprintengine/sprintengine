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
import type { StudioDatabase } from '../server/db/database'
import {
  parseWorkspaceRegistryFile,
  serializeWorkspaceRegistryContent,
  type WorkspaceRegistryFile,
} from '../shared/workspace-registry'

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
  // What the database holds now, row by row: a write changes only what differs.
  let writtenHead: string | null = null
  let writtenRows = new Map<string, { position: number; body: string }>()
  // The content key of the newest file accepted for writing, so an unchanged one is no write.
  let acceptedContent: string | null = null
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
    if (head.length === 0) return { status: 'missing' }
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
    acceptedContent = serializeWorkspaceRegistryContent(parsed.file)
    return { status: 'loaded', file: parsed.file, droppedRecords: parsed.droppedRecords }
  }

  async function persist(file: WorkspaceRegistryFile): Promise<void> {
    const head = headOf(file)
    const rows = new Map(file.workspaces.map((record, position) => [record.id, { position, body: JSON.stringify(record) }]))
    const statements: Array<{ sql: string; params: Array<string | number> }> = []
    if (head !== writtenHead)
      statements.push({
        sql: 'INSERT INTO chat_registry (id, body) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body',
        params: [head],
      })
    for (const id of writtenRows.keys())
      if (!rows.has(id)) statements.push({ sql: 'DELETE FROM chats WHERE id = ?', params: [id] })
    for (const [id, row] of rows) {
      const before = writtenRows.get(id)
      if (before && before.body === row.body && before.position === row.position) continue
      statements.push({
        sql: `INSERT INTO chats (id, position, body) VALUES (?, ?, ?)
              ON CONFLICT (id) DO UPDATE SET position = excluded.position, body = excluded.body`,
        params: [id, row.position, row.body],
      })
    }
    if (statements.length === 0) return
    try {
      await db.batch(statements)
      writtenHead = head
      writtenRows = rows
    } catch (error) {
      // Never a silent success: in-memory state stays authoritative for the
      // session, and the next write writes every row that differs again.
      acceptedContent = null
      deps.logDiagnostic?.({
        level: 'warning',
        title: 'Workspace registry not persisted',
        message: 'The workspace registry could not be written; in-memory workspaces still apply until the app restarts.',
        details: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Write the newest file waiting, then whatever came while it was written. */
  function drain(): Promise<void> {
    busy = true
    writing = (async () => {
      while (waiting) {
        const file = waiting
        waiting = null
        await persist(file)
      }
      busy = false
    })()
    return writing
  }

  return {
    read,
    /**
     * Write a file: committed in its own transaction, behind any write in
     * flight. A content-identical file is no write: the authority persists
     * after every accepted mutation, and an unchanged registry is not a new
     * revision.
     */
    write(file) {
      const content = serializeWorkspaceRegistryContent(file)
      if (content === acceptedContent) return
      acceptedContent = content
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

/** The registry the file builds before the database wrote holds, rows and head apart (the import); null when it does not read. */
export function readWorkspaceRegistryFile(raw: string): { head: string; records: Array<{ id: string; body: string }> } | null {
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
