import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import type { StudioSchedules } from '../../../../packages/studio-protocol/src/public'
import { createStudioSchedulesDomain } from '../../../server/schedules/schedules-domain'
import { studioWindowGrant } from '../../../server/rpc/studio-frame-port'
import { createStudioRpcRouter } from '../../../server/rpc/studio-rpc-router'
import { createFakeBackend } from '../../../server/rpc/studio-rpc.test-helper'
import { schedulerWithRunRecords } from '../../scheduled-agents/scheduled-runs.test-helper'
import { createScheduledAgentsService } from '../../scheduled-agents/service'
import { createScheduledAgentsStore } from '../../scheduled-agents/store'
import { deviceRig, refusalOf, until, type DeviceRig } from './tailnet-studio.test-helper'

// A paired device's reach to a Studio's scheduled agents (`schedules.*`), on
// the real tailnet listener: a `workspace:operate` pairing lists, makes,
// changes, runs, pauses, resumes and closes them; a `workspace:read` one only
// lists them and hears them change; a pairing without either reaches none;
// a removed one is closed. Served by the real scheduled agents service, the
// one every server's core runs.

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function domain() {
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-schedules-'))
  let ids = 0
  const store = createScheduledAgentsStore({
    filePath: join(dir, 'scheduled-agents.json'),
    newId: () => `sa-${(ids += 1)}`,
  })
  await store.load()
  const runs: string[] = []
  const scheduler = schedulerWithRunRecords({
    list: () => store.list(),
    recordRun: (id, ran) => store.recordRun(id, ran),
    run: async (agent) => {
      runs.push(agent.id)
      return { at: Date.now(), ok: true, workspaceId: `run-${runs.length}`, agentId: 'agent-1' }
    },
    pausedAll: () => store.pausedAll(),
  })
  const service = createScheduledAgentsService({ store, scheduler })
  const schedules = createStudioSchedulesDomain({
    service,
    findWorkspace: (workspaceId) =>
      workspaceId === 'ws-1'
        ? { folderPath: '/Users/dev/app', hostId: null }
        : workspaceId === 'ws-tree'
          ? { folderPath: '/Users/dev/app-trees/fix', worktree: { repoRoot: '/Users/dev/app' }, hostId: null }
          : null,
    defaultCli: () => 'claude-code',
  })
  cleanups.push(() => {
    scheduler.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  return { schedules, runs, store }
}

async function rig() {
  const { schedules, runs, store } = await domain()
  const r: DeviceRig = await deviceRig({ schedules })
  cleanups.push(() => r.dispose())
  return Object.assign(r, { runs, store })
}

const DRAFT = { workspaceId: 'ws-1', prompt: 'Triage new issues', cron: '0 9 * * 1-5', timezone: 'UTC' }

test('a paired desktop or phone that may operate makes, runs, pauses, resumes and closes a schedule', async () => {
  const r = await rig()
  const phone = r.pair(['workspace:operate'])
  const client = await r.client(phone.token)
  assert.ok(client.supports('schedules'))
  assert.deepEqual(await client.rpc['schedules.list']({}), { schedules: [], pausedAll: null })

  const { schedule } = await client.rpc['schedules.create']({ ...DRAFT, workspaceId: 'ws-tree', commandId: 'c-1' })
  assert.equal(schedule.folderPath, '/Users/dev/app', "a worktree's workspace schedules into its project")
  assert.equal(schedule.cli, 'claude-code', 'no CLI named: the one last picked there')
  assert.equal(schedule.scheduleWords, 'Weekdays at 9:00 AM')
  assert.equal(typeof schedule.nextRunAt, 'number')

  const paused = await client.rpc['schedules.pause']({ id: schedule.id, commandId: 'c-2' })
  assert.equal(typeof paused.schedule.pausedAt, 'number')
  const resumed = await client.rpc['schedules.resume']({ id: schedule.id, commandId: 'c-3' })
  assert.equal(resumed.schedule.pausedAt, undefined)

  const changed = await client.rpc['schedules.update']({
    id: schedule.id,
    prompt: 'Triage and label',
    commandId: 'c-4',
  })
  assert.equal(changed.schedule.prompt, 'Triage and label')
  assert.equal(changed.schedule.schedule.cron, '0 9 * * 1-5', 'what is left out stays')

  assert.deepEqual(await client.rpc['schedules.runNow']({ id: schedule.id, commandId: 'c-5' }), {
    workspaceId: 'run-1',
  })
  // The same command again is answered from its receipt: one chat, not two.
  assert.deepEqual(await client.rpc['schedules.runNow']({ id: schedule.id, commandId: 'c-5' }), {
    workspaceId: 'run-1',
  })
  assert.deepEqual(r.runs, [schedule.id])

  assert.deepEqual(await client.rpc['schedules.delete']({ id: schedule.id, commandId: 'c-6' }), {
    removed: schedule.id,
  })
  assert.equal(await refusalOf(client.rpc['schedules.pause']({ id: schedule.id, commandId: 'c-7' })), 'not_found')
  assert.equal(
    await refusalOf(client.rpc['schedules.create']({ ...DRAFT, workspaceId: 'ws-gone', commandId: 'c-8' })),
    'unknown_workspace',
  )
})

test('a read-only pairing lists the schedules and hears them change, and changes none', async () => {
  const r = await rig()
  const owner = await r.client(r.pair(['workspace:operate'], 'build-box').token)
  const phone = r.pair(['workspace:read'])
  const reader = await r.client(phone.token)
  const heard: StudioSchedules[] = []
  reader.subscribe('schedules.changed', {}, { onPayload: (payload) => heard.push(payload) })
  await reader.rpc['schedules.list']({})

  const { schedule } = await owner.rpc['schedules.create']({ ...DRAFT, commandId: 'c-1' })
  await until(() => heard.some((state) => state.schedules.some((row) => row.id === schedule.id)), 'the change pushed')
  assert.equal((await reader.rpc['schedules.list']({})).schedules[0]?.id, schedule.id)

  for (const call of [
    reader.rpc['schedules.create']({ ...DRAFT, commandId: 'r-1' }),
    reader.rpc['schedules.update']({ id: schedule.id, prompt: 'x', commandId: 'r-2' }),
    reader.rpc['schedules.pause']({ id: schedule.id, commandId: 'r-3' }),
    reader.rpc['schedules.resume']({ id: schedule.id, commandId: 'r-4' }),
    reader.rpc['schedules.runNow']({ id: schedule.id, commandId: 'r-5' }),
    reader.rpc['schedules.delete']({ id: schedule.id, commandId: 'r-6' }),
  ])
    assert.equal(await refusalOf(call), 'scope_required')
  assert.deepEqual(r.runs, [])
})

test('a pairing without a workspace scope reaches no schedule, and a removed one is closed', async () => {
  const r = await rig()
  const chatsOnly = await r.client(r.pair(['conversation:operate']).token)
  assert.equal(await refusalOf(chatsOnly.rpc['schedules.list']({})), 'scope_required')
  assert.equal(await refusalOf(chatsOnly.rpc['schedules.create']({ ...DRAFT, commandId: 'c-1' })), 'scope_required')

  const phone = r.pair(['workspace:operate'])
  const client = await r.client(phone.token)
  await client.rpc['schedules.list']({})
  r.devices.updateDeviceScopes(phone.id, ['workspace:read'])
  assert.equal(await refusalOf(client.rpc['schedules.create']({ ...DRAFT, commandId: 'c-2' })), 'scope_required')
  r.devices.revokeDevice(phone.id)
  await until(() => client.state !== 'open', 'the revoked connection to close')
})

test('an operating pairing pauses and resumes them all and marks a failure seen; it names no folder', async () => {
  const r = await rig()
  const client = await r.client(r.pair(['workspace:operate']).token)
  const { schedule } = await client.rpc['schedules.create']({ ...DRAFT, commandId: 'c-1' })

  const until = Date.now() + 60 * 60_000
  const paused = await client.rpc['schedules.pauseAll']({ until, commandId: 'c-2' })
  assert.equal(paused.pausedAll.until, until)
  assert.deepEqual((await client.rpc['schedules.list']({})).pausedAll, paused.pausedAll)
  assert.equal(
    await refusalOf(client.rpc['schedules.pauseAll']({ until: Date.now() - 1_000, commandId: 'c-3' })),
    'invalid_params',
    'a time already gone',
  )
  assert.deepEqual(await client.rpc['schedules.resumeAll']({ commandId: 'c-4' }), { pausedAll: null })
  assert.equal((await client.rpc['schedules.list']({})).pausedAll, null)

  await r.store.recordRun(schedule.id, { at: Date.now(), ok: false, message: 'Codex is not signed in.' })
  const seen = await client.rpc['schedules.markSeen']({ id: schedule.id, commandId: 'c-5' })
  assert.equal(typeof seen.schedule.lastFailureSeenAt, 'number')
  assert.equal(await refusalOf(client.rpc['schedules.markSeen']({ id: 'gone', commandId: 'c-6' })), 'not_found')

  // A folder is the owner's to name, however much else the pairing holds.
  const { workspaceId: _workspaceId, ...noWorkspace } = DRAFT
  assert.equal(
    await refusalOf(
      client.rpc['schedules.create']({ ...noWorkspace, workspaceRoot: '/Users/dev/app', commandId: 'c-7' }),
    ),
    'owner_required',
  )
})

test("the desktop's own window schedules by folder and machine, and its chips keep their names", async () => {
  const { schedules } = await domain()
  const router = createStudioRpcRouter({ backend: createFakeBackend(), info: () => ({}) as never, schedules })
  cleanups.push(() => router.close())
  const window = { connectionId: 'w', slot: 1, ownWindow: true }
  const ask = (method: string, params: unknown) =>
    router.handle(studioWindowGrant(), method as never, params as never, window as never) as Promise<{
      ok: boolean
      result?: { schedule: StudioSchedules['schedules'][number] }
      error?: { code: string }
    }>
  const { workspaceId: _workspaceId, ...noWorkspace } = DRAFT
  const made = await ask('schedules.create', {
    ...noWorkspace,
    workspaceRoot: '/Users/dev/notes',
    hostId: 'wsl:Ubuntu',
    skills: [{ id: 'skill-1', name: 'Release notes' }],
    mcpServers: ['server-1'],
    commandId: 'w-1',
  })
  assert.equal(made.ok, true, JSON.stringify(made))
  const schedule = made.result!.schedule
  assert.equal(schedule.folderPath, '/Users/dev/notes')
  assert.equal(schedule.hostId, 'wsl:Ubuntu')
  assert.deepEqual(schedule.skills, [{ id: 'skill-1', name: 'Release notes' }])
  assert.deepEqual(schedule.mcpServers, [{ id: 'server-1', name: 'server-1' }])

  // An edit by id alone keeps the name it was saved with.
  const edited = await ask('schedules.update', { id: schedule.id, skills: ['skill-1'], commandId: 'w-2' })
  assert.deepEqual(edited.result!.schedule.skills, [{ id: 'skill-1', name: 'Release notes' }])

  for (const params of [
    { ...DRAFT, workspaceRoot: '/Users/dev/notes', commandId: 'w-3' },
    { ...noWorkspace, workspaceRoot: '/Users/dev/notes', hostId: 'ssh:build-box', commandId: 'w-4' },
    { ...DRAFT, hostId: 'local', commandId: 'w-5' },
  ])
    assert.equal((await ask('schedules.create', params)).error?.code, 'invalid_params', JSON.stringify(params))
})
