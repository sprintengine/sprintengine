import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import type { ConversationLaunchRequest, ConversationLaunchResult } from '../conversation-launch-service'
import { cronForInstant, type ScheduledAgentDraft } from '../../shared/scheduled-agents'
import { runScheduledAgent } from './runner'
import { createScheduledRunOutcomes } from './run-outcomes'
import { recoverScheduledRuns, RUN_CUT_OFF } from './run-recovery'
import { createScheduledAgentsScheduler } from './scheduler'
import { schedulerWithRunRecords } from './scheduled-runs.test-helper'
import { createScheduledAgentsService } from './service'
import { createScheduledAgentsStore, type ScheduledRunRecord } from './store'

// A scheduled run cut off by a crash, at each point of its start, and what the
// next start makes of it: the run is finished once, under the command id it
// was written down with, and never run a second time.
//
// Each "process" below is a store, a scheduler and the recovery built on the
// same file, as the scheduled-agents module builds them; a crash is a process
// left where it stopped, and the next one booted beside it. The chats are a
// stand-in for the conversation runtime that keeps what matters here: a chat
// carries the command id it was launched under, and its log keeps a receipt
// per command id, so a message sent again under the same id runs no second
// turn.

// Wednesday 30 September 2026, 12:10 UTC.
const NOW = Date.UTC(2026, 8, 30, 12, 10)
const HOUR = 60 * 60 * 1000

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sprintengine-scheduled-run-recovery-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'scheduled-agents.json')
}

function draft(overrides: Partial<ScheduledAgentDraft> = {}): ScheduledAgentDraft {
  return {
    prompt: 'Triage the issues opened since the last run.',
    schedule: { cron: '0 13 * * *', timezone: 'UTC' },
    folderPath: '/Users/dev/acme',
    hostId: null,
    cli: 'claude-code',
    cliModel: null,
    permissionPreset: null,
    skills: [{ id: 'triage', name: 'Triage' }],
    mcpServers: [],
    worktree: null,
    ...overrides,
  }
}

const onceAt = (at: number): ScheduledAgentDraft['schedule'] => ({
  cron: cronForInstant(at, 'UTC'),
  timezone: 'UTC',
  once: at,
})

/** Where a run's start stops: never, or held at that step for good (the process crashes there). */
type Hang = null | 'before-chat' | 'before-message' | 'mid-turn'

type Chat = { workspaceId: string; agentId: string; launchCommandId: string | null; receipts: Set<string> }

/** The chats and their logs: what outlives a process. */
function chatWorld() {
  const chats: Chat[] = []
  const turns: { workspaceId: string; commandId: string; message: string; skills: string[] }[] = []
  let hang: Hang = null
  const never = new Promise<never>(() => undefined)
  // A turn command: committed with its receipt in one write, so a repeat is
  // answered from the receipt and runs nothing.
  const commit = (chat: Chat, commandId: string, message: string, skills: string[]): void => {
    if (chat.receipts.has(commandId)) return
    chat.receipts.add(commandId)
    turns.push({ workspaceId: chat.workspaceId, commandId, message, skills })
  }
  return {
    chats,
    turns,
    hangAt(at: Hang) {
      hang = at
    },
    async launch(request: ConversationLaunchRequest): Promise<ConversationLaunchResult> {
      if (hang === 'before-chat') return never
      const chat: Chat = {
        workspaceId: `ws-${chats.length + 1}`,
        agentId: `agent-${chats.length + 1}`,
        launchCommandId: request.launchCommandId ?? null,
        receipts: new Set(),
      }
      chats.push(chat)
      const stage = hang
      // The first message goes after the launch answers, as the launch service sends it.
      void Promise.resolve().then(async () => {
        if (stage === 'before-message') return never
        commit(chat, request.firstCommandId ?? 'random', request.prompt ?? '', request.skills ?? [])
        if (stage === 'mid-turn') return never
        request.onFirstSent?.()
      })
      return {
        ok: true,
        workspaceId: chat.workspaceId,
        agentId: chat.agentId,
        name: 'Triage',
        cli: 'claude-code',
        providerId: 'claude',
        modelId: 'sonnet',
        sessionId: `session-${chat.workspaceId}`,
      }
    },
    findChat(commandId: string) {
      const chat = chats.find((candidate) => candidate.launchCommandId === commandId)
      return chat ? { workspaceId: chat.workspaceId, agentId: chat.agentId } : null
    },
    async send(
      key: { workspaceId: string; agentId: string },
      commandId: string,
      message: { prompt: string; skills: string[] },
    ): Promise<{ ok: true } | { ok: false; message: string }> {
      const chat = chats.find((candidate) => candidate.workspaceId === key.workspaceId)
      if (!chat) return { ok: false, message: 'The chat is no longer there.' }
      commit(chat, commandId, message.prompt, message.skills)
      return { ok: true }
    },
  }
}

/** One process: what the scheduled-agents module builds at start, on `file`. */
async function boot(file: string, world: ReturnType<typeof chatWorld>, now: number) {
  let clock = now
  const timers: { callback: () => void; at: number }[] = []
  const store = createScheduledAgentsStore({ filePath: file, now: () => clock })
  await store.load()
  const outcomes = createScheduledRunOutcomes({
    store,
    notifyRan: () => undefined,
    notifyChanged: () => undefined,
    warn: () => undefined,
  })
  let ids = 0
  const scheduler = createScheduledAgentsScheduler({
    list: () => store.list(),
    beginRun: (commandId, run) => store.beginRun(commandId, run),
    endRun: (commandId) => store.endRun(commandId),
    recordRun: outcomes.recordRun,
    onRan: outcomes.onRan,
    newCommandId: () => `scheduled-run:${now}-${++ids}`,
    run: (agent, signal, commandId) =>
      runScheduledAgent(
        agent,
        commandId,
        {
          launchConversation: (request) => world.launch(request),
          getRepoRoot: async () => null,
          createWorktree: async () => ({ ok: false, message: 'not asked' }),
          onFirstSendFailed: (workspaceId, message) => outcomes.firstSendFailed(agent.id, workspaceId, message),
          onFirstSendDone: () => void store.endRun(commandId),
          now: () => clock,
        },
        signal,
      ),
    now: () => clock,
    setTimer: (callback, ms) => {
      const timer = { callback, at: clock + ms }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      const at = timers.indexOf(handle as (typeof timers)[number])
      if (at >= 0) timers.splice(at, 1)
    },
  })
  const recovered = await recoverScheduledRuns({
    store,
    outcomes,
    findChat: (commandId) => world.findChat(commandId),
    send: (chat, commandId, message) => world.send(chat, commandId, message),
    warn: () => undefined,
  })
  scheduler.start()
  const settle = async () => {
    for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return {
    store,
    scheduler,
    async advanceTo(to: number) {
      clock = to
      for (const timer of timers.splice(0).filter((due) => due.at <= to)) timer.callback()
      await settle()
    },
    async settled() {
      await recovered.finishing
      await settle()
    },
  }
}

/**
 * Waits, on a machine under load, for what a process does without being
 * awaited (a run's writes, a schedule closing) to have happened.
 */
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting until ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const recordsOnDisk = (file: string): ScheduledRunRecord[] => Object.values(runsOnDisk(file))

/** Whether the file still lists that schedule. */
const agentOnDisk = (file: string, id: string): boolean =>
  (JSON.parse(readFileSync(file, 'utf8')) as { agents?: { id: string }[] }).agents?.some((agent) => agent.id === id) ??
  false

/** The file's run records, as the next process (or a hand-over) reads them. */
function runsOnDisk(file: string): Record<string, ScheduledRunRecord> {
  return (JSON.parse(readFileSync(file, 'utf8')) as { runs?: Record<string, ScheduledRunRecord> }).runs ?? {}
}

async function seed(file: string, schedule: ScheduledAgentDraft['schedule']): Promise<string> {
  const store = createScheduledAgentsStore({ filePath: file, now: () => NOW - 2 * HOUR })
  const created = await store.create(draft({ schedule }))
  return created.id
}

test('a run is written down with its first message before it makes anything, and goes once that message is answered', async () => {
  const file = tempFile()
  const world = chatWorld()
  await seed(file, { cron: '0 13 * * *', timezone: 'UTC' })
  const first = await boot(file, world, NOW)
  world.hangAt('before-chat')
  void first.scheduler.runNow((await first.store.list())[0]!.id)
  await until(() => recordsOnDisk(file).length === 1, 'the run is on disk')
  assert.deepEqual(Object.values(runsOnDisk(file)), [
    {
      scheduledAgentId: first.store.list()[0]!.id,
      startedAt: NOW,
      prompt: 'Triage the issues opened since the last run.',
      skills: ['triage'],
    },
  ])

  // Another start while that one is still making its chat is refused.
  assert.deepEqual(await first.scheduler.runNow(first.store.list()[0]!.id), { ok: false, refused: 'starting' })
})

test('a crash before the run made its chat: a repeating schedule records the run as cut off, and waits for its next time', async () => {
  const file = tempFile()
  const world = chatWorld()
  const id = await seed(file, { cron: '0 13 * * *', timezone: 'UTC' })
  const first = await boot(file, world, NOW)
  world.hangAt('before-chat')
  void first.scheduler.runNow(id)
  await until(() => recordsOnDisk(file).length === 1, 'the run is on disk')
  // The process stops here, and the next one starts.
  world.hangAt(null)
  const second = await boot(file, world, NOW + HOUR / 2)
  await second.settled()

  assert.deepEqual(second.store.get(id)?.lastRun, { at: NOW, ok: false, message: RUN_CUT_OFF })
  assert.deepEqual(runsOnDisk(file), {})
  assert.deepEqual(world.chats, [])
  assert.equal(second.scheduler.nextRunAt(id), Date.UTC(2026, 8, 30, 13, 0), 'the missed run is not made up')
})

test('a crash before the run made its chat: a one-time schedule runs once at the next start, late rather than never', async () => {
  const file = tempFile()
  const world = chatWorld()
  const id = await seed(file, onceAt(NOW))
  const first = await boot(file, world, NOW)
  world.hangAt('before-chat')
  await first.advanceTo(NOW)
  await until(() => recordsOnDisk(file).length === 1, 'the run was written down as it began')
  world.hangAt(null)
  const second = await boot(file, world, NOW + HOUR)
  await second.advanceTo(NOW + HOUR)
  await second.settled()
  await until(() => second.store.get(id) === null && recordsOnDisk(file).length === 0, 'the run is done')

  assert.equal(world.chats.length, 1)
  assert.deepEqual(
    world.turns.map((turn) => turn.message),
    ['Triage the issues opened since the last run.'],
  )
  assert.equal(second.store.get(id), null, 'its chat started, so the one-time schedule closed')
  assert.deepEqual(runsOnDisk(file), {})
})

test('a crash after the chat was made and before its first message went: the next start sends it, once, under the run’s id', async () => {
  const file = tempFile()
  const world = chatWorld()
  const id = await seed(file, onceAt(NOW))
  const first = await boot(file, world, NOW)
  world.hangAt('before-message')
  await first.advanceTo(NOW)
  // The crashed process has stopped writing: its run names its chat, and its
  // one-time schedule's close, which follows that write unawaited, is on disk
  // too. A late write of its own would otherwise land over the next process's.
  await until(
    () => recordsOnDisk(file)[0]?.chat !== undefined && first.store.get(id) === null && !agentOnDisk(file, id),
    'the run names its chat on disk, and its schedule has closed',
  )
  const [commandId] = Object.keys(runsOnDisk(file))
  assert.ok(commandId)
  assert.equal(world.chats[0]?.launchCommandId, commandId, 'the chat carries the id its run was written down with')
  assert.deepEqual(world.turns, [])

  world.hangAt(null)
  const second = await boot(file, world, NOW + HOUR)
  await second.advanceTo(NOW + HOUR)
  await second.settled()
  await until(() => second.store.get(id) === null && recordsOnDisk(file).length === 0, 'the run is done')

  assert.equal(world.chats.length, 1, 'no second chat')
  assert.deepEqual(world.turns, [
    {
      workspaceId: 'ws-1',
      commandId,
      message: 'Triage the issues opened since the last run.',
      skills: ['triage'],
    },
  ])
  assert.equal(second.store.get(id), null, 'the one-time schedule did its job and closed')
  assert.deepEqual(runsOnDisk(file), {})
})

test('a crash after the first message went: the next start finishes the run without a second turn', async () => {
  const file = tempFile()
  const world = chatWorld()
  const id = await seed(file, { cron: '0 13 * * *', timezone: 'UTC' })
  const first = await boot(file, world, NOW)
  world.hangAt('mid-turn')
  await first.scheduler.runNow(id)
  await until(
    () => recordsOnDisk(file)[0]?.chat !== undefined && world.turns.length === 1,
    'the first message went and the run names its chat on disk',
  )
  const [commandId] = Object.keys(runsOnDisk(file))
  assert.deepEqual(runsOnDisk(file)[commandId!]?.chat, { workspaceId: 'ws-1', agentId: 'agent-1' })
  assert.equal(world.turns.length, 1)

  world.hangAt(null)
  const second = await boot(file, world, NOW + HOUR / 2)
  await second.settled()
  await until(() => recordsOnDisk(file).length === 0, 'the run is done')

  assert.equal(world.turns.length, 1, 'the repeat was answered from the chat’s receipt')
  assert.equal(world.chats.length, 1)
  assert.deepEqual(second.store.get(id)?.lastRun, { at: NOW, ok: true, workspaceId: 'ws-1', agentId: 'agent-1' })
  assert.deepEqual(runsOnDisk(file), {})
})

test('a run whose chat has gone by the next start is recorded as failed, and its record goes', async () => {
  const file = tempFile()
  const world = chatWorld()
  const id = await seed(file, { cron: '0 13 * * *', timezone: 'UTC' })
  const first = await boot(file, world, NOW)
  world.hangAt('before-message')
  await first.scheduler.runNow(id)
  await until(() => recordsOnDisk(file)[0]?.chat !== undefined, 'the run names its chat on disk')
  // The person deleted the chat before the next start.
  world.chats.splice(0)
  world.hangAt(null)
  const second = await boot(file, world, NOW + HOUR / 2)
  await second.settled()
  await until(() => second.store.get(id)?.lastRun?.ok === false, 'the run is recorded as failed')

  const lastRun = second.store.get(id)?.lastRun
  assert.equal(lastRun?.ok, false)
  assert.match(lastRun && !lastRun.ok ? lastRun.message : '', /no longer there/u)
  assert.deepEqual(runsOnDisk(file), {})
})

test('a missed start time: a one-time schedule runs once, a repeating one waits for its next time', async () => {
  const file = tempFile()
  const world = chatWorld()
  const once = await seed(file, onceAt(NOW - HOUR))
  const repeating = (await createScheduledAgentsStore({ filePath: file, now: () => NOW - 2 * HOUR }).create(draft())).id
  // The app was closed through both times; nothing was on its way.
  const started = await boot(file, world, NOW)
  await started.advanceTo(NOW)
  await started.settled()
  await until(
    () => world.turns.length === 1 && started.store.get(once) === null && recordsOnDisk(file).length === 0,
    'the one-time schedule ran and closed',
  )

  assert.equal(world.turns.length, 1)
  assert.equal(started.store.get(once), null)
  assert.equal(started.store.get(repeating)?.lastRun, null)
  assert.equal(started.scheduler.nextRunAt(repeating), Date.UTC(2026, 8, 30, 13, 0))

  // Started again: the one-time schedule is done, and nothing runs twice.
  const again = await boot(file, world, NOW + HOUR / 4)
  await again.advanceTo(NOW + HOUR / 4)
  await again.settled()
  assert.equal(world.turns.length, 1)
})

test('run records are plain entries keyed by command id; one this build would not write is dropped, not sent', async () => {
  const file = tempFile()
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      agents: [],
      runs: {
        'scheduled-run:a': {
          scheduledAgentId: 'sa-gone',
          startedAt: NOW,
          prompt: 'Look at the queue.',
          chat: { workspaceId: 'ws-9', agentId: 'agent-9' },
        },
        'scheduled-run:b': { scheduledAgentId: 'sa-gone', startedAt: 'yesterday', prompt: 'Look.' },
      },
    }),
  )
  const store = createScheduledAgentsStore({ filePath: file, now: () => NOW })
  await store.load()
  assert.deepEqual(store.runs(), {
    'scheduled-run:a': {
      scheduledAgentId: 'sa-gone',
      startedAt: NOW,
      prompt: 'Look at the queue.',
      chat: { workspaceId: 'ws-9', agentId: 'agent-9' },
    },
  })

  // Its schedule is gone, and the run is still finished from what its record says.
  const world = chatWorld()
  world.chats.push({ workspaceId: 'ws-9', agentId: 'agent-9', launchCommandId: 'scheduled-run:a', receipts: new Set() })
  const started = await boot(file, world, NOW + HOUR)
  await started.settled()
  assert.deepEqual(world.turns, [
    { workspaceId: 'ws-9', commandId: 'scheduled-run:a', message: 'Look at the queue.', skills: [] },
  ])
  assert.deepEqual(runsOnDisk(file), {})
})

test('the images a run on its way names are kept, though its schedule is gone', async () => {
  const file = tempFile()
  const store = createScheduledAgentsStore({ filePath: file, now: () => NOW })
  const id = (await store.create(draft({ prompt: 'Look at /data/scheduled-images/abc/shot.png' }))).id
  await store.beginRun('scheduled-run:a', {
    scheduledAgentId: id,
    startedAt: NOW,
    prompt: 'Look at /data/scheduled-images/abc/shot.png',
  })
  const pruned: string[][] = []
  const service = createScheduledAgentsService({
    store,
    scheduler: schedulerWithRunRecords({
      list: () => store.list(),
      run: async () => ({ at: NOW, ok: true, workspaceId: 'w' }),
      recordRun: async () => undefined,
    }),
    promptImages: { keep: async (prompt) => prompt, prune: async (prompts) => void pruned.push([...prompts]) },
  })
  assert.equal((await service.remove(id)).ok, true)
  assert.deepEqual(pruned, [['Look at /data/scheduled-images/abc/shot.png']])
})
