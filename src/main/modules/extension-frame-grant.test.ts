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
import { createExtensionFrameGrant } from './extension-frame-grant'

// A frame's calls are judged by the approvals and switches as they stand now:
// an extension installed and approved during the session is served without a
// restart, and one switched off or uninstalled is refused at the next call.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const access = (over: Partial<ExtensionAccess> = {}): ExtensionAccess => ({
  permissions: ['backlog:read'],
  tier: 'ui',
  worker: false,
  background: false,
  tools: {},
  actions: [],
  ...over,
})

test('an extension approved after the kernel started is served at once, and refused once switched off or forgotten', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'frame-grant-'))
  dirs.push(dataDir)
  const kernel = createMainKernel({
    // The kernel started knowing no extension at all.
    resolveModuleManifest: () => undefined,
    resolveFrameGrant: createExtensionFrameGrant({ approvals: createExtensionApprovalReader(dataDir), dataDir }),
  })
  kernel
    .hostFor('@host')
    .provideService(
      serviceTokens.BacklogModuleServiceToken,
      () => ({ getLocation: async (moduleId: string) => ({ ok: true, location: { root: moduleId } }) }) as never,
    )
  const call = () =>
    kernel.callFrameMethod({
      moduleId: 'local.fresh',
      method: 'backlog.location',
      params: { workspaceId: 'ws' },
      clientId: 'c',
      commandId: 'k',
      invoker: ownerInvoker(),
    })
  assert.equal((await call()).ok, false, 'not installed and approved yet')

  await writeExtensionApproval(dataDir, 'local.fresh', { fingerprint: 'sha256-a', access: access() })
  assert.deepEqual(await call(), { ok: true, result: { ok: true, location: { root: 'local.fresh' } } })

  await writeModuleOverrides(dataDir, { 'local.fresh': false })
  const off = await call()
  assert.equal(!off.ok && off.code, 'approval_required')

  await writeModuleOverrides(dataDir, {})
  await writeExtensionApproval(dataDir, 'local.fresh', null)
  const gone = await call()
  assert.equal(!gone.ok && gone.code, 'approval_required')
})

test('only what the approval holds is granted, and only to an extension with surfaces', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'frame-grant-'))
  dirs.push(dataDir)
  const grant = createExtensionFrameGrant({ approvals: createExtensionApprovalReader(dataDir), dataDir })
  await writeExtensionApproval(dataDir, 'local.ui', { fingerprint: 'sha256-a', access: access() })
  await writeExtensionApproval(dataDir, 'local.worker', {
    fingerprint: 'sha256-b',
    access: access({ tier: 'worker', permissions: ['storage:own'] }),
  })
  await writeExtensionApproval(dataDir, 'local.plain', {
    fingerprint: 'sha256-c',
    access: access({ tier: 'declarative', permissions: [] }),
  })
  assert.deepEqual(grant('local.ui'), ['backlog:read'])
  assert.deepEqual(grant('local.worker'), ['storage:own'])
  assert.equal(grant('local.plain'), null)
  assert.equal(grant('backlog'), null, 'one of the app’s own modules is not an extension')
})
