import { mkdirSync } from 'node:fs'

import type { DiagnosticLogInput } from '../../shared/ipc/diagnostics'
import { writeDiagnosticLog } from '../../main/diagnostics-service'
import type { StudioPlatform } from '../platform/platform'
import { processIsRunning } from '../platform/process-alive'
import {
  acquireDataDirLock,
  readDataDirSecrets,
  recordDataDirSecrets,
  type DataDirHolder,
  type DataDirLock,
  type StudioRole,
} from './data-dir'
import { errorMessage } from '../../shared/errors'
import { prepareDataFormat } from '../environment/data-format'
import { openStudioDatabase, type StudioDatabase } from '../db/database'

// How a core takes its data directory: the run lock, then the record of whose
// cipher seals it. The two roles answer a problem in opposite ways.
//
// A server refuses: a held directory, one it cannot write, one the desktop's
// keychain sealed while its own cipher could seal into it. It exits and says
// why, since running anyway would make it a second writer.
//
// The desktop's server starts whatever is wrong with the directory's lock or
// record (no permission, a full disk, a file an antivirus holds open): that
// is reported and it runs without them, as builds before either existed did.
// And the desktop wins the directory: it holds Electron's single-instance lock
// for this profile (or is a dev build given a profile of its own), so a lock
// naming a desktop is a previous run's, whatever its process id or its host
// name says (a Mac's host name changes with the network). A lock naming a
// Studio server is taken over too; the server sees it lost its lock and stops,
// and the desktop waits for it to exit before it touches the data: a server
// still writing records after they were moved into the database would lose
// them.
//
// Then the data's format (`data-format.ts`), the same for both roles: data
// newer than this build reads, or a format step that failed, refuses the
// start in its own words, the lock given back. The stores live in the
// database the format guards, so running on would start them without their
// records, and what they wrote could stand in the way of a correct import.

export type TakenDataDir = {
  /** Null only in a desktop that could not take it, and runs without, as builds before the lock did. */
  lock: DataDirLock | null
}

/** Another process holds the data directory. Thrown to a server, which exits rather than run as a second writer. */
export class StudioDataDirBusyError extends Error {
  constructor(
    message: string,
    readonly holder: DataDirHolder,
  ) {
    super(message)
    this.name = 'StudioDataDirBusyError'
  }
}

/** The data directory cannot be used: not creatable, not writable, sealed by a cipher this server would overwrite. */
export class StudioDataDirUnusableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StudioDataDirUnusableError'
  }
}

export type TakeDataDirDeps = {
  acquire?: typeof acquireDataDirLock
  readSecrets?: typeof readDataDirSecrets
  record?: typeof recordDataDirSecrets
  /** Brings the data to this build's format, or throws in words (`data-format.ts`). */
  prepareFormat?: (dataDir: string, version: string) => void
  log?: (diagnostic: DiagnosticLogInput) => void
  isRunning?: (pid: number) => boolean
  /** How long the desktop waits for a displaced server to exit, and how often it looks; it waits on this thread, before anything is served. */
  waitForServerMs?: number
  pollMs?: number
}

const WAIT_FOR_SERVER_MS = 15_000
const POLL_MS = 250

export function takeDataDir(platform: StudioPlatform, role: StudioRole, deps: TakeDataDirDeps = {}): TakenDataDir {
  const log = deps.log ?? ((diagnostic) => void writeDiagnosticLog(diagnostic))
  return role === 'desktop' ? takeForDesktop(platform, deps, log) : takeForServer(platform, deps)
}

function takeForDesktop(
  platform: StudioPlatform,
  deps: TakeDataDirDeps,
  log: (diagnostic: DiagnosticLogInput) => void,
): TakenDataDir {
  const dataDir = platform.paths.dataDir()
  const acquire = deps.acquire ?? acquireDataDirLock
  const report = (title: string, message: string, error?: unknown) =>
    log({
      level: 'warning',
      source: 'workspace',
      title,
      message,
      ...(error === undefined ? {} : { details: errorMessage(error) }),
    })

  let lock: DataDirLock | null = null
  let displaced: number | null = null
  try {
    mkdirSync(dataDir, { recursive: true })
    const taken = acquire(dataDir, 'desktop', { takeOver: () => true })
    if (taken.ok) {
      lock = taken.lock
      const server = taken.displaced?.role === 'server' && taken.displaced.pid > 0 ? taken.displaced : null
      if (server) {
        report(
          'A Studio server had this data directory open',
          `A Studio server (pid ${server.pid}) was running against this app's data directory. ` +
            'The app has taken it over; the server stops, and the app waits for it before reading the data.',
        )
        displaced = server.pid
      }
    } else {
      report('Data directory in use', taken.message)
    }
  } catch (error) {
    report(
      'Data directory lock not taken',
      'The app runs without its data directory lock, so a Studio server started against it is not refused.',
      error,
    )
  }
  if (displaced !== null && !waitForExit(displaced, deps)) {
    lock?.release()
    throw new StudioDataDirUnusableError(
      `A Studio server (pid ${displaced}) still has the data directory ${dataDir} open after it was asked to stop. Stop it, then retry.`,
    )
  }

  try {
    const sealedBy = (deps.readSecrets ?? readDataDirSecrets)(dataDir)
    if (sealedBy === 'server-key') {
      report(
        'Secrets sealed by a Studio server',
        "This data directory's secrets were sealed by a standalone Studio server, which the app's keychain cannot open. Saved keys read as not set here.",
      )
    } else {
      ;(deps.record ?? recordDataDirSecrets)(dataDir, 'desktop-keychain')
    }
  } catch (error) {
    report(
      'Data directory record not written',
      'The app could not record that its keychain seals this directory.',
      error,
    )
  }

  try {
    prepareFormat(deps)(dataDir, platform.identity.version())
  } catch (error) {
    lock?.release()
    // Its own words: "this data was written by Studio X; update this server".
    throw new StudioDataDirUnusableError(errorMessage(error))
  }
  return { lock }
}

function prepareFormat(deps: TakeDataDirDeps): (dataDir: string, version: string) => void {
  return deps.prepareFormat ?? ((dataDir, version) => void prepareDataFormat(dataDir, { version }))
}

function takeForServer(platform: StudioPlatform, deps: TakeDataDirDeps): TakenDataDir {
  const dataDir = platform.paths.dataDir()
  const unusable = (error: unknown): never => {
    throw new StudioDataDirUnusableError(`The data directory ${dataDir} cannot be used: ${errorMessage(error)}`)
  }
  let taken: ReturnType<typeof acquireDataDirLock>
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    taken = (deps.acquire ?? acquireDataDirLock)(dataDir, 'server')
  } catch (error) {
    return unusable(error)
  }
  if (!taken.ok) throw new StudioDataDirBusyError(taken.message, taken.holder)
  const lock = taken.lock
  try {
    const sealedBy = (deps.readSecrets ?? readDataDirSecrets)(dataDir)
    if (sealedBy === 'desktop-keychain' && platform.secrets.available()) {
      throw new StudioDataDirUnusableError(
        `${dataDir} holds secrets the desktop's keychain sealed; a server there must run with its secrets off.`,
      )
    }
    if (sealedBy === null && platform.secrets.available()) (deps.record ?? recordDataDirSecrets)(dataDir, 'server-key')
  } catch (error) {
    lock.release()
    if (error instanceof StudioDataDirUnusableError) throw error
    return unusable(error)
  }
  try {
    prepareFormat(deps)(dataDir, platform.identity.version())
  } catch (error) {
    lock.release()
    // Its own words: "this data was written by Studio X; update this server".
    throw new StudioDataDirUnusableError(errorMessage(error))
  }
  return { lock }
}

/**
 * The data folder's database, opened once its format is this build's. One
 * that cannot be opened (damaged, on a file system without WAL, changed by a
 * newer Studio) stops the start in its own words, the lock given back: there
 * is no way to run without it, and none to run on an empty one in its place.
 */
export function openDataDirDatabase(
  dataDir: string,
  lock: DataDirLock | null,
  open: (dataDir: string) => StudioDatabase = openStudioDatabase,
): StudioDatabase {
  try {
    return open(dataDir)
  } catch (error) {
    lock?.release()
    throw new StudioDataDirUnusableError(errorMessage(error))
  }
}

/** Wait on this thread for `pid` to exit, polling; false when it still runs at the deadline. */
function waitForExit(pid: number, deps: TakeDataDirDeps): boolean {
  const isRunning = deps.isRunning ?? processIsRunning
  const deadline = Date.now() + (deps.waitForServerMs ?? WAIT_FOR_SERVER_MS)
  const pause = new Int32Array(new SharedArrayBuffer(4))
  while (isRunning(pid)) {
    if (Date.now() >= deadline) return false
    Atomics.wait(pause, 0, 0, deps.pollMs ?? POLL_MS)
  }
  return true
}
