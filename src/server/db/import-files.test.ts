import assert from 'node:assert/strict'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { openTestDatabase } from '../../../tests/studio-database'
import { launchNoticesDatabaseStorage, readSavedLaunchNotices } from '../../main/agent-launch-notices'
import { createAgentPromptStore } from '../../main/agent-prompt-store'
import { hashSecret } from '../../main/automation/tailnet/secret-hash'
import { createTailnetDeviceStore } from '../../main/automation/tailnet/tailnet-devices'
import { createLocalServerRecord } from '../local-servers/local-server-record'
import { createClientToolsetStore } from '../tools/client-toolset-store'
import { createEmbedStore } from '../web/embeds'
import { ConversationApprovalRuleStore } from '../../main/conversation-approval-rules'
import { createPendingFirstMessages } from '../../main/conversation-first-messages'
import {
  DATA_FORMAT_FILENAME,
  prepareDataFormat,
  STUDIO_DATA_FORMAT,
  StudioDataMigrationError,
} from '../environment/data-format'
import { prepareStudioDatabase, STUDIO_DATABASE_FILENAME, studioDatabaseFiles } from './database'
import { DATABASE_COPIES_DIRNAME } from './copies'
import {
  CHAT_RECORDS_STEP,
  CHAT_SIDE_RECORDS_STEP,
  importChatRecords,
  importChatSideRecords,
  importPullRequestRecords,
  importWorktreeRecords,
  PULL_REQUEST_RECORD_STEP,
  WORKTREE_RECORDS_STEP,
} from './import-files'
import { createPoolStore, POOL_RECORD_VERSION } from '../../main/worktree-pool/pool-store'
import { PULL_REQUEST_RECORD_FILE } from '../pull-requests/pull-request-record'
import { createSnapshotStorage } from './snapshot-storage'
import { createWorkspaceRegistryStore } from '../../main/workspace-registry-store'
import { createScheduledAgentsStore } from '../../main/scheduled-agents/store'
import {
  emptyWorkspaceRegistryFile,
  serializeWorkspaceRegistryFile,
  toWorkspaceRegistryRecord,
} from '../../shared/workspace-registry'
import type { Workspace } from '../../shared/workspace'

// The files builds before the database kept these four stores in, as they
// wrote them, with what a crash or a hand edit leaves: a torn agent file, a
// rule no build keeps, a first message missing its words.

const RULE = {
  id: 'rule-1',
  workspaceRoot: '/Users/dev/repo',
  toolKind: 'file_write',
  toolName: 'Write',
  matcher: { type: 'path', prefix: '/Users/dev/repo' },
  label: 'Write: files within /Users/dev/repo except .git',
  createdAt: 1,
}
// A program-wide grant an older build saved: kept narrowed, as the store narrowed it.
const WIDE_RULE = {
  id: 'rule-2',
  workspaceRoot: '/Users/dev/repo',
  toolKind: 'command',
  toolName: 'Bash',
  matcher: { type: 'program', program: 'rg' },
  label: 'Bash: rg',
  createdAt: 2,
}
const NOTICES = {
  version: 1,
  parents: [
    {
      workspaceId: 'ws-1',
      agentId: 'parent',
      touchedAt: Date.now(),
      pending: [
        {
          kind: 'finished',
          child: { workspaceId: 'ws-1', agentId: 'child', sessionId: 's-child', transport: 'conversation' },
          reply: 'done',
        },
      ],
    },
  ],
  children: [],
}
const promptFile = (agentId: string, sessionId: string, text: string) => ({
  version: 1,
  workspaceId: 'ws-1',
  agentId,
  cli: 'codex',
  sessionIds: [sessionId],
  updatedAt: 10,
  prompts: [{ text, at: 5 }],
})

function legacyFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'se-import-'))
  writeFileSync(
    join(dir, 'conversation-first-messages.json'),
    JSON.stringify({
      v: 1,
      messages: {
        'launch-1:first': {
          launchCommandId: 'launch-1',
          message: 'fix the build',
          images: [{ file: '0', mediaType: 'image/png', byteLength: 4 }],
          at: 3,
        },
        'launch-2:first': { launchCommandId: 'launch-2', at: 4 },
      },
    }),
  )
  mkdirSync(join(dir, 'conversation-first-messages', 'abc'), { recursive: true })
  writeFileSync(join(dir, 'conversation-approval-rules.json'), JSON.stringify([RULE, WIDE_RULE, { id: 'junk' }]))
  writeFileSync(join(dir, 'launch-notices.json'), JSON.stringify(NOTICES))
  mkdirSync(join(dir, 'agent-prompts'))
  writeFileSync(join(dir, 'agent-prompts', 'a.json'), JSON.stringify(promptFile('agent-a', 'session-a', 'hello a')))
  writeFileSync(join(dir, 'agent-prompts', 'b.json'), JSON.stringify(promptFile('agent-b', 'session-b', 'hello b')))
  // Torn by a crash mid-write.
  writeFileSync(
    join(dir, 'agent-prompts', 'c.json'),
    JSON.stringify(promptFile('agent-c', 'session-c', 'hi')).slice(0, 40),
  )
  return dir
}

/** Every file in the folder and its bytes, but the database's and the format marker. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (at: string, prefix: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (
        entry.name.startsWith(STUDIO_DATABASE_FILENAME) ||
        entry.name === DATA_FORMAT_FILENAME ||
        entry.name === DATABASE_COPIES_DIRNAME
      )
        continue
      if (entry.isDirectory()) walk(join(at, entry.name), relative)
      else files[relative] = readFileSync(join(at, entry.name), 'utf8')
    }
  }
  walk(dir, '')
  return files
}

const imported = (dir: string) => {
  const connection = prepareStudioDatabase(join(dir, STUDIO_DATABASE_FILENAME))
  try {
    return connection
      .all<{ source: string; records: number; skipped: number }>(
        'SELECT source, records, skipped FROM imports WHERE records > 0 OR skipped > 0 ORDER BY source',
      )
      .map((row) => ({ ...row }))
  } finally {
    connection.close()
  }
}

/** The formats a folder in format `from - 1` is brought through to this build's. */
const formatsFrom = (from: number): number[] =>
  Array.from({ length: STUDIO_DATA_FORMAT - from + 1 }, (_, index) => from + index)

test('format 2 brings the four stores into the database, reads them as their stores did, and leaves every file as it was', async () => {
  const dir = legacyFolder()
  const before = snapshot(dir)
  assert.deepEqual(prepareDataFormat(dir, { version: '2.0.0' }), {
    format: STUDIO_DATA_FORMAT,
    migrated: formatsFrom(2),
    restored: false,
  })
  assert.deepEqual(snapshot(dir), before, 'no file changed, moved or deleted')
  assert.deepEqual(imported(dir), [
    { source: 'agent-prompts/a.json', records: 1, skipped: 0 },
    { source: 'agent-prompts/b.json', records: 1, skipped: 0 },
    { source: 'agent-prompts/c.json', records: 0, skipped: 1 },
    { source: 'conversation-approval-rules.json', records: 2, skipped: 1 },
    { source: 'conversation-first-messages.json', records: 1, skipped: 0 },
    { source: 'launch-notices.json', records: 1, skipped: 0 },
  ])

  const database = openTestDatabase(dir)
  const rules = await new ConversationApprovalRuleStore(database).list()
  assert.deepEqual(
    rules.map((rule) => [rule.id, rule.matcher]),
    [
      ['rule-1', RULE.matcher],
      ['rule-2', { type: 'command', program: 'rg' }],
    ],
  )
  const firstMessages = createPendingFirstMessages({ database, imagesRoot: join(dir, 'conversation-first-messages') })
  const kept = await firstMessages.all()
  assert.deepEqual(Object.keys(kept), ['launch-1:first'])
  assert.equal(kept['launch-1:first']?.images?.[0]?.file, '0')
  assert.deepEqual(readSavedLaunchNotices(await launchNoticesDatabaseStorage(database).read()), NOTICES)
  const prompts = createAgentPromptStore({ database })
  assert.deepEqual(await prompts.read({ workspaceId: 'ws-1', agentId: 'agent-a' }), [{ text: 'hello a', at: 5 }])
  assert.equal((await prompts.findBySessionId('session-b'))?.agentId, 'agent-b')
  assert.equal(await prompts.findBySessionId('session-c'), null)
})

test('an import that runs twice brings nothing in twice', () => {
  const dir = legacyFolder()
  prepareDataFormat(dir, { version: '2.0.0' })
  // At the format, a start runs no step.
  assert.deepEqual(prepareDataFormat(dir, { version: '2.0.1' }).migrated, [])
  const connection = prepareStudioDatabase(join(dir, STUDIO_DATABASE_FILENAME))
  try {
    assert.deepEqual(importChatSideRecords(connection, dir), [])
    assert.equal(connection.get<{ n: number }>('SELECT COUNT(*) AS n FROM approval_rules')?.n, 2)
  } finally {
    connection.close()
  }
})

test('an import a crash cut short is put back and runs again whole at the next start', () => {
  const dir = legacyFolder()
  const crashed = join(mkdtempSync(join(tmpdir(), 'se-import-crash-')), 'data')
  // The folder as a crash halfway through would leave it: the database made,
  // the first messages and rules in, the rest not yet, the format still 1.
  assert.throws(() =>
    prepareDataFormat(dir, {
      version: '2.0.0',
      format: 2,
      steps: [
        {
          ...CHAT_SIDE_RECORDS_STEP,
          run: (at) => {
            const connection = prepareStudioDatabase(join(at, STUDIO_DATABASE_FILENAME))
            connection.run("INSERT INTO approval_rules (id, workspace_root, body) VALUES ('half', '/', '{}')")
            cpSync(at, crashed, { recursive: true })
            connection.close()
            throw new Error('the snapshot is taken')
          },
        },
      ],
    }),
  )
  assert.ok(existsSync(join(crashed, 'migration-backup', 'marker.json')))
  assert.deepEqual(prepareDataFormat(crashed, { version: '2.0.0' }), {
    format: STUDIO_DATA_FORMAT,
    migrated: formatsFrom(2),
    restored: true,
  })
  assert.equal(imported(crashed).length, 6)
  const connection = prepareStudioDatabase(join(crashed, STUDIO_DATABASE_FILENAME))
  try {
    assert.deepEqual(
      connection.all<{ id: string }>('SELECT id FROM approval_rules ORDER BY rowid').map((row) => row.id),
      ['rule-1', 'rule-2'],
      'the half-done import is gone; the whole one is in',
    )
  } finally {
    connection.close()
  }
})

test('rollback: with the database moved aside and the format set back, an older build finds its files as they were; put back, nothing is lost', async () => {
  const dir = legacyFolder()
  const before = snapshot(dir)
  prepareDataFormat(dir, { version: '2.0.0' })
  const database = openTestDatabase(dir)
  const rules = new ConversationApprovalRuleStore(database)
  // Done after the upgrade: the old files never hear of it.
  await rules.revoke('rule-1')
  const since = await rules.list()
  await database.close()

  // The steps docs/data-folder.md gives: quit, move the database aside, set the format back.
  const aside = mkdtempSync(join(tmpdir(), 'se-import-aside-'))
  for (const path of studioDatabaseFiles(dir))
    if (existsSync(path)) renameSync(path, join(aside, path.slice(dir.length + 1)))
  writeFileSync(join(dir, DATA_FORMAT_FILENAME), JSON.stringify({ format: 1, writtenBy: '1.0.0' }))
  assert.deepEqual(prepareDataFormat(dir, { version: '1.0.0', format: 1, steps: [] }).format, 1)
  assert.deepEqual(snapshot(dir), before, 'the older build reads the files the upgrade left')

  // Upgrading again with the moved database put back loses nothing done since.
  renameSync(join(aside, STUDIO_DATABASE_FILENAME), join(dir, STUDIO_DATABASE_FILENAME))
  writeFileSync(join(dir, DATA_FORMAT_FILENAME), JSON.stringify({ format: STUDIO_DATA_FORMAT, writtenBy: '5.0.0' }))
  const back = openTestDatabase(dir)
  assert.deepEqual(await new ConversationApprovalRuleStore(back).list(), since)
  assert.deepEqual(
    since.map((rule) => rule.id),
    ['rule-2'],
  )
})

test(
  'a file there that cannot be read stops the step rather than importing it as nothing',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  () => {
    const dir = legacyFolder()
    chmodSync(join(dir, 'conversation-approval-rules.json'), 0o000)
    try {
      assert.throws(() => prepareDataFormat(dir, { version: '2.0.0' }), StudioDataMigrationError)
      assert.ok(!existsSync(join(dir, STUDIO_DATABASE_FILENAME)), 'the database the step made is gone')
      assert.ok(
        !existsSync(join(dir, DATA_FORMAT_FILENAME)) ||
          JSON.parse(readFileSync(join(dir, DATA_FORMAT_FILENAME), 'utf8')).format === 1,
      )
    } finally {
      chmodSync(join(dir, 'conversation-approval-rules.json'), 0o600)
    }
  },
)

test('format 3 brings the device and session records in as their stores read them, and a revoked device stays revoked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'se-import-devices-'))
  writeFileSync(join(dir, DATA_FORMAT_FILENAME), JSON.stringify({ format: 2, writtenBy: '2.0.0' }))
  const token = 'mctn_phone-token'
  const device = {
    id: 'tnd_phone',
    name: 'android-phone',
    scopes: ['workspace:read'],
    createdAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt: null,
    lastPeerNode: null,
    origin: { kind: 'code', by: null },
    tokenHash: hashSecret(token),
  }
  // A device revoked before the upgrade is not in the file; a malformed one is no grant.
  writeFileSync(
    join(dir, 'tailnet-remote-devices.json'),
    JSON.stringify({ version: 1, devices: [device, { id: 'tnd_half', name: 'x' }] }),
  )
  const sealed = {
    id: 'tnc_1',
    machineName: 'mac-mini',
    endpoint: '100.64.0.2:8443',
    deviceId: 'dev_1',
    deviceName: 'build-box',
    scopes: ['workspace:read'],
    pairedAt: '2026-09-01T00:00:00.000Z',
    lastConnectedAt: null,
    pairedVia: 'link',
    sealedToken: 'c2VhbGVk',
  }
  writeFileSync(
    join(dir, 'tailnet-mesh-connections.json'),
    JSON.stringify({
      version: 2,
      connections: [sealed, { ...sealed, id: 'tnc_2', sealedToken: undefined, deviceToken: 'mctn_plaintext' }],
    }),
  )
  const session = {
    id: 'ws_1',
    name: 'Browser',
    kind: 'web',
    route: 'loopback',
    owner: true,
    scopes: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2999-01-01T00:00:00.000Z',
    lastSeenAt: null,
    secretHash: 'hash',
  }
  writeFileSync(join(dir, 'web-sessions.json'), JSON.stringify({ sessions: [session] }))
  const embed = {
    embedId: 'emb_1',
    tokenHash: 'hash',
    expiresAt: '2999-01-01T00:00:00.000Z',
    conversation: { workspaceId: 'ws-1', agentId: 'agent-1' },
    origins: ['https://dashboard.example.com'],
  }
  writeFileSync(join(dir, 'embeds.json'), JSON.stringify({ embeds: [embed] }))
  mkdirSync(join(dir, 'local-servers'))
  writeFileSync(
    join(dir, 'local-servers', 'linked.json'),
    JSON.stringify({
      version: 1,
      servers: [
        { id: 'k1', workspaceId: 'ws-1', agentId: 'agent-1', url: 'http://localhost:5173/', title: '', linkedAt: 5 },
      ],
    }),
  )
  writeFileSync(
    join(dir, 'client-toolsets.json'),
    JSON.stringify({ bindings: [{ toolset: 'game', clientId: 'sla_game', title: 'Acme Game', conversations: [] }] }),
  )
  writeFileSync(
    join(dir, 'file-views.json'),
    JSON.stringify({ version: 1, chats: { 'ws-1\u0000agent-1': { at: 1, paths: ['/Users/dev/app/a.ts'] } } }),
  )
  writeFileSync(join(dir, 'extension-approvals.json'), JSON.stringify({ 'local.one': { fingerprint: 'nope' } }))
  const before = snapshot(dir)

  assert.deepEqual(prepareDataFormat(dir, { version: '3.0.0' }), {
    format: STUDIO_DATA_FORMAT,
    migrated: formatsFrom(3),
    restored: false,
  })
  assert.deepEqual(snapshot(dir), before, 'no file changed, moved or deleted')
  assert.deepEqual(imported(dir), [
    { source: 'client-toolsets.json', records: 1, skipped: 0 },
    { source: 'embeds.json', records: 1, skipped: 0 },
    { source: 'file-views.json', records: 1, skipped: 0 },
    { source: 'local-servers/linked.json', records: 1, skipped: 0 },
    { source: 'tailnet-mesh-connections.json', records: 1, skipped: 1 },
    { source: 'tailnet-remote-devices.json', records: 1, skipped: 0 },
    { source: 'web-sessions.json', records: 1, skipped: 0 },
  ])

  const database = openTestDatabase(dir)
  const devices = createTailnetDeviceStore({ database })
  assert.deepEqual(
    devices.listDevices().map((entry) => entry.id),
    ['tnd_phone'],
  )
  assert.equal(devices.authenticate(token)?.id, 'tnd_phone')
  assert.equal(devices.revokeDevice('tnd_phone'), true)
  await devices.flush()
  // Revoked after the upgrade: gone through a restart, and the old file is never read again.
  assert.deepEqual(createTailnetDeviceStore({ database }).listDevices(), [])
  assert.equal(prepareDataFormat(dir, { version: '3.0.1' }).migrated.length, 0)
  assert.deepEqual(createTailnetDeviceStore({ database }).listDevices(), [])

  const mesh = database.readNow<{ id: string; body: string }>('SELECT id, body FROM mesh_links')
  assert.deepEqual(
    mesh.map((row) => row.id),
    ['tnc_1'],
  )
  assert.doesNotMatch(
    mesh.map((row) => row.body).join(''),
    /mctn_plaintext/u,
    'a plaintext token never reaches the database',
  )
  assert.equal(createEmbedStore({ database }).authenticate('emb_1', 'wrong'), null)
  assert.equal(createClientToolsetStore({ database }).binding('game')?.clientId, 'sla_game')
  const linked = createLocalServerRecord({ database })
  await linked.whenLoaded()
  assert.deepEqual(
    linked.all().map((entry) => entry.id),
    ['k1'],
  )
  assert.deepEqual(
    database.readNow<{ id: string }>('SELECT id FROM file_views').map((row) => row.id),
    [JSON.stringify(['ws-1', 'agent-1'])],
  )
})

test('format 4 brings in the open-turn list; transcripts wait to be taken up', () => {
  const dir = mkdtempSync(join(tmpdir(), 'se-import-history-'))
  writeFileSync(join(dir, DATA_FORMAT_FILENAME), JSON.stringify({ format: 3, writtenBy: '3.0.0' }))
  const chat = { workspaceRoot: '/Users/dev/app', workspaceId: 'ws-1', agentId: 'agent-1' }
  writeFileSync(join(dir, 'conversation-outbox.json'), JSON.stringify({ version: 1, chats: [chat, { agentId: 'x' }] }))
  assert.deepEqual(prepareDataFormat(dir, { version: '4.0.0' }), {
    format: STUDIO_DATA_FORMAT,
    migrated: formatsFrom(4),
    restored: false,
  })
  const connection = prepareStudioDatabase(join(dir, STUDIO_DATABASE_FILENAME))
  try {
    assert.deepEqual(
      connection.all('SELECT workspace_root, workspace_id, agent_id FROM turn_outbox').map((row) => ({ ...row })),
      [{ workspace_root: chat.workspaceRoot, workspace_id: chat.workspaceId, agent_id: chat.agentId }],
    )
    assert.equal(connection.get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_logs')?.n, 0)
  } finally {
    connection.close()
  }
})

// The chat records and the stores kept whole, as builds before format 5 wrote
// them: a registry with a record its parser drops, schedules with a run on
// its way, resumes, and scheduled messages torn by a crash mid-write.
function chatRecord(id: string, name: string) {
  return toWorkspaceRegistryRecord(
    {
      id,
      name,
      mode: 'standard',
      folderPath: '/Users/dev/app',
      templateId: 'solo',
      layoutModel: { global: {}, borders: [], layout: { type: 'row', children: [] } },
      agents: {},
      worktreeState: { containerPath: null, entries: {}, updatedAt: null },
      editorState: { openFiles: [], activeFilePath: null },
      createdAt: 1_000,
    } as Workspace,
    3,
  )
}

const SCHEDULE = {
  id: 'sa-1',
  prompt: 'Triage the issues opened since the last run.',
  schedule: { cron: '0 13 * * *', timezone: 'UTC' },
  folderPath: '/Users/dev/app',
  hostId: null,
  cli: 'claude-code',
  cliModel: null,
  permissionPreset: null,
  skills: [],
  mcpServers: [],
  worktree: null,
  ownerModuleId: null,
  createdAt: 1_000,
  updatedAt: 1_000,
  lastRun: null,
  lastFailureSeenAt: null,
}

function chatRecordsFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'se-import-records-'))
  writeFileSync(join(dir, DATA_FORMAT_FILENAME), JSON.stringify({ format: 4, writtenBy: '4.0.0' }))
  const registry = JSON.parse(
    serializeWorkspaceRegistryFile({
      ...emptyWorkspaceRegistryFile(5_000),
      revision: 3,
      workspaces: [chatRecord('ws-1', 'Fix the login bug'), chatRecord('ws-2', 'Release notes')],
      activeWorkspaceId: 'ws-2',
    }),
  ) as { workspaces: unknown[] }
  // A record no build keeps: dropped by the parser, counted.
  registry.workspaces.push({ id: 'ws-junk' })
  writeFileSync(join(dir, 'workspace-registry.json'), JSON.stringify(registry, null, 2))
  writeFileSync(
    join(dir, 'scheduled-agents.json'),
    JSON.stringify(
      { version: 1, agents: [SCHEDULE], runs: { 'scheduled-run:a': { scheduledAgentId: 'sa-1' } } },
      null,
      2,
    ),
  )
  writeFileSync(
    join(dir, 'usage-limit-resumes.json'),
    JSON.stringify({ version: 1, autoResume: true, pending: [], resumed: [] }),
  )
  writeFileSync(join(dir, 'scheduled-messages.json'), '{"version":1,"messages":[{"id":"m-1",')
  return dir
}

test('format 5 brings the chat records and the whole stores in, read by their own parsers, and leaves every file as it was', async () => {
  const dir = chatRecordsFolder()
  const before = snapshot(dir)
  assert.deepEqual(prepareDataFormat(dir, { version: '5.0.0' }), {
    format: STUDIO_DATA_FORMAT,
    migrated: formatsFrom(5),
    restored: false,
  })
  assert.deepEqual(snapshot(dir), before, 'no file changed, moved or deleted')
  assert.deepEqual(imported(dir), [
    { source: 'scheduled-agents.json', records: 1, skipped: 0 },
    { source: 'scheduled-messages.json', records: 0, skipped: 1 },
    { source: 'usage-limit-resumes.json', records: 1, skipped: 0 },
    { source: 'workspace-registry.json', records: 2, skipped: 1 },
  ])

  const database = openTestDatabase(dir)
  const registry = createWorkspaceRegistryStore({ database }).read()
  assert.equal(registry.status, 'loaded')
  if (registry.status !== 'loaded') return
  assert.deepEqual(
    registry.file.workspaces.map((record) => [record.id, record.name]),
    [
      ['ws-1', 'Fix the login bug'],
      ['ws-2', 'Release notes'],
    ],
  )
  assert.equal(registry.file.revision, 3)
  assert.equal(registry.file.activeWorkspaceId, 'ws-2')

  const schedules = createScheduledAgentsStore({ storage: createSnapshotStorage(database, 'schedules') })
  await schedules.load()
  assert.deepEqual(
    schedules.list().map((entry) => entry.id),
    ['sa-1'],
  )
  assert.equal(
    await createSnapshotStorage(database, 'usage_limit_resumes').read(),
    readFileSync(join(dir, 'usage-limit-resumes.json'), 'utf8'),
  )
  // Torn: not brought in as nothing, so a later write cannot pass for it; the file is there to be looked at.
  assert.equal(await createSnapshotStorage(database, 'scheduled_messages').read(), null)
})

test('the chat records import runs once: a second run brings nothing in twice', () => {
  const dir = chatRecordsFolder()
  prepareDataFormat(dir, { version: '5.0.0' })
  const connection = prepareStudioDatabase(join(dir, STUDIO_DATABASE_FILENAME))
  try {
    assert.deepEqual(importChatRecords(connection, dir), [])
    assert.equal(connection.get<{ n: number }>('SELECT COUNT(*) AS n FROM chats')?.n, 2)
    assert.equal(connection.get<{ n: number }>('SELECT COUNT(*) AS n FROM store_records')?.n, 2)
  } finally {
    connection.close()
  }
})

test('a chat records import a crash cut short is put back and runs again whole at the next start', () => {
  const dir = chatRecordsFolder()
  const crashed = join(mkdtempSync(join(tmpdir(), 'se-import-records-crash-')), 'data')
  // Format 4's database first, as the folder had it before this step.
  const connection = prepareStudioDatabase(join(dir, STUDIO_DATABASE_FILENAME))
  connection.close()
  assert.throws(() =>
    prepareDataFormat(dir, {
      version: '5.0.0',
      format: 5,
      steps: [
        {
          ...CHAT_RECORDS_STEP,
          run: (at) => {
            // The registry in, the stores not yet: then the process stops.
            const half = prepareStudioDatabase(join(at, STUDIO_DATABASE_FILENAME))
            half.run("INSERT INTO chats (id, position, body) VALUES ('ws-half', 0, '{}')")
            cpSync(at, crashed, { recursive: true })
            half.close()
            throw new Error('the snapshot is taken')
          },
        },
      ],
    }),
  )
  assert.ok(existsSync(join(crashed, 'migration-backup', 'marker.json')))
  assert.deepEqual(prepareDataFormat(crashed, { version: '5.0.0' }), {
    format: STUDIO_DATA_FORMAT,
    migrated: formatsFrom(5),
    restored: true,
  })
  const after = prepareStudioDatabase(join(crashed, STUDIO_DATABASE_FILENAME))
  try {
    assert.deepEqual(
      after.all<{ id: string }>('SELECT id FROM chats ORDER BY position').map((row) => row.id),
      ['ws-1', 'ws-2'],
      'the half-done import is gone; the whole one is in',
    )
    assert.equal(after.get<{ n: number }>('SELECT COUNT(*) AS n FROM store_records')?.n, 2)
  } finally {
    after.close()
  }
})

test(
  'a registry file there that cannot be read stops the step rather than importing it as nothing',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  () => {
    const dir = chatRecordsFolder()
    chmodSync(join(dir, 'workspace-registry.json'), 0o000)
    try {
      assert.throws(() => prepareDataFormat(dir, { version: '5.0.0' }), StudioDataMigrationError)
      assert.equal(JSON.parse(readFileSync(join(dir, DATA_FORMAT_FILENAME), 'utf8')).format, 4)
    } finally {
      chmodSync(join(dir, 'workspace-registry.json'), 0o600)
    }
  },
)

// ── Format 6: the pull request record ─────────────────────────────────────────

const pullRequest = (number: number, extra: Record<string, unknown> = {}) => ({
  url: `https://github.com/acme/app/pull/${number}`,
  repoKey: 'github.com/acme/app',
  repoName: 'app',
  number,
  title: `#${number}`,
  state: 'open',
  isDraft: false,
  openedAt: 1_000 + number,
  stateAt: 1_000 + number,
  openedByWorkspaceId: 'ws-1',
  openedByAgentId: 'agent-1',
  ...extra,
})

/** A folder in format 5 with a pull request record file, as a build before the database wrote it. */
function pullRequestFolder(file: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'se-import-prs-')), 'data')
  mkdirSync(join(dir, 'pull-requests'), { recursive: true })
  writeFileSync(join(dir, DATA_FORMAT_FILENAME), JSON.stringify({ format: 5, writtenBy: '5.0.0' }))
  writeFileSync(join(dir, PULL_REQUEST_RECORD_FILE), file)
  return dir
}

const pullRequestRows = (dir: string) => {
  const connection = prepareStudioDatabase(join(dir, STUDIO_DATABASE_FILENAME))
  try {
    return connection
      .all<{ id: string; body: string }>('SELECT id, body FROM pull_requests ORDER BY position')
      .map((row) => ({ id: row.id, body: JSON.parse(row.body) as Record<string, unknown> }))
  } finally {
    connection.close()
  }
}

test('format 6 brings the pull request record in, a row each with its watch, and leaves the file as it was', () => {
  const watched = { ...pullRequest(2), watch: { startedAt: 5 }, untold: [{ commandId: null }] }
  const dir = pullRequestFolder(
    JSON.stringify({ version: 2, pullRequests: [pullRequest(1), watched, { url: 'not a pull request' }] }),
  )
  const before = snapshot(dir)
  assert.deepEqual(prepareDataFormat(dir, { version: '6.0.0' }), {
    format: STUDIO_DATA_FORMAT,
    migrated: formatsFrom(PULL_REQUEST_RECORD_STEP.to),
    restored: false,
  })
  assert.deepEqual(snapshot(dir), before, 'no file changed, moved or deleted')
  assert.deepEqual(imported(dir), [{ source: PULL_REQUEST_RECORD_FILE, records: 2, skipped: 1 }])
  assert.deepEqual(pullRequestRows(dir), [
    { id: pullRequest(1).url, body: pullRequest(1) },
    { id: watched.url, body: watched },
  ])

  // A second run brings nothing in twice.
  const connection = prepareStudioDatabase(join(dir, STUDIO_DATABASE_FILENAME))
  try {
    assert.deepEqual(importPullRequestRecords(connection, dir), [])
  } finally {
    connection.close()
  }
  assert.equal(pullRequestRows(dir).length, 2)
})

test('a pull request record this build cannot read is skipped and left as it was', () => {
  const dir = pullRequestFolder('{"version": 2, "pullRequests": [')
  const before = snapshot(dir)
  prepareDataFormat(dir, { version: '6.0.0' })
  assert.deepEqual(snapshot(dir), before)
  assert.deepEqual(imported(dir), [{ source: PULL_REQUEST_RECORD_FILE, records: 0, skipped: 1 }])
  assert.deepEqual(pullRequestRows(dir), [])
})

test('a pull request import a crash cut short is put back and runs again whole at the next start', () => {
  const dir = pullRequestFolder(JSON.stringify({ version: 2, pullRequests: [pullRequest(1), pullRequest(2)] }))
  const crashed = join(mkdtempSync(join(tmpdir(), 'se-import-prs-crash-')), 'data')
  // Format 5's database first, as the folder had it before this step.
  prepareStudioDatabase(join(dir, STUDIO_DATABASE_FILENAME)).close()
  assert.throws(() =>
    prepareDataFormat(dir, {
      version: '6.0.0',
      format: PULL_REQUEST_RECORD_STEP.to,
      steps: [
        {
          ...PULL_REQUEST_RECORD_STEP,
          run: (at) => {
            const half = prepareStudioDatabase(join(at, STUDIO_DATABASE_FILENAME))
            half.run("INSERT INTO pull_requests (id, position, body) VALUES ('half', 0, '{}')")
            cpSync(at, crashed, { recursive: true })
            half.close()
            throw new Error('the snapshot is taken')
          },
        },
      ],
    }),
  )
  assert.deepEqual(prepareDataFormat(crashed, { version: '6.0.0' }), {
    format: STUDIO_DATA_FORMAT,
    migrated: formatsFrom(PULL_REQUEST_RECORD_STEP.to),
    restored: true,
  })
  assert.deepEqual(
    pullRequestRows(crashed).map((row) => row.id),
    [pullRequest(1).url, pullRequest(2).url],
    'the half-done import is gone; the whole one is in',
  )
})

// ── Format 7: the worktree records ────────────────────────────────────────────

const poolRecord = (poolId: string) => ({
  version: POOL_RECORD_VERSION,
  poolId,
  repoRoot: '/Users/dev/app',
  commonDir: '/Users/dev/app/.git',
  hostId: 'local',
  slots: [],
})

/** A folder in format 6 with a branch ledger and pool records, as a build before the database wrote them. */
function worktreeFolder(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'se-import-worktrees-')), 'data')
  mkdirSync(join(dir, 'worktree-pool'), { recursive: true })
  writeFileSync(join(dir, DATA_FORMAT_FILENAME), JSON.stringify({ format: 6, writtenBy: '6.0.0' }))
  writeFileSync(
    join(dir, 'worktree-branches.json'),
    JSON.stringify({
      version: 1,
      repos: {
        '/Users/dev/new/.git': { updatedAt: 20, branches: ['feat/b', 'feat/a'] },
        '/Users/dev/old/.git': { updatedAt: 10, branches: ['feat/c'] },
      },
    }),
  )
  writeFileSync(
    join(dir, 'worktree-pool', 'pool-0123456789abcdef.json'),
    JSON.stringify(poolRecord('0123456789abcdef')),
  )
  writeFileSync(join(dir, 'worktree-pool', 'pool-fedcba9876543210.json'), '{ torn')
  writeFileSync(join(dir, 'worktree-pool', 'settings.json'), JSON.stringify({ maxSlots: 4 }))
  return dir
}

test('format 7 brings the branch ledger and each pool record in, and leaves every file as it was', async () => {
  const dir = worktreeFolder()
  const before = snapshot(dir)
  assert.deepEqual(prepareDataFormat(dir, { version: '7.0.0' }), {
    format: STUDIO_DATA_FORMAT,
    migrated: formatsFrom(WORKTREE_RECORDS_STEP.to),
    restored: false,
  })
  assert.deepEqual(snapshot(dir), before, 'no file changed, moved or deleted')
  assert.deepEqual(imported(dir), [
    { source: 'worktree-branches.json', records: 3, skipped: 0 },
    { source: 'worktree-pool/pool-0123456789abcdef.json', records: 1, skipped: 0 },
    { source: 'worktree-pool/pool-fedcba9876543210.json', records: 0, skipped: 1 },
  ])

  const database = openTestDatabase(dir)
  assert.deepEqual(
    await database.all('SELECT repo, branch FROM worktree_branches ORDER BY seq'),
    [
      { repo: '/Users/dev/old/.git', branch: 'feat/c' },
      { repo: '/Users/dev/new/.git', branch: 'feat/b' },
      { repo: '/Users/dev/new/.git', branch: 'feat/a' },
    ],
    'the oldest repository first, each in the order its branches were recorded',
  )
  const pools = await createPoolStore({ dataDir: dir, database }).readAll()
  assert.deepEqual(
    pools.map((pool) => [pool.poolId, pool.record?.repoRoot]),
    [['0123456789abcdef', '/Users/dev/app']],
  )

  // A second run brings nothing in twice.
  const connection = prepareStudioDatabase(join(dir, STUDIO_DATABASE_FILENAME))
  try {
    assert.deepEqual(importWorktreeRecords(connection, dir), [])
  } finally {
    connection.close()
  }
})
