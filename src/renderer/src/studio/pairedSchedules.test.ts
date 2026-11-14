import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

import { fakePairedStudios } from './environmentStudio.double'
import { closeEnvironmentStudios, configureEnvironmentStudio } from './environmentStudio'
import { createPairedScheduledAgent, pairedScheduledAgentAction } from './pairedSchedules'

// A schedule asked of another machine has one outcome. A machine away refuses
// it here and nothing is made there on its return (the client would
// otherwise hold the request and send it on the reconnect, after this window
// had said "Not scheduled"); a machine that never connected in time is asked
// nothing later either; and a retry of the same draft is the same command
// there, so a lost answer never makes two.

const MACHINE = { route: 'ssh:build-box', name: 'dev@build-box' }
const DRAFT = { workspaceRoot: '/home/dev/proj', prompt: 'echo hi', cron: '* * * * *', cli: 'claude-code' }
const created = (params: Record<string, unknown>) => ({
  schedule: { id: 'sa-1', prompt: params.prompt, schedule: { cron: params.cron, timezone: 'UTC' } },
})

// What the window asks by: its bridge, which the double stands behind.
const api = {} as object
;(globalThis as { window?: unknown }).window = { api }
afterEach(() => {
  vi.useRealTimers()
  closeEnvironmentStudios(api as never)
})

test('a machine away refuses a new schedule at once, asks nothing of it, and says nothing was made', async () => {
  const studio = fakePairedStudios(api, { 'schedules.create': created })
  // Open once, then dropped: the client is reconnecting.
  assert.equal((await createPairedScheduledAgent(MACHINE, DRAFT, 'cmd-1')).ok, true)
  studio.setState(MACHINE.route, 'reconnecting')
  const refused = await createPairedScheduledAgent(MACHINE, { ...DRAFT, prompt: 'while away' }, 'cmd-2')
  assert.equal(refused.ok, false)
  assert.match(refused.ok ? '' : refused.message, /dev@build-box is not connected, so nothing was scheduled there/u)
  assert.deepEqual(
    studio.calls.filter((call) => call.method === 'schedules.create').map((call) => call.params.prompt),
    ['echo hi'],
    'the one made while away was never asked',
  )
  studio.setState(MACHINE.route, 'open')
  assert.equal(studio.calls.filter((call) => call.method === 'schedules.create').length, 1)
})

test('a machine that does not connect in time is asked nothing once it does', async () => {
  vi.useFakeTimers()
  let connect: () => void = () => undefined
  const calls: string[] = []
  configureEnvironmentStudio(api, {
    connect: () =>
      new Promise((resolve) => {
        connect = () =>
          resolve({
            state: 'open',
            supports: () => true,
            rpc: new Proxy(
              {},
              {
                get: (_target, method: string) => async (params: Record<string, unknown>) => {
                  calls.push(method)
                  return created(params)
                },
              },
            ),
            closed: new Promise(() => undefined),
            close: () => undefined,
          } as never)
      }),
  })
  const asked = createPairedScheduledAgent(MACHINE, DRAFT, 'cmd-1')
  await vi.advanceTimersByTimeAsync(16_000)
  const answer = await asked
  assert.equal(answer.ok, false)
  assert.match(answer.ok ? '' : answer.message, /not connected, so nothing was scheduled/u)
  connect()
  await vi.advanceTimersByTimeAsync(10)
  assert.deepEqual(calls, [], 'nothing went once it connected')
})

test('every try of one draft goes under the command id given, so the machine makes it once', async () => {
  const studio = fakePairedStudios(api, { 'schedules.create': created })
  await createPairedScheduledAgent(MACHINE, DRAFT, 'draft-1')
  await createPairedScheduledAgent(MACHINE, DRAFT, 'draft-1')
  assert.deepEqual(
    studio.calls.filter((call) => call.method === 'schedules.create').map((call) => call.params.commandId),
    ['draft-1', 'draft-1'],
  )
})

test('pausing, running or deleting one while its machine is away is refused, not done on its return', async () => {
  const studio = fakePairedStudios(api, { 'schedules.list': () => ({ schedules: [], pausedAll: null }) })
  await createPairedScheduledAgent(MACHINE, DRAFT).catch(() => undefined)
  studio.setState(MACHINE.route, 'reconnecting')
  const paused = await pairedScheduledAgentAction(MACHINE, 'sa-1', 'pause')
  assert.equal(paused.ok, false)
  assert.match(paused.ok ? '' : paused.message, /nothing was paused there/u)
  assert.equal(studio.calls.filter((call) => call.method === 'schedules.pause').length, 0)
})
