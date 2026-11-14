// The WSL helper end to end, on this machine: main's real client starts the
// real helper through a real `sh -s` (standing in for `wsl.exe --exec sh -s`).
// (A terminal agent's hook reporter and MCP bridge reach the distribution's
// Studio server instead: `server/wsl/agent-state-relay.test.ts` and
// `server/wsl/wsl-environment-manager.test.ts`.)
// Everything the helper does is plain Node on Linux, so only `wsl.exe` itself
// and /proc (macOS has none) are not exercised here.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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

test('the handshake gives main the helper paths', async () => {
  const info = await client.start()
  assert.equal(client.state(), 'ready')
  assert.equal(info.nodePath, process.execPath)
  assert.equal(await client.start(), info, 'a second start reuses the running helper')
})

test('main asks the helper to run argv', async () => {
  const echoed = await client.request<{ code: number; stdout: string }>('run', {
    argv: ['sh', '-c', 'printf "%s" "$1"', 'sh', "a 'quoted' $arg"],
    timeoutMs: 5_000,
  })
  assert.equal(echoed.stdout, "a 'quoted' $arg")
  await assert.rejects(client.request('run', { argv: 'rm -rf /', timeoutMs: 5_000 }), /array/u)
  await assert.rejects(client.request('run', { argv: ['true'], timeoutMs: null }), /deadline/u)
})

test('shutdown ends the helper', async () => {
  await client.start()
  await client.shutdown()
  assert.equal(client.state(), 'stopped')
})
