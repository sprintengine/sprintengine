import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import {
  accessGrowth,
  createExtensionApprovalReader,
  extensionAccess,
  extensionApprovalFingerprint,
  extensionNeedsApproval,
  readExtensionApprovalsSync,
  writeExtensionApproval,
  type ExtensionAccess,
} from './extension-approvals'

const WORKER: ExtensionAccess = {
  permissions: ['storage:own'],
  tier: 'worker',
  worker: true,
  background: false,
  tools: { notes_search: 'read' },
  actions: ['notes.open=chat.new'],
  editors: [],
  hooks: [],
}
const NO_CONTRIBUTIONS = {
  commands: [],
  menus: [],
  topBarItems: [],
  panels: [],
  doors: [],
  settingsSections: [],
  mcpTools: [],
  hooks: [],
  syntaxes: [],
  customEditors: [],
  keybindings: [],
  statusBarItems: [],
  settings: [],
}

function withDataDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mc-extension-approvals-'))
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('the fingerprint covers the sorted permissions, the tier, the worker, background and the content', () => {
  const base = extensionApprovalFingerprint(WORKER, 'abc')
  assert.match(base, /^sha256-[0-9a-f]{64}$/)
  // Order of the permissions does not matter; each other part does.
  assert.equal(
    extensionApprovalFingerprint({ ...WORKER, permissions: ['b:x', 'a:y'] }, 'abc'),
    extensionApprovalFingerprint({ ...WORKER, permissions: ['a:y', 'b:x'] }, 'abc'),
  )
  const variants = [
    extensionApprovalFingerprint({ ...WORKER, permissions: ['storage:own', 'github:api'] }, 'abc'),
    extensionApprovalFingerprint({ ...WORKER, tier: 'ui' }, 'abc'),
    extensionApprovalFingerprint({ ...WORKER, worker: false }, 'abc'),
    extensionApprovalFingerprint({ ...WORKER, background: true }, 'abc'),
    extensionApprovalFingerprint(WORKER, 'abd'),
  ]
  assert.equal(new Set([base, ...variants]).size, variants.length + 1)
})

test('what a manifest asks for, and that only content needs no approval', () => {
  assert.deepEqual(
    extensionAccess({
      permissions: ['tools:contribute', 'storage:own'],
      tier: 'worker',
      main: 'dist/main.cjs',
      contributes: {
        ...NO_CONTRIBUTIONS,
        commands: [
          { id: 'b.run', title: 'B', action: 'chat.new' },
          { id: 'a.mine', title: 'A' },
        ],
        mcpTools: [{ name: 'notes_write', description: 'Writes.', access: 'operate', inputSchema: { type: 'object' } }],
      },
    }),
    {
      permissions: ['storage:own', 'tools:contribute'],
      tier: 'worker',
      worker: true,
      background: false,
      tools: { notes_write: 'operate' },
      actions: ['b.run=chat.new'],
      editors: [],
      hooks: [],
    },
  )
  assert.equal(extensionNeedsApproval({ tier: 'content' }), false)
  for (const tier of ['declarative', 'ui', 'worker'] as const) assert.equal(extensionNeedsApproval({ tier }), true)
})

test('an update grows its access by a permission, a higher tier, a worker, background or a contribution that carries authority, and only so', () => {
  assert.deepEqual(accessGrowth(WORKER, WORKER), [])
  assert.deepEqual(accessGrowth(WORKER, { ...WORKER, permissions: [] }), [], 'asking for less is no growth')
  assert.deepEqual(accessGrowth({ ...WORKER, tier: 'ui', worker: false }, WORKER), ['the "worker" tier', 'a worker'])
  assert.deepEqual(accessGrowth(WORKER, { ...WORKER, permissions: ['storage:own', 'github:api'], background: true }), [
    'the "github:api" permission',
    'a worker that runs in the background',
  ])
  // Contributions count per entry: a new tool, a tool that may now change
  // things, a command that runs an action it did not.
  assert.deepEqual(
    accessGrowth(WORKER, {
      ...WORKER,
      tools: { notes_search: 'operate', notes_drop: 'read' },
      actions: ['notes.open=chat.new', 'notes.clear=settings.open'],
    }),
    [
      'the MCP tool "notes_search" changing things',
      'the MCP tool "notes_drop"',
      'the command "notes.clear" running "settings.open"',
    ],
  )
  assert.deepEqual(accessGrowth(WORKER, { ...WORKER, tools: {}, actions: [] }), [], 'dropping them is no growth')
  assert.deepEqual(
    accessGrowth(WORKER, { ...WORKER, actions: ['notes.open=settings.open'] }),
    ['the command "notes.open" running "settings.open"'],
    'the same command running another action is new',
  )
})

test('a new custom editor, or one that takes more files, asks again; one that takes fewer does not', () => {
  const editor = (extensions: string[], filenames?: string[]) => ({
    id: 'todo',
    title: 'Todo list',
    entry: 'editor.js',
    extensions,
    ...(filenames ? { filenames } : {}),
  })
  const access = (editors: Array<ReturnType<typeof editor> & { priority?: 'default' | 'option' }>) =>
    extensionAccess({
      permissions: ['workspace-files:read'],
      tier: 'ui',
      contributes: { ...NO_CONTRIBUTIONS, customEditors: editors },
    })
  const approved = access([editor(['.todo'], ['TODO'])])
  assert.deepEqual(approved.editors, ['todo=.todo,todo|default'])
  assert.deepEqual(accessGrowth(approved, approved), [])
  assert.deepEqual(accessGrowth(approved, access([editor(['.TODO'])])), [])
  assert.deepEqual(accessGrowth(approved, access([editor(['.todo', '.tasks'], ['TODO'])])), [
    'the editor "todo" opening .tasks files too',
  ])
  assert.deepEqual(accessGrowth(access([]), approved), ['the editor "todo" opening .todo, todo files'])
  const offered = access([{ ...editor(['.todo']), priority: 'option' as const }])
  assert.deepEqual(accessGrowth(offered, access([editor(['.todo'])])), [
    'the editor "todo" opening its files by default',
  ])
  assert.deepEqual(accessGrowth(access([editor(['.todo'])]), offered), [], 'only offering its files is no growth')
})

test('approvals are kept per install key, forgotten on request, and nothing is approved by a bad file', async () => {
  await withDataDir(async (dir) => {
    assert.equal(readExtensionApprovalsSync(dir).size, 0)
    const record = { fingerprint: extensionApprovalFingerprint(WORKER, 'abc'), access: WORKER }
    const [a, b] = await Promise.all([
      writeExtensionApproval(dir, 'local.one', record),
      writeExtensionApproval(dir, 'local.two', record),
    ])
    assert.deepEqual([a, b], [{ ok: true }, { ok: true }])
    assert.deepEqual([...readExtensionApprovalsSync(dir).keys()], ['local.one', 'local.two'])
    assert.deepEqual(await writeExtensionApproval(dir, 'local.one', null), { ok: true })
    assert.deepEqual([...readExtensionApprovalsSync(dir).keys()], ['local.two'])

    writeFileSync(join(dir, 'extension-approvals.json'), '{"local.two": {"fingerprint": "nope"}}')
    assert.equal(readExtensionApprovalsSync(dir).size, 0)
    writeFileSync(join(dir, 'extension-approvals.json'), 'not json')
    assert.equal(readExtensionApprovalsSync(dir).size, 0)
  })
})

test('the reader a host call uses sees a change to the approvals at once', async () => {
  await withDataDir(async (dir) => {
    const read = createExtensionApprovalReader(dir)
    assert.equal(read().size, 0)
    const record = { fingerprint: extensionApprovalFingerprint(WORKER, 'abc'), access: WORKER }
    await writeExtensionApproval(dir, 'local.one', record)
    assert.equal(read().get('local.one')?.fingerprint, record.fingerprint)
    await writeExtensionApproval(dir, 'local.one', null)
    assert.equal(read().has('local.one'), false)
  })
})

test('a hook the approved version did not have is growth, said in the approval’s own words', () => {
  const hooked = (points: string[]) => ({ ...WORKER, hooks: points })
  assert.deepEqual(
    extensionAccess({
      permissions: [],
      tier: 'worker',
      main: 'dist/main.cjs',
      contributes: {
        ...NO_CONTRIBUTIONS,
        hooks: [{ point: 'agent.tool.after' }, { point: 'agent.tool.before', onError: 'deny' }],
      },
    }).hooks,
    ['agent.tool.after', 'agent.tool.before'],
  )
  assert.deepEqual(accessGrowth(hooked(['agent.tool.before']), hooked(['agent.tool.before'])), [])
  assert.deepEqual(accessGrowth(hooked(['agent.tool.before', 'agent.tool.after']), hooked(['agent.tool.before'])), [])
  assert.deepEqual(accessGrowth(hooked([]), hooked(['agent.tool.before', 'editor.save.before'])), [
    'a hook: can check, change or refuse your agents’ tool calls in Claude Code chats',
    'a hook: can check, change or refuse the files you save in the editor',
  ])
})

test('an approval stored without the hooks it covers approves nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'approvals-hooks-'))
  writeFileSync(
    join(dir, 'extension-approvals.json'),
    JSON.stringify({ 'local.old': { fingerprint: 'sha256-abc', access: { ...WORKER, hooks: undefined } } }),
  )
  assert.equal(readExtensionApprovalsSync(dir).has('local.old'), false)
})
