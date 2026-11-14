// The WSL helper end to end, on this machine: main's real client starts the
// real helper through a real `sh -s` (standing in for `wsl.exe --exec sh -s`).
// (A terminal agent's hook reporter and MCP bridge reach the distribution's
// Studio server instead: `server/wsl/agent-state-relay.test.ts` and
// `server/wsl/wsl-environment-manager.test.ts`.)
// Everything the helper does is plain Node on Linux, so only `wsl.exe` itself
// and /proc (macOS has none) are not exercised here.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { HELPER_ENTRY } from '../../../../tests/wsl-helper-modules'
import {
  createWslHelperClient,
  type HelperProcess,
  type WslHelperClient,
  type WslHelperEvent,
} from '../wsl-helper-client'

let temp = ''
const events: WslHelperEvent[] = []
let client: WslHelperClient

// A socket path must stay short (about 100 bytes), so the fixture lives in /tmp.
function shortTemp(prefix: string): string {
  return mkdtempSync(join(existsSync('/tmp') ? '/tmp' : tmpdir(), prefix))
}

beforeAll(async () => {
  temp = shortTemp('se-e2e-')
  mkdirSync(join(temp, 'home'))

  client = createWslHelperClient({
    distro: 'Ubuntu',
    appVersion: '0.4.0',
    profile: 'abc123def456',
    spawnShell: (): HelperProcess =>
      spawn('sh', ['-s'], {
        cwd: join(temp, 'home'),
        env: {
          PATH: process.env.PATH,
          HOME: join(temp, 'home'),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    // The installed layout is proved by the install tests; here the script
    // execs the helper straight from the source tree.
    launchScript: async () => `exec '${process.execPath}' '${HELPER_ENTRY}' --profile 'abc123def456'`,
    install: async () => assert.fail('nothing to install'),
    prewarm: async () => undefined,
    unready: async () => undefined,
    onEvent: (event) => events.push(event),
  })
})

afterAll(async () => {
  await client?.shutdown()
  rmSync(temp, { recursive: true, force: true })
})

async function waitFor<T>(read: () => T | undefined, ms = 5_000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('the handshake gives main the helper paths', async () => {
  const info = await client.start()
  assert.equal(client.state(), 'ready')
  assert.equal(info.nodePath, process.execPath)
  assert.equal(await client.start(), info, 'a second start reuses the running helper')
})

test('git through the helper takes stdin: a hunk applied to the index, and paths checked against ignores', async () => {
  if (spawnSync('git', ['--version']).status !== 0) return
  const repo = join(temp, 'repo-stdin')
  mkdirSync(repo)
  const git = (...args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 'dev@example.com')
  git('config', 'user.name', 'Dev')
  writeFileSync(join(repo, '.gitignore'), 'out/\n*.log\n')
  writeFileSync(join(repo, 'a.txt'), 'one\n')
  git('add', '.')
  git('-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'init')
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
  const patch = git('diff', 'a.txt').stdout
  const applied = await client.request<{ code: number; stderr: string }>('git', {
    cwd: repo,
    args: ['apply', '--cached', '-'],
    timeoutMs: null,
    env: { LC_ALL: 'C' },
    stdinB64: Buffer.from(patch).toString('base64'),
  })
  assert.equal(applied.code, 0, applied.stderr)
  assert.equal(git('diff', '--cached', '--name-only').stdout.trim(), 'a.txt', 'the hunk is in the index')
  mkdirSync(join(repo, 'out'))
  const ignored = await client.request<{ code: number; stdout: string }>('git', {
    cwd: repo,
    args: ['check-ignore', '-z', '--stdin'],
    timeoutMs: 10_000,
    env: { LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
    stdinB64: Buffer.from('out\0a.txt\0x.log\0').toString('base64'),
  })
  assert.deepEqual(ignored.stdout.split('\0').filter(Boolean), ['out', 'x.log'])
  await assert.rejects(
    client.request('git', { cwd: repo, args: ['status'], timeoutMs: 5_000, stdinB64: '***' }),
    /base64/u,
  )
})

test('a directory the helper watches reports its changes to main, and stops when told', async () => {
  const dir = join(temp, 'watched')
  mkdirSync(dir)
  await client.start()
  const heard: Array<string | null> = []
  let failed = 0
  const watch = client.watch(
    dir,
    false,
    (name) => heard.push(name),
    () => (failed += 1),
  )
  await new Promise((resolve) => setTimeout(resolve, 200))
  writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n')
  await waitFor(() => (heard.includes('HEAD') ? true : undefined))
  watch.close()
  const missing = client.watch(
    join(temp, 'not-there'),
    false,
    () => undefined,
    () => (failed += 1),
  )
  await waitFor(() => (failed === 1 ? true : undefined))
  missing.close()
})

test('main asks the helper to run argv and git', async () => {
  const echoed = await client.request<{ code: number; stdout: string }>('run', {
    argv: ['sh', '-c', 'printf "%s" "$1"', 'sh', "a 'quoted' $arg"],
    timeoutMs: 5_000,
  })
  assert.equal(echoed.stdout, "a 'quoted' $arg")
  await assert.rejects(client.request('run', { argv: 'rm -rf /', timeoutMs: 5_000 }), /array/u)
  await assert.rejects(client.request('run', { argv: ['true'], timeoutMs: null }), /deadline/u)
  if (spawnSync('git', ['--version']).status === 0) {
    const repo = join(temp, 'repo')
    mkdirSync(repo)
    spawnSync('git', ['init', '-q', repo])
    const top = await client.request<{ code: number; stdout: string }>('git', {
      cwd: repo,
      args: ['rev-parse', '--is-inside-work-tree'],
      timeoutMs: 10_000,
      env: { LC_ALL: 'C' },
    })
    assert.equal(top.stdout.trim(), 'true')
  }
})

test('shutdown ends the helper', async () => {
  await client.start()
  await client.shutdown()
  assert.equal(client.state(), 'stopped')
})
