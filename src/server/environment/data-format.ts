import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'

import { flushFileSync, flushFolderSync, writeFileAtomicSync } from '../platform/atomic-file'
import { copyStudioDatabase, databaseCopyName, keepOnlyDatabaseCopy } from '../db/copies'
import { STUDIO_DATABASE_FILENAME, studioDatabaseFiles } from '../db/database'
import {
  CHAT_HISTORY_STEP,
  CHAT_RECORDS_STEP,
  CHAT_SIDE_RECORDS_STEP,
  DEVICE_AND_SESSION_RECORDS_STEP,
  PULL_REQUEST_RECORD_STEP,
} from '../db/import-files'

// The format a data directory's files are written in, and the one way it
// changes (design-server-update, 8).
//
// `<data>/format.json` says `{ format, writtenBy }`. A server never starts on
// data in a newer format than it reads: a tree rolled back after a failed
// update (an SSH machine's previous server) must not rewrite what a newer one
// wrote. Format 1 is the layout every build before the marker wrote, so a
// directory without one is format 1.
//
// A format changes only through a step run here: the files the step touches
// are copied to `<data>/migration-backup/` and a marker written durably
// before it runs. A step that throws is undone from the copies and the server
// refuses to start; a start that finds the marker (a crash mid-step) restores
// the copies before anything reads the data.
//
// A step that changes the database (`database: true`) is undone from a copy
// of it rather than from `files`: `VACUUM INTO` before the step, so the copy
// holds the WAL's commits too. That copy is kept once the step has worked, as
// the one copy of the database Studio keeps (`db/copies.ts`); the one before
// it goes. A step that makes the database (format 2) has nothing to copy:
// the files it imports from are left as they were, and are the way back.
//
// Format 2: the data folder has a database (`studio.sqlite`), and a chat's
// first message, the approval rules, the launch notices and the agents'
// prompts are kept in it rather than in their files.
//
// Format 3: paired devices and machines, browser sessions, embeds, linked
// local servers, apps' toolsets, file views and extension approvals too.
//
// Format 4: chat history (events, receipts, the chat list's rows, search,
// the open-turn list, tool details). Each chat's transcript is imported when
// it is first taken up, or by the background pass.
//
// Format 5: the chat records (the workspace registry), the schedules and
// their runs, scheduled messages and usage-limit resumes.
//
// Format 6: the pull request record, a row per pull request.

export const DATA_FORMAT_FILENAME = 'format.json'
export const MIGRATION_BACKUP_DIRNAME = 'migration-backup'
const MARKER = 'marker.json'

/** The newest format this build reads and writes. */
export const STUDIO_DATA_FORMAT = 6

export type DataFormatStep = {
  /** The format the step brings the data to: one above the one before it. */
  to: number
  /** The files it changes, relative to the data directory; each is copied aside first. */
  files: readonly string[]
  /** It changes the database: a copy is taken first, put back if the step fails, and kept once it works. */
  database?: true
  run(dataDir: string): void
}

/** The steps this build knows, oldest first. */
export const STUDIO_DATA_FORMAT_STEPS: readonly DataFormatStep[] = [
  CHAT_SIDE_RECORDS_STEP,
  DEVICE_AND_SESSION_RECORDS_STEP,
  CHAT_HISTORY_STEP,
  CHAT_RECORDS_STEP,
  PULL_REQUEST_RECORD_STEP,
]

/** Data written in a format this server does not read: it is updated, not the data rewritten. */
export class StudioDataTooNewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StudioDataTooNewError'
  }
}

/** A format step failed (and was undone), or an interrupted one could not be undone. */
export class StudioDataMigrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StudioDataMigrationError'
  }
}

type Marker = {
  from: number
  to: number
  files: Array<{ path: string; existed: boolean }>
  /** A step that changes the database: the copy it is undone from, or null when there was no database before it. */
  database?: { copy: string | null }
}

export type PreparedDataFormat = {
  format: number
  /** The steps run this start, by the format each brought the data to. */
  migrated: number[]
  /** Whether an interrupted step was undone first. */
  restored: boolean
}

/**
 * Bring the data directory to this build's format, or refuse: called once,
 * holding the data directory's lock, before any store reads it.
 */
export function prepareDataFormat(
  dataDir: string,
  options: { version: string; format?: number; steps?: readonly DataFormatStep[] },
): PreparedDataFormat {
  const known = options.format ?? STUDIO_DATA_FORMAT
  const steps = options.steps ?? STUDIO_DATA_FORMAT_STEPS
  const restored = restoreInterrupted(dataDir)
  const found = readFormat(dataDir)
  let format = found?.format ?? 1
  if (format > known)
    throw new StudioDataTooNewError(
      `This data was written by Studio ${found?.writtenBy ?? 'a newer version'} (data format ${format}); this Studio server (${options.version}) reads format ${known} or older. Update this server.`,
    )
  const migrated: number[] = []
  for (const step of steps) {
    if (step.to <= format || step.to > known) continue
    if (step.to !== format + 1)
      throw new StudioDataMigrationError(`No step brings this data from format ${format} to ${step.to}.`)
    runStep(dataDir, format, step, options.version)
    format = step.to
    migrated.push(step.to)
  }
  if (!found || migrated.length > 0) writeFormat(dataDir, format, options.version)
  return { format, migrated, restored }
}

function readFormat(dataDir: string): { format: number; writtenBy: string | null } | null {
  const path = join(dataDir, DATA_FORMAT_FILENAME)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new StudioDataMigrationError(`${path} could not be read: ${messageOf(error)}`)
  }
  try {
    const parsed = JSON.parse(text) as { format?: unknown; writtenBy?: unknown }
    if (typeof parsed.format === 'number' && Number.isSafeInteger(parsed.format) && parsed.format >= 1)
      return { format: parsed.format, writtenBy: typeof parsed.writtenBy === 'string' ? parsed.writtenBy : null }
  } catch {
    // Said below.
  }
  // Read as format 1 it could let an older server rewrite newer data; refused, in words.
  throw new StudioDataMigrationError(
    `${path} does not say which format this data is in. Move it aside to start; Studio then reads the data as format 1.`,
  )
}

function writeFormat(dataDir: string, format: number, version: string): void {
  writeFileAtomicSync(join(dataDir, DATA_FORMAT_FILENAME), `${JSON.stringify({ format, writtenBy: version })}\n`, {
    mode: 0o600,
  })
}

/** A step's file, kept inside the data directory. */
function inside(relative: string): string {
  const path = normalize(relative)
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`))
    throw new StudioDataMigrationError(`A format step names a file outside the data directory: ${relative}`)
  return path
}

function runStep(dataDir: string, from: number, step: DataFormatStep, version: string): void {
  const backup = join(dataDir, MIGRATION_BACKUP_DIRNAME)
  rmSync(backup, { recursive: true, force: true })
  mkdirSync(backup, { recursive: true, mode: 0o700 })
  // The format marker is among them, so an undone step leaves it as it was.
  const named = [DATA_FORMAT_FILENAME, ...step.files.filter((file) => normalize(file) !== DATA_FORMAT_FILENAME)]
  const files = named.map((file) => {
    const path = inside(file)
    const existed = existsSync(join(dataDir, path))
    if (existed) {
      mkdirSync(dirname(join(backup, 'files', path)), { recursive: true, mode: 0o700 })
      copyFileSync(join(dataDir, path), join(backup, 'files', path))
      flushFileSync(join(backup, 'files', path))
    }
    return { path, existed }
  })
  let database: Marker['database']
  if (step.database) {
    const copy = existsSync(join(dataDir, STUDIO_DATABASE_FILENAME)) ? databaseCopyName(step.to) : null
    if (copy) {
      try {
        copyStudioDatabase(dataDir, copy)
      } catch (error) {
        // Nothing has changed yet; the copies of a step that never started go.
        rmSync(backup, { recursive: true, force: true })
        throw new StudioDataMigrationError(
          `Studio could not copy its database before moving this data from format ${from} to ${step.to}, so nothing was changed: ${messageOf(error)}`,
        )
      }
    }
    database = { copy }
  }
  // The marker last, so a backup without one is a copy that never started.
  const marker: Marker = { from, to: step.to, files, ...(database ? { database } : {}) }
  writeFileAtomicSync(join(backup, MARKER), `${JSON.stringify(marker)}\n`, { mode: 0o600 })
  try {
    step.run(dataDir)
    writeFormat(dataDir, step.to, version)
  } catch (error) {
    restore(dataDir, marker)
    throw new StudioDataMigrationError(
      `Moving this data from format ${from} to ${step.to} failed, so it was put back as it was: ${messageOf(error)}`,
    )
  }
  // The commit point: once the marker is gone the step stands, and a crash
  // in what follows leaves copies the next start drops as never started.
  commit(backup)
  rmSync(backup, { recursive: true, force: true })
  if (database?.copy) keepOnlyDatabaseCopy(dataDir, database.copy)
}

/** Remove the marker, durably: what was done since it was written now stands. */
function commit(backup: string): void {
  rmSync(join(backup, MARKER), { force: true })
  flushFolderSync(backup)
}

/** Undo a step a crash interrupted, from its copies. True when there was one. */
function restoreInterrupted(dataDir: string): boolean {
  const backup = join(dataDir, MIGRATION_BACKUP_DIRNAME)
  if (!existsSync(backup)) return false
  let text: string | null = null
  try {
    text = readFileSync(join(backup, MARKER), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new StudioDataMigrationError(`${join(backup, MARKER)} could not be read: ${messageOf(error)}`)
  }
  if (text === null) {
    // Copies of a step that never started: the data is as it was.
    rmSync(backup, { recursive: true, force: true })
    return false
  }
  let marker: Marker
  try {
    marker = JSON.parse(text) as Marker
    if (!Array.isArray(marker.files)) throw new Error('no files')
  } catch {
    throw new StudioDataMigrationError(
      `An interrupted format change left ${backup}, whose marker does not read. Studio will not start on this data until it is put back by hand.`,
    )
  }
  restore(dataDir, marker)
  return true
}

/**
 * Put the data back as the marker says it was. Safe to run again after a
 * crash anywhere in it: nothing is deleted before every source it restores
 * from is known to be there; the database is replaced by a rename, not
 * removed first; and the copies are let go of only after the marker is gone.
 */
function restore(dataDir: string, marker: Marker): void {
  const backup = join(dataDir, MIGRATION_BACKUP_DIRNAME)
  const copy = marker.database?.copy ? join(dataDir, inside(marker.database.copy)) : null
  const missing = [
    ...marker.files.filter((file) => file.existed).map((file) => join(backup, 'files', inside(file.path))),
    ...(copy ? [copy] : []),
  ].filter((path) => !existsSync(path))
  if (missing.length > 0)
    throw new StudioDataMigrationError(
      `An interrupted format change cannot be undone: ${missing.join(', ')} is missing. Nothing was changed; Studio will not start on this data until it is put back by hand.`,
    )
  for (const file of marker.files) {
    const path = inside(file.path)
    if (file.existed) {
      mkdirSync(dirname(join(dataDir, path)), { recursive: true })
      copyFileSync(join(backup, 'files', path), join(dataDir, path))
      flushFileSync(join(dataDir, path))
    } else rmSync(join(dataDir, path), { recursive: true, force: true })
  }
  if (marker.database) {
    // The database as it was before the step: its copy, which holds the WAL's
    // commits, put in place by a rename once it is whole on disk; or none.
    const [live, wal, shm] = studioDatabaseFiles(dataDir)
    if (copy) {
      const restoring = `${live}.restoring`
      copyFileSync(copy, restoring)
      flushFileSync(restoring)
      rmSync(wal, { force: true })
      rmSync(shm, { force: true })
      renameSync(restoring, live)
    } else for (const path of [live, wal, shm]) rmSync(path, { force: true })
    flushFolderSync(dataDir)
  }
  commit(backup)
  // The copy of a step that did not happen; the one before it, if any, stays the kept one.
  if (copy) rmSync(copy, { force: true })
  rmSync(backup, { recursive: true, force: true })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
