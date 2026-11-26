import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { STUDIO_DATABASE_FILENAME } from './database'
import { SyncConnection } from './sqlite'

// The one copy of the database Studio keeps: taken just before a format step
// changes it, and only the latest. Before the first step there is no
// database, and the files the builds before it wrote are the way back; after
// it those files are no longer read, so a later step's way back is this copy.
// There is no daily copy (owner decision 2026-11-25).

export const DATABASE_COPIES_DIRNAME = 'database-copies'

/** The copy taken before the step to `format`, relative to the data folder. */
export function databaseCopyName(format: number): string {
  return join(DATABASE_COPIES_DIRNAME, `studio-before-format-${format}.sqlite`)
}

/**
 * Copy the folder's database to `relative` (one consistent file, the WAL's
 * commits included: `VACUUM INTO`), flushed to the disk before it is named.
 * Only while nothing else has the database open: at start, before the server
 * opens it.
 */
export function copyStudioDatabase(dataDir: string, relative: string): void {
  mkdirSync(join(dataDir, DATABASE_COPIES_DIRNAME), { recursive: true, mode: 0o700 })
  const target = join(dataDir, relative)
  const partial = `${target}.partial`
  rmSync(partial, { force: true })
  const connection = new SyncConnection(join(dataDir, STUDIO_DATABASE_FILENAME))
  try {
    connection.run('VACUUM INTO ?', [partial])
  } finally {
    connection.close()
  }
  if (process.platform !== 'win32') chmodSync(partial, 0o600)
  const fd = openSync(partial, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(partial, target)
}

/** Remove every copy but `keep` (relative to the data folder), and any copy a stop cut short. */
export function keepOnlyDatabaseCopy(dataDir: string, keep: string): void {
  const folder = join(dataDir, DATABASE_COPIES_DIRNAME)
  let names: string[]
  try {
    names = readdirSync(folder)
  } catch {
    return
  }
  for (const name of names) {
    if (join(DATABASE_COPIES_DIRNAME, name) === keep) continue
    rmSync(join(folder, name), { force: true, recursive: true })
  }
}
