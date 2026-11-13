// Runs once per `vitest` run, in the main process, before any worker starts.
//
// Suites make their scratch folders with `mkdtemp(join(tmpdir(), ...))`, and
// most never removed them: the OS temp folder of a machine that runs the suite
// often grew by hundreds of thousands of folders. So the run gets one folder
// of its own in a temp folder, and every worker and every process the
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

// A POSIX socket's path holds about a hundred bytes, and suites listen on
// sockets a few folders deep in their temp folder. The run's folder and the
// file's add 22 bytes, so they go in `/tmp` when the OS temp folder is long
// (macOS's per-user one is 48 bytes): a deeper base pushed hundreds of sockets
// past the limit.
const LONGEST_TEMP_BASE = 26

function tempBase(): string {
  const base = tmpdir()
  return process.platform !== 'win32' && base.length > LONGEST_TEMP_BASE ? '/tmp' : base
}

export default function setup(): () => Promise<void> {
  const root = mkdtempSync(join(tempBase(), 'se-'))
  process.env[RUN_TEMP_ENV] = root
  // What a worker writes outside every test file (before its first one) lands
  // in the run's folder too.
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

/**
 * What is in the run's folder although its test file's cleanup has run (or
 * was written outside any test file), by the file that owned it. The folder of
 * a file whose hooks never ran (all its tests skipped) is not counted: it is
 * removed with the run's folder.
 */
function leftovers(root: string): Leftover[] {
  const owners = new Map<string, string>()
  const removed = new Set<string>()
  const log = join(root, TEMP_FOLDER_LOG)
  if (existsSync(log)) {
    for (const line of readFileSync(log, 'utf8').split('\n')) {
      const [name, event, file] = line.split('\t')
      if (!name || !file) continue
      owners.set(name, file)
      if (event === 'removed') removed.add(name)
    }
  }
  const found: Leftover[] = []
  for (const name of readdirSync(root)) {
    if (name === TEMP_FOLDER_LOG) continue
    if (owners.has(name) && !removed.has(name)) continue
    let entries: string[] = []
    try {
      entries = readdirSync(join(root, name))
    } catch {
      entries = []
    }
    found.push({
      file: owners.get(name) ?? '(outside any test file)',
      entries: entries.length > 0 ? entries.slice(0, 5) : [name],
    })
  }
  return found
}
