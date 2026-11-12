import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { SpawnOptions } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

import { afterEach, beforeEach, test, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn,
}))
// The macOS install locations are looked for first; a machine with Tailscale
// installed would otherwise run the real CLI instead of the stand-in on PATH.
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  existsSync: () => false,
}))

import { runTailscale, runTailscaleResult } from './tailscale-cli'

const actual = await vi.importActual<typeof import('child_process')>('child_process')

// Whatever is asked for, a Node process that answers `{}` runs in its place,
// with the options the run was given.
beforeEach(() => {
  spawn.mockReset()
  spawn.mockImplementation((_file: string, _args: string[], options: SpawnOptions) =>
    actual.spawn(process.execPath, ['-e', "process.stdout.write('{}')"], options),
  )
})

function envOfLastRun(): NodeJS.ProcessEnv {
  const options = spawn.mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv } | undefined
  assert.ok(options?.env, 'every Tailscale run passes an explicit environment')
  return options.env
}

// Launched from the Dock, the app has no TERM, and the macOS binary then tries
// to start its GUI and prints that failure to stdout with exit 0. The switch
// has to reach every run, reads and writes alike.
test('a read asks the binary to be the CLI', async () => {
  await runTailscale(['status', '--json'], 1000)
  assert.equal(envOfLastRun().TAILSCALE_BE_CLI, '1')
})

test('a write asks the binary to be the CLI', async () => {
  await runTailscaleResult(['serve', 'status'], 1000)
  assert.equal(envOfLastRun().TAILSCALE_BE_CLI, '1')
})

test('the rest of the environment is kept', async () => {
  process.env.SPRINTENGINE_TEST_CANARY = 'kept'
  try {
    await runTailscale(['status', '--json'], 1000)
    assert.equal(envOfLastRun().SPRINTENGINE_TEST_CANARY, 'kept')
  } finally {
    delete process.env.SPRINTENGINE_TEST_CANARY
  }
})

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Puts a stand-in `tailscale` first on PATH and runs `body` with real
 * processes. It is shaped like `/usr/local/bin/tailscale`: a shell wrapper
 * that runs the binary as its child rather than `exec`ing it. Each writes its
 * pid beside it; the wrapper then runs `wrapper` and the binary, the binary
 * what `binary` says.
 */
async function withStandIn(
  binary: string,
  body: (dir: string) => Promise<void>,
  wrapper: string[] = [],
): Promise<void> {
  spawn.mockImplementation(actual.spawn)
  const dir = mkdtempSync(join(tmpdir(), 'tailscale-cli-'))
  const script = (name: string, lines: string[]) => {
    writeFileSync(join(dir, name), ['#!/bin/sh', ...lines, ''].join('\n'))
    chmodSync(join(dir, name), 0o755)
  }
  script('tailscale', [
    'echo $$ > "$(dirname "$0")/wrapper.pid"',
    ...wrapper,
    '"$(dirname "$0")/tailscale-binary" "$@"',
  ])
  script('tailscale-binary', ['echo $$ > "$(dirname "$0")/binary.pid"', binary])
  const path = process.env.PATH
  process.env.PATH = `${dir}${delimiter}${path ?? ''}`
  try {
    await body(dir)
  } finally {
    process.env.PATH = path
    for (const name of ['wrapper.pid', 'binary.pid']) {
      try {
        const pid = Number(readFileSync(join(dir, name), 'utf8'))
        if (pid > 0 && isAlive(pid)) process.kill(pid, 'SIGKILL')
      } catch {
        // Never started.
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

test.skipIf(process.platform === 'win32')('a run that answers in time reads as it always did', async () => {
  // In time whatever the machine's load: the deadline is a fake timer nothing fires.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await withStandIn(`echo '{"Self":{}}'`, async () => {
    assert.equal(await runTailscale(['status', '--json'], 5_000), '{"Self":{}}\n')
    assert.deepEqual(await runTailscaleResult(['serve', 'status'], 5_000), { ok: true, stdout: '{"Self":{}}\n' })
  })
})

/** The pid a stand-in wrote once it was running, or undefined before then. */
function pidOf(dir: string, name: string): number | undefined {
  try {
    const text = readFileSync(join(dir, name), 'utf8')
    return /^\d+\n$/.test(text) ? Number(text) : undefined
  } catch {
    return undefined
  }
}

// Real time, for waiting on real processes while the run's own deadline is a
// fake timer the test fires (node:timers/promises is not faked).
async function waitFor<T>(what: string, read: () => T | undefined, withinMs = 30_000): Promise<T> {
  const deadline = Date.now() + withinMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    assert.ok(Date.now() < deadline, `${what} within ${withinMs} ms`)
    await sleep(10)
  }
}

afterEach(() => {
  vi.useRealTimers()
})

/**
 * Runs a write against a stand-in that outlives SIGTERM, and checks it was
 * ended at the deadline.
 *
 * The deadline is a fake timer, fired only once the wrapper and the binary
 * behind it are both running. On a real clock it raced their start: on a
 * loaded machine a one-second deadline could fire before the wrapper had
 * started the binary, so there was no binary to end and no pid to check.
 */
async function expectEndedAtDeadline(dir: string): Promise<void> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const deadlineMs = 1_000
  let settled: Awaited<ReturnType<typeof runTailscaleResult>> | undefined
  void runTailscaleResult(['serve', '--bg', '3000'], deadlineMs).then((result) => {
    settled = result
  })
  const pids = {
    wrapper: await waitFor('the wrapper started', () => pidOf(dir, 'wrapper.pid')),
    binary: await waitFor('the wrapper started the binary', () => pidOf(dir, 'binary.pid')),
  }
  // Both are up and would run for 30 s; one tick short of the deadline the
  // run is still waiting on them.
  vi.advanceTimersByTime(deadlineMs - 1)
  await sleep(50)
  assert.equal(settled, undefined, 'the run waits until its deadline')

  vi.advanceTimersByTime(1)
  // The stand-in would run for 30 s on its own; settling well inside that is
  // the deadline ending it, not the process finishing.
  const result = await waitFor('the run settled after its deadline', () => settled, 10_000)
  assert.deepEqual(result, { ok: false, stdout: '', stderr: '', timedOut: true })
  for (const [name, pid] of Object.entries(pids)) {
    // Killed, a process is reparented and reaped; wait for that.
    await waitFor(`${name} was ended`, () => (isAlive(pid) ? undefined : true), 10_000)
  }
}

// A TERM to the wrapper ends the wrapper alone: the binary, which ignores it,
// would carry on with no parent.
test.skipIf(process.platform === 'win32')(
  'a run that misses its deadline ends the binary behind the wrapper too',
  () => withStandIn(`trap '' TERM\nexec sleep 30`, expectEndedAtDeadline),
  60_000,
)

// A TERM nobody acts on would leave the run waiting until the process ends on
// its own.
test.skipIf(process.platform === 'win32')(
  'a run that ignores SIGTERM still settles at its deadline',
  () => withStandIn('exec sleep 30', expectEndedAtDeadline, ["trap '' TERM"]),
  60_000,
)
