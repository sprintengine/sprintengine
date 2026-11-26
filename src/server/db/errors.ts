import { dirname } from 'node:path'

// The ways a data folder's database stops a start, each in words that say
// what to do. None is ever read as "no records": a database that cannot be
// read and is treated as empty would be written over, and its records lost.

/** Base of every error below, so a caller can tell a database refusal from a fault. */
export class StudioDatabaseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'StudioDatabaseError'
  }
}

/** The file is damaged, or is not a SQLite database. */
export class StudioDatabaseDamagedError extends StudioDatabaseError {
  constructor(path: string, cause: unknown) {
    super(
      `Studio's database at ${path} is damaged or is not a SQLite database, so Studio cannot start. To recover, quit Studio and move that file, with any -wal and -shm files beside it, out of the folder; or put back a copy (the latest one Studio kept is in ${dirname(path)}/database-copies). Studio makes a new database at the next start.`,
      { cause },
    )
    this.name = 'StudioDatabaseDamagedError'
  }
}

/** The folder's file system cannot hold a database in WAL mode (a network share, a synced folder). */
export class StudioDatabaseFolderError extends StudioDatabaseError {
  constructor(path: string, detail: string, cause?: unknown) {
    super(
      `Studio cannot keep its database in ${dirname(path)}: ${detail}. That usually means the folder is on a network drive or a share. Start Studio with a data folder on a local disk (--data-dir, or SPRINTENGINE_USER_DATA_DIR).`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'StudioDatabaseFolderError'
  }
}

/** A newer Studio changed this database's layout; this one does not know it. */
export class StudioDatabaseTooNewError extends StudioDatabaseError {
  constructor(path: string, detail: string) {
    super(
      `Studio's database at ${path} was changed by a newer Studio (${detail}). Update this Studio, or move the database aside to go back to the records as they were before it.`,
    )
    this.name = 'StudioDatabaseTooNewError'
  }
}

/** A migration failed and was rolled back. */
export class StudioDatabaseMigrationError extends StudioDatabaseError {
  constructor(message: string, cause: unknown) {
    super(message, { cause })
    this.name = 'StudioDatabaseMigrationError'
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
