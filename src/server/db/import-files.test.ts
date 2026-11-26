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
import { DATA_FORMAT_FILENAME, prepareDataFormat, StudioDataMigrationError } from '../environment/data-format'
import { prepareStudioDatabase, STUDIO_DATABASE_FILENAME, studioDatabaseFiles } from './database'
import { DATABASE_COPIES_DIRNAME } from './copies'
import { CHAT_SIDE_RECORDS_STEP, importChatSideRecords } from './import-files'

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

test('format 2 brings the four stores into the database, reads them as their stores did, and leaves every file as it was', async () => {
  const dir = legacyFolder()
  const before = snapshot(dir)
  assert.deepEqual(prepareDataFormat(dir, { version: '2.0.0' }), { format: 3, migrated: [2, 3], restored: false })
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
  assert.deepEqual(prepareDataFormat(crashed, { version: '2.0.0' }), { format: 3, migrated: [2, 3], restored: true })
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
  writeFileSync(join(dir, DATA_FORMAT_FILENAME), JSON.stringify({ format: 3, writtenBy: '3.0.0' }))
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

  assert.deepEqual(prepareDataFormat(dir, { version: '3.0.0' }), { format: 3, migrated: [3], restored: false })
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
