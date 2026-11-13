import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, test } from 'vitest'

import { createStudioPhoneReads } from '../../../server/backlog/backlog-domain'
import type { TailnetScope } from '../../../shared/tailnet'
import type { MobileControlPullRequestReader } from '../../mobile/control/pull-request'
import { deviceRig, refusalOf, until, type DeviceRig } from './tailnet-studio.test-helper'

// A paired device's reach to a Studio's backlogs, its shares and the pull
// request reads, on the real tailnet listener: a pairing's backlog scopes
// read and change the backlog; its workspace read reads the shares; its
// workspace operate reads a pull request in full (as the old command lane
// had it). A narrowed pairing is refused at the next request and a removed
// one is closed. Nothing that crosses names a folder on this machine.

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const ITEM = '---\nstatus: idea\ntype: feature\n---\n# Fix the login\n\nIt loops.\n'

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tailnet-backlog-'))
  const file = join(root, 'backlog/fix-login.md')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, ITEM, 'utf8')
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

const reader: MobileControlPullRequestReader = {
  summary: async () => ({ settled: false, reason: 'rate-limited' }),
  files: async () => ({ settled: false, reason: 'rate-limited' }),
  diff: async () => ({ settled: false, reason: 'rate-limited' }),
}

async function rig(root: string): Promise<DeviceRig> {
  const phoneReads = createStudioPhoneReads({
    roots: () => [root],
    readShares: async () => [
      {
        id: 'serve:443',
        label: 'localhost:5173',
        url: 'https://mac-mini.example.ts.net/',
        localPort: 5173,
        machine: 'mac-mini',
      },
    ],
    pullRequests: reader,
    debounceMs: 20,
  })
  const r = await deviceRig({ phoneReads })
  cleanups.push(() => r.dispose())
  return r
}

test('a pairing that may operate the backlog reads it with no folder named, changes an item once, and hears it move', async () => {
  const root = await project()
  const r = await rig(root)
  const phone = await r.client(r.pair(['backlog:operate', 'workspace:read']).token)
  const { workspaces } = await phone.rpc['backlog.list']({})
  assert.equal(workspaces.length, 1)
  const [backlog] = workspaces
  assert.match(backlog!.workspaceId, /^backlog:ws_/u)
  assert.ok(!JSON.stringify(workspaces).includes(root), 'no local path crosses')
  assert.equal(backlog!.items[0]?.status, 'idea')

  const heard: string[][] = []
  phone.subscribe('backlog.changed', {}, { onPayload: (changed) => heard.push(changed.workspaceIds) })
  // The folder is watched once someone listens; give the watch a moment to stand.
  await new Promise((resolve) => setTimeout(resolve, 300))
  const update = { workspaceId: backlog!.workspaceId, relativePath: 'backlog/fix-login.md', status: 'ready' as const }
  const changed = await phone.rpc['backlog.update']({ ...update, commandId: 'c-1' })
  assert.equal(changed.item?.status, 'ready')
  assert.match(await readFile(join(root, 'backlog/fix-login.md'), 'utf8'), /status: ready/u)
  await until(() => heard.some((ids) => ids.includes(backlog!.workspaceId)), 'the change said')

  assert.equal(
    await refusalOf(phone.rpc['backlog.update']({ ...update, workspaceId: `backlog:${root}`, commandId: 'c-2' })),
    'not_found',
    'a folder is never a name',
  )
  assert.equal(
    await refusalOf(phone.rpc['backlog.update']({ ...update, relativePath: '../secret.md', commandId: 'c-3' })),
    'not_found',
    'nothing outside the backlog folder is an item',
  )
  assert.deepEqual(
    (await phone.rpc['shares.list']({})).shares.map((share) => share.localPort),
    [5173],
  )
})

test('a read-only pairing reads and changes nothing; the pull request reads need workspace operate', async () => {
  const root = await project()
  const r = await rig(root)
  const reader = await r.client(r.pair(['backlog:read', 'workspace:read', 'conversation:read']).token)
  const { workspaces } = await reader.rpc['backlog.list']({})
  const update = {
    workspaceId: workspaces[0]!.workspaceId,
    relativePath: 'backlog/fix-login.md',
    status: 'ready' as const,
  }
  assert.equal(await refusalOf(reader.rpc['backlog.update']({ ...update, commandId: 'r-1' })), 'scope_required')
  assert.equal(
    await refusalOf(reader.rpc['pullRequests.detail']({ url: 'https://github.com/acme/app/pull/1' })),
    'scope_required',
  )

  const operator = await r.client(r.pair(['workspace:operate']).token)
  assert.equal(await refusalOf(operator.rpc['backlog.list']({})), 'scope_required', 'the backlog is its own grant')
  // Reached, and refused for what GitHub said, in words.
  assert.equal(
    await refusalOf(operator.rpc['pullRequests.detail']({ url: 'https://github.com/acme/app/pull/1' })),
    'unavailable',
  )
})

test('a narrowed pairing is refused at its next request, and a removed one is closed', async () => {
  const root = await project()
  const r = await rig(root)
  const scopes: TailnetScope[] = ['backlog:operate']
  const paired = r.pair(scopes)
  const phone = await r.client(paired.token)
  await phone.rpc['backlog.list']({})
  r.devices.updateDeviceScopes(paired.id, ['conversation:read'])
  assert.equal(await refusalOf(phone.rpc['backlog.list']({})), 'scope_required')
  r.devices.revokeDevice(paired.id)
  await until(() => phone.state !== 'open', 'the revoked connection to close')
})

// A read-only file refuses a write only where permissions bind: not on Windows, nor for root.
const permissionsBind = process.platform !== 'win32' && process.getuid?.() !== 0

test.skipIf(!permissionsBind)('a change the filesystem refuses is said without the folder it failed in', async () => {
  const root = await project()
  const reads = createStudioPhoneReads({ roots: () => [root], pullRequests: reader })
  const [listed] = await reads.backlog.list()
  assert.ok(listed)
  // The item and its folder cannot be written: the write fails with the file's path in its words.
  const folder = join(root, 'backlog')
  await chmod(join(folder, 'fix-login.md'), 0o444)
  await chmod(folder, 0o555)
  cleanups.push(async () => {
    await chmod(folder, 0o755)
    await chmod(join(folder, 'fix-login.md'), 0o644)
  })
  const refused = await reads.backlog.update({
    workspaceId: listed.workspaceId,
    relativePath: 'backlog/fix-login.md',
    status: 'ready',
  })
  assert.equal(refused.ok, false)
  assert.ok(!refused.ok && !refused.message.includes(root), refused.ok ? '' : refused.message)
  assert.ok(!refused.ok && !refused.message.includes(tmpdir()), refused.ok ? '' : refused.message)
})
