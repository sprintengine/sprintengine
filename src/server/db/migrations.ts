import { StudioDatabaseMigrationError, StudioDatabaseTooNewError, errorText } from './errors'
import { recordTableSql } from './record-table'
import type { SyncConnection } from './sqlite'

// The database's layout, as a numbered list. Each migration runs in its own
// transaction and is recorded by id and name, so a start a crash cut short
// carries on after the last one that finished. They run at every open, before
// any store is built; a failure stops the start, named.
//
// A migration that moves records out of files, or rewrites ones already here,
// goes with a data-format step (`environment/data-format.ts`): the step takes
// the copy of the database a failure is undone from, and its format is what
// an older Studio reads to refuse the folder.
//
// Ids are never reused or renumbered once merged. A database that records a
// migration this build does not know, or under another name, was changed by
// a newer (or another) build, and is refused rather than written on.

export type Migration = {
  id: number
  name: string
  up(connection: SyncConnection): void
}

export const STUDIO_MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'chat-side-records',
    up: (db) =>
      db.exec(`
        -- What a format step or a first open brought in from the files
        -- builds before the database wrote: one row per file, so an import
        -- runs once, and says what it kept and what it skipped.
        CREATE TABLE imports (
          source TEXT PRIMARY KEY,
          imported_at INTEGER NOT NULL,
          records INTEGER NOT NULL,
          skipped INTEGER NOT NULL
        );
        -- A new chat's first message, kept until the chat answers it.
        CREATE TABLE first_messages (
          command_id TEXT PRIMARY KEY,
          body TEXT NOT NULL
        );
        -- "Always allow" rules, in the order they were made (rowid).
        CREATE TABLE approval_rules (
          id TEXT PRIMARY KEY,
          workspace_root TEXT NOT NULL,
          body TEXT NOT NULL
        );
        -- The launch notices' links and queues, kept whole as one record.
        CREATE TABLE launch_notices (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          body TEXT NOT NULL
        );
        -- The prompts a person sent each terminal agent, for the peek.
        CREATE TABLE agent_prompts (
          key TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          body TEXT NOT NULL
        );
        CREATE INDEX agent_prompts_updated ON agent_prompts (updated_at);
      `),
  },
  {
    id: 2,
    name: 'device-and-session-records',
    // One table per store, a row per record (`record-table.ts`): the devices
    // paired with this Studio, the machines it is paired with, browser
    // sessions, embeds, linked local servers, apps' toolsets, file views and
    // extension approvals.
    up: (db) =>
      db.exec(
        (
          [
            'devices',
            'mesh_links',
            'web_sessions',
            'embeds',
            'linked_servers',
            'client_toolsets',
            'file_views',
            'extension_approvals',
          ] as const
        )
          .map(recordTableSql)
          .join('\n'),
      ),
  },
]

/** Run the migrations `connection` has not had, in order; returns the ids it ran. */
export function migrate(connection: SyncConnection, migrations: readonly Migration[] = STUDIO_MIGRATIONS): number[] {
  connection.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
  )
  const known = new Map(migrations.map((migration) => [migration.id, migration.name]))
  const recorded = connection.all<{ id: number; name: string }>('SELECT id, name FROM schema_migrations ORDER BY id')
  for (const row of recorded) {
    const name = known.get(row.id)
    if (name === undefined)
      throw new StudioDatabaseTooNewError(connection.path, `it has migration ${row.id} "${row.name}"`)
    if (name !== row.name)
      throw new StudioDatabaseTooNewError(
        connection.path,
        `its migration ${row.id} is "${row.name}", which this Studio calls "${name}"`,
      )
  }
  const done = new Set(recorded.map((row) => row.id))
  const ran: number[] = []
  for (const migration of [...migrations].sort((a, b) => a.id - b.id)) {
    if (done.has(migration.id)) continue
    try {
      connection.transaction(() => {
        migration.up(connection)
        connection.run('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', [
          migration.id,
          migration.name,
          Date.now(),
        ])
      })
    } catch (error) {
      throw new StudioDatabaseMigrationError(
        `Studio could not bring its database at ${connection.path} up to date (migration ${migration.id} "${migration.name}" failed and was rolled back): ${errorText(error)}`,
        error,
      )
    }
    ran.push(migration.id)
  }
  return ran
}
