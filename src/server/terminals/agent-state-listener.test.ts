import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { AgentStateFrame } from '../../main/agent-state'
import { resolveAgentStateSocketPath } from '../../main/agent-state-service'
import { createAgentStateListener } from './agent-state-listener'

function writeLine(socketPath: string, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    socket.on('error', reject)
    socket.on('connect', () => socket.write(line, () => socket.end()))
    socket.on('close', () => resolve())
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('the listener delivers valid frames from its socket and from a relay, and drops the rest', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'se-agent-state-listener-'))
  const received: AgentStateFrame[] = []
  const listener = createAgentStateListener({
    socketPath: resolveAgentStateSocketPath(dataDir),
    onFrame: (frame) => received.push(frame),
    now: () => 4242,
  })
  await listener.start()
  assert.equal(listener.isRunning(), true)

  await writeLine(listener.socketPath, 'not json\n')
  await writeLine(
    listener.socketPath,
    `${JSON.stringify({ type: 'agent_state', agentId: 'a1', workspaceId: 'w1', phase: 'tool_use', event: 'PreToolUse' })}\n`,
  )
  await waitFor(() => received.length >= 1)
  assert.equal(received.length, 1)
  assert.equal(received[0]?.agentId, 'a1')
  assert.equal(received[0]?.phase, 'tool_use')
  // Stamped with the clock, since the frame carried no time of its own.
  assert.equal(received[0]?.ts, 4242)

  // An invalid phase is refused by validation, from the socket and from a relay alike.
  await writeLine(listener.socketPath, `${JSON.stringify({ type: 'agent_state', agentId: 'a1', phase: 'bogus' })}\n`)
  listener.ingestLine(JSON.stringify({ type: 'agent_state', agentId: 'a1', phase: 'bogus' }))
  listener.ingestLine('{')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(received.length, 1)

  // A WSL helper's relayed line is held to the same rule and delivered the same way.
  listener.ingestLine(JSON.stringify({ type: 'agent_state', agentId: 'a2', workspaceId: 'w1', phase: 'idle' }))
  assert.equal(received.at(-1)?.agentId, 'a2')

  await listener.stop()
  assert.equal(listener.isRunning(), false)
  if (process.platform !== 'win32') assert.equal(existsSync(listener.socketPath), false)
})

test('a listener stopped while it starts does not keep listening', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'se-agent-state-listener-'))
  const listener = createAgentStateListener({ socketPath: resolveAgentStateSocketPath(dataDir), onFrame: () => {} })
  const started = listener.start()
  await listener.stop()
  await started
  assert.equal(listener.isRunning(), false)
})
