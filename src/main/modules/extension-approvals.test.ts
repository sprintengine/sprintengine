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

const WORKER: ExtensionAccess = { permissions: ['storage:own'], tier: 'worker', worker: true, background: false }

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
    extensionAccess({ permissions: ['tools:contribute', 'storage:own'], tier: 'worker', main: 'dist/main.cjs' }),
    { permissions: ['storage:own', 'tools:contribute'], tier: 'worker', worker: true, background: false },
  )
  assert.equal(extensionNeedsApproval({ tier: 'content' }), false)
  for (const tier of ['declarative', 'ui', 'worker'] as const) assert.equal(extensionNeedsApproval({ tier }), true)
})

test('an update grows its access by a permission, a higher tier, a worker or background, and only so', () => {
  assert.deepEqual(accessGrowth(WORKER, WORKER), [])
  assert.deepEqual(accessGrowth(WORKER, { ...WORKER, permissions: [] }), [], 'asking for less is no growth')
  assert.deepEqual(accessGrowth({ ...WORKER, tier: 'ui', worker: false }, WORKER), ['the "worker" tier', 'a worker'])
  assert.deepEqual(accessGrowth(WORKER, { ...WORKER, permissions: ['storage:own', 'github:api'], background: true }), [
    'the "github:api" permission',
    'a worker that runs in the background',
  ])
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
