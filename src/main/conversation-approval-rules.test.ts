import { test, expect } from 'vitest'
import { mkdtemp, mkdir, symlink, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { openTestDatabase } from '../../tests/studio-database'
import type { StudioDatabase } from '../server/db/database'
import { ConversationApprovalRuleStore } from './conversation-approval-rules'

/** The rules as the database keeps them, in order. */
const saved = async (db: StudioDatabase) =>
  (await db.all<{ body: string }>('SELECT body FROM approval_rules ORDER BY rowid')).map(
    (row) => JSON.parse(row.body) as { id: string; matcher: { tool?: string } },
  )

test('conversation grants expire; workspace grants persist and revoke without leaking across roots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-grants-'))
  try {
    const db = openTestDatabase(dir)
    const store = new ConversationApprovalRuleStore(db)
    const request = { action: 'Bash', input: { command: 'rg value src' } }
    await store.remember('/workspace/app', 'session', request, 'conversation')
    expect(await store.match('/workspace/app', 'session', request)).not.toBeNull()
    expect(await store.match('/workspace/app', 'other', request)).toBeNull()
    store.dropSession('session')
    expect(await store.match('/workspace/app', 'session', request)).toBeNull()
    const rule = await store.remember('/workspace/app', 'session', request, 'always')
    const reloaded = new ConversationApprovalRuleStore(db)
    expect(await reloaded.match('/workspace/app', 'other', request)).not.toBeNull()
    expect(await reloaded.match('/workspace/other', 'other', request)).toBeNull()
    await reloaded.revoke(rule.id)
    expect(await new ConversationApprovalRuleStore(db).list()).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('symlink escapes and dangerous commands cannot create or use remembered grants', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-grant-scope-'))
  try {
    const root = join(dir, 'workspace')
    await mkdir(root)
    await mkdir(join(dir, 'outside'))
    const store = new ConversationApprovalRuleStore()
    const safe = { action: 'Write', input: { path: 'new/file.ts' } }
    await store.remember(root, 'session', safe, 'conversation')
    expect(await store.match(root, 'session', safe)).not.toBeNull()
    await symlink(join(dir, 'outside'), join(root, 'link'))
    const unsafe = { action: 'Write', input: { path: 'link/secret.ts' } }
    expect(await store.match(root, 'session', unsafe)).toBeNull()
    await expect(store.remember(root, 'session', unsafe, 'conversation')).rejects.toThrow('only be allowed once')
    await expect(
      store.remember(root, 'session', { action: 'Bash', input: { command: 'sudo ls' } }, 'conversation'),
    ).rejects.toThrow('only be allowed once')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('saved program-wide command grants are narrowed on load and written back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-grant-migrate-'))
  try {
    const legacy = (program: string) => ({
      id: program,
      workspaceRoot: '/workspace/app',
      toolKind: 'command',
      toolName: 'Bash',
      matcher: { type: 'program', program },
      label: `Bash: ${program}`,
      createdAt: 1,
    })
    const db = openTestDatabase(dir)
    await db.batch(
      [legacy('git'), legacy('rg')].map((rule) => ({
        sql: 'INSERT INTO approval_rules (id, workspace_root, body) VALUES (?, ?, ?)',
        params: [rule.id, rule.workspaceRoot, JSON.stringify(rule)],
      })),
    )
    const store = new ConversationApprovalRuleStore(db)
    const status = { action: 'Bash', input: { command: 'git rebase --exec=./evil.sh HEAD~1' } }
    expect(await store.match('/workspace/app', 'session', status)).toBeNull()
    expect(
      await store.match('/workspace/app', 'session', { action: 'Bash', input: { command: 'rg x' } }),
    ).not.toBeNull()
    expect((await saved(db)).map((rule) => [rule.id, rule.matcher])).toEqual([
      ['rg', { type: 'command', program: 'rg' }],
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a file grant does not follow a symlink into the git directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-grant-git-'))
  try {
    const root = join(dir, 'workspace')
    await mkdir(join(root, '.git', 'hooks'), { recursive: true })
    const store = new ConversationApprovalRuleStore()
    await store.remember(root, 'session', { action: 'Write', input: { path: 'src/a.ts' } }, 'conversation')
    await symlink(join(root, '.git', 'hooks'), join(root, 'tools'))
    expect(await store.match(root, 'session', { action: 'Write', input: { path: 'tools/pre-commit' } })).toBeNull()
    expect(await store.match(root, 'session', { action: 'Write', input: { path: '.git/hooks/pre-commit' } })).toBeNull()
    expect(await store.match(root, 'session', { action: 'Write', input: { path: 'src/b.ts' } })).not.toBeNull()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a revoked app’s tools lose every approval, in either spelling, saved or for a session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-grant-apps-'))
  try {
    const db = openTestDatabase(dir)
    const store = new ConversationApprovalRuleStore(db)
    const call = (tool: string) => ({
      action: `mcp__sprintengine-studio__${tool}`,
      input: {},
      toolKind: 'mcp' as const,
    })
    await store.remember('/workspace/app', 'session', call('game_spawn_enemy'), 'always')
    await store.remember('/workspace/app', 'session', call('game.screenshot'), 'conversation')
    await store.remember('/workspace/app', 'session', call('gamepad_press'), 'always')
    await store.remember('/workspace/app', 'session', call('browser_open'), 'always')
    expect(await store.forgetGatewayToolsets(['game'])).toBe(1)
    expect(await store.match('/workspace/app', 'session', call('game_spawn_enemy'))).toBeNull()
    expect(await store.match('/workspace/app', 'session', call('game.screenshot'))).toBeNull()
    // Another toolset whose name only starts the same, and Studio's own tools, keep theirs.
    expect(await store.match('/workspace/app', 'session', call('gamepad_press'))).not.toBeNull()
    expect(await store.match('/workspace/app', 'session', call('browser_open'))).not.toBeNull()
    expect((await saved(db)).map((rule) => rule.matcher.tool).sort()).toEqual(['browser_open', 'gamepad_press'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a rule handed over from a desktop is kept as given, once, and one this build would narrow is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-grants-adopt-'))
  try {
    const desktop = new ConversationApprovalRuleStore(openTestDatabase(join(dir, 'desktop')))
    const machineDb = openTestDatabase(join(dir, 'machine'))
    const rule = await desktop.remember(
      '/home/dev/repo',
      'session',
      { action: 'Bash', input: { command: 'rg value src' } },
      'always',
    )
    const machine = new ConversationApprovalRuleStore(machineDb)
    expect(await machine.adopt(JSON.parse(JSON.stringify(rule)))).toEqual({ ok: true })
    expect(await new ConversationApprovalRuleStore(machineDb).list('/home/dev/repo')).toEqual([rule])
    expect(await machine.adopt(JSON.parse(JSON.stringify(rule)))).toMatchObject({ ok: false, exists: true })
    // A program-wide grant from an older build is narrowed on load: not the rule that was sent.
    const wide = {
      id: 'wide',
      workspaceRoot: '/home/dev/repo',
      toolKind: 'command',
      toolName: 'Bash',
      matcher: { type: 'program', program: 'git' },
      label: 'Bash: git',
      createdAt: 1,
    }
    expect(await machine.adopt(wide)).toMatchObject({ ok: false })
    expect(await machine.adopt({ id: 'nothing' })).toMatchObject({ ok: false })
    expect(await new ConversationApprovalRuleStore().adopt(rule)).toMatchObject({ ok: false })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
