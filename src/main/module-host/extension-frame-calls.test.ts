import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import { declaredSettingsReader, withDeclaredSettings } from '../modules/extension-declared-settings'
import { createExtensionFrameCalls } from './extension-frame-calls'
import { OWNER_PRINCIPAL, type ExtensionInvoker } from './extension-invocation'
import { createModuleAppStateMirror } from './module-app-state-mirror'
import { extensionManifest, writeExtensionFolder } from '../../../tests/extension-folder'

// A frame's `settings.set` writes through the store the extension's code
// reads, so a setting the extension declares is held to its declaration
// there too, and `settings.get` reads it by the rule Settings reads it by.

const OWNER: ExtensionInvoker = { principal: OWNER_PRINCIPAL, permissionCeiling: null, label: 'you' }

test('a frame’s settings.set is held to the declaration, and settings.get reads by it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frame-settings-'))
  const moduleId = 'local.tuned'
  writeExtensionFolder(join(root, moduleId), {
    manifest: extensionManifest({
      id: 'tuned',
      contributes: {
        settings: [{ key: 'indent', title: 'Indent width', type: 'integer', minimum: 1, maximum: 8, default: 2 }],
      },
    }),
  })
  const store = withDeclaredSettings(
    createModuleAppStateMirror({ filePath: join(root, 'state.json'), watchFile: false }),
    declaredSettingsReader(() => root),
  )
  const call = createExtensionFrameCalls({
    grantOf: () => ({ grant: ['settings:own'], outdated: false }),
    service: () => undefined,
    callModuleMethod: async () => ({ ok: false, code: 'extension_unavailable', message: 'none' }) as never,
    emitNotification: () => undefined,
    appState: () => store,
    fileExclusions: () => [],
  })
  const frame = (method: string, params: unknown) =>
    call({ moduleId, frame: 'f'.repeat(64), method, params, clientId: 'c', commandId: 'k', invoker: OWNER })

  assert.deepEqual(await frame('settings.get', {}), { ok: true, result: { indent: 2 } })
  assert.deepEqual(await frame('settings.set', { key: 'indent', value: 12 }), {
    ok: false,
    code: 'invalid_params',
    message: 'Indent width must be at most 8.',
  })
  assert.deepEqual(await frame('settings.set', { key: 'indent', value: 5 }), { ok: true, result: { ok: true } })
  assert.deepEqual(await frame('settings.set', { key: 'note', value: 'free' }), { ok: true, result: { ok: true } })
  assert.deepEqual(await frame('settings.get', {}), { ok: true, result: { indent: 5, note: 'free' } })
})
