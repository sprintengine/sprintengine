// The scratch folders of a test run (see tests/global-setup.ts and tests/setup.ts).
import { appendFileSync, mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The run's own folder under the OS temp folder, set by the global setup. */
export const RUN_TEMP_ENV = 'SE_TEST_RUN_TEMP'

/** In the run's folder: one line per test file, `<its folder>\t<the file>`. */
export const TEMP_FOLDER_LOG = 'files.tsv'

/**
 * How a scratch folder is removed: retried briefly, since on Windows a file a
 * process just closed can stay locked for a moment, and a folder a child
 * process was still writing to can refill between listing and removal.
 */
export const TEMP_REMOVAL = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const

/**
 * Makes the current test file's scratch folder and points TMPDIR, TMP and TEMP
 * at it, so every `tmpdir()` the file and the processes it spawns make lands
 * there. Returns its removal, for the file's last `afterAll`.
 */
export function useFileTempFolder(testFile: string): () => Promise<void> {
  const root = process.env[RUN_TEMP_ENV]
  // `f` keeps the path short: POSIX socket paths hold about a hundred bytes.
  const folder = mkdtempSync(root ? join(root, 'f') : join(tmpdir(), 'se-test-file-'))
  if (root) appendFileSync(join(root, TEMP_FOLDER_LOG), `${folder.slice(root.length + 1)}\t${testFile}\n`)
  const before = ['TMPDIR', 'TMP', 'TEMP'].map((name) => [name, process.env[name]] as const)
  for (const [name] of before) process.env[name] = folder
  return async () => {
    // What still runs in this worker after the file (the next file, a late
    // timer) gets the temp folder it had before, not a removed one.
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(folder, TEMP_REMOVAL).catch(() => undefined)
  }
}
