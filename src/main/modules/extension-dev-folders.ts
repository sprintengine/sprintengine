import { readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

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
 * development folder, and approving one never approves another.
 */
export function resolveDevFolder(path: string): DevFolderResolution {
  if (!isAbsolute(path))
    return {
      ok: false,
      code: 'invalid_argument',
      message: `${path} is not an absolute path. Name the folder as an absolute path on the machine Studio runs on.`,
    }
  try {
    const real = realpathSync(path)
    if (!statSync(real).isDirectory())
      return { ok: false, code: 'invalid_argument', message: `${path} is not a folder.` }
    return { ok: true, path: real }
  } catch {
    return {
      ok: false,
      code: 'invalid_argument',
      message: `${path} is not a folder on the machine Studio runs on.`,
    }
  }
}
