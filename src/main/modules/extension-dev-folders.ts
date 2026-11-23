import { readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'

// The development folders the owner registered on this server: extensions
// Studio loads straight from where they are, with no install copy, and reads
// again on every save (`sprintengine-extension dev load`, or Settings ▸
// Extensions ▸ Development folders). They load after the installed
// extensions, in the order they were registered; one whose key an installed
// extension has takes its place while it is registered, and needs its own
// approval (extension-approvals.ts).
//
// Kept in `<dataDir>/extension-dev-folders.json`, `{ folders: [<real path>…] }`,
// written only through the owner's `extension.devLoad` / `extension.devUnload`.
// A missing or malformed file registers nothing.

const FILE_NAME = 'extension-dev-folders.json'
/** The most development folders one server holds. */
export const MAX_DEV_FOLDERS = 64

export function readDevFoldersSync(dataDir: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dataDir, FILE_NAME), 'utf8'))
    const folders = (parsed as { folders?: unknown } | null)?.folders
    if (!Array.isArray(folders)) return []
    const seen = new Set<string>()
    return folders.filter((entry): entry is string => {
      if (typeof entry !== 'string' || !isAbsolute(entry) || seen.has(entry)) return false
      seen.add(entry)
      return true
    })
  } catch {
    return []
  }
}

// Read-modify-write one at a time, so two registrations at once cannot lose one.
let writeChain: Promise<unknown> = Promise.resolve()

export function writeDevFolders(dataDir: string, folders: readonly string[]): Promise<void> {
  const run = writeChain.then(async () => {
    const path = join(dataDir, FILE_NAME)
    await mkdir(dataDir, { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify({ folders: [...folders] }, null, 2), { mode: 0o600 })
    await rename(tmp, path)
  })
  writeChain = run.catch(() => undefined)
  return run
}

export type DevFolderResolution = { ok: true; path: string } | { ok: false; code: 'invalid_argument'; message: string }

/**
 * A folder on this server, as the one place it is: absolute, existing, a
 * directory, through every link to it. Two names for one folder are one
 * development folder, and approving one never approves another. One inside
 * `refused` (the extensions folder, Studio's data folder) is refused: what is
 * installed there is held to its files, and a development folder is not.
 */
export function resolveDevFolder(path: string, refused: readonly string[] = []): DevFolderResolution {
  if (!isAbsolute(path))
    return {
      ok: false,
      code: 'invalid_argument',
      message: `${path} is not an absolute path. Name the folder as an absolute path on the machine Studio runs on.`,
    }
  let real: string
  try {
    real = realpathSync(path)
    if (!statSync(real).isDirectory())
      return { ok: false, code: 'invalid_argument', message: `${path} is not a folder.` }
  } catch {
    return {
      ok: false,
      code: 'invalid_argument',
      message: `${path} is not a folder on the machine Studio runs on.`,
    }
  }
  const inside = insideRefusedRoot(real, refused)
  if (inside)
    return {
      ok: false,
      code: 'invalid_argument',
      message: `${path} is inside ${inside}, which Studio keeps for itself. Develop the extension in a folder of your own.`,
    }
  return { ok: true, path: real }
}

/** The refused root `real` is, or is inside, by real path; null when none. */
export function insideRefusedRoot(real: string, refused: readonly string[]): string | null {
  for (const root of refused) {
    let realRoot: string
    try {
      realRoot = realpathSync(root)
    } catch {
      continue
    }
    if (real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`)) return root
  }
  return null
}

/**
 * Whether a registered folder is still the one place it was registered as:
 * the same real path, so a folder (or one of its parents) swapped for a link
 * since is not loaded under the approval the first one was given.
 */
export function devFolderStillResolves(folder: string): { ok: true } | { ok: false; now: string | null } {
  try {
    const real = realpathSync(folder)
    return real === folder ? { ok: true } : { ok: false, now: real }
  } catch {
    return { ok: false, now: null }
  }
}
