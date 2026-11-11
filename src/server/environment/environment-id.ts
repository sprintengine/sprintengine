import { randomUUID } from 'node:crypto'
import { chmodSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The id a Studio's data directory is known by (its environment id): minted
// the first time it is asked for, and kept for good. Every client keys what it
// knows about a Studio on it (its saved routes, its caches, the address of a
// chat there), so a client that reaches one Studio by two routes recognises it
// as one, and a machine that is renamed or moves address keeps its chats.
//
// So the id must not change by accident, which three rules see to:
//
//   - It is created whole or not at all: written to a file of its own, then
//     linked into place, which fails if the file is already there. Two
//     processes on one data directory (the desktop and its server, both
//     starting for the first time) cannot both win; the loser reads the
//     winner's id.
//   - A file that is there but cannot be read (held by a scanner, a
//     permission) is never written over. The run uses an id of its own, says
//     so, and the next run reads the kept one.
//   - A file that reads but holds no id is moved aside, not deleted, before a
//     new id is minted, so whatever it held can be recovered.

export const STUDIO_ENVIRONMENT_FILENAME = 'studio-environment.json'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

type Read =
  { kind: 'id'; id: string } | { kind: 'absent' } | { kind: 'malformed' } | { kind: 'unreadable'; error: unknown }

function read(path: string): Read {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unreadable', error }
  }
  try {
    const stored = JSON.parse(text) as { id?: unknown }
    if (typeof stored?.id === 'string' && UUID.test(stored.id)) return { kind: 'id', id: stored.id }
  } catch {
    // Not JSON: malformed, below.
  }
  return { kind: 'malformed' }
}

/** Create `path` holding `text`, only if it does not exist. False when another writer got there first. */
function createExclusive(path: string, text: string): boolean {
  const staging = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(staging, text, { mode: 0o600 })
  try {
    if (process.platform !== 'win32') chmodSync(staging, 0o600)
    try {
      linkSync(staging, path)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') return false
      // A file system without hard links: an exclusive create, which a reader
      // could catch empty for a moment, is the best left.
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV') throw error
    }
    try {
      writeFileSync(path, text, { mode: 0o600, flag: 'wx' })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw error
    }
  } finally {
    try {
      unlinkSync(staging)
    } catch {
      // Already gone.
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The environment id of the Studio whose data directory this is. Never
 * throws for a file it cannot use: at worst the run gets an id of its own,
 * logged, and the file on disk is left as it was.
 */
export function readStudioEnvironmentId(dataDir: string, options: { log?: (message: string) => void } = {}): string {
  const path = join(dataDir, STUDIO_ENVIRONMENT_FILENAME)
  // One answer per run, whoever asks (the RPC, the web door, the tailnet):
  // a temporary id must not differ between them.
  const known = idsThisRun.get(path)
  if (known) return known
  const id = resolve(path, options.log)
  idsThisRun.set(path, id)
  return id
}

const idsThisRun = new Map<string, string>()

function resolve(path: string, log: ((message: string) => void) | undefined): string {
  // A malformed file is moved aside once, and a lost race is read again once.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const found = read(path)
    if (found.kind === 'id') return found.id
    if (found.kind === 'unreadable') {
      log?.(
        `This Studio's id could not be read (${describe(found.error)}); this run goes by a temporary one, and the next reads it again.`,
      )
      return randomUUID()
    }
    if (found.kind === 'malformed') {
      const aside = `${path}.malformed-${Date.now()}`
      try {
        renameSync(path, aside)
        log?.(`This Studio's id file held no id; it was moved to ${aside} and a new id minted.`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          log?.(`This Studio's id file held no id and could not be moved aside (${describe(error)}).`)
          return randomUUID()
        }
      }
    }
    const id = randomUUID()
    try {
      if (createExclusive(path, `${JSON.stringify({ id }, null, 2)}\n`)) return id
    } catch (error) {
      log?.(`This Studio's id could not be saved (${describe(error)}); this run goes by a temporary one.`)
      return id
    }
    // Another process minted one first: read it on the next pass.
  }
  const last = read(path)
  return last.kind === 'id' ? last.id : randomUUID()
}
