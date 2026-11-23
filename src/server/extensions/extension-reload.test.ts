import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { STUDIO_EXTENSION_VERSION } from '../../../packages/extension-sdk/src/extension-manifest'
import type { CapabilityModule, LoadMainModulesResult } from '../../main/module-host/load-modules'
import {
  devFolderApprovalFingerprint,
  extensionAccess,
  type ExtensionApprovalRecord,
} from '../../main/modules/extension-approvals'
import { discoverUserModulesSync } from '../../main/modules/user-module-registry'
import { createExtensionDevEvents } from './dev/dev-events'
import { planInstalledExtensions } from './extension-plan'
import { createExtensionReloader } from './extension-reload'
import type { ExtensionWorkers } from './workers/worker-manager'

// A save in a development folder loads it again while Studio runs; a save
// that asks for more holds it back and says what it asks; a folder taken out
// is let go.

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'se-reload-')))
  made.push(dir)
  return dir
}

function writeExtension(folder: string, permissions: string[] = []): void {
  mkdirSync(join(folder, 'src'), { recursive: true })
  writeFileSync(
    join(folder, 'extension.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: 'notes',
      version: '1.0.0',
      engines: { studio: `>=${STUDIO_EXTENSION_VERSION}` },
      tier: 'ui',
      name: 'Notes',
      permissions,
      contributes: { panels: [{ id: 'p', title: 'P', entry: 'src/panel.ts' }] },
    }),
  )
}

function approval(folder: string): ExtensionApprovalRecord {
  const access = extensionAccess(
    {
      permissions: [],
      tier: 'ui',
      contributes: { mcpTools: [], commands: [], customEditors: [], hooks: [], mcpServers: [], providers: [] },
    } as never,
    {},
  )
  return { fingerprint: devFolderApprovalFingerprint(access, folder), access, devFolder: folder }
}

function setUp() {
  const root = tempDir()
  const folder = join(tempDir(), 'notes')
  writeExtension(folder)
  writeFileSync(
    join(folder, 'src', 'panel.ts'),
    'export function mount(root: HTMLElement) { root.textContent = "1" }\n',
  )
  const devFolders = [folder]
  const ctx = () => ({ approvals: new Map([['local.notes', approval(folder)]]), devFolders: [...devFolders] })
  const workers = { willReload: () => undefined } as unknown as ExtensionWorkers
  const plan = planInstalledExtensions(discoverUserModulesSync(root, ctx()), () => workers)
  const replaced: Array<{ modules: string[]; removed: string[] }> = []
  const load = {
    replaceModules: async (update: { modules: readonly CapabilityModule[]; removed: readonly string[] }) => {
      replaced.push({ modules: update.modules.map((module) => module.manifest.id), removed: [...update.removed] })
      return { loaded: [], disabled: [], errors: [] }
    },
  } as unknown as LoadMainModulesResult
  const events = createExtensionDevEvents()
  const told: string[][] = []
  const reloader = createExtensionReloader({
    plan,
    discover: () => discoverUserModulesSync(root, ctx()),
    workers: () => workers,
    load: () => load,
    overrides: () => ({}),
    reloaded: ({ changed }) => told.push(changed),
    events,
  })
  return { folder, devFolders, plan, replaced, events, told, reloader }
}

test('a save loads the extension again, and says reloaded', async () => {
  const { folder, replaced, events, told, reloader, plan } = setUp()
  await reloader.reload()
  assert.deepEqual(replaced, [], 'nothing changed, nothing loads again')
  writeFileSync(
    join(folder, 'src', 'panel.ts'),
    'export function mount(root: HTMLElement) { root.textContent = "2" }\n',
  )
  await reloader.reload()
  assert.deepEqual(replaced, [{ modules: ['local.notes'], removed: [] }])
  assert.deepEqual(told, [['local.notes']])
  assert.equal(plan.ineligible['local.notes'], undefined, 'it still runs: its approval holds')
  assert.deepEqual(
    events.since(0).map((event) => event.kind),
    ['reloaded'],
  )
})

test('a save that asks for more is held back, and says what it asks', async () => {
  const { folder, events, reloader, plan } = setUp()
  writeExtension(folder, ['workspace:read'])
  await reloader.reload()
  assert.equal(plan.ineligible['local.notes'], 'unapproved')
  const asked = events.since(0).find((event) => event.kind === 'approval')
  assert.deepEqual(asked?.growth, ['the "workspace:read" permission'])
})

test('a folder taken out is let go', async () => {
  const { devFolders, replaced, reloader } = setUp()
  devFolders.splice(0)
  await reloader.reload()
  assert.deepEqual(replaced, [{ modules: [], removed: ['local.notes'] }])
})
