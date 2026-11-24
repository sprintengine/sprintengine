import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test, vi } from 'vitest'

import type { CapabilityManifest } from '../../shared/modules/manifest'
import { readModuleOverridesSync } from '../module-host/enablement-store'
import { createModuleLifecycle, liveModuleIds, summarizeModules, type ModuleLifecycleView } from './module-lifecycle'
import { createModuleRegistryMirror } from './registry-mirror'
import { extensionManifest, HELLO_MOUNT_SOURCE, writeExtensionFolder } from '../../../tests/extension-folder'
import { EXTENSION_FRAME_THEMES } from '../../shared/extension-frame-themes.generated'
import { extensionFrameDocuments } from '../../server/extensions/frames/frame-cache'
import { extensionFrameHash } from '../../server/extensions/frames/frame-document'
import {
  createExtensionApprovalReader,
  readExtensionApprovalsSync,
  writeExtensionApproval,
} from './extension-approvals'
import { createExtensionFrameGrant } from './extension-frame-grant'
import { createExtensionDiscovery } from '../../server/extensions/extension-discovery'
import { frameStandingOf } from '../../server/extensions/extension-plan'
import { approvalOf } from './extension-approvals.test-helper'
import { NO_EXTENSION_RUN } from './third-party-module-view'
import { MODULE_APP_STATE_FILE, moduleAppStateMirrorFor } from '../module-host/module-app-state-mirror'

// The lifecycle's own rules: which switches apply at once, how a module is
// listed, and that switches arriving together are each kept. Its whole path
// over the protocol is src/seams/moduleLifecycleSeam.test.ts.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A kernel that loaded nothing, and a registry nobody reported. */
const quiet = () => ({
  run: () => NO_EXTENSION_RUN,
  registry: createModuleRegistryMirror(),
})

const manifest = (id: string, extra: Partial<CapabilityManifest> = {}): CapabilityManifest => ({
  id,
  displayName: id,
  version: 1,
  defaultEnabled: true,
  ...extra,
})

test('every installed extension switches at once, except one whose main half failed at start', () => {
  const live = liveModuleIds(['deck', 'broken'], [{ id: 'broken' }])
  assert.ok(live.includes('deck'))
  assert.ok(live.includes('scheduled-agents'), 'the bundled ones that could still can')
  assert.equal(live.includes('broken'), false)
})

test('a module is listed with its switch, whether it runs, why not, and what it declares while it runs', () => {
  const view: ModuleLifecycleView = {
    manifests: () => [
      manifest('deck', { source: 'third-party' }),
      manifest('waiting', { source: 'third-party' }),
      manifest('off'),
    ],
    enabled: (id) => id !== 'off',
    running: (id) => id === 'deck',
    ineligible: (id) => (id === 'waiting' ? 'unapproved' : undefined),
    loadError: () => undefined,
    declaredMethods: (id) => (id === 'deck' ? [{ name: 'cards.list', access: 'read' }] : []),
  }
  assert.deepEqual(summarizeModules(view), [
    {
      id: 'deck',
      name: 'deck',
      version: 1,
      source: 'third-party',
      enabled: true,
      running: true,
      methods: [{ name: 'cards.list', access: 'read' }],
    },
    {
      id: 'waiting',
      name: 'waiting',
      version: 1,
      source: 'third-party',
      enabled: true,
      running: false,
      blocked: 'It waits for your approval.',
      methods: [],
    },
    { id: 'off', name: 'off', version: 1, source: 'bundled', enabled: false, running: false, methods: [] },
  ])
})

test('switches sent together are each kept, applied in order, and null is back to the default', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'module-lifecycle-'))
  dirs.push(dataDir)
  const applied: Array<Record<string, boolean>> = []
  const lifecycle = createModuleLifecycle({
    dataDir,
    moduleRoot: () => join(dataDir, 'modules'),
    view: () => null,
    applyEnablement: async (overrides) => {
      applied.push(overrides)
      return { ok: true }
    },
    changed: () => undefined,
    ...quiet(),
  })
  await Promise.all([
    lifecycle.setEnabled('a', false),
    lifecycle.setEnabled('b', true),
    lifecycle.setEnabled('c', false),
  ])
  assert.deepEqual(readModuleOverridesSync(dataDir), { a: false, b: true, c: false })
  assert.deepEqual(applied.at(-1), { a: false, b: true, c: false })
  await lifecycle.setEnabled('b', null)
  assert.deepEqual(readModuleOverridesSync(dataDir), { a: false, c: false })
  assert.equal((await lifecycle.setEnabled('../x', true)).ok, false, 'not a module id')
})

test('a switch that cannot be applied now is still kept for the next start, and says why', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'module-lifecycle-'))
  dirs.push(dataDir)
  const lifecycle = createModuleLifecycle({
    dataDir,
    moduleRoot: () => join(dataDir, 'modules'),
    view: () => null,
    applyEnablement: async () => ({ ok: false, message: 'Scheduled agents could not start.' }),
    changed: () => undefined,
    ...quiet(),
  })
  assert.deepEqual(await lifecycle.setEnabled('scheduled-agents', true), {
    ok: false,
    message: 'Scheduled agents could not start.',
  })
  assert.deepEqual(readModuleOverridesSync(dataDir), { 'scheduled-agents': true })
})

test('a registry a window reports is held to its shape; nothing installed offers nothing and draws no frame', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'module-lifecycle-'))
  dirs.push(dataDir)
  const registry = createModuleRegistryMirror()
  const lifecycle = createModuleLifecycle({
    dataDir,
    moduleRoot: () => join(dataDir, 'modules'),
    view: () => null,
    applyEnablement: async () => ({ ok: true }),
    changed: () => undefined,
    ...quiet(),
    registry,
  })
  assert.equal(lifecycle.reportRegistry({ modules: 'none' }).ok, false)
  assert.equal(registry.read(), null, 'a malformed report is refused and nothing is kept')
  assert.deepEqual(lifecycle.reportRegistry({ capturedAt: 1_700_000_000_000, channel: 'production', modules: [] }), {
    ok: true,
  })
  assert.equal(registry.read()?.channel, 'production')
  assert.deepEqual(await lifecycle.installed(), { modules: [], rejected: [] }, 'nothing installed, nothing listed')
  assert.deepEqual(await lifecycle.contributions(), { extensions: [], failures: {} })
  const frame = await lifecycle.frame({ moduleId: 'local.deck', point: 'doors', id: 'deck' })
  assert.equal(frame.ok, false)
})

test('an approved extension’s surface is drawn from its verified entry, in the theme asked for, and kept for the web route', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'module-lifecycle-'))
  dirs.push(dataDir)
  const root = join(dataDir, 'modules')
  const folder = writeExtensionFolder(join(root, 'local.deck'), {
    manifest: extensionManifest({
      id: 'deck',
      tier: 'ui',
      main: undefined,
      contributes: { doors: [{ id: 'deck', title: 'Deck', entry: 'dist/door.js' }] },
    }),
    files: { 'dist/door.js': HELLO_MOUNT_SOURCE },
  })
  const lifecycle = createModuleLifecycle({
    dataDir,
    moduleRoot: () => root,
    view: () => null,
    applyEnablement: async () => ({ ok: true }),
    changed: () => undefined,
    ...quiet(),
    registry: createModuleRegistryMirror(),
  })
  // Not approved yet: nothing is offered and nothing drawn.
  assert.deepEqual((await lifecycle.contributions()).extensions, [])
  assert.equal((await lifecycle.frame({ moduleId: 'local.deck', point: 'doors', id: 'deck' })).ok, false)

  await writeExtensionApproval(dataDir, 'local.deck', approvalOf(folder))
  assert.deepEqual(
    (await lifecycle.contributions()).extensions.map((extension) => extension.id),
    ['local.deck'],
  )
  const frame = await lifecycle.frame({ moduleId: 'local.deck', point: 'doors', id: 'deck', theme: 'nord' })
  assert.ok(frame.ok)
  assert.equal(frame.hash, extensionFrameHash(frame.html))
  assert.equal(extensionFrameDocuments.get(frame.hash), frame.html)
  // Its calls are held to what the approval held when it was built.
  const discovery = createExtensionDiscovery({ moduleRoot: () => root, dataDir })
  const grant = createExtensionFrameGrant({
    approvals: createExtensionApprovalReader(dataDir),
    dataDir,
    standing: (moduleId) => frameStandingOf(discovery.current(), moduleId),
    // A folder changed where no watcher heard it: discovery reads it again.
    refresh: () => discovery.invalidate(),
  })
  assert.deepEqual(grant('local.deck', frame.hash), { grant: ['storage:own'], outdated: false })
  assert.ok(frame.html.includes(JSON.stringify(HELLO_MOUNT_SOURCE).slice(1, 20)), 'the entry is in the document')
  assert.ok(frame.html.includes(`--bg-app:${EXTENSION_FRAME_THEMES.nord!.tokens['--bg-app']}`), 'drawn in nord')
  assert.equal((await lifecycle.frame({ moduleId: 'local.deck', point: 'doors', id: 'nope' })).ok, false)

  // Switched off: no frame.
  await lifecycle.setEnabled('local.deck', false)
  assert.equal((await lifecycle.frame({ moduleId: 'local.deck', point: 'doors', id: 'deck' })).ok, false)
})

test('a frame is refused once a file deep in its installed folder changes, though no watcher told discovery', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'module-lifecycle-'))
  dirs.push(dataDir)
  const root = join(dataDir, 'modules')
  const folder = writeExtensionFolder(join(root, 'local.deck'), {
    manifest: extensionManifest({
      id: 'deck',
      tier: 'ui',
      main: undefined,
      contributes: { doors: [{ id: 'deck', title: 'Deck', entry: 'dist/door.js' }] },
    }),
    files: { 'dist/door.js': HELLO_MOUNT_SOURCE, 'dist/parts/deep/more.js': 'export const more = 1\n' },
  })
  await writeExtensionApproval(dataDir, 'local.deck', approvalOf(folder))
  const lifecycle = createModuleLifecycle({
    dataDir,
    moduleRoot: () => root,
    view: () => null,
    applyEnablement: async () => ({ ok: true }),
    changed: () => undefined,
    ...quiet(),
    registry: createModuleRegistryMirror(),
  })
  const frame = await lifecycle.frame({ moduleId: 'local.deck', point: 'doors', id: 'deck' })
  assert.ok(frame.ok)
  const discovery = createExtensionDiscovery({ moduleRoot: () => root, dataDir })
  let refreshed = 0
  const grant = createExtensionFrameGrant({
    approvals: createExtensionApprovalReader(dataDir),
    dataDir,
    standing: (moduleId) => frameStandingOf(discovery.current(), moduleId),
    refresh: () => {
      refreshed += 1
      discovery.invalidate()
    },
  })
  assert.deepEqual(grant('local.deck', frame.hash), { grant: ['storage:own'], outdated: false })
  assert.equal(refreshed, 0, 'files as discovery judged them: nothing is read again')

  // A nested file changes: discovery, holding its first reading, still calls it runnable.
  writeFileSync(join(folder, 'dist', 'parts', 'deep', 'more.js'), 'export const more = 2\n')
  assert.equal(frameStandingOf(discovery.current(), 'local.deck')?.runnable, true, 'discovery has not heard')
  // Past the two seconds a matching digest is trusted for.
  const later = Date.now() + 3_000
  const clock = vi.spyOn(Date, 'now').mockReturnValue(later)
  try {
    assert.equal(grant('local.deck', frame.hash), null, 'the files no longer match the approval')
  } finally {
    clock.mockRestore()
  }
  assert.equal(refreshed, 1)
  assert.equal(frameStandingOf(discovery.current(), 'local.deck')?.runnable, false, 'discovery read it again')
})

test('a development folder registered over an installed extension waits for the person, who approves it in its place; removing it forgets its approval under every key', async () => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'module-lifecycle-')))
  dirs.push(dataDir)
  const root = join(dataDir, 'modules')
  const deck = (files: Record<string, string>) => ({
    manifest: extensionManifest({
      id: 'deck',
      tier: 'ui',
      main: undefined,
      contributes: { doors: [{ id: 'deck', title: 'Deck', entry: 'dist/door.js' }] },
    }),
    files,
  })
  const installed = writeExtensionFolder(join(root, 'local.deck'), deck({ 'dist/door.js': HELLO_MOUNT_SOURCE }))
  await writeExtensionApproval(dataDir, 'local.deck', approvalOf(installed))
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'module-lifecycle-work-')))
  dirs.push(work)
  const folder = writeExtensionFolder(join(work, 'deck'), deck({ 'dist/door.js': HELLO_MOUNT_SOURCE }))
  const lifecycle = createModuleLifecycle({
    dataDir,
    moduleRoot: () => root,
    view: () => null,
    applyEnablement: async () => ({ ok: true }),
    changed: () => undefined,
    ...quiet(),
    registry: createModuleRegistryMirror(),
  })

  // An agent registers it: nothing approves it, and the installed one runs on.
  const loaded = await lifecycle.devLoad(folder)
  assert.ok(loaded.ok)
  assert.equal(loaded.approval.state, 'pending')
  const listed = await lifecycle.devFolders()
  assert.equal(listed[0]!.waiting, true)
  assert.deepEqual(
    (await lifecycle.contributions()).extensions.map((extension) => extension.id),
    ['local.deck'],
    'the installed one is what clients draw',
  )
  const views = (await lifecycle.installed()).modules
  assert.equal(views.length, 2, 'both are listed: the installed one, and the folder waiting to replace it')
  const waiting = views.find((view) => view.development)!
  assert.equal(waiting.development?.waiting, true)
  assert.equal(views.find((view) => !view.development)!.approval.state, 'approved')

  // The person approves the folder, named by its own fingerprint: it stands in.
  assert.equal(waiting.approval.state, 'pending')
  const approved = await lifecycle.approve(
    'local.deck',
    waiting.approval.state === 'pending' ? waiting.approval.fingerprint : '',
  )
  assert.deepEqual(approved, { ok: true })
  const after = await lifecycle.devFolders()
  assert.equal(after[0]!.waiting, undefined)
  assert.equal(after[0]!.approval?.state, 'approved')

  // Its id changes, so discovery no longer finds it under that key; removing
  // it still forgets the approval it was given.
  writeExtensionFolder(folder, {
    ...deck({ 'dist/door.js': HELLO_MOUNT_SOURCE }),
    manifest: extensionManifest({
      id: 'deck2',
      tier: 'ui',
      main: undefined,
      contributes: { doors: [{ id: 'deck', title: 'Deck', entry: 'dist/door.js' }] },
    }),
  })
  const removed = await lifecycle.devUnload({ path: folder })
  assert.ok(removed.ok)
  assert.equal(
    [...readExtensionApprovalsSync(dataDir).values()].some((record) => record.devFolder === folder),
    false,
  )
})

test('an uninstall whose Settings values cannot be forgotten says so, and forgets the rest', async () => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'module-lifecycle-')))
  dirs.push(dataDir)
  const root = join(dataDir, 'modules')
  const source = writeExtensionFolder(join(dataDir, 'src'), {
    manifest: extensionManifest({ id: 'notes', tier: 'declarative', permissions: [], main: undefined }),
  })
  const lifecycle = createModuleLifecycle({
    dataDir,
    moduleRoot: () => root,
    view: () => null,
    applyEnablement: async () => ({ ok: true }),
    changed: () => undefined,
    ...quiet(),
    registry: createModuleRegistryMirror(),
  })
  assert.ok((await lifecycle.install(source)).ok)
  const settings = moduleAppStateMirrorFor(dataDir)
  settings.setValue('local.notes', 'folder', 'inbox')
  // The settings file cannot be written: where its temporary file goes is a folder.
  const tmp = join(dataDir, `${MODULE_APP_STATE_FILE}.${process.pid}.tmp`)
  mkdirSync(tmp)
  const answer = await lifecycle.uninstall('local.notes')
  assert.equal(answer.ok, false)
  assert.match(answer.ok ? '' : answer.message, /^Removed "local\.notes" but could not forget its Settings values/)
  assert.equal(existsSync(join(root, 'local.notes')), false, 'its folder is gone all the same')
  assert.deepEqual(settings.get('local.notes'), { folder: 'inbox' }, 'what is still on disk is what is shown')
})
