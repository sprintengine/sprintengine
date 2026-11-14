// What a WSL distribution's Studio does inside it for the desktop's WSL
// terminals, as plain Node on this machine: the private launch directory and
// its files, and the process reads and kills against a fake /proc.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test } from 'vitest'

import { createDistributionTerminalHost } from './distribution-terminal-host'

let temp = ''

// Short, for the runtime directory a socket base may become.
beforeAll(() => {
  temp = mkdtempSync(join(existsSync('/tmp') ? '/tmp' : tmpdir(), 'se-dth-'))
})
afterAll(() => rmSync(temp, { recursive: true, force: true }))

function host(name: string, procRoot?: string, kills: number[] = []) {
  const home = join(temp, name, 'home')
  mkdirSync(home, { recursive: true })
  return createDistributionTerminalHost({
    profile: 'abc123def456',
    home,
    env: {},
    runtimeBase: join(temp, name, 'rt'),
    ...(procRoot ? { procRoot } : {}),
    kill: (pid) => void kills.push(pid),
  })
}

test("a launch's files go into a private directory under the home, by relative name, and nowhere else", () => {
  const terminals = host('files')
  assert.equal(
    terminals.sessionDir,
    join(temp, 'files', 'home', '.local', 'share', 'sprintengine-studio', 'sessions', 'abc123def456'),
  )
  assert.equal(statSync(terminals.sessionDir).mode & 0o777, 0o700)
  assert.equal(statSync(terminals.pidDir).mode & 0o777, 0o700)
  const { paths } = terminals.launchFiles({
    write: [{ path: 'sid-9-1.sh', b64: Buffer.from("export T='x'\n").toString('base64') }],
  })
  assert.deepEqual(paths, [join(terminals.sessionDir, 'sid-9-1.sh')])
  assert.equal(readFileSync(paths[0], 'utf8'), "export T='x'\n")
  assert.equal(statSync(paths[0]).mode & 0o777, 0o600, 'a startup script holds secrets: this user only')
  assert.throws(
    () => terminals.launchFiles({ write: [{ path: '../../.bashrc', b64: '' }] }),
    /Refusing the launch file path/u,
  )
  terminals.launchFiles({ remove: ['sid-9-1.sh', '../outside'] })
  assert.equal(existsSync(paths[0]), false)
})

test("a closed session's shell tree and its CLI are ended, and endAll ends every session its pid files name", async () => {
  const procRoot = join(temp, 'proc-root')
  const add = (pid: number, ppid: number, started: number, argv: string[]) => {
    mkdirSync(join(procRoot, String(pid)), { recursive: true })
    writeFileSync(
      join(procRoot, String(pid), 'stat'),
      `${pid} (${argv[0]}) S ${ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${started} 0 0`,
    )
    writeFileSync(join(procRoot, String(pid), 'cmdline'), `${argv.join('\0')}\0`)
  }
  add(1, 0, 1, ['/init'])
  add(100, 1, 1000, ['bash', '-li', '/x/sessions/sid-a-1.sh'])
  add(101, 100, 1001, ['claude', '--session-id', 'aaaa'])
  add(200, 1, 2000, ['bash', '-li', '/x/sessions/sid-b-2.sh'])
  add(201, 200, 2001, ['codex'])
  const kills: number[] = []
  const terminals = host('procs', procRoot, kills)
  writeFileSync(join(terminals.pidDir, 'sid-a-1.pid'), '100 1000\n')
  writeFileSync(join(terminals.pidDir, 'sid-b-2.pid'), '200 2000\n')

  const killed = await terminals.processes({ op: 'kill', cliSessionId: 'aaaa', key: 'sid-a-1' })
  assert.deepEqual([...(killed.killed ?? [])].sort(), [100, 101])
  assert.equal(existsSync(join(terminals.pidDir, 'sid-a-1.pid')), false, 'its pid file goes with it')

  terminals.launchFiles({ write: [{ path: 'sid-b-2.sh', b64: '' }] })
  const all = await terminals.processes({ op: 'endAll' })
  assert.ok(all.killed?.includes(200), JSON.stringify(all))
  assert.equal(existsSync(join(terminals.sessionDir, 'sid-b-2.sh')), false, 'and the launch files with them')

  // A read with no process table is undetermined, never "safe to reap".
  const missing = createDistributionTerminalHost({
    profile: 'abc123def456',
    home: join(temp, 'procs', 'home'),
    env: {},
    runtimeBase: join(temp, 'procs', 'rt'),
    procRoot: join(temp, 'no-proc'),
  })
  assert.deepEqual((await missing.processes({ op: 'snapshot', keys: ['sid-b-2'] })).verdicts, {})
})
