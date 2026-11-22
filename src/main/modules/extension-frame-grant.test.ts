import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { ownerInvoker } from '../module-host/extension-invocation'
import { writeModuleOverrides } from '../module-host/enablement-store'
import { createMainKernel } from '../module-host/main-host'
import * as serviceTokens from '../module-host/service-tokens'
import { createExtensionApprovalReader, writeExtensionApproval, type ExtensionAccess } from './extension-approvals'
import { createExtensionFrameGrant, pinExtensionFrame } from './extension-frame-grant'

// A frame's calls are judged by the approvals and switches as they stand now,
// pinned to what was approved when its document was built: an extension
// installed and approved during the session is served without a restart, one
// switched off or uninstalled is refused at the next call, and a frame drawn
// before its extension's access grew uses none of the new access.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const V1 = '1'.repeat(64)
const V2 = '2'.repeat(64)

const access = (over: Partial<ExtensionAccess> = {}): ExtensionAccess => ({
  permissions: ['backlog:read'],
  tier: 'ui',
  worker: false,
  background: false,
  tools: {},
  actions: [],
  editors: [],
  ...over,
})

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'frame-grant-'))
  dirs.push(dataDir)
  const kernel = createMainKernel({
    // The kernel started knowing no extension at all.
    resolveModuleManifest: () => undefined,
    resolveFrameGrant: createExtensionFrameGrant({ approvals: createExtensionApprovalReader(dataDir), dataDir }),
  })
  kernel.hostFor('@host').provideService(
    serviceTokens.BacklogModuleServiceToken,
    () =>
      ({
        getLocation: async (moduleId: string) => ({ ok: true, location: { root: moduleId } }),
        create: async () => ({ ok: true }),
      }) as never,
  )
  const call = (frame: string, method = 'backlog.location', params: unknown = { workspaceId: 'ws' }) =>
    kernel.callFrameMethod({
      moduleId: 'local.fresh',
      frame,
      method,
      params,
      clientId: 'c',
      commandId: 'k',
      invoker: ownerInvoker(),
    })
  return { dataDir, call }
}

test('an extension approved after the kernel started is served at once, and refused once switched off or forgotten', async () => {
  const { dataDir, call } = setup()
  assert.equal((await call(V1)).ok, false, 'not installed and approved yet')

  await writeExtensionApproval(dataDir, 'local.fresh', { fingerprint: 'sha256-a', access: access() })
  pinExtensionFrame(V1, 'local.fresh', ['backlog:read'])
  assert.deepEqual(await call(V1), { ok: true, result: { ok: true, location: { root: 'local.fresh' } } })

  await writeModuleOverrides(dataDir, { 'local.fresh': false })
  const off = await call(V1)
  assert.equal(!off.ok && off.code, 'approval_required')

  await writeModuleOverrides(dataDir, {})
  await writeExtensionApproval(dataDir, 'local.fresh', null)
  const gone = await call(V1)
  assert.equal(!gone.ok && gone.code, 'approval_required')
})

test('a frame drawn before an update that asks for more is refused the new permission, and drawn again', async () => {
  const { dataDir, call } = setup()
  await writeExtensionApproval(dataDir, 'local.fresh', { fingerprint: 'sha256-v1', access: access() })
  pinExtensionFrame(V1, 'local.fresh', ['backlog:read'])
  const create = { workspaceId: 'ws', input: { title: 'x' } }
  const before = await call(V1, 'backlog.create', create)
  assert.equal(!before.ok && before.code, 'not_permitted', 'version 1 was not approved to write the Backlog')

  // Version 2 asks for backlog:operate too, and the person approves it while version 1's frame is open.
  await writeExtensionApproval(dataDir, 'local.fresh', {
    fingerprint: 'sha256-v2',
    access: access({ permissions: ['backlog:operate', 'backlog:read'] }),
  })
  const old = await call(V1, 'backlog.create', create)
  assert.equal(!old.ok && old.code, 'frame_outdated', 'the old frame uses none of the new access')
  assert.equal((await call(V1)).ok, false, 'nor anything else: it is drawn again')

  // The frame drawn from version 2 has it.
  pinExtensionFrame(V2, 'local.fresh', ['backlog:operate', 'backlog:read'])
  assert.deepEqual(await call(V2, 'backlog.create', create), { ok: true, result: { ok: true } })
  // A document this server does not know is drawn again too.
  const unknown = await call('3'.repeat(64))
  assert.equal(!unknown.ok && unknown.code, 'frame_outdated')
})

test('an approval that shrank holds an older frame to what is left', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'frame-grant-'))
  dirs.push(dataDir)
  const grant = createExtensionFrameGrant({ approvals: createExtensionApprovalReader(dataDir), dataDir })
  pinExtensionFrame(V1, 'local.ui', ['backlog:read', 'storage:own'])
  await writeExtensionApproval(dataDir, 'local.ui', { fingerprint: 'sha256-a', access: access() })
  assert.deepEqual(grant('local.ui', V1), { grant: ['backlog:read'], outdated: false })
  assert.deepEqual(grant('local.other', V1), null, 'not approved')
  await writeExtensionApproval(dataDir, 'local.other', { fingerprint: 'sha256-b', access: access() })
  assert.deepEqual(grant('local.other', V1), { grant: [], outdated: true }, 'another extension’s document')
  await writeExtensionApproval(dataDir, 'local.plain', {
    fingerprint: 'sha256-c',
    access: access({ tier: 'declarative', permissions: [] }),
  })
  assert.equal(grant('local.plain', V1), null, 'no surfaces')
  assert.equal(grant('backlog', V1), null, 'one of the app’s own modules is not an extension')
})
