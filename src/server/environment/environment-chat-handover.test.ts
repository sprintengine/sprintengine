import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import type { StudioClient } from '../../../packages/client-runtime/src/public'
import { ConversationApprovalRuleStore } from '../../main/conversation-approval-rules'
import { workspaceStorePath } from '../../main/workspace-store'
import { conversationWorkingRoot } from '../../shared/agent-state'
import type { EnvironmentClients } from '../../shared/environment-clients'
import { machineSpellingOf } from '../../shared/machine-spelling'
import { machineStudioClient } from '../../shared/machine-studio-client'
import { createEnvironmentAdoption, type EnvironmentAdoptionStores } from './environment-adoption'
import { chatSourceFiles } from './environment-chat-sources'
import { createEnvironmentMigration } from './environment-migration'
import { studioMigrationStores } from './environment-migration-stores'

// A WSL distribution's chats that ran through `wsl.exe` on this desktop,
// handed to the distribution's own Studio (design-wsl-ssh-direct PR 3c): the
// workspace record, the chat's files read where they lie and sent in parts,
// and its saved approvals, each respelled for the distribution, through the
// real journal on this side and the real adoption on that one.

const dirs: string[] = []
const temp = (name: string) => {
  const dir = mkdtempSync(join(tmpdir(), name))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.SPRINTENGINE_STORE_HOME
})

test('a chat ran here lists its own files, those of its store only where the distribution does not keep it', async () => {
  process.env.SPRINTENGINE_STORE_HOME = temp('chat-sources-home-')
  const dataDir = temp('chat-sources-data-')
  const key = { workspaceRoot: '/Users/dev/repo', workspaceId: 'ws-1', agentId: 'a1' }
  const store = workspaceStorePath(key.workspaceRoot, 'conversations', 'ws-1')
  mkdirSync(join(store, 'a1.tools'), { recursive: true })
  mkdirSync(join(store, 'handoffs'), { recursive: true })
  writeFileSync(join(store, 'a1.jsonl'), '{}\n')
  writeFileSync(join(store, 'a2.jsonl'), '{}\n')
  writeFileSync(join(store, 'a1.tools', 'toolu_1.json'), '{}')
  writeFileSync(join(store, 'handoffs', 'a1-20261113-0930.md'), '# a1')
  writeFileSync(join(store, 'handoffs', 'a2-20261113-0930.md'), '# a2')
  const folder = createHash('sha256')
    .update(['/Users/dev/repo', 'ws-1', 'a1'].join('\u0000'))
    .digest('hex')
    .slice(0, 32)
  for (const directory of ['conversation-attachments', 'conversation-images', 'conversation-plans'])
    mkdirSync(join(dataDir, directory, folder), { recursive: true })
  writeFileSync(join(dataDir, 'conversation-attachments', folder, '0f1e.png'), 'png')
  writeFileSync(join(dataDir, 'conversation-attachments', folder, 'odd name.png'), 'png')
  writeFileSync(join(dataDir, 'conversation-plans', folder, 'the-plan-abc.md'), '# plan')

  const found = await chatSourceFiles({ dataDir, distro: 'Ubuntu', ...key })
  assert.deepEqual(found.map((file) => `${file.place} ${file.path}`).sort(), [
    `attachments ${folder}/0f1e.png`,
    `plans ${folder}/the-plan-abc.md`,
    'store a1.jsonl',
    'store a1.tools/toolu_1.json',
    'store handoffs/a1-20261113-0930.md',
  ])
})

/** This desktop with one WSL workspace, its chat and a saved approval, and the distribution's real adoption. */
function handOverRig() {
  process.env.SPRINTENGINE_STORE_HOME = temp('chat-handover-home-')
  const desktopDir = temp('chat-handover-desktop-')
  const machineDir = temp('chat-handover-machine-')
  const sourceDir = temp('chat-handover-sources-')

  // This desktop: a WSL workspace in a Windows drive folder, one chat, one saved approval.
  const record = {
    id: 'ws-1',
    name: 'repo',
    folderPath: 'C:\\code\\repo',
    hostId: 'wsl:Ubuntu',
    environment: { kind: 'wsl' as const, id: 'Ubuntu', label: 'WSL: Ubuntu' },
    agents: { a1: { conversation: { providerId: 'mock-provider' } } },
  }
  const transcript = Buffer.alloc(4 * 1024 * 1024 + 99, 'x')
  writeFileSync(join(sourceDir, 'a1.jsonl'), transcript)
  writeFileSync(join(sourceDir, 'shot.png'), 'png bytes')
  // As a Windows desktop saved it ("always allow" a write in the chat's folder).
  const rule = {
    id: 'rule-1',
    workspaceRoot: 'C:\\code\\repo',
    toolKind: 'file_write',
    toolName: 'Write',
    matcher: { type: 'path', prefix: 'c:/code/repo' },
    label: 'Write: files within c:/code/repo except .git',
    createdAt: 1,
  }
  writeFileSync(join(desktopDir, 'conversation-approval-rules.json'), JSON.stringify([rule]))
  const desktopRules = new ConversationApprovalRuleStore(desktopDir)

  // The distribution's Studio: its real adoption, its own registry and rule store.
  const theirs = new Map<string, Record<string, unknown>>()
  const machineRules = new ConversationApprovalRuleStore(machineDir)
  const adoptionStores: EnvironmentAdoptionStores = {
    flush: async () => undefined,
    workspaces: {
      has: (id) => theirs.has(id),
      chatRoot: (id, agentId) => {
        const there = theirs.get(id) as { folderPath?: string; agents?: Record<string, never> } | undefined
        return there ? conversationWorkingRoot(there.agents?.[agentId], there.folderPath) : null
      },
      adopt: (body) => (theirs.set(String(body.id), body), { ok: true }),
    },
    schedules: {
      has: () => false,
      adopt: async () => ({ ok: true }),
      keepImage: async () => '',
    },
    messages: {
      scheduleFrom: () => ({ ok: true }),
      hold: () => ({ ok: true }),
      holdCarrying: async () => ({ ok: true }),
    },
    approvalRules: { adopt: (value) => machineRules.adopt(value) },
    resumes: { adopt: async () => ({ ok: true }) },
    pullRequests: {
      noteOpened: async () => ({ ok: true }),
      watch: async () => ({ ok: true }),
      keepUntold: () => undefined,
    },
  }
  const adoption = createEnvironmentAdoption({ dataDir: machineDir, stores: adoptionStores })
  const staged = new Map<string, Buffer>()
  let uploads = 0
  let partsCalls = 0
  const raw = {
    async request(method: string, params: Record<string, unknown>) {
      if (method === 'uploads.begin') {
        const uploadId = `up-${++uploads}`
        staged.set(uploadId, Buffer.alloc(0))
        return { uploadId, chunkBytes: 1024 * 1024 }
      }
      if (method === 'uploads.append') {
        const id = String(params.uploadId)
        staged.set(id, Buffer.concat([staged.get(id)!, Buffer.from(String(params.dataBase64), 'base64')]))
        return { received: staged.get(id)!.length }
      }
      if (method === 'environment.adopt') {
        const files = new Map(
          ((params.files as Array<{ uploadId: string; digest: string }> | undefined) ?? []).map((file) => [
            file.digest,
            { bytes: staged.get(file.uploadId)!, mediaType: 'application/octet-stream' },
          ]),
        )
        if ((params.records as unknown[]).length === 0) partsCalls++
        return adoption.adopt({
          migrationId: String(params.migrationId),
          records: params.records as never,
          files,
        })
      }
      throw new Error(`not served: ${method}`)
    },
  } as unknown as StudioClient
  const spelling = machineSpellingOf('wsl:Ubuntu')!
  const clients: EnvironmentClients = {
    clientFor: async () => ({ ok: true, client: machineStudioClient(raw, spelling), name: 'WSL: Ubuntu' }),
    onConnected: () => () => undefined,
  }

  const migration = createEnvironmentMigration({
    dataDir: desktopDir,
    clients,
    spellingOf: () => spelling,
    stores: studioMigrationStores({
      workspaceRegistry: { getRecords: () => [record] as never },
      scheduledAgents: { loaded: async () => undefined, list: () => [], remove: async () => undefined } as never,
      scheduledMessages: {
        state: () => ({ messages: [] }),
        carriedOf: () => null,
        update: () => undefined,
        loaded: async () => undefined,
      } as never,
      usageLimitResumes: { state: () => ({ notices: [] }), update: () => undefined } as never,
      pullRequests: { whenLoaded: async () => undefined, handingOver: () => [], letGo: () => undefined } as never,
      chatSources: async () => [
        { place: 'store', path: 'a1.jsonl', source: join(sourceDir, 'a1.jsonl') },
        { place: 'attachments', path: `${'b'.repeat(32)}/shot.png`, source: join(sourceDir, 'shot.png') },
      ],
      approvalRules: desktopRules,
    }),
  })
  return {
    migration,
    theirs,
    machineDir,
    desktopDir,
    sourceDir,
    transcript,
    partsCalls: () => partsCalls,
    uploads: () => uploads,
  }
}

test("a WSL workspace's chat, its files and its saved approvals reach the distribution's Studio, respelled, in parts", async () => {
  const { migration, theirs, machineDir, desktopDir, transcript, partsCalls, uploads } = handOverRig()
  await migration.plan()
  assert.equal(await migration.deliver('wsl:Ubuntu'), true)
  assert.equal(migration.handedOver('wsl:Ubuntu'), true)

  // The record, in the distribution's own spelling, with nothing of this PC's machine.
  const there = theirs.get('ws-1') as { folderPath: string; hostId?: string; environment?: unknown }
  assert.equal(there.folderPath, '/mnt/c/code/repo')
  assert.equal(there.hostId, undefined)
  assert.equal(there.environment, undefined)
  // The transcript, put back together from its two parts where its runtime reads it.
  assert.ok(partsCalls() >= 1, 'its parts went ahead of it')
  const store = workspaceStorePath('/mnt/c/code/repo', 'conversations', 'ws-1')
  assert.deepEqual(readFileSync(join(store, 'a1.jsonl')), transcript)
  assert.equal(
    readFileSync(join(machineDir, 'conversation-attachments', 'b'.repeat(32), 'shot.png'), 'utf8'),
    'png bytes',
  )
  assert.deepEqual(
    readdirSync(join(machineDir, 'environment-adoptions', 'parts')).flatMap((id) =>
      readdirSync(join(machineDir, 'environment-adoptions', 'parts', id)),
    ),
    [],
    'no part waits for the sweep',
  )
  // The approval, its folder in the distribution's spelling, in its matcher and its words.
  const kept = await new ConversationApprovalRuleStore(machineDir).list()
  assert.equal(kept.length, 1)
  assert.equal(kept[0]!.workspaceRoot, '/mnt/c/code/repo')
  assert.deepEqual(kept[0]!.matcher, { type: 'path', prefix: '/mnt/c/code/repo' })
  assert.match(kept[0]!.label, /files within \/mnt\/c\/code\/repo except \.git/u)
  assert.deepEqual(await new ConversationApprovalRuleStore(desktopDir).list(), [], 'let go here')

  // Planned again (a restart): nothing more goes.
  const before = uploads()
  await migration.plan()
  assert.equal(await migration.deliver('wsl:Ubuntu'), true)
  assert.equal(uploads(), before)
})

test('a chat whose files changed after it was planned is left here as a conflict; the rest of the hand-over goes on', async () => {
  const { migration, theirs, machineDir, sourceDir } = handOverRig()
  await migration.plan()
  // The transcript is written again between the plan and the delivery.
  writeFileSync(join(sourceDir, 'a1.jsonl'), 'another transcript')
  assert.equal(await migration.deliver('wsl:Ubuntu'), true, 'not held up on every connect')
  assert.equal(migration.handedOver('wsl:Ubuntu'), true)
  assert.ok(theirs.has('ws-1'), 'the workspace went')
  assert.equal((await new ConversationApprovalRuleStore(machineDir).list()).length, 1, 'its approval went')
  const store = workspaceStorePath('/mnt/c/code/repo', 'conversations', 'ws-1')
  assert.throws(() => readFileSync(join(store, 'a1.jsonl')), 'the chat did not')
  assert.equal(readFileSync(join(sourceDir, 'a1.jsonl'), 'utf8'), 'another transcript', 'left where it lies')
})

test("a schedule goes with its folder's machine; one picked to run on This PC in a distribution's folder stays (R88)", async () => {
  const schedule = (id: string, folderPath: string, hostId: string | null) => ({ id, folderPath, hostId, prompt: 'p' })
  const stores = studioMigrationStores({
    workspaceRegistry: { getRecords: () => [] },
    scheduledAgents: {
      loaded: async () => undefined,
      list: () => [
        schedule('on-ssh', 'ssh://build-box/home/dev/repo', null),
        schedule('on-this-pc', '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo', 'local'),
        schedule('here', '/Users/dev/repo', null),
      ],
      remove: async () => undefined,
    } as never,
    scheduledMessages: { state: () => ({ messages: [] }), loaded: async () => undefined } as never,
    usageLimitResumes: { state: () => ({ notices: [] }) } as never,
    pullRequests: { whenLoaded: async () => undefined, handingOver: () => [] } as never,
  })
  const found = await stores.collect(() => true)
  assert.deepEqual(
    found.filter((record) => record.kind === 'schedule').map((record) => `${record.id} ${record.route}`),
    ['on-ssh ssh:build-box'],
  )
})

test('a schedule saved for a machine is handed over at once, each machine once a list; one that runs here is not', async () => {
  const { handOverSchedulesWhenSaved } = await import('./environment-migration-stores')
  const schedule = (id: string, folderPath: string, hostId: string | null = null) => ({ id, folderPath, hostId })
  let publish: (agents: never[]) => void = () => undefined
  const handedOver: string[] = []
  const stop = handOverSchedulesWhenSaved(
    {
      onChanged: (listener) => {
        publish = listener as never
        return () => (publish = () => undefined)
      },
    },
    async (route) => {
      handedOver.push(route)
    },
  )
  publish([schedule('here', '/Users/dev/repo')] as never[])
  assert.deepEqual(handedOver, [], 'a schedule of this computer stays')
  publish([
    schedule('here', '/Users/dev/repo'),
    schedule('nightly', 'ssh://build-box/home/dev/repo'),
    schedule('weekly', 'ssh://build-box/home/dev/other'),
  ] as never[])
  assert.deepEqual(handedOver, ['ssh:build-box'], 'its machine is asked once for both')
  stop()
  publish([schedule('nightly', 'ssh://build-box/home/dev/repo')] as never[])
  assert.deepEqual(handedOver, ['ssh:build-box'], 'nothing after it stops')
})

test('a schedule saved here for a machine never runs here: its times are skipped and Run now is refused, from the save on', async () => {
  const { scheduleWaitsForHandOver } = await import('./environment-migration-stores')
  const { createScheduledAgentsStore } = await import('../../main/scheduled-agents/store')
  const { createScheduledAgentsService } = await import('../../main/scheduled-agents/service')
  const { schedulerWithRunRecords } = await import('../../main/scheduled-agents/scheduled-runs.test-helper')
  const dir = mkdtempSync(join(tmpdir(), 'schedule-ownership-'))
  let now = Date.UTC(2026, 8, 30, 12, 59)
  let fire: (() => void) | null = null
  const ran: string[] = []
  try {
    const store = createScheduledAgentsStore({ filePath: join(dir, 'scheduled-agents.json'), now: () => now })
    await store.load()
    const scheduler = schedulerWithRunRecords({
      list: () => store.list(),
      run: async (agent) => {
        ran.push(agent.folderPath)
        return { at: now, ok: true, workspaceId: 'run' }
      },
      recordRun: (entry, run) => store.recordRun(entry, run),
      waitingFor: scheduleWaitsForHandOver,
      now: () => now,
      setTimer: (callback) => {
        fire = callback
        return 1
      },
      clearTimer: () => undefined,
    })
    const service = createScheduledAgentsService({
      store,
      scheduler,
      now: () => now,
      waitingFor: scheduleWaitsForHandOver,
    })
    scheduler.start()
    const base = {
      prompt: 'Triage.',
      schedule: { cron: '* * * * *', timezone: 'UTC' },
      hostId: null,
      cli: 'claude-code',
      cliModel: null,
      permissionPreset: null,
      skills: [],
      mcpServers: [],
      worktree: null,
    }
    const machine = await service.create({ ...base, folderPath: 'ssh://build-box/home/dev/repo' })
    const here = await service.create({ ...base, folderPath: '/Users/dev/repo' })
    assert.ok(machine.ok && here.ok)
    assert.match(service.get(machine.agent.id)?.waiting ?? '', /build-box/, 'listed as waiting to move')
    const refused = await service.runNow(machine.agent.id)
    assert.equal(refused.ok, false, 'Run now is refused here')
    assert.equal(service.get(here.agent.id)?.waiting, undefined)
    // Both come due at the next minute: only this computer's runs.
    now += 60_000
    ;(fire as (() => void) | null)?.()
    for (let wait = 0; wait < 100 && ran.length === 0; wait++) await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(ran, ['/Users/dev/repo'], 'its time is skipped here')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
