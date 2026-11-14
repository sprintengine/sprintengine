// A WSL terminal agent's reports reach this PC through its distribution's
// Studio: the app's real hook reporter writes to a real listener socket, the
// relay sends each valid line on the `agent-state` stream, and the desktop's
// side hands it to the same validation its own socket uses. The `wsl.exe`
// between them is a plain stream pair here.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex, duplexPair } from 'node:stream'
import { afterAll, beforeAll, test } from 'vitest'

import { parseAgentStateFrame } from '../../main/agent-state'
import { createAgentStateListener, type AgentStateListener } from '../terminals/agent-state-listener'
import { createAgentStateRelay, followRelayedAgentState, readRelayedAgentState } from './agent-state-relay'

const REPORTER = join(process.cwd(), 'resources', 'hooks', 'sprintengine-agent-state.mjs')

let temp = ''
let socketPath = ''
let listener: AgentStateListener
const relay = createAgentStateRelay()

// A socket path must stay short (about 100 bytes), so the fixture lives in /tmp.
beforeAll(async () => {
  temp = mkdtempSync(join(existsSync('/tmp') ? '/tmp' : tmpdir(), 'se-asr-'))
  socketPath = join(temp, 'agent-state.sock')
  listener = createAgentStateListener({ socketPath, onFrame: (_frame, line) => relay.send(line) })
  await listener.start()
})

afterAll(async () => {
  relay.close()
  await listener.stop()
  rmSync(temp, { recursive: true, force: true })
})

/** Two ends of one stream, as the front door hands the distribution one and the desktop the other. */
function streamPair(): { distribution: Duplex; desktop: Duplex } {
  const [distribution, desktop] = duplexPair()
  return { distribution, desktop }
}

async function waitFor<T>(read: () => T | undefined, ms = 5_000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function runReporter(env: Record<string, string>, input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [REPORTER, '--socket', '/nonexistent/baked.sock'], {
      env: { PATH: process.env.PATH, ...env },
    })
    child.on('error', reject)
    child.on('close', () => resolve())
    child.stdin.end(input)
  })
}

test("the app's own hook reporter reaches the desktop through the distribution's relay, and the desktop's parser accepts it", async () => {
  const { distribution, desktop } = streamPair()
  relay.attach(distribution)
  const lines: string[] = []
  void readRelayedAgentState(desktop, (line) => lines.push(line))
  await runReporter(
    {
      SPRINTENGINE_AGENT_ID: 'agent-1',
      SPRINTENGINE_WORKSPACE_ID: 'ws-1',
      // The env wins over the baked argument, as the WSL startup script exports it.
      SPRINTENGINE_AGENT_STATE_SOCKET: socketPath,
    },
    JSON.stringify({ hook_event_name: 'Stop', session_id: 'cli-1' }),
  )
  const line = await waitFor(() => lines[0])
  const frame = parseAgentStateFrame(JSON.parse(line), Date.now())
  assert.ok(frame, 'the relayed line passes the same validation as one on this PC')
  assert.equal(frame.agentId, 'agent-1')
  assert.equal(frame.event, 'Stop')
  desktop.end()
  await waitFor(() => (relay.size() === 0 ? true : undefined))
})

test('garbage and over-long lines on the socket never cross to the desktop', async () => {
  const { distribution, desktop } = streamPair()
  relay.attach(distribution)
  const lines: string[] = []
  void readRelayedAgentState(desktop, (line) => lines.push(line))
  await new Promise<void>((resolve) => {
    const socket = connect(socketPath, () => {
      socket.write('not json\n[1,2]\n{"no":"frame"}\n')
      socket.end(`${'x'.repeat(70 * 1024)}\n`)
    })
    socket.on('close', () => resolve())
    socket.on('error', () => resolve())
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.deepEqual(lines, [])
  desktop.end()
})

test('a line the desktop has not read past the bound is dropped, not kept', () => {
  const sent: string[] = []
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      sent.push(chunk.toString('utf8'))
      // Never calls back: the desktop stopped reading.
      void callback
    },
    highWaterMark: 1,
  })
  const own = createAgentStateRelay()
  own.attach(stream)
  const line = `{"x":"${'a'.repeat(60 * 1024)}"}`
  for (let index = 0; index < 200; index += 1) own.send(line)
  assert.ok(stream.writableLength <= 4 * 1024 * 1024 + line.length + 1, 'what waits for the desktop is bounded')
  own.send('two\nlines')
  own.close()
  assert.equal(stream.destroyed, true)
})

test('the desktop follows a connection for as long as it stands, opening the stream again if it ends', async () => {
  let resolveClosed: () => void = () => undefined
  const owner = { state: 'open', closed: new Promise<void>((resolve) => (resolveClosed = resolve)) }
  const opened: Duplex[] = []
  const lines: string[] = []
  const following = followRelayedAgentState(
    {
      distro: 'Ubuntu',
      owner,
      open: async () => {
        const { distribution, desktop } = streamPair()
        opened.push(distribution)
        return desktop
      },
    },
    (line) => lines.push(line),
    () => undefined,
    10,
  )
  await waitFor(() => opened[0])
  opened[0].write('{"a":1}\n')
  await waitFor(() => lines[0])
  // The server ended the stream while the connection stands: opened again.
  opened[0].end()
  await waitFor(() => opened[1])
  opened[1].write('{"a":2}\n')
  await waitFor(() => lines[1])
  // The connection ended: the stream with it, and nothing opens again.
  owner.state = 'closed'
  resolveClosed()
  await following
  assert.equal(opened.length, 2)
  assert.deepEqual(lines, ['{"a":1}', '{"a":2}'])
})
