import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import { STUDIO_EXTENSION_VERSION } from '../../../packages/extension-sdk/src/extension-manifest'
import { writeDevFolders } from '../../main/modules/extension-dev-folders'
import { createExtensionDiscovery } from './extension-discovery'

// One discovery per change: a save in a development folder reads that folder
// alone again, and the installed extensions stay as read until something
// else changes.

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'se-discovery-')))
  made.push(dir)
  return dir
}

function writeExtension(folder: string, id: string, text = '1'): void {
  mkdirSync(join(folder, 'src'), { recursive: true })
  writeFileSync(
    join(folder, 'extension.json'),
    JSON.stringify({
      manifestVersion: 1,
      id,
      version: '1.0.0',
      engines: { studio: `>=${STUDIO_EXTENSION_VERSION}` },
      tier: 'ui',
      name: id,
      permissions: [],
      contributes: { panels: [{ id: 'p', title: 'P', entry: 'src/panel.ts' }] },
    }),
  )
  writeFileSync(
    join(folder, 'src', 'panel.ts'),
    `export function mount(root: HTMLElement) { root.textContent = "${text}" }\n`,
  )
}

test('a save reads its folder alone again; the installed extensions stay as read until invalidated', async () => {
  const dataDir = tempDir()
  const root = join(dataDir, 'extensions')
  writeExtension(join(root, 'local.deck'), 'deck')
  const one = join(tempDir(), 'one')
  const two = join(tempDir(), 'two')
  writeExtension(one, 'one')
  writeExtension(two, 'two')
  await writeDevFolders(dataDir, [one, two])
  const discovery = createExtensionDiscovery({ moduleRoot: () => root, dataDir })
  const first = discovery.current()
  assert.equal(discovery.current(), first, 'read once for one change')
  const of = (result: typeof first, key: string) => result.modules.find((module) => module.key === key)!

  writeExtension(one, 'one', '2')
  writeExtension(join(root, 'local.deck'), 'deck', '2')
  discovery.folderChanged(one)
  const saved = discovery.current()
  assert.notEqual(of(saved, 'local.one').standing.contentDigest, of(first, 'local.one').standing.contentDigest)
  assert.equal(of(saved, 'local.two').standing, of(first, 'local.two').standing, 'the other folder is not read again')
  assert.equal(of(saved, 'local.deck').standing, of(first, 'local.deck').standing, 'nor the installed ones')

  discovery.invalidate()
  assert.notEqual(
    of(discovery.current(), 'local.deck').standing.contentDigest,
    of(first, 'local.deck').standing.contentDigest,
    'read again once the extensions folder changed',
  )
})
