// Runs once per `vitest` run, in the main process, before any worker starts.
//
// Suites make their scratch folders with `mkdtemp(join(tmpdir(), ...))`, and
// most never removed them: the OS temp folder of a machine that runs the suite
// often grew by hundreds of thousands of folders. So the run gets one folder
// of its own under the OS temp folder, and every worker and every process the
// suites spawn see it as their temp folder (TMPDIR, TMP and TEMP are inherited).
// tests/setup.ts gives each test file a folder inside it and removes that once
// the file is done; this removes the run's folder at the end.
//
// The guard: what is still in the run's folder at the end outlived the test
// file that made it, which means something (a server, a child process, a
// watcher) went on writing after its suite finished. Each such file is named,
// and the run fails, because only this run's own folder is counted and a
// parallel run on the same machine cannot trip it.
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RUN_TEMP_ENV, TEMP_FOLDER_LOG, TEMP_REMOVAL } from './temp-folders'

export default function setup(): () => Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'se-test-run-'))
  process.env[RUN_TEMP_ENV] = root
  // A run that starts outside every test file (a worker before its first file)
  // already writes in the run's folder.
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = root

  return async () => {
    const left = leftovers(root)
    await rm(root, TEMP_REMOVAL).catch(() => undefined)
    if (left.length === 0) return
    const lines = left.map(({ file, entries }) => `  ${file}: ${entries.join(', ')}`)
    throw new Error(
      [
        `${left.length} test file(s) left temp folders behind after their own cleanup ran.`,
        'Something they started (a server, a child process, a watcher) went on writing after the file finished:',
        'stop it in the file’s afterEach/afterAll.',
        ...lines,
      ].join('\n'),
    )
  }
}

interface Leftover {
  file: string
  entries: string[]
}

/** The per-file folders still present in the run's folder, by the test file that owned each. */
function leftovers(root: string): Leftover[] {
  const owners = new Map<string, string>()
  const log = join(root, TEMP_FOLDER_LOG)
  if (existsSync(log)) {
    for (const line of readFileSync(log, 'utf8').split('\n')) {
      const tab = line.indexOf('\t')
      if (tab > 0) owners.set(line.slice(0, tab), line.slice(tab + 1))
    }
  }
  const found: Leftover[] = []
  for (const name of readdirSync(root)) {
    if (name === TEMP_FOLDER_LOG) continue
    let entries: string[] = []
    try {
      entries = readdirSync(join(root, name))
    } catch {
      entries = []
    }
    // A per-file folder emptied but not yet removed is not a leak of anything.
    if (owners.has(name) && entries.length === 0) continue
    found.push({ file: owners.get(name) ?? name, entries: entries.length > 0 ? entries.slice(0, 5) : [name] })
  }
  return found
}
