import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, test } from 'vitest'

import {
  STUDIO_FILE_SYSTEM_METHODS,
  type StudioFileSystemMethod,
  type StudioScope,
} from '../../../packages/studio-protocol/src/public'
import { createStudioFileSystem } from '../files/studio-file-system'
import {
  connectLineClient,
  createFakeBackend,
  hello,
  OWNER_TOKEN,
  pairFakeClient,
  startTestServer,
} from './studio-rpc.test-helper'
import { studioWindowGrant } from './studio-frame-port'
import { createStudioRpcRouter } from './studio-rpc-router'

// The files on this machine by path (`file-system`, and the search, stat,
// picture and repository-root reads `chat.ts` declares) over the owner
// socket, on a real disk: what an owner does, what a paired app may name
// (never a path whose real place is outside the folders Studio knows, by `..`
// or by a link), what each grant reaches, and an owner's `ssh://` path.

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A workspace folder Studio knows, a store it reads in, and a folder outside both with a secret in it. */
function disk() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'studio-file-system-')))
  cleanups.push(() => rmSync(base, { recursive: true, force: true }))
  const workspace = join(base, 'workspace')
  const store = join(base, 'store')
  const outside = join(base, 'outside')
  for (const folder of [workspace, store, outside, join(workspace, 'sub')]) mkdirSync(folder, { recursive: true })
  writeFileSync(join(workspace, 'a.txt'), 'alpha')
  writeFileSync(join(store, 'sent.txt'), 'sent')
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  // A link inside the workspace that leads out of it.
  symlinkSync(outside, join(workspace, 'link'))
  return { base, workspace, store, outside }
}

async function serve(options: { trash?: (path: string) => Promise<void>; files?: boolean } = {}) {
  const at = disk()
  const trashed: string[] = []
  const started = await startTestServer({
    ...(options.files === false
      ? {}
      : {
          fileSystem: createStudioFileSystem({
            readableRoots: () => [at.workspace, at.store],
            writableRoots: () => [at.workspace],
            trash:
              options.trash ??
              (async (path) => {
                trashed.push(path)
                rmSync(path, { recursive: true })
              }),
          }),
        }),
  })
  cleanups.push(() => started.dispose())
  return { started, trashed, ...at }
}

async function client(path: string, token: string) {
  const line = await connectLineClient(path)
  cleanups.push(() => line.close())
  line.send(hello({ token }))
  const welcome = await line.next((frame) => frame.t === 'welcome')
  let seq = 0
  return {
    line,
    welcome,
    async request(method: string, params: unknown) {
      const id = `r${++seq}`
      line.send({ t: 'req', id, method, params })
      return line.next((frame) => frame.t === 'res' && frame.id === id)
    },
    async subscribe(topic: string, params: unknown) {
      const id = `s${++seq}`
      line.send({ t: 'sub', id, topic, params })
      return id
    },
  }
}

type Frame = { t: string; ok?: boolean; error?: { code: string }; result?: unknown }
const codeOf = (frame: Frame) => (frame.t === 'res' && !frame.ok ? (frame.error?.code ?? null) : null)
const resultOf = <T>(frame: Frame) => {
  assert.equal(codeOf(frame), null, JSON.stringify(frame))
  return frame.result as T
}

let commands = 0
const cid = () => `c${++commands}`

/** Each method with params its validator takes, inside the workspace. */
function calls(workspace: string): Record<StudioFileSystemMethod, Record<string, unknown>> {
  return {
    'files.listDirectory': { path: workspace },
    'files.readText': { path: join(workspace, 'a.txt') },
    'files.exists': { path: join(workspace, 'a.txt') },
    'files.checkWorkspaceFolder': { path: workspace },
    'files.projectLogo': { folderPath: workspace },
    'files.projectIcon': { path: join(workspace, 'a.txt') },
    'files.searchContent': { rootPath: workspace, query: '' },
    'files.cancelContentSearch': {},
    'files.defaultWorkspaceParent': {},
    'files.writeText': { commandId: cid(), path: join(workspace, 'w.txt'), text: 'w' },
    'files.saveDroppedImage': { commandId: cid(), mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=' },
    'files.createFile': { commandId: cid(), parentPath: workspace, name: 'new.txt' },
    'files.createDirectory': { commandId: cid(), parentPath: workspace, name: 'dir', existing: 'keep' },
    'files.rename': { commandId: cid(), path: join(workspace, 'a.txt'), name: 'b.txt' },
    'files.copy': {
      commandId: cid(),
      path: join(workspace, 'b.txt'),
      toFolder: join(workspace, 'sub'),
      onConflict: 'rename',
    },
    'files.move': { commandId: cid(), path: join(workspace, 'new.txt'), toFolder: join(workspace, 'sub') },
    'files.trash': { commandId: cid(), path: join(workspace, 'w.txt') },
  }
}

const WRITES = new Set(
  Object.entries(STUDIO_FILE_SYSTEM_METHODS)
    .filter(([, spec]) => spec.mutation)
    .map(([m]) => m),
)

test('every method of the family has a call here, and none is an owner’s alone', () => {
  assert.deepEqual(Object.keys(calls('/w')).sort(), Object.keys(STUDIO_FILE_SYSTEM_METHODS).sort())
  for (const [method, spec] of Object.entries(STUDIO_FILE_SYSTEM_METHODS))
    assert.deepEqual(
      [method, spec.owner, spec.scope],
      [method, undefined, spec.mutation ? 'files:write' : 'files:read'],
    )
})

test('a Studio advertises its files by path only where its core gives them', async () => {
  const without = await serve({ files: false })
  const owner = await client(without.started.path, OWNER_TOKEN)
  const caps = (welcome: Frame) => (welcome as unknown as { capabilities: string[] }).capabilities
  assert.equal(caps(owner.welcome).includes('file-system'), false)
  assert.equal(caps(owner.welcome).includes('files-mention'), false)
  assert.equal(codeOf(await owner.request('files.exists', { path: '/' })), 'unavailable')
  const served = await serve()
  const window = await client(served.started.path, OWNER_TOKEN)
  assert.equal(caps(window.welcome).includes('file-system'), true)
  // The search, stat and picture reads are the core's now, with no chat surface beside it.
  assert.equal(caps(window.welcome).includes('files-mention'), true)
  assert.equal(codeOf(await window.request('files.stat', { path: served.workspace })), null)
})

test('an owner reads, writes, renames, copies, moves and trashes on this disk', async () => {
  const { started, workspace, outside, trashed } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  for (const [method, params] of Object.entries(calls(workspace)))
    assert.deepEqual([method, codeOf(await owner.request(method, params))], [method, null])
  assert.equal(readFileSync(join(workspace, 'sub', 'b copy.txt'), 'utf8'), 'alpha')
  assert.equal(existsSync(join(workspace, 'sub', 'new.txt')), true)
  assert.deepEqual(trashed, [join(workspace, 'w.txt')])
  // An owner names any path on this disk, outside the workspace too.
  assert.deepEqual(resultOf(await owner.request('files.readText', { path: join(outside, 'secret.txt') })), {
    text: 'secret',
  })
  // A taken name is refused, and a copy that may overwrite does.
  writeFileSync(join(workspace, 'c.txt'), 'c')
  const into = { path: join(workspace, 'c.txt'), toFolder: join(workspace, 'sub') }
  assert.equal(codeOf(await owner.request('files.copy', { ...into, onConflict: 'fail', commandId: cid() })), null)
  assert.equal(
    codeOf(await owner.request('files.copy', { ...into, onConflict: 'fail', commandId: cid() })),
    'unavailable',
  )
  writeFileSync(join(workspace, 'c.txt'), 'c2')
  assert.equal(codeOf(await owner.request('files.copy', { ...into, onConflict: 'overwrite', commandId: cid() })), null)
  assert.equal(readFileSync(join(workspace, 'sub', 'c.txt'), 'utf8'), 'c2')
  // A name is one name, never a path.
  const climbing = { commandId: cid(), parentPath: workspace, name: '../escape.txt' }
  assert.equal(codeOf(await owner.request('files.createFile', climbing)), 'invalid_params')
})

test('a retried write is answered with its first outcome, not carried out again', async () => {
  const { started, workspace } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  const create = { commandId: 'once', parentPath: workspace, name: 'once.txt' }
  const first = resultOf<{ path: string }>(await owner.request('files.createFile', create))
  const again = resultOf<{ path: string }>(await owner.request('files.createFile', create))
  assert.deepEqual(again, first)
})

test('a paired app names only what is really inside the folders Studio knows, by `..` or by a link', async () => {
  const { started, workspace, store, outside, trashed } = await serve()
  const scopes: StudioScope[] = ['files:read', 'files:write']
  const app = await client(started.path, pairFakeClient(started.auth, 'app', scopes))
  // Inside: answered.
  assert.deepEqual(resultOf(await app.request('files.readText', { path: join(workspace, 'a.txt') })), { text: 'alpha' })
  assert.deepEqual(resultOf(await app.request('files.readText', { path: join(store, 'sent.txt') })), { text: 'sent' })
  const secret = join(outside, 'secret.txt')
  const climbs = `${workspace}/../outside/secret.txt`
  const linked = join(workspace, 'link', 'secret.txt')
  for (const path of [secret, climbs, linked, `${workspace}/sub/../../outside/secret.txt`]) {
    for (const method of ['files.readText', 'files.stat', 'files.checkWorkspaceFolder'])
      assert.deepEqual([method, path, codeOf(await app.request(method, { path }))], [method, path, 'not_found'])
    assert.deepEqual(resultOf(await app.request('files.exists', { path })), { exists: false })
  }
  for (const path of [outside, join(workspace, 'link'), `${workspace}/../outside`])
    assert.equal(codeOf(await app.request('files.listDirectory', { path })), 'not_found')
  assert.equal(codeOf(await app.request('files.search', { rootPath: outside, query: 'secret' })), 'not_found')
  assert.equal(
    codeOf(await app.request('files.searchContent', { rootPath: join(workspace, 'link'), query: 's' })),
    'not_found',
  )
  assert.deepEqual(resultOf(await app.request('files.projectLogo', { folderPath: outside })), { logo: null })

  // Writes: only inside the workspace's own folder, never through a link out of it.
  const refusedWrites: Array<[string, Record<string, unknown>]> = [
    ['files.writeText', { path: join(workspace, 'link', 'planted.txt'), text: 'x' }],
    ['files.writeText', { path: `${workspace}/../outside/planted.txt`, text: 'x' }],
    ['files.writeText', { path: join(store, 'planted.txt'), text: 'x' }],
    ['files.createFile', { parentPath: join(workspace, 'link'), name: 'planted.txt' }],
    ['files.createDirectory', { parentPath: outside, name: 'planted' }],
    ['files.rename', { path: secret, name: 'gone.txt' }],
    ['files.move', { path: join(workspace, 'a.txt'), toFolder: join(workspace, 'link') }],
    ['files.copy', { path: secret, toFolder: workspace, onConflict: 'rename' }],
    ['files.copy', { path: join(workspace, 'a.txt'), toFolder: outside, onConflict: 'rename' }],
    ['files.trash', { path: linked }],
    // The workspace's own folder is not renamed, moved or trashed by an app.
    ['files.rename', { path: workspace, name: 'renamed' }],
    ['files.trash', { path: workspace }],
    ['files.move', { path: workspace, toFolder: store }],
  ]
  for (const [method, params] of refusedWrites)
    assert.deepEqual(
      [method, params, codeOf(await app.request(method, { ...params, commandId: cid() }))],
      [method, params, 'not_found'],
    )
  assert.equal(existsSync(join(outside, 'planted.txt')), false)
  assert.equal(existsSync(join(store, 'planted.txt')), false)
  assert.equal(readFileSync(secret, 'utf8'), 'secret')
  assert.deepEqual(trashed, [])

  // Inside, it writes, and a copy from Studio's stores into the workspace is fine.
  assert.equal(
    codeOf(await app.request('files.writeText', { path: join(workspace, 'ok.txt'), text: 'ok', commandId: cid() })),
    null,
  )
  assert.equal(
    codeOf(
      await app.request('files.copy', {
        path: join(store, 'sent.txt'),
        toFolder: workspace,
        onConflict: 'fail',
        commandId: cid(),
      }),
    ),
    null,
  )
  assert.equal(readFileSync(join(workspace, 'ok.txt'), 'utf8'), 'ok')

  // A folder outside is not watched.
  const watched = await app.subscribe('files.watchPath', { path: join(workspace, 'link') })
  const failed = await app.line.next((frame) => frame.t === 'subFailed' && frame.sub === watched)
  assert.equal(failed.t === 'subFailed' && failed.code, 'not_found')
  // Nor is a path on an SSH machine named.
  assert.equal(codeOf(await app.request('files.readText', { path: 'ssh://build-box/etc/hosts' })), 'not_found')
})

test('each grant reaches what its scopes name, and nothing more', async () => {
  const { started, workspace } = await serve()
  const reader = await client(started.path, pairFakeClient(started.auth, 'reader', ['files:read']))
  const chats = await client(started.path, pairFakeClient(started.auth, 'chats', ['conversation:read']))
  for (const [method, params] of Object.entries(calls(workspace))) {
    assert.deepEqual(
      [method, codeOf(await reader.request(method, params))].map((v) => (v === 'not_found' ? null : v)),
      [method, WRITES.has(method) ? 'scope_required' : null],
    )
    assert.deepEqual([method, codeOf(await chats.request(method, params))], [method, 'scope_required'])
  }
  const id = await chats.subscribe('files.watchPath', { path: workspace })
  const failed = await chats.line.next((frame) => frame.t === 'subFailed' && frame.sub === id)
  assert.equal(failed.t === 'subFailed' && failed.code, 'scope_required')
})

test('an owner hears what changes in a folder it watches', async () => {
  const { started, workspace } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  const id = await owner.subscribe('files.watchPath', { path: workspace })
  await new Promise((resolve) => setTimeout(resolve, 150))
  writeFileSync(join(workspace, 'fresh.txt'), 'fresh')
  const pushed = await owner.line.next((frame) => frame.t === 'push' && frame.sub === id, 5_000)
  assert.equal(pushed.t, 'push')
  const missing = await owner.subscribe('files.watchPath', { path: join(workspace, 'nowhere') })
  const failed = await owner.line.next((frame) => frame.t === 'subFailed' && frame.sub === missing)
  assert.equal(failed.t === 'subFailed', true)
})

test('an owner’s path on an SSH machine is refused in words, never read on this disk', async () => {
  const { started, workspace } = await serve()
  const owner = await client(started.path, OWNER_TOKEN)
  // That machine's own Studio answers for it: the window asks it there. The
  // same plain path here (this workspace) is never what answers.
  const app = `ssh://build-box${workspace}`
  for (const [method, params] of [
    ['files.listDirectory', { path: app }],
    ['files.readText', { path: `${app}/a.txt` }],
    ['files.stat', { path: app }],
    ['files.search', { rootPath: app, query: 'a' }],
    ['files.repoRoot', { folderPath: app }],
    ['files.createFile', { commandId: cid(), parentPath: app, name: 'x' }],
  ] as const) {
    const frame = await owner.request(method, params)
    assert.deepEqual([method, codeOf(frame)], [method, 'unavailable'])
    assert.match(frame.t === 'res' && !frame.ok ? (frame.error?.message ?? '') : '', /SSH machine/)
  }
  assert.deepEqual(resultOf(await owner.request('files.exists', { path: app })), { exists: false })
  const watched = await owner.subscribe('files.watchPath', { path: app })
  const failed = await owner.line.next((frame) => frame.t === 'subFailed' && frame.sub === watched)
  assert.equal(failed.t === 'subFailed' && failed.code, 'unavailable')
})

test('a paired app’s ~/ path is the file in the home folder, held to the same folders', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'studio-file-system-home-')))
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  cleanups.push(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  })
  mkdirSync(join(home, 'Desktop'))
  writeFileSync(join(home, 'Desktop', 'shot.png'), Buffer.from('iVBORw0KGgo=', 'base64'))
  writeFileSync(join(home, 'elsewhere.png'), Buffer.from('iVBORw0KGgo=', 'base64'))
  const started = await startTestServer({
    fileSystem: createStudioFileSystem({ readableRoots: () => [join(home, 'Desktop')], writableRoots: () => [] }),
  })
  cleanups.push(() => started.dispose())
  const app = await client(started.path, pairFakeClient(started.auth, 'app', ['files:read']))
  const read = resultOf<{ dataUrl: string }>(await app.request('files.readImage', { path: '~/Desktop/shot.png' }))
  assert.match(read.dataUrl, /^data:image\/png;base64,/)
  assert.equal(codeOf(await app.request('files.readImage', { path: '~/Desktop/../Desktop/shot.png' })), 'not_found')
  assert.equal(codeOf(await app.request('files.readImage', { path: '~/elsewhere.png' })), 'not_found')
})

test('an owner’s connection held to known folders (a tailnet one) names only them; Studio’s own window names any', async () => {
  const at = disk()
  const router = createStudioRpcRouter({
    backend: createFakeBackend(),
    info: () => ({}) as never,
    fileSystem: createStudioFileSystem({ readableRoots: () => [at.workspace], writableRoots: () => [at.workspace] }),
  })
  cleanups.push(() => router.close())
  const grant = studioWindowGrant()
  const tailnet = { connectionId: 't', slot: 1, ownWindow: false, knownFoldersOnly: true }
  const window = { connectionId: 'w', slot: 2, ownWindow: true }
  const ask = (method: string, params: unknown, context: typeof window) =>
    router.handle(grant, method as never, params as never, context)
  const code = (answer: { ok: boolean; error?: { code: string } }) => (answer.ok ? null : answer.error!.code)
  const secret = join(at.outside, 'secret.txt')
  for (const [method, params] of [
    ['files.readText', { path: secret }],
    ['files.stat', { path: secret }],
    ['files.readImage', { path: secret }],
    ['files.search', { rootPath: at.outside, query: 'a' }],
    ['files.repoRoot', { folderPath: at.outside }],
  ] as const) {
    assert.deepEqual([method, code(await ask(method, params, tailnet))], [method, 'not_found'])
    assert.notEqual(code(await ask(method, params, window)), 'not_found', method)
  }
  assert.equal(code(await ask('files.readText', { path: join(at.workspace, 'a.txt') }, tailnet)), null)
  assert.equal(code(await ask('files.repoRoot', { folderPath: at.workspace }, tailnet)), null)
})

test('a closed connection’s searches end, in a slot clear of any window’s', async () => {
  const at = disk()
  const real = createStudioFileSystem({ readableRoots: () => [at.workspace], writableRoots: () => [at.workspace] })
  const slots = { searched: [] as number[], released: [] as number[] }
  const started = await startTestServer({
    fileSystem: {
      ...real,
      searchFiles: async (slot, input) => {
        slots.searched.push(slot)
        return real.searchFiles(slot, input)
      },
      releaseSlot: (slot) => {
        slots.released.push(slot)
        real.releaseSlot(slot)
      },
    },
  })
  cleanups.push(() => started.dispose())
  const owner = await client(started.path, OWNER_TOKEN)
  assert.equal(codeOf(await owner.request('files.search', { rootPath: at.workspace, query: 'a' })), null)
  owner.line.close()
  for (let tries = 0; slots.released.length === 0 && tries < 50; tries++)
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(slots.released, slots.searched)
  assert.ok(slots.searched[0]! >= 1_000_000_000, 'its slot is clear of any window’s webContents id')
})
