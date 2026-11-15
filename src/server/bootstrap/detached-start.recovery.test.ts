// An upgrade whose new server does not start (design-server-update, 7): the
// previous tree is started again and the failure recorded, so a machine is
// never left with nothing running and the same update is not tried again on
// its own. The forks are stood in for; the real tree's start is in
// detached-start.test.ts. The server being replaced is a process this test
// starts, so the drain's signal reaches nothing else.

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { startDetached, type LaunchOutcome, type ServerTree } from './detached-start'
import { FAILED_UPDATE_FILENAME, readHostId } from './server-record'

const scratch: string[] = []
const children: ChildProcess[] = []
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A machine with trees for `versions`, and (when `running`) a server of the first one holding the run lock. */
function machine(versions: string[], running: string | null) {
  const base = mkdtempSync(join(tmpdir(), 'se-recover-'))
  scratch.push(base)
  for (const version of versions) {
    mkdirSync(join(base, `server-${version}`), { recursive: true })
    writeFileSync(join(base, `server-${version}`, 'server.cjs'), '')
  }
  const dataDir = join(base, 'data')
  const runDir = join(dataDir, 'run')
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  if (running) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    children.push(child)
    writeFileSync(join(runDir, 'studio.lock'), JSON.stringify({ pid: child.pid, hostname: hostname() }))
    writeFileSync(
      join(runDir, 'server.json'),
      JSON.stringify({ v: 1, pid: child.pid, version: running, origin: 'bootstrap', hostId: readHostId() }),
    )
  }
  return { base, dataDir, runDir }
}

async function upgrade(
  at: ReturnType<typeof machine>,
  to: string,
  outcome: (tree: ServerTree) => LaunchOutcome,
  replace = true,
) {
  const lines: string[] = []
  const launched: string[] = []
  const code = await startDetached({
    dataDir: at.dataDir,
    logsDir: join(at.dataDir, 'logs'),
    idleMs: null,
    startedBy: 'test',
    replace,
    channel: 'latest',
    entry: join(at.base, `server-${to}`, 'server.cjs'),
    execPath: process.execPath,
    appDir: join(at.base, `server-${to}`),
    version: to,
    print: (line) => lines.push(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))),
    launch: async (tree) => {
      launched.push(`${tree.version}:${tree.appDir.slice(at.base.length)}`)
      return outcome(tree)
    },
  })
  return { code, lines, launched }
}

const failedRecord = (runDir: string) =>
  JSON.parse(readFileSync(join(runDir, FAILED_UPDATE_FILENAME), 'utf8')) as Record<string, unknown>

test('a replace whose new server fails starts the previous tree again and records the failure', async () => {
  const at = machine(['1.4.0', '1.5.0'], '1.4.0')
  const result = await upgrade(at, '1.5.0', (tree) =>
    tree.version === '1.5.0' ? { ok: false, message: 'The Studio server did not start. EADDRINUSE' } : { ok: true },
  )
  assert.equal(result.code, 1)
  assert.deepEqual(result.launched, ['1.5.0:/server-1.5.0', '1.4.0:/server-1.4.0'])
  assert.match(
    result.lines.at(-1) ?? '',
    /^@@SPRINTENGINE_FAIL update-failed Studio server 1\.5\.0 did not start, so 1\.4\.0 runs again\. .*EADDRINUSE/u,
  )
  const record = failedRecord(at.runDir)
  assert.deepEqual(
    [record.from, record.to, record.reason],
    ['1.4.0', '1.5.0', 'The Studio server did not start. EADDRINUSE'],
  )
  assert.equal(typeof record.at, 'number')
})

test('when the previous tree does not start either, the failure says so and stays recorded', async () => {
  const at = machine(['1.4.0', '1.5.0'], '1.4.0')
  const result = await upgrade(at, '1.5.0', () => ({ ok: false, message: 'no' }))
  assert.match(result.lines.at(-1) ?? '', /and 1\.4\.0 did not start again either/u)
  assert.equal(failedRecord(at.runDir).to, '1.5.0')
  // Its tree gone (pruned by hand): said, not thrown.
  const gone = machine(['1.5.0'], '1.4.0')
  const without = await upgrade(gone, '1.5.0', () => ({ ok: false, message: 'no' }))
  assert.deepEqual(without.launched, ['1.5.0:/server-1.5.0'])
  assert.match(without.lines.at(-1) ?? '', /server-1\.4\.0\) is no longer on this machine/u)
})

test('a start that succeeds removes the record; a first start that fails has nothing to fall back to', async () => {
  const at = machine(['1.4.0', '1.5.0'], null)
  writeFileSync(
    join(at.runDir, FAILED_UPDATE_FILENAME),
    JSON.stringify({ from: '1.4.0', to: '1.5.0', at: 1, reason: 'x' }),
  )
  const failed = await upgrade(at, '1.5.0', () => ({ ok: false, message: 'still no' }), false)
  assert.deepEqual(failed.launched, ['1.5.0:/server-1.5.0'])
  assert.match(failed.lines.at(-1) ?? '', /^@@SPRINTENGINE_FAIL start still no/u)
  assert.ok(existsSync(join(at.runDir, FAILED_UPDATE_FILENAME)), 'kept until a start succeeds')
  const started = await upgrade(at, '1.5.0', () => ({ ok: true }), false)
  assert.equal(started.code, 0)
  assert.ok(started.lines.at(-1)?.startsWith('@@SPRINTENGINE_READY '))
  assert.ok(!existsSync(join(at.runDir, FAILED_UPDATE_FILENAME)))
})
