import assert from 'node:assert/strict'
import type { IpcMain } from 'electron'
import { test } from 'vitest'

import type { StudioServerStatus } from '../../shared/studio-server-status'
import type { SupervisorState } from '../server-supervisor/supervisor'
import { registerStudioServerIpc, studioServerPhase } from './studio-server-ipc'

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    ipcMain: { handle: (channel: string, handler: never) => handlers.set(channel, handler) } as unknown as IpcMain,
    invoke: (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args),
  }
}

test('each supervisor state is one phase in words', () => {
  const phases: Array<[SupervisorState, string]> = [
    [{ kind: 'idle' }, 'starting'],
    [{ kind: 'starting', attempt: 1 }, 'starting'],
    [{ kind: 'ready', ready: {} as never }, 'running'],
    [{ kind: 'backoff', attempt: 2, delayMs: 1_000, exit: { code: 70, signal: null } }, 'reconnecting'],
    [{ kind: 'failed', reason: 'x', exit: null }, 'stopped'],
    [{ kind: 'stopping' }, 'stopping'],
    [{ kind: 'stopped' }, 'stopped'],
  ]
  for (const [state, phase] of phases) assert.equal(studioServerPhase(state), phase, state.kind)
})

function fakeSupervisor(initial: SupervisorState) {
  const listeners: Array<(state: SupervisorState) => void> = []
  const calls: string[] = []
  const supervisor = {
    state: initial,
    health: { pid: 4321, restarts: 2, lastExit: null, lastFatal: null, loopLagMs: null, startedAt: 1_000 },
    onState: (listener: (state: SupervisorState) => void) => {
      listeners.push(listener)
      return () => undefined
    },
    retry: () => void calls.push('retry'),
    restart: (why: string) => void calls.push(`restart: ${why}`),
    call: async () => ({}) as never,
  }
  return {
    supervisor,
    calls,
    move(state: SupervisorState) {
      supervisor.state = state
      for (const listener of listeners) listener(state)
    },
  }
}

test('a server that cannot start is said stopped, with its reason, and every window is told', async () => {
  const ipc = fakeIpc()
  const fake = fakeSupervisor({ kind: 'starting', attempt: 1 })
  const published: StudioServerStatus[] = []
  registerStudioServerIpc(ipc.ipcMain, {
    supervisor: fake.supervisor as never,
    openLog: async () => true,
    publish: (status) => published.push(status),
  })
  assert.equal(((await ipc.invoke('studio-server:status')) as StudioServerStatus).phase, 'starting')
  fake.move({
    kind: 'failed',
    reason: 'The Studio server failed to start 3 times. The data directory is not writable.',
    exit: { code: 70, signal: null },
  })
  const status = (await ipc.invoke('studio-server:status')) as StudioServerStatus
  assert.deepEqual(status, {
    phase: 'stopped',
    reason: 'The Studio server failed to start 3 times. The data directory is not writable.',
    pid: 4321,
    restarts: 2,
    startedAt: 1_000,
  })
  assert.deepEqual(published.at(-1), status)
  // Nothing to switch to: no mode, no fallback, no relaunch into another one.
  assert.equal(Object.hasOwn(status, 'mode'), false)
  assert.equal(Object.hasOwn(status, 'fellBack'), false)
  assert.equal(await ipc.invoke('studio-server:info'), null, 'a stopped server has no info')
  await ipc.invoke('studio-server:retry')
  assert.deepEqual(fake.calls, ['retry'])
})

test('only the one mode’s channels are served', () => {
  const ipc = fakeIpc()
  const channels: string[] = []
  registerStudioServerIpc({ handle: (channel: string) => void channels.push(channel) } as unknown as IpcMain, {
    supervisor: fakeSupervisor({ kind: 'idle' }).supervisor as never,
    openLog: async () => true,
    publish: () => undefined,
  })
  void ipc
  assert.deepEqual(channels.sort(), [
    'studio-server:info',
    'studio-server:open-log',
    'studio-server:restart',
    'studio-server:retry',
    'studio-server:status',
  ])
})
