import type { StudioDatabase } from './database'

// A small store kept whole, as one record (`store_records`, a row by name): a
// store whose records are read and written together (the schedules with
// their runs, the scheduled messages, the usage-limit resumes), each change
// one transaction. Read with the store's own parser, as its file was.

export type SnapshotStoreName = 'schedules' | 'scheduled_messages' | 'usage_limit_resumes'

export type SnapshotStorage = {
  /** The record as last written, or null when there is none. */
  read(): Promise<string | null>
  write(body: string): Promise<void>
}

export function createSnapshotStorage(database: StudioDatabase, name: SnapshotStoreName): SnapshotStorage {
  return {
    read: async () =>
      (await database.get<{ body: string }>('SELECT body FROM store_records WHERE name = ?', [name]))?.body ?? null,
    write: async (body) => {
      await database.run(
        'INSERT INTO store_records (name, body) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET body = excluded.body',
        [name, body],
      )
    },
  }
}
