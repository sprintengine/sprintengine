import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { ownerInvoker } from '../module-host/extension-invocation'
import { writeModuleOverrides } from '../module-host/enablement-store'
import { createMainKernel } from '../module-host/main-host'
import * as serviceTokens from '../module-host/service-tokens'
import { createExtensionApprovalReader, writeExtensionApproval, type ExtensionAccess } from './extension-approvals'
import { writeKillListCache } from '../../server/extensions/catalogue/catalogue-files'
import { createExtensionFrameGrant, pinExtensionFrame, type ExtensionFrameStanding } from './extension-frame-grant'
import { extensionContentSync } from './module-signature'

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
  hooks: [],
  localServers: [],
  providers: [],
  ...over,
})

/**
 * How each extension stands, as the server's discovery would read it: every
 * key asked about is installed, runnable, at 1.0.0, unless a test says
 * otherwise.
 */
function standings(dataDir: string) {
  const moduleRoot = join(dataDir, 'extensions', 'installed')
  mkdirSync(moduleRoot, { recursive: true })
  writeFileSync(join(moduleRoot, 'extension.json'), '{}')
  const overrides = new Map<string, ExtensionFrameStanding | undefined>()
  const content = extensionContentSync(moduleRoot)
  const runnable: ExtensionFrameStanding = {
    runnable: true,
    version: '1.0.0',
    moduleRoot,
    contentDigest: content.ok ? content.fingerprint : undefined,
    development: false,
  }
  return {
    moduleRoot,
    set: (moduleId: string, standing: Partial<ExtensionFrameStanding> | undefined) =>
      overrides.set(moduleId, standing && { ...runnable, ...standing }),
    standing: (moduleId: string): ExtensionFrameStanding | undefined =>
      overrides.has(moduleId) ? overrides.get(moduleId) : runnable,
  }
}

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'frame-grant-'))
  dirs.push(dataDir)
  const discovered = standings(dataDir)
  // A components panel's images, as the server reads them (readSurfaceImage).
  const imagesRead: string[] = []
  const kernel = createMainKernel({
    // The kernel started knowing no extension at all.
    resolveModuleManifest: () => undefined,
    frameOwnImage: (moduleId, path) => {
      imagesRead.push(`${moduleId}:${path}`)
      return { mime: 'image/png', data: 'iVBORw0KGgo=' }
    },
    resolveFrameGrant: createExtensionFrameGrant({
      approvals: createExtensionApprovalReader(dataDir),
      dataDir,
      standing: discovered.standing,
      refresh: () => undefined,
    }),
  })
  const created: unknown[] = []
  kernel.hostFor('@host').provideService(
    serviceTokens.BacklogModuleServiceToken,
    () =>
      ({
        getLocation: async (moduleId: string) => ({ ok: true, location: { root: moduleId } }),
        create: async (...args: unknown[]) => {
          created.push(args)
          return { ok: true }
        },
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
  return { dataDir, call, created, discovered, imagesRead }
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
  const grant = createExtensionFrameGrant({
    approvals: createExtensionApprovalReader(dataDir),
    dataDir,
    standing: standings(dataDir).standing,
    refresh: () => undefined,
  })
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

test('a frame kept open is refused at its next call once its extension is killed, and nothing it asked for happens', async () => {
  const { dataDir, call, created } = setup()
  await writeExtensionApproval(dataDir, 'local.fresh', {
    fingerprint: 'sha256-a',
    access: access({ permissions: ['backlog:operate', 'backlog:read'] }),
  })
  pinExtensionFrame(V1, 'local.fresh', ['backlog:operate', 'backlog:read'])
  const create = { workspaceId: 'ws', input: { title: 'x' } }
  assert.deepEqual(await call(V1, 'backlog.create', create), { ok: true, result: { ok: true } })
  assert.equal(created.length, 1)

  // The kill list names its version. The approval stays on record, and the
  // discovery has not heard yet: the call is refused all the same.
  await writeKillListCache(dataDir, {
    killListVersion: 1,
    generatedAt: '2026-11-24T00:00:00.000Z',
    extensions: [{ id: 'local.fresh', versions: ['1.0.0'], reason: 'It sends your files away.' }],
  })
  const killed = await call(V1, 'backlog.create', create)
  assert.equal(!killed.ok && killed.code, 'approval_required')
  assert.equal(created.length, 1, 'the replayed call had no effect')

  // Taken off the list, it runs again, but the frame drawn before is drawn again first.
  await writeKillListCache(dataDir, { killListVersion: 1, generatedAt: '2026-11-24T01:00:00.000Z', extensions: [] })
  const again = await call(V1, 'backlog.create', create)
  assert.equal(!again.ok && again.code, 'frame_outdated')
  assert.equal(created.length, 1)
})

test('a frame is refused once its extension no longer runs as approved, or its folder is gone', async () => {
  const { dataDir, call, created, discovered } = setup()
  await writeExtensionApproval(dataDir, 'local.fresh', { fingerprint: 'sha256-a', access: access() })
  const create = { workspaceId: 'ws', input: { title: 'x' } }

  // Its files changed under its approval, or its signature no longer holds: not runnable.
  pinExtensionFrame(V1, 'local.fresh', ['backlog:read'])
  discovered.set('local.fresh', { runnable: false })
  assert.equal((await call(V1)).ok, false)

  // No folder holds it any more.
  discovered.set('local.fresh', undefined)
  pinExtensionFrame(V1, 'local.fresh', ['backlog:read'])
  assert.equal((await call(V1)).ok, false)

  // The discovery still lists it, but its folder was removed under it.
  discovered.set('local.fresh', {})
  pinExtensionFrame(V1, 'local.fresh', ['backlog:read'])
  assert.equal((await call(V1)).ok, true)
  rmSync(discovered.moduleRoot, { recursive: true, force: true })
  const gone = await call(V1, 'backlog.create', create)
  assert.equal(gone.ok, false)
  assert.equal(created.length, 0)
})

// A components panel's frame is judged like any frame. Its images need no
// permission of the extension's, so only its standing stands between a kept
// frame and its files: killed, switched off or no longer approved, it is
// refused before anything is read.
test('a components panel’s frame is refused its images once its extension is killed, switched off or unapproved', async () => {
  const { dataDir, call, imagesRead } = setup()
  const image = () => call(V1, 'assets.image', { path: 'assets/logo.png' })
  await writeExtensionApproval(dataDir, 'local.fresh', { fingerprint: 'sha256-a', access: access({ permissions: [] }) })
  pinExtensionFrame(V1, 'local.fresh', [])
  assert.deepEqual(await image(), { ok: true, result: { mime: 'image/png', data: 'iVBORw0KGgo=' } })
  assert.deepEqual(imagesRead, ['local.fresh:assets/logo.png'])

  await writeKillListCache(dataDir, {
    killListVersion: 1,
    generatedAt: '2026-11-24T00:00:00.000Z',
    extensions: [{ id: 'local.fresh', versions: ['1.0.0'], reason: 'It sends your files away.' }],
  })
  const killed = await image()
  assert.equal(!killed.ok && killed.code, 'approval_required')
  await writeKillListCache(dataDir, { killListVersion: 1, generatedAt: '2026-11-24T01:00:00.000Z', extensions: [] })

  await writeModuleOverrides(dataDir, { 'local.fresh': false })
  const off = await image()
  assert.equal(!off.ok && off.code, 'approval_required')
  await writeModuleOverrides(dataDir, {})

  await writeExtensionApproval(dataDir, 'local.fresh', null)
  const unapproved = await image()
  assert.equal(!unapproved.ok && unapproved.code, 'approval_required')
  assert.equal(imagesRead.length, 1, 'nothing was read for a refused frame')
})
