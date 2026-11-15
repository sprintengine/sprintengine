import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { scheduledAgentsSwitchModule } from '../../main/modules/scheduled-agents-switch'
import type { StudioPlatform } from '../platform/platform'
import { createStudioScheduledAgents } from './studio-scheduled-agents'

// The scheduler waits for the hand-over's first plan however it is started:
// the desktop starts it through the Scheduled agents switch, which says
// nothing of the plan, and a schedule the plan would take out (a machine's)
// must not run here meanwhile. A plan that failed (an unreadable journal)
// holds it, and the reason is said with the list.

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function scheduledAgents(after?: Promise<unknown>) {
  const dataDir = mkdtempSync(join(tmpdir(), 'scheduled-agents-'))
  folders.push(dataDir)
  return createStudioScheduledAgents({
    platform: { paths: { dataDir: () => dataDir } } as unknown as Pick<StudioPlatform, 'paths' | 'clients'>,
    conversations: { listSessions: () => ({ ok: true, sessions: [] }) },
    launch: async () => ({ ok: false, message: 'not in this test' }) as never,
    createConversationHost: () => ({ resolveKey: () => null, command: async () => ({ ok: false }) }) as never,
    workspaceRecords: () => [],
    gitHost: () => null as never,
    ...(after ? { after } : {}),
  })
}

/** Start it as the desktop's module kernel does: the switch's sidecar, with no arguments. */
async function startBySwitch(agents: ReturnType<typeof scheduledAgents>): Promise<void> {
  let sidecar: { start: () => Promise<void> | void } | null = null
  scheduledAgentsSwitchModule(agents, () => undefined).registerMain!({
    provideService: () => undefined,
    registerSidecar: (_spec: unknown, handlers: { start: () => Promise<void> | void }) => {
      sidecar = handlers
    },
  } as never)
  assert.ok(sidecar, 'the switch registers the scheduler')
  void (sidecar as { start: () => Promise<void> | void }).start()
  // The store is read and the runs a stop cut off settled before the wait.
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5))
}

test('the switch’s start waits for the hand-over’s plan, and runs nothing until it has finished', async () => {
  let planDone: () => void = () => undefined
  const plan = new Promise<void>((resolve) => (planDone = resolve))
  const agents = scheduledAgents(plan)
  await startBySwitch(agents)
  assert.equal(agents.running(), false, 'held while the plan is still to finish')
  planDone()
  for (let i = 0; i < 10 && !agents.running(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(agents.running(), true, 'runs once the plan has finished')
  await agents.stop()
})

test('a plan that never finishes (its journal unreadable) holds the scheduler the switch starts', async () => {
  const agents = scheduledAgents(new Promise<void>(() => undefined))
  await startBySwitch(agents)
  assert.equal(agents.running(), false)
  assert.deepEqual(agents.upcoming(), [], 'nothing is said to come')
  await agents.stop()
})

test('why they are held is said with every change, and cleared once they may run', () => {
  const agents = scheduledAgents()
  const heard: Array<string | null> = []
  agents.service.onChanged(() => heard.push(agents.held()))
  assert.equal(agents.held(), null)
  agents.hold('The hand-over journal could not be read (EACCES).')
  assert.equal(agents.held(), 'The hand-over journal could not be read (EACCES).')
  agents.hold(null)
  assert.deepEqual(heard, ['The hand-over journal could not be read (EACCES).', null])
})
