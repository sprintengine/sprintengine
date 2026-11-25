import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import { declaredSettingsReader, withDeclaredSettings } from '../modules/extension-declared-settings'
import { approvedContext } from '../modules/extension-approvals.test-helper'
import { readSurfaceImage } from '../modules/extension-surface-entries'
import { discoverUserModules } from '../modules/user-module-registry'
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

test('a custom text editor’s save meets the save hooks, as the connection that saved, after its path is checked', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'frame-editor-save-'))
  writeFileSync(join(folder, 'list.todo'), '- [ ] one\n')
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  const workspaces = {
    get: async (id: string) => (id === 'ws' ? { id, name: 'ws', folderPath: folder, mode: 'standard' } : null),
    list: async () => [],
  }
  const asked: Array<{ path: string; relativePath: string; workspaceId: string; text: string; invoker: string }> = []
  // A format-on-save hook, and a guard that refuses a save holding "secret".
  let hooked = true
  const call = createExtensionFrameCalls({
    grantOf: () => ({ grant: ['workspace-files:read', 'workspace-files:write'], outdated: false }),
    service: (key) => (key === 'core.workspace-context' ? workspaces : undefined),
    callModuleMethod: async () => ({ ok: false, code: 'extension_unavailable', message: 'none' }) as never,
    emitNotification: () => undefined,
    appState: () => undefined,
    fileExclusions: () => [],
    editorSaveHooks: ({ invoker, ...event }) => {
      if (!hooked) return null
      asked.push({ ...event, invoker: invoker.label })
      return Promise.resolve(
        event.text.includes('secret')
          ? { ok: false as const, message: 'The extension "Guard" (acme.guard) refused this: it holds a secret.' }
          : { ok: true as const, text: event.text.toUpperCase() },
      )
    },
  })
  // A paired window that may write files.
  const WRITER: ExtensionInvoker = {
    principal: studioGrantPrincipal({
      owner: false,
      scopes: ['extensions:read', 'extensions:operate', 'files:read', 'files:write'],
    }),
    permissionCeiling: null,
    label: 'the device "dev-macbook-air"',
  }
  const write = (params: Record<string, unknown>, invoker = WRITER) =>
    call({
      moduleId: 'local.todo-editor',
      frame: 'f'.repeat(64),
      method: 'files.write',
      params: { workspaceId: 'ws', path: 'list.todo', ...params },
      clientId: 'c',
      commandId: 'k',
      invoker,
    })
  const onDisk = () => readFileSync(join(folder, 'list.todo'), 'utf8')

  // One that may not write files is refused before any hook hears of it.
  const notAllowed = await write({ content: '- [ ] two\n', save: {} }, PAIRED)
  assert.equal(notAllowed.ok ? 'written' : notAllowed.code, 'not_permitted')
  assert.equal(asked.length, 0)

  // Refused: nothing is written.
  const refused = await write({ content: '- [ ] secret\n', expectedSha256: sha('- [ ] one\n'), save: {} })
  assert.deepEqual(refused, {
    ok: false,
    code: 'refused_by_extension',
    message: 'The extension "Guard" (acme.guard) refused this: it holds a secret.',
  })
  assert.equal(onDisk(), '- [ ] one\n')
  assert.deepEqual(asked.at(-1), {
    path: join(realpathSync(folder), 'list.todo'),
    relativePath: 'list.todo',
    workspaceId: 'ws',
    text: '- [ ] secret\n',
    languageId: null,
    invoker: WRITER.label,
  })

  // Changed: what the hook made is written, and answered for the editor to take.
  const changed = await write({ content: '- [ ] two\n', expectedSha256: sha('- [ ] one\n'), save: {} })
  assert.ok(changed.ok)
  assert.equal(onDisk(), '- [ ] TWO\n')
  assert.deepEqual(changed.ok && changed.result, {
    size: 10,
    created: false,
    sha256: sha('- [ ] TWO\n'),
    text: '- [ ] TWO\n',
  })

  // The conditional write still holds after the hook: a stale base is refused.
  const stale = await write({ content: '- [ ] three\n', expectedSha256: sha('- [ ] two\n'), save: {} })
  assert.equal(stale.ok ? 'written' : stale.code, 'conflict')
  assert.equal(onDisk(), '- [ ] TWO\n')

  // A path outside the workspace is refused before any hook hears of it.
  const before = asked.length
  const outside = await write({ path: '../elsewhere.todo', content: 'x', save: {} })
  assert.equal(outside.ok, false)
  assert.equal(asked.length, before)

  // A frame's own write, and a write of bytes, are no person's save of text.
  assert.ok((await write({ content: '- [ ] four\n' })).ok)
  assert.equal(onDisk(), '- [ ] four\n')
  const bytes = Buffer.from('- [ ] five\n').toString('base64')
  assert.ok((await write({ content: bytes, encoding: 'base64', save: {} })).ok)
  assert.equal(onDisk(), '- [ ] five\n')
  assert.equal(asked.length, before)

  // With no hook on the point, a save writes what it was given.
  hooked = false
  const plain = await write({ content: '- [ ] six\n', save: { languageId: 'todo' } })
  assert.ok(plain.ok && !('text' in (plain.result as object)))
  assert.equal(onDisk(), '- [ ] six\n')
  assert.equal((await write({ content: 'x', save: 'yes' })).ok, false, 'a malformed save is refused')
})

test('a save whose extension is revoked while its hook runs writes nothing', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'frame-save-revoked-'))
  writeFileSync(join(folder, 'list.todo'), '- [ ] one\n')
  const workspaces = {
    get: async (id: string) => (id === 'ws' ? { id, name: 'ws', folderPath: folder, mode: 'standard' } : null),
    list: async () => [],
  }
  let runnable = true
  let release: () => void = () => undefined
  let hookStarted: () => void = () => undefined
  const nextHook = () => new Promise<void>((resolve) => (hookStarted = resolve))
  let started = nextHook()
  const call = createExtensionFrameCalls({
    // Null once the extension is killed, switched off or uninstalled.
    grantOf: () => (runnable ? { grant: ['workspace-files:read', 'workspace-files:write'], outdated: false } : null),
    service: (key) => (key === 'core.workspace-context' ? workspaces : undefined),
    callModuleMethod: async () => ({ ok: false, code: 'extension_unavailable', message: 'none' }) as never,
    emitNotification: () => undefined,
    appState: () => undefined,
    fileExclusions: () => [],
    // A slow hook: the extension is revoked while it runs.
    editorSaveHooks: ({ text }) => {
      hookStarted()
      return new Promise((resolve) => (release = () => resolve({ ok: true, text })))
    },
  })
  const write = (path: string) =>
    call({
      moduleId: 'local.todo-editor',
      frame: 'f'.repeat(64),
      method: 'files.write',
      params: { workspaceId: 'ws', path, content: '- [ ] two\n', save: {} },
      clientId: 'c',
      commandId: 'k',
      invoker: OWNER,
    })

  // Over a file that exists.
  const pending = write('list.todo')
  await started
  runnable = false
  release()
  const answer = await pending
  assert.equal(answer.ok ? 'written' : answer.code, 'approval_required')
  assert.equal(readFileSync(join(folder, 'list.todo'), 'utf8'), '- [ ] one\n')

  // A new file: none is left behind.
  runnable = true
  started = nextHook()
  const made = write('new.todo')
  await started
  runnable = false
  release()
  const madeAnswer = await made
  assert.equal(madeAnswer.ok, false)
  assert.equal(existsSync(join(folder, 'new.todo')), false)
})

// A components panel's `Image` asks for one of its extension's own files
// (`assets.image`): the call is answered from the extension that drew the
// frame, through the same reader the server is wired with (server-modules.ts,
// app-main.ts), as a `{ mime, data }` the window turns into a `data:` URL.
// Anything it is not, outside the folder, missing or another extension's, is
// null; a malformed path is refused.
test('a components panel’s assets.image answers its own image, and nothing else', async () => {
  const root = mkdtempSync(join(tmpdir(), 'frame-images-'))
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==',
    'base64',
  )
  const panelExtension = (id: string) => {
    const folder = writeExtensionFolder(join(root, `local.${id}`), {
      manifest: extensionManifest({
        id,
        tier: 'ui',
        main: undefined,
        contributes: { panels: [{ id: 'board', title: 'Board', entry: 'src/panel.tsx', ui: 'components' }] },
      }),
      files: { 'src/panel.tsx': 'export default function Panel() { return null }\n', 'assets/readme.txt': 'words' },
    })
    mkdirSync(join(folder, 'assets'), { recursive: true })
    writeFileSync(join(folder, 'assets', `${id}.png`), png)
    return folder
  }
  const pictures = panelExtension('pictures')
  panelExtension('neighbour')
  writeFileSync(join(root, 'outside.png'), png)
  const { modules } = await discoverUserModules(root, approvedContext({ 'local.pictures': pictures }))
  const ownImages: string[] = []
  const call = createExtensionFrameCalls({
    // A panel that declares no permission at all: its images need none.
    grantOf: () => ({ grant: [], outdated: false }),
    service: () => undefined,
    callModuleMethod: async () => ({ ok: false, code: 'extension_unavailable', message: 'none' }) as never,
    emitNotification: () => undefined,
    appState: () => undefined,
    fileExclusions: () => [],
    ownImage: (moduleId, path) => {
      ownImages.push(`${moduleId}:${path}`)
      return readSurfaceImage(
        modules.find((module) => module.key === moduleId),
        path,
      )
    },
  })
  const image = (params: unknown, invoker: ExtensionInvoker = OWNER, moduleId = 'local.pictures') =>
    call({ moduleId, frame: 'f'.repeat(64), method: 'assets.image', params, clientId: 'c', commandId: 'k', invoker })

  const drawn = await image({ path: 'assets/pictures.png' })
  assert.deepEqual(drawn, { ok: true, result: { mime: 'image/png', data: png.toString('base64') } })
  // What the window draws: the same bytes, as a data: URL.
  const result = (drawn.ok ? drawn.result : null) as { mime: string; data: string }
  assert.ok(Buffer.from(`data:${result.mime};base64,${result.data}`.split(',')[1]!, 'base64').equals(png))
  // A paired device that may use extensions sees the panel's images too.
  assert.deepEqual(await image({ path: 'assets/pictures.png' }, PAIRED), drawn)

  assert.deepEqual(await image({ path: 'assets/readme.txt' }), { ok: true, result: null }, 'not an image')
  assert.deepEqual(await image({ path: 'assets/missing.png' }), { ok: true, result: null }, 'missing')
  assert.deepEqual(await image({ path: '../outside.png' }), { ok: true, result: null }, 'outside its folder')
  assert.deepEqual(
    await image({ path: '../local.neighbour/assets/neighbour.png' }),
    { ok: true, result: null },
    'another extension’s, by a path',
  )
  // Another extension's frame asks for this one's image: it is read from its own folder, which has none.
  assert.deepEqual(await image({ path: 'assets/pictures.png' }, OWNER, 'local.neighbour'), { ok: true, result: null })

  // A path that is not one is refused before anything is read.
  const asked = ownImages.length
  for (const params of [{}, { path: '' }, { path: 42 }, { path: `${'a/'.repeat(300)}x.png` }, 'assets/pictures.png']) {
    const refused = await image(params)
    assert.equal(refused.ok ? 'answered' : refused.code, 'invalid_params', JSON.stringify(params).slice(0, 40))
  }
  assert.equal(ownImages.length, asked)

  // A connection that may not use extensions at all is not shown it.
  const stranger: ExtensionInvoker = {
    principal: studioGrantPrincipal({ owner: false, scopes: [] }),
    permissionCeiling: null,
    label: 'the device "android-phone"',
  }
  const refused = await image({ path: 'assets/pictures.png' }, stranger)
  assert.equal(refused.ok, false)
  assert.equal(ownImages.length, asked)
})
