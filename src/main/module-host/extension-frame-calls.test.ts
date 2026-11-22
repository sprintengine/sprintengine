import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import { declaredSettingsReader, withDeclaredSettings } from '../modules/extension-declared-settings'
import { createExtensionFrameCalls } from './extension-frame-calls'
import { studioGrantPrincipal } from '../../../packages/studio-protocol/src/permissions'
import { OWNER_PRINCIPAL, type ExtensionInvoker } from './extension-invocation'
import { createModuleAppStateMirror } from './module-app-state-mirror'
import { extensionManifest, writeExtensionFolder } from '../../../tests/extension-folder'

// A frame's `settings.set` writes through the store the extension's code
// reads, so a setting the extension declares is held to its declaration
// there too, and `settings.get` reads it by the rule Settings reads it by.

const OWNER: ExtensionInvoker = { principal: OWNER_PRINCIPAL, permissionCeiling: null, label: 'you' }
/** A pairing that may use extensions, and may not change Studio's settings. */
const PAIRED: ExtensionInvoker = {
  principal: studioGrantPrincipal({ owner: false, scopes: ['extensions:read', 'extensions:operate'] }),
  permissionCeiling: null,
  label: 'the device "build-box"',
}

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
  const frame = (method: string, params: unknown, invoker: ExtensionInvoker = OWNER) =>
    call({ moduleId, frame: 'f'.repeat(64), method, params, clientId: 'c', commandId: 'k', invoker })

  assert.deepEqual(await frame('settings.get', {}), { ok: true, result: { indent: 2 } })
  assert.deepEqual(await frame('settings.set', { key: 'indent', value: 12 }), {
    ok: false,
    code: 'invalid_params',
    message: 'Indent width must be at most 8.',
  })
  assert.deepEqual(await frame('settings.set', { key: 'indent', value: 5 }), { ok: true, result: { ok: true } })
  assert.deepEqual(await frame('settings.set', { key: 'note', value: 'free' }), { ok: true, result: { ok: true } })
  assert.deepEqual(await frame('settings.get', {}), { ok: true, result: { indent: 5, note: 'free' } })

  // A frame drawn for someone who may not change Studio's settings: it still
  // reads its own configuration to draw itself, and changes nothing.
  assert.deepEqual(await frame('settings.get', {}, PAIRED), { ok: true, result: { indent: 5, note: 'free' } })
  const refused = await frame('settings.set', { key: 'indent', value: 3 }, PAIRED)
  assert.equal(refused.ok, false)
  if (!refused.ok) {
    assert.equal(refused.code, 'not_permitted')
    assert.match(refused.message, /needs "settings:write"/)
  }
  assert.deepEqual(await frame('settings.get', {}, PAIRED), { ok: true, result: { indent: 5, note: 'free' } })
})

// A custom editor's document is read and saved through these same calls, as
// the extension and as whoever opened it: an extension not approved to read
// files gets nothing, one not approved to write saves nothing, and a write
// against bytes that changed since is refused.
test('a custom editor’s file reads and saves are held to the extension’s file permissions', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'frame-editor-'))
  writeFileSync(join(folder, 'list.todo'), '- [ ] one\n')
  const workspaces = {
    get: async (id: string) => (id === 'ws' ? { id, name: 'ws', folderPath: folder, mode: 'standard' } : null),
    list: async () => [],
  }
  const callsFor = (grant: string[]) => {
    const call = createExtensionFrameCalls({
      grantOf: () => ({ grant, outdated: false }),
      service: (key) => (key === 'core.workspace-context' ? workspaces : undefined),
      callModuleMethod: async () => ({ ok: false, code: 'extension_unavailable', message: 'none' }) as never,
      emitNotification: () => undefined,
      appState: () => undefined,
      fileExclusions: () => [],
    })
    return (method: string, params: unknown) =>
      call({
        moduleId: 'local.todo-editor',
        frame: 'f'.repeat(64),
        method,
        params,
        clientId: 'c',
        commandId: 'k',
        invoker: OWNER,
      })
  }
  const path = { workspaceId: 'ws', path: 'list.todo' }

  const none = callsFor([])
  const refused = await none('files.read', path)
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.equal(refused.code, 'not_permitted')

  const readOnly = callsFor(['workspace-files:read'])
  const read = await readOnly('files.read', { ...path, encoding: 'base64' })
  assert.ok(read.ok)
  const { content, sha256 } = (read.ok ? read.result : {}) as { content: string; sha256: string }
  assert.equal(Buffer.from(content, 'base64').toString('utf8'), '- [ ] one\n')
  const write = await readOnly('files.write', { ...path, content: 'x', expectedSha256: sha256 })
  assert.equal(write.ok ? 'written' : write.code, 'not_permitted')

  const writer = callsFor(['workspace-files:read', 'workspace-files:write'])
  writeFileSync(join(folder, 'list.todo'), '- [x] one\n')
  const stale = await writer('files.write', { ...path, content: '- [ ] two\n', expectedSha256: sha256 })
  assert.equal(stale.ok ? 'written' : stale.code, 'conflict')
  assert.equal(readFileSync(join(folder, 'list.todo'), 'utf8'), '- [x] one\n')
})
