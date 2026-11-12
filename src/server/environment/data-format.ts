import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'

import { writeFileAtomicSync } from '../platform/atomic-file'

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
// the copies before anything reads the data. There is no step yet: the first
// store change an older server cannot read adds one.

export const DATA_FORMAT_FILENAME = 'format.json'
export const MIGRATION_BACKUP_DIRNAME = 'migration-backup'
const MARKER = 'marker.json'

/** The newest format this build reads and writes. */
export const STUDIO_DATA_FORMAT = 1

export type DataFormatStep = {
  /** The format the step brings the data to: one above the one before it. */
  to: number
  /** The files it changes, relative to the data directory; each is copied aside first. */
  files: readonly string[]
  run(dataDir: string): void
}

/** The steps this build knows, oldest first. */
export const STUDIO_DATA_FORMAT_STEPS: readonly DataFormatStep[] = []

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

type Marker = { from: number; to: number; files: Array<{ path: string; existed: boolean }> }

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
      syncFile(join(backup, 'files', path))
    }
    return { path, existed }
  })
  // The marker last, so a backup without one is a copy that never started.
  const marker: Marker = { from, to: step.to, files }
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
  rmSync(backup, { recursive: true, force: true })
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

function restore(dataDir: string, marker: Marker): void {
  const backup = join(dataDir, MIGRATION_BACKUP_DIRNAME)
  for (const file of marker.files) {
    const path = inside(file.path)
    if (file.existed) {
      mkdirSync(dirname(join(dataDir, path)), { recursive: true })
      copyFileSync(join(backup, 'files', path), join(dataDir, path))
      syncFile(join(dataDir, path))
    } else rmSync(join(dataDir, path), { recursive: true, force: true })
  }
  rmSync(backup, { recursive: true, force: true })
}

function syncFile(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
