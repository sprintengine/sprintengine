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
import { ConversationApprovalRuleStore } from '../../main/conversation-approval-rules'
import { createPendingFirstMessages } from '../../main/conversation-first-messages'
import { DATA_FORMAT_FILENAME, prepareDataFormat, StudioDataMigrationError } from '../environment/data-format'
import { prepareStudioDatabase, STUDIO_DATABASE_FILENAME, studioDatabaseFiles } from './database'
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
      if (entry.name.startsWith(STUDIO_DATABASE_FILENAME) || entry.name === DATA_FORMAT_FILENAME) continue
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
        'SELECT source, records, skipped FROM imports ORDER BY source',
      )
      .map((row) => ({ ...row }))
  } finally {
    connection.close()
  }
}

test('format 2 brings the four stores into the database, reads them as their stores did, and leaves every file as it was', async () => {
  const dir = legacyFolder()
  const before = snapshot(dir)
  assert.deepEqual(prepareDataFormat(dir, { version: '2.0.0' }), { format: 2, migrated: [2], restored: false })
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
  assert.deepEqual(prepareDataFormat(crashed, { version: '2.0.0' }), { format: 2, migrated: [2], restored: true })
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
  writeFileSync(join(dir, DATA_FORMAT_FILENAME), JSON.stringify({ format: 2, writtenBy: '2.0.0' }))
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
