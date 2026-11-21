// The extension worker entry (src/server/extensions/workers/worker-entry.ts)
// built the way the app builds it, one file with nothing but Node's own
// modules, so a test forks a real worker process across a real IPC channel.
// Built once per test file, into that file's scratch folder.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { buildSync } from 'esbuild'

let built: string | null = null

export function workerEntryForTests(): string {
  if (built) return built
  const outfile = join(mkdtempSync(join(tmpdir(), 'extension-worker-')), 'extension-worker.cjs')
  buildSync({
    entryPoints: [resolve(__dirname, '../src/server/extensions/workers/worker-entry.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22.12',
    logLevel: 'error',
  })
  built = outfile
  return outfile
}
