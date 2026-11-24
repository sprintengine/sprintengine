import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

import { afterEach, test } from 'vitest'

import { studioProcessId } from '../../../packages/studio-protocol/src/public'
import { createAgentProcessDomain, studioCommandMatcher } from './agent-process-domain'
import { createProcessReader, type ProcessReader } from './agent-process-reader'
import type { ProcessSnapshot, ScannedProcess } from './agent-process-scan'

// What `processes.stop` will and will not signal, against a fresh read of the
// machine, and the same once on a real process this test starts itself.

const NOW = Date.UTC(2026, 10, 24, 12)
const SELF = 10
const A = { workspaceId: 'ws-a', agentId: 'agent-a' }

function proc(pid: number, ppid: number, command: string, extra: Partial<ScannedProcess> = {}): ScannedProcess {
  return { pid, ppid, pgid: pid, startedAt: NOW - 86_400_000, rssBytes: 1000, command, identity: A, ...extra }
}

/** A machine whose processes end when signalled, unless they ignore SIGTERM. */
function fakeMachine(processes: ScannedProcess[], ignoresTerm: readonly number[] = []) {
  let alive = [...processes]
  const signals: Array<[number, NodeJS.Signals]> = []
  const reader: ProcessReader = {
    read: async (): Promise<ProcessSnapshot> => ({ processes: alive, listeners: new Map(), scannedAt: NOW }),
    cwds: async () => new Map(),
  }
  const kill = (pid: number, signal: NodeJS.Signals) => {
    signals.push([pid, signal])
    const hit = pid < 0 ? alive.filter((entry) => entry.pgid === -pid) : alive.filter((entry) => entry.pid === pid)
    if (hit.length === 0) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    const ends = hit.filter((entry) => signal === 'SIGKILL' || !ignoresTerm.includes(entry.pid))
    alive = alive.filter((entry) => !ends.includes(entry))
  }
  let clock = NOW
  const domain = createAgentProcessDomain({
    reader,
    selfPid: SELF,
    kill,
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
  })
  return { domain, signals, alive: () => alive.map((entry) => entry.pid) }
}

const BASE = [
  proc(1, 0, '/sbin/launchd', { identity: null }),
  proc(SELF, 1, '/Applications/SprintEngine Studio.app/Contents/MacOS/SprintEngine Studio', { identity: null }),
  proc(20, SELF, '/Users/dev/.local/bin/claude --output-format stream-json'),
]
const idOf = (entry: ScannedProcess) => studioProcessId(entry.pid, entry.startedAt)

test('a left-behind group leader is stopped by its group; what is gone or reused is said, not signalled', async () => {
  const leader = proc(40, 1, 'python3 -m http.server 8000')
  const child = proc(41, 40, 'python3 worker.py', { pgid: 40 })
  const machine = fakeMachine([...BASE, leader, child])
  const answer = await machine.domain.stop([idOf(leader), '999-1', `40-${Math.floor(leader.startedAt / 1000) + 7}`])
  assert.deepEqual(answer.results, [
    { id: idOf(leader), outcome: 'stopped' },
    { id: '999-1', outcome: 'gone' },
    { id: `40-${Math.floor(leader.startedAt / 1000) + 7}`, outcome: 'changed' },
  ])
  assert.deepEqual(machine.signals, [[-40, 'SIGTERM']])
  assert.deepEqual(machine.alive(), [1, SELF, 20])
})

test('Studio, an agent’s CLI and anything untagged are refused, and nothing is signalled', async () => {
  const untagged = proc(60, 1, 'node /Users/dev/server.js', { identity: null })
  const bridge = proc(
    22,
    20,
    '/Applications/SprintEngine Studio.app/Contents/MacOS/SprintEngine Studio mcp-stdio-bridge.mjs',
  )
  const machine = fakeMachine([...BASE, untagged, bridge])
  const answer = await machine.domain.stop([idOf(BASE[1]!), idOf(BASE[2]!), idOf(untagged), idOf(bridge)])
  assert.deepEqual(
    answer.results.map((entry) => entry.outcome),
    ['refused', 'refused', 'refused', 'refused'],
  )
  assert.deepEqual(machine.signals, [])
})

test('a group holding an agent’s CLI is not signalled as a group: the row and its own are, and the CLI lives', async () => {
  const script = proc(70, 1, 'node /Users/dev/orchestrate.mjs')
  const helper = proc(72, 70, 'node /Users/dev/helper.mjs', { pgid: 70 })
  const cli = proc(71, 70, 'codex exec fix-it', { pgid: 70 })
  const machine = fakeMachine([...BASE, script, helper, cli])
  const answer = await machine.domain.stop([idOf(script)])
  assert.deepEqual(answer.results, [{ id: idOf(script), outcome: 'stopped' }])
  assert.equal(
    machine.signals.some(([pid]) => pid < 0 || pid === 71),
    false,
    JSON.stringify(machine.signals),
  )
  assert.deepEqual(machine.alive(), [1, SELF, 20, 71])
})

test('what ignores SIGTERM is killed once the grace is up, and only while it is still the same process', async () => {
  const stubborn = proc(50, 30, 'node /Users/dev/stubborn.js', { pgid: 30 })
  const machine = fakeMachine([...BASE, proc(30, 20, '/bin/zsh -c run'), stubborn], [50])
  const answer = await machine.domain.stop([idOf(stubborn)])
  assert.deepEqual(answer.results, [{ id: idOf(stubborn), outcome: 'stopped' }])
  assert.deepEqual(machine.signals, [
    [50, 'SIGTERM'],
    [50, 'SIGKILL'],
  ])
})

test('without a reader (Windows) the list says why and a stop signals nothing', async () => {
  const domain = createAgentProcessDomain({ reader: null })
  const listed = await domain.list()
  assert.deepEqual([listed.processes, listed.unavailable], [[], 'platform'])
  const stopped = await domain.stop(['40-1'])
  assert.deepEqual(stopped, { results: [{ id: '40-1', outcome: 'refused' }], unavailable: 'platform' })
})

test('inside the app every process of its bundle is Studio’s; a plain Node server claims only its own line', () => {
  const inApp = studioCommandMatcher(
    '/Users/dev/studio/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
    true,
  )
  assert.equal(
    inApp('/Users/dev/studio/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app/x'),
    true,
  )
  const server = studioCommandMatcher('/usr/local/bin/node', false)
  assert.equal(server('/usr/local/bin/node /Users/dev/vite.js'), false)
  assert.equal(server('/opt/sprintengine-studio/sprintengine-studio --type=gpu'), true)
})

// ── On this machine ─────────────────────────────────────────────────────────

const started: number[] = []
afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already stopped, as it should be.
    }
  }
})

const reader = createProcessReader()

test.skipIf(reader === null)(
  'a real process carrying an agent’s identity is read back and stopped, and nothing else is',
  async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: { PATH: process.env.PATH ?? '', SPRINTENGINE_WORKSPACE_ID: 'ws-test', SPRINTENGINE_AGENT_ID: 'agent-test' },
      stdio: 'ignore',
    })
    started.push(child.pid!)
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    // This test is not Studio: its own process is a stand-in that is not on the machine.
    const domain = createAgentProcessDomain({ reader, selfPid: 2 ** 30 })
    let found: ScannedProcess | undefined
    for (let attempt = 0; attempt < 20 && !found?.identity; attempt++) {
      found = (await reader!.read()).processes.find((entry) => entry.pid === child.pid)
      if (!found?.identity) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.deepEqual(found?.identity, { workspaceId: 'ws-test', agentId: 'agent-test' })
    const id = studioProcessId(found!.pid, found!.startedAt)
    // The wrong start second names another process: refused as changed, and it keeps running.
    const wrong = await domain.stop([`${found!.pid}-${Math.floor(found!.startedAt / 1000) - 60}`])
    assert.equal(wrong.results[0]!.outcome, 'changed')
    assert.equal(child.exitCode, null)
    const answer = await domain.stop([id])
    assert.deepEqual(answer.results, [{ id, outcome: 'stopped' }])
    await exited
    assert.equal(child.signalCode, 'SIGTERM')
  },
  15_000,
)
