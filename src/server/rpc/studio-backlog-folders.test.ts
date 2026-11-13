import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, test } from 'vitest'

import { STUDIO_SCOPES, type StudioGrant } from '../../../packages/studio-protocol/src/public'
import { createStudioPhoneReads } from '../backlog/backlog-domain'
import { studioWindowGrant } from './studio-frame-port'
import { createStudioRpcRouter } from './studio-rpc-router'
import { createFakeBackend } from './studio-rpc.test-helper'

// A project's backlog by its folder over the Studio protocol, answered by the
// real backlog service on a real folder: what the desktop's own window reads
// and writes (its location, ids, records and each item change), a retried
// write carried out once, what a paired device is refused however many
// scopes it holds, a browser on the tailnet held to the folders Studio knows,
// and a folder on an SSH machine refused in words.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const ITEM = '---\nstatus: idea\ntype: feature\n---\n# Fix the login\n\nIt loops.\n'

async function project(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'studio-backlog-folders-')))
  const file = join(root, 'backlog/fix-login.md')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, ITEM, 'utf8')
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

function rig(roots: string[]) {
  const router = createStudioRpcRouter({
    backend: createFakeBackend(),
    info: () => ({}) as never,
    phoneReads: createStudioPhoneReads({ roots: () => roots }),
  })
  cleanups.push(() => router.close())
  const window = { connectionId: 'w', slot: 1, ownWindow: true }
  const tailnet = { connectionId: 't', slot: 2, ownWindow: false, knownFoldersOnly: true }
  const paired: StudioGrant = {
    clientId: 'phone',
    name: 'phone',
    owner: false,
    scopes: [...STUDIO_SCOPES],
    ceiling: 'auto',
  } as StudioGrant
  const ask = (method: string, params: unknown, as: { grant?: StudioGrant; context?: object } = {}) =>
    router.handle(
      as.grant ?? studioWindowGrant(),
      method as never,
      params as never,
      (as.context ?? window) as never,
    ) as Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }>
  return { ask, tailnet, paired }
}

const codeOf = (answer: { ok: boolean; error?: { code: string } }) => (answer.ok ? null : answer.error!.code)
let commands = 0
const cid = () => `c${++commands}`

test('the window reads where a backlog lives, gives its items ids and records, and changes an item', async () => {
  const root = await project()
  const { ask } = rig([root])
  const location = await ask('backlog.location', { workspaceRoot: root })
  assert.deepEqual(location.result, {
    ok: true,
    location: { workspaceRoot: root, root: join(root, 'backlog'), isDefault: true, exists: true },
  })

  const ids = (await ask('backlog.ensureIds', {
    commandId: cid(),
    workspaceRoot: root,
    items: [{ relativePath: 'backlog/fix-login.md', numericId: null }],
  })) as { result: { ok: true; assignments: Record<string, number> } }
  assert.equal(ids.result.ok, true)
  assert.equal(ids.result.assignments['backlog/fix-login.md'], 1)
  assert.match(await readFile(join(root, 'backlog/fix-login.md'), 'utf8'), /^id: 1$/mu)

  const records = (await ask('backlog.ensureRecords', {
    commandId: cid(),
    workspaceRoot: root,
    items: [{ relativePath: 'backlog/fix-login.md', status: 'idea' }],
  })) as { result: { ok: true; store: { items: Array<{ source: { relativePath: string } }> } } }
  assert.deepEqual(
    records.result.store.items.map((item) => item.source.relativePath),
    ['backlog/fix-login.md'],
  )

  const starred = await ask('backlog.edit', {
    commandId: cid(),
    workspaceRoot: root,
    relativePath: 'backlog/fix-login.md',
    edit: { kind: 'highlight', starred: true, color: 'blue' },
  })
  assert.equal(codeOf(starred), null, JSON.stringify(starred))
  // A person's star sits in the item's own file, beside its status.
  assert.match(await readFile(join(root, 'backlog/fix-login.md'), 'utf8'), /blue/u)

  const status = await ask('backlog.edit', {
    commandId: cid(),
    workspaceRoot: root,
    relativePath: 'backlog/fix-login.md',
    edit: { kind: 'status', status: 'ready' },
  })
  assert.equal(codeOf(status), null, JSON.stringify(status))

  const dependsOn = await ask('backlog.edit', {
    commandId: cid(),
    workspaceRoot: root,
    relativePath: 'backlog/fix-login.md',
    edit: { kind: 'dependencies', dependsOn: ['other-item'] },
  })
  assert.equal(codeOf(dependsOn), null, JSON.stringify(dependsOn))
  assert.match(await readFile(join(root, 'backlog/fix-login.md'), 'utf8'), /^dependsOn: other-item$/mu)
})

test('a retried epic is made once, and a change that is not one is refused before anything is written', async () => {
  const root = await project()
  const { ask } = rig([root])
  const create = { commandId: 'epic-once', workspaceRoot: root, title: 'Sign-in' }
  const first = (await ask('backlog.createEpic', create)) as { result: { ok: true; relativePath: string } }
  assert.equal(first.result.ok, true)
  const again = (await ask('backlog.createEpic', create)) as { result: { ok: true; relativePath: string } }
  assert.deepEqual(again.result, first.result)

  for (const edit of [
    { kind: 'status', status: 'done' },
    { kind: 'highlight', starred: 'yes', color: null },
    { kind: 'addLink', link: { id: 'l1' } },
    { kind: 'dependencies', dependsOn: 'other-item' },
    { kind: 'unknown' },
  ]) {
    const answer = await ask('backlog.edit', {
      commandId: cid(),
      workspaceRoot: root,
      relativePath: 'backlog/fix-login.md',
      edit,
    })
    assert.deepEqual([edit.kind, codeOf(answer)], [edit.kind, 'invalid_params'])
  }
  assert.equal(await readFile(join(root, 'backlog/fix-login.md'), 'utf8'), ITEM)
})

test('a paired device holding every scope is refused a backlog by its folder; it triages by token', async () => {
  const root = await project()
  const { ask, paired } = rig([root])
  for (const [method, params] of [
    ['backlog.location', { workspaceRoot: root }],
    [
      'backlog.edit',
      { commandId: cid(), workspaceRoot: root, relativePath: 'backlog/fix-login.md', edit: { kind: 'removeRecord' } },
    ],
    ['backlog.createEpic', { commandId: cid(), workspaceRoot: root, title: 'x' }],
  ] as const) {
    assert.deepEqual([method, codeOf(await ask(method, params, { grant: paired }))], [method, 'owner_required'])
  }
  assert.equal(codeOf(await ask('backlog.list', {}, { grant: paired })), null)
})

test('a browser on the tailnet is held to the folders Studio knows, and an SSH machine’s folder is refused in words', async () => {
  const root = await project()
  const { ask, tailnet } = rig([root])
  const refused = await ask('backlog.location', { workspaceRoot: '/Users/dev/elsewhere' }, { context: tailnet })
  assert.equal(codeOf(refused), 'invalid_params')
  assert.match(refused.error!.message, /not one of the projects Studio holds/u)

  const ssh = await ask('backlog.location', { workspaceRoot: 'ssh://build-box/home/dev/app' })
  assert.equal(codeOf(ssh), 'unavailable')
  assert.match(ssh.error!.message, /SSH machine/u)
})
