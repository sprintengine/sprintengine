import assert from 'node:assert/strict'
import { test } from 'vitest'

import { STUDIO_EXTENSION_VERSION } from '../../../packages/extension-sdk/src/extension-manifest'
import { extensionManifest } from '../../../tests/extension-folder'
import {
  LOCAL_EXTENSION_PUBLISHER,
  capabilityManifestOf,
  extensionInstallKey,
  isExtensionInstallKey,
  isReservedExtensionId,
  parseExtensionInstallKey,
  parseExtensionManifest,
  studioReadsManifest,
  type ExtensionManifest,
} from './third-party-manifest'

function parsed(overrides: Record<string, unknown> = {}): ExtensionManifest {
  const result = parseExtensionManifest(JSON.stringify(extensionManifest(overrides)))
  assert.ok(result.ok, JSON.stringify(!result.ok && result.issues))
  return result.manifest
}

test('the module kernel lists an extension by its install key, on by default and third-party', () => {
  const extension = parsed({ permissions: ['storage:own', 'workspace:read'] })
  const manifest = capabilityManifestOf('acme.demo', 'acme', extension)
  assert.deepEqual(manifest, {
    id: 'acme.demo',
    displayName: 'Demo',
    version: '1.0.0',
    publisher: 'acme',
    summary: 'A demo.',
    defaultEnabled: true,
    source: 'third-party',
    permissions: ['storage:own', 'workspace:read'],
  })
  // A copy: the kernel's list cannot reach back into the manifest.
  assert.notEqual(manifest.permissions, extension.permissions)
})

test('an extension without a description has no summary', () => {
  const extension = parsed({ description: undefined })
  assert.equal('summary' in capabilityManifestOf('local.demo', LOCAL_EXTENSION_PUBLISHER, extension), false)
  const empty = parsed({ description: '' })
  assert.equal('summary' in capabilityManifestOf('local.demo', LOCAL_EXTENSION_PUBLISHER, empty), false)
})

test('a manifest the validator refuses comes back with its issues, not half-read', () => {
  const notJson = parseExtensionManifest('{nope')
  assert.equal(notJson.ok, false)
  const unknownKey = parseExtensionManifest(JSON.stringify(extensionManifest({ entry: { main: 'dist/main.cjs' } })))
  assert.equal(unknownKey.ok, false)
  assert.match(JSON.stringify(!unknownKey.ok && unknownKey.issues), /entry/)
})

test('Studio reads a manifest written for it or older, and refuses one written for a newer Studio by name', () => {
  assert.deepEqual(studioReadsManifest(parsed()), { ok: true })
  const [major, minor] = STUDIO_EXTENSION_VERSION.split('.').map(Number)
  const newer = `${major}.${minor + 1}.0`
  const refused = studioReadsManifest(parsed({ engines: { studio: `>=${newer}` } }))
  assert.equal(refused.ok, false)
  assert.match(!refused.ok ? refused.message : '', new RegExp(`needs Studio ${newer.replaceAll('.', '\\.')}`))
})

test('an install key is <publisher>.<id>, and nothing else parses as one', () => {
  assert.equal(extensionInstallKey(LOCAL_EXTENSION_PUBLISHER, 'demo'), 'local.demo')
  assert.deepEqual(parseExtensionInstallKey('acme.deck-tools'), { publisher: 'acme', id: 'deck-tools' })
  for (const key of ['demo', '.demo', 'acme.', 'Acme.demo', 'acme.Demo', 'acme.de_mo', 'acme.constructor']) {
    assert.equal(isExtensionInstallKey(key), false, key)
  }
})

test('studio- and sprintengine- ids are reserved for Studio’s own catalogue', () => {
  assert.equal(isReservedExtensionId('studio-notes'), true)
  assert.equal(isReservedExtensionId('sprintengine-notes'), true)
  assert.equal(isReservedExtensionId('notes'), false)
})
