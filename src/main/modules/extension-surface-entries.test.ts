import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'

import { validateExtensionManifest } from '../../../packages/extension-sdk/src/extension-manifest'
import {
  extensionManifest,
  HELLO_MOUNT_SOURCE,
  newExtensionSigner,
  signExtensionFolder,
  writeExtensionFolder,
} from '../../../tests/extension-folder'
import { capabilityManifestOf, EXTENSION_SURFACE_POINTS } from '../../shared/modules/third-party-manifest'
import type { ExtensionStandingContext } from './module-signature'
import { approvedContext } from './extension-approvals.test-helper'
import {
  collectExtensionContributions,
  readExtensionSurfaceEntry,
  surfaceEntriesView as rendererEntryView,
} from './extension-surface-entries'
import { discoverUserModules, type InstalledModule } from './user-module-registry'
import { test } from 'vitest'

/**
 * What a client is offered (`extension.contributions`), with every surface's
 * entry read as a frame would read it: the entries by path, or the
 * extension's failure.
 */
async function collectThirdPartyRendererEntries(modules: readonly InstalledModule[]) {
  const contributions = collectExtensionContributions(modules)
  const failures: Record<string, string> = { ...contributions.failures }
  const entries: Array<(typeof contributions.extensions)[number] & { entries: Record<string, string> }> = []
  for (const extension of contributions.extensions) {
    const installed = modules.find((module) => module.key === extension.id)!
    const code: Record<string, string> = {}
    let failed: string | null = null
    for (const point of EXTENSION_SURFACE_POINTS) {
      for (const contribution of installed.extension.contributes[point]) {
        const read = await readExtensionSurfaceEntry(installed, point, contribution.id)
        if (read.ok) code[read.entryPath] = read.code
        else failed = read.message
      }
    }
    if (failed) failures[extension.id] = failed
    else entries.push({ ...extension, entries: code })
  }
  return { entries, failures }
}

const EMPTY_TRUST: ExtensionStandingContext = { approvals: new Map() }
const ABSOLUTE_PATH_PATTERN = /(^|[\s'"])(?:\/[\w.-]|[A-Za-z]:\\)/

// A ui-tier extension with one panel drawn by `dist/panel.js`.
const PANEL_MANIFEST = (id: string, overrides: Record<string, unknown> = {}) =>
  extensionManifest({
    id,
    tier: 'ui',
    main: undefined,
    contributes: { panels: [{ id: 'board', title: 'Board', entry: 'dist/panel.js' }] },
    ...overrides,
  })

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mc-renderer-entries-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function writePanelExtension(
  root: string,
  id: string,
  files: Record<string, string> = { 'dist/panel.js': HELLO_MOUNT_SOURCE },
): string {
  return writeExtensionFolder(join(root, `local.${id}`), { manifest: PANEL_MANIFEST(id), files })
}

// The approval Settings → Extensions records: the folder as it is now.
function grantsFor(...folders: string[]): ExtensionStandingContext {
  return approvedContext(Object.fromEntries(folders.map((folder) => [basename(folder), folder])))
}

// Only approved extensions are servable; signed or unsigned but not approved,
// and invalid, stay blocked.
test('only an approved extension’s entries are served', async () => {
  await withTempDir(async (root) => {
    const approved = writePanelExtension(root, 'approved')
    writePanelExtension(root, 'unapproved')
    signExtensionFolder(writePanelExtension(root, 'pending'), newExtensionSigner())
    const tampered = writePanelExtension(root, 'tampered')
    signExtensionFolder(tampered, newExtensionSigner())
    await writeFile(join(tampered, 'dist', 'panel.js'), 'export function mount() { /* evil */ }\n')

    const { modules } = await discoverUserModules(root, grantsFor(approved))
    const statuses = Object.fromEntries(
      modules.map((module) => [module.key, [module.standing.signature, module.standing.approval.state]]),
    )
    assert.deepEqual(statuses, {
      'local.approved': ['unsigned', 'approved'],
      'local.pending': ['signed', 'pending'],
      'local.tampered': ['invalid', 'unavailable'],
      'local.unapproved': ['unsigned', 'pending'],
    })

    const served = await collectThirdPartyRendererEntries(modules)
    assert.deepEqual(
      served.entries.map((entry) => entry.id),
      ['local.approved'],
    )
    assert.deepEqual(served.entries[0]!.entries, { 'dist/panel.js': HELLO_MOUNT_SOURCE })
    assert.equal(served.entries[0]!.extension.id, 'approved')
    assert.equal(served.entries[0]!.manifest.id, 'local.approved')
    assert.deepEqual(served.failures, {}, 'extensions waiting for approval are not serving failures')

    const views = Object.fromEntries(modules.map((module) => [module.key, rendererEntryView(module)]))
    assert.equal(views['local.approved']!.availability, 'available')
    assert.equal(views['local.pending']!.availability, 'blocked')
    assert.equal(views['local.unapproved']!.availability, 'blocked')
    assert.equal(views['local.tampered']!.availability, 'blocked')
  })
})

test('each distinct entry is served once, whichever surfaces share it', async () => {
  await withTempDir(async (root) => {
    const folder = writeExtensionFolder(join(root, 'local.shared'), {
      manifest: PANEL_MANIFEST('shared', {
        contributes: {
          panels: [{ id: 'board', title: 'Board', entry: 'dist/panel.js' }],
          doors: [{ id: 'room', title: 'Room', entry: 'dist/panel.js' }],
          settingsSections: [{ id: 'prefs', title: 'Prefs', entry: 'dist/settings.mjs' }],
        },
      }),
      files: { 'dist/panel.js': HELLO_MOUNT_SOURCE, 'dist/settings.mjs': 'export function mount() {}\n' },
    })
    const { modules } = await discoverUserModules(root, grantsFor(folder))
    const served = await collectThirdPartyRendererEntries(modules)
    assert.deepEqual(Object.keys(served.entries[0]!.entries), ['dist/panel.js', 'dist/settings.mjs'])
  })
})

// An approved extension with no window code is still served, with no entries,
// so the window registers its commands, menus and top bar items.
test('an approved code-free extension is served with no entries', async () => {
  await withTempDir(async (root) => {
    const folder = writeExtensionFolder(join(root, 'local.aliases'), {
      manifest: extensionManifest({
        id: 'aliases',
        tier: 'declarative',
        permissions: undefined,
        main: undefined,
        contributes: { commands: [{ id: 'backlog.toggle', title: 'Toggle backlog', action: 'panel.backlog.toggle' }] },
      }),
      files: {},
    })
    const { modules } = await discoverUserModules(root, grantsFor(folder))
    assert.equal(rendererEntryView(modules[0]!).availability, 'none')
    const served = await collectThirdPartyRendererEntries(modules)
    assert.deepEqual(
      served.entries.map((entry) => [entry.id, entry.entries]),
      [['local.aliases', {}]],
    )
  })
})

// An entry escaping the extension's folder is rejected with an explicit error
// that never leaks an absolute path. Manifest validation already rejects ".."
// and absolute paths, so this exercises the defense-in-depth containment layer
// with constructed InstalledModule fixtures, as if a crafted manifest slipped
// past parsing.
test('an entry outside the extension’s folder is never served', async () => {
  await withTempDir(async (root) => {
    await writeFile(join(root, 'escape.js'), 'export {}')
    const moduleRoot = join(root, 'local.crafted')
    const validated = validateExtensionManifest(PANEL_MANIFEST('crafted'))
    assert.ok(validated.ok)
    const escapingEntries: Record<string, string> = {
      traversal: '../escape.js',
      'nested-traversal': 'nested/../../escape.js',
      absolute: join(root, 'escape.js'),
      'module-root-itself': '.',
    }

    for (const [id, entry] of Object.entries(escapingEntries)) {
      const extension = {
        ...validated.manifest,
        contributes: { ...validated.manifest.contributes, panels: [{ id: 'board', title: 'Board', entry }] },
      }
      const crafted: InstalledModule = {
        key: id,
        publisher: 'local',
        manifest: capabilityManifestOf(id, 'local', extension),
        extension,
        moduleRoot,
        standing: {
          signature: 'unsigned',
          approval: { state: 'approved', fingerprint: 'sha256-test' },
          verifiedFiles: { [entry]: 'a'.repeat(64) },
        },
      }
      const view = rendererEntryView(crafted)
      assert.equal(view.availability, 'error', `${id} entry must be rejected`)
      assert.equal(view.message, 'entry must resolve inside the module root.')
      assert.doesNotMatch(view.message ?? '', ABSOLUTE_PATH_PATTERN)

      const served = await collectThirdPartyRendererEntries([crafted])
      assert.deepEqual(served.entries, [], `${id} entry is never served, even for an approved extension`)
      assert.equal(served.failures[id], 'entry must resolve inside the module root.')
    }
  })
})

// The parser front line: a manifest declaring ".." or absolute entry paths is
// rejected before it ever becomes an installed extension.
test('discovery rejects a manifest whose entry escapes its folder', async () => {
  await withTempDir(async (root) => {
    const escaping = (id: string, entry: string) =>
      writeExtensionFolder(join(root, `local.${id}`), {
        manifest: PANEL_MANIFEST(id, { contributes: { panels: [{ id: 'board', title: 'Board', entry }] } }),
        files: {},
      })
    escaping('traversal', '../escape.js')
    escaping('absolute', '/tmp/escape.js')
    const { modules, rejected } = await discoverUserModules(root, EMPTY_TRUST)
    assert.deepEqual(modules, [])
    assert.equal(rejected.length, 2)
    for (const rejection of rejected) {
      assert.equal(rejection.issues[0]!.path, 'contributes.panels[0].entry')
      assert.match(rejection.issues[0]!.message, /relative path inside the extension/)
    }
  })
})

// Content-bound approval: changing an approved extension's files removes it from
// the servable set (the approval names other content now).
test('a changed file takes an approved extension out of the served set', async () => {
  await withTempDir(async (root) => {
    const folder = writePanelExtension(root, 'demo')
    const approvals = grantsFor(folder)

    const before = await discoverUserModules(root, approvals)
    assert.equal(before.modules[0]!.standing.approval.state, 'approved')
    assert.equal((await collectThirdPartyRendererEntries(before.modules)).entries.length, 1)

    await writeFile(
      join(folder, 'extension.json'),
      JSON.stringify(PANEL_MANIFEST('demo', { permissions: ['settings:own'] })),
    )
    const after = await discoverUserModules(root, approvals)
    assert.equal(after.modules[0]!.standing.approval.state, 'pending')
    const served = await collectThirdPartyRendererEntries(after.modules)
    assert.deepEqual(served.entries, [], 'changed content is no longer servable')
    assert.equal(rendererEntryView(after.modules[0]!).availability, 'blocked')
  })
})

test('a missing entry is a serving failure; a content-only extension with no entries is none', async () => {
  await withTempDir(async (root) => {
    const missing = writePanelExtension(root, 'missing-entry', {})
    writeExtensionFolder(join(root, 'local.content-only'), {
      manifest: extensionManifest({ id: 'content-only', tier: 'content', permissions: undefined, main: undefined }),
      files: {},
    })
    const { modules } = await discoverUserModules(root, grantsFor(missing))

    const missingModule = modules.find((module) => module.key === 'local.missing-entry')!
    const view = rendererEntryView(missingModule)
    assert.equal(view.availability, 'error')
    assert.equal(view.message, 'The surface entry dist/panel.js is missing.')
    assert.doesNotMatch(view.message ?? '', ABSOLUTE_PATH_PATTERN)

    const contentOnly = modules.find((module) => module.key === 'local.content-only')!
    assert.equal(contentOnly.standing.approval.state, 'not-needed')
    assert.equal(rendererEntryView(contentOnly).availability, 'none')

    const served = await collectThirdPartyRendererEntries(modules)
    // Content needs no approval: it is served, with nothing to run.
    assert.deepEqual(
      served.entries.map((entry) => [entry.id, entry.entries]),
      [['local.content-only', {}]],
    )
    assert.equal(served.failures['local.missing-entry'], 'The surface entry dist/panel.js is missing.')
    assert.equal('local.content-only' in served.failures, false)
  })
})

test('an entry that changed after verification is not served', async () => {
  await withTempDir(async (root) => {
    const folder = writePanelExtension(root, 'swapped')
    const { modules } = await discoverUserModules(root, grantsFor(folder))
    await writeFile(join(folder, 'dist', 'panel.js'), 'export function mount() { /* swapped */ }\n')
    const served = await collectThirdPartyRendererEntries(modules)
    assert.deepEqual(served.entries, [])
    assert.equal(
      served.failures['local.swapped'],
      'A surface’s entry changed after the extension was verified, so it was not drawn.',
    )
  })
})
