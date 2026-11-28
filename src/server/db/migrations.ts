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
  {
    id: 3,
    name: 'chat-history',
    up: (db) =>
      db.exec(`
        -- One log per agent of a chat (chat-logs.ts), named <chat>/<agent>.
        CREATE TABLE chat_logs (
          log_key TEXT PRIMARY KEY,
          workspace_root TEXT NOT NULL,
          generation TEXT NOT NULL,
          last_seq INTEGER NOT NULL
        );
        -- Its events by sequence number; a merged run of deltas is one row.
        CREATE TABLE chat_events (
          log_key TEXT NOT NULL,
          seq INTEGER NOT NULL,
          first_seq INTEGER NOT NULL,
          type TEXT NOT NULL,
          turn_id TEXT,
          bytes INTEGER NOT NULL,
          body TEXT NOT NULL,
          PRIMARY KEY (log_key, seq)
        ) WITHOUT ROWID;
        CREATE INDEX chat_events_turn ON chat_events (log_key, turn_id) WHERE turn_id IS NOT NULL;
        CREATE INDEX chat_events_type ON chat_events (log_key, type, seq);
        -- A command's receipt, written with what it committed. No cap.
        CREATE TABLE chat_receipts (
          log_key TEXT NOT NULL,
          command_id TEXT NOT NULL,
          at INTEGER NOT NULL,
          body TEXT NOT NULL,
          PRIMARY KEY (log_key, command_id)
        );
        -- The chat list's row for each log, folded from its events up to folded_seq.
        CREATE TABLE chat_threads (
          log_key TEXT PRIMARY KEY,
          chat_key TEXT NOT NULL,
          folded_seq INTEGER NOT NULL,
          thread TEXT,
          fold TEXT NOT NULL
        );
        CREATE INDEX chat_threads_chat ON chat_threads (chat_key);
        -- What search reads: a person's message, and an agent's reply, per turn.
        CREATE TABLE chat_search_docs (
          id INTEGER PRIMARY KEY,
          log_key TEXT NOT NULL,
          chat_key TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          seq INTEGER NOT NULL,
          origin TEXT NOT NULL,
          body TEXT NOT NULL,
          UNIQUE (log_key, turn_id, kind)
        );
        CREATE INDEX chat_search_docs_chat ON chat_search_docs (chat_key);
        CREATE VIRTUAL TABLE chat_search USING fts5(
          body, content = 'chat_search_docs', content_rowid = 'id', tokenize = 'trigram'
        );
        CREATE TRIGGER chat_search_docs_added AFTER INSERT ON chat_search_docs BEGIN
          INSERT INTO chat_search (rowid, body) VALUES (new.id, new.body);
        END;
        CREATE TRIGGER chat_search_docs_removed AFTER DELETE ON chat_search_docs BEGIN
          INSERT INTO chat_search (chat_search, rowid, body) VALUES ('delete', old.id, old.body);
        END;
        CREATE TRIGGER chat_search_docs_changed AFTER UPDATE ON chat_search_docs BEGIN
          INSERT INTO chat_search (chat_search, rowid, body) VALUES ('delete', old.id, old.body);
          INSERT INTO chat_search (rowid, body) VALUES (new.id, new.body);
        END;
        -- The chats whose provider turn may still be open (conversation-outbox.ts).
        CREATE TABLE turn_outbox (
          workspace_root TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          PRIMARY KEY (workspace_root, workspace_id, agent_id)
        );
        -- A tool's detail, and the output it streamed, by <chat>/<agent>/<tool use>.
        CREATE TABLE tool_details (
          detail_key TEXT PRIMARY KEY,
          log_key TEXT NOT NULL,
          body TEXT NOT NULL
        );
        CREATE INDEX tool_details_log ON tool_details (log_key);
        CREATE TABLE tool_outputs (
          detail_key TEXT NOT NULL,
          part INTEGER NOT NULL,
          log_key TEXT NOT NULL,
          bytes BLOB NOT NULL,
          PRIMARY KEY (detail_key, part)
        );
        CREATE INDEX tool_outputs_log ON tool_outputs (log_key);
      `),
  },
  {
    id: 4,
    name: 'chat-records',
    up: (db) =>
      db.exec(`
        -- The chat records (the workspace registry), a row each, in their order.
        CREATE TABLE chats (id TEXT PRIMARY KEY, position INTEGER NOT NULL, body TEXT NOT NULL);
        -- The rest of the registry: its revision, windows, the active chat, tombstones.
        CREATE TABLE chat_registry (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL);
        -- Stores kept whole as one record each (snapshot-storage.ts).
        CREATE TABLE store_records (name TEXT PRIMARY KEY, body TEXT NOT NULL);
      `),
  },
  {
    id: 5,
    name: 'pull-request-record',
    // The pull request record, a row per pull request (`record-table.ts`).
    up: (db) => db.exec(recordTableSql('pull_requests')),
  },
  {
    id: 6,
    name: 'worktree-records',
    up: (db) =>
      db.exec(`
        -- The branches Studio made for worktrees (worktree-branch-ledger.ts), numbered in the order recorded.
        CREATE TABLE worktree_branches (
          seq INTEGER PRIMARY KEY,
          repo TEXT NOT NULL,
          branch TEXT NOT NULL,
          UNIQUE (repo, branch)
        );
        -- Each worktree pool's record (worktree-pool/pool-store.ts), written whole.
        CREATE TABLE pool_records (pool_id TEXT PRIMARY KEY, body TEXT NOT NULL);
      `),
  },
  {
    id: 7,
    name: 'chat-moves',
    // A chat's move to another project while its record is not yet written (chat-moves.ts).
    up: (db) =>
      db.exec(`
        CREATE TABLE chat_moves (
          workspace_id TEXT PRIMARY KEY,
          from_folder TEXT NOT NULL,
          to_folder TEXT NOT NULL,
          from_key TEXT NOT NULL,
          to_key TEXT NOT NULL
        );
      `),
  },
  {
    id: 8,
    name: 'adoptions',
    // What a hand-over kept here under which digest (environment-adoption.ts), a row per record.
    up: (db) =>
      db.exec(`
        CREATE TABLE adoptions (
          key TEXT PRIMARY KEY,
          digest TEXT NOT NULL,
          migration_id TEXT NOT NULL,
          at INTEGER NOT NULL,
          pending INTEGER NOT NULL
        );
      `),
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
