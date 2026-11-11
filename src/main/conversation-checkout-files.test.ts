import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { CONVERSATION_MAX_CHECKOUT_FILE_BYTES } from '../../packages/conversation-protocol/src/public'
import type { FileWatchEvent } from '../shared/ipc/filesystem'
import { createConversationCheckoutFiles } from './conversation-checkout-files'
import type { WatchHub } from './workspace-watch-hub'

// A paired device reading and changing a chat's files in a real folder: what
// the Files tab here shows, and nothing outside the chat's folder.

const chat = { workspaceId: 'ws', agentId: 'chat' }
const made: string[] = []

function folders(): { root: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), 'checkout-files-'))
  const outside = mkdtempSync(join(tmpdir(), 'checkout-files-outside-'))
  made.push(root, outside)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'dist'))
  writeFileSync(join(root, '.gitignore'), 'dist/\n')
  writeFileSync(join(root, 'src', 'app.ts'), 'export const app = 1\n')
  writeFileSync(join(outside, 'secret.txt'), 'not for a paired device\n')
  mkdirSync(join(outside, 'folder'))
  return { root, outside }
}

afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

test('a folder lists its entries, dims what git ignores, and names the chat’s folder', async () => {
  const { root, outside } = folders()
  symlinkSync(join(root, 'src'), join(root, 'src-link'))
  symlinkSync(join(outside, 'folder'), join(root, 'away'))
  const files = createConversationCheckoutFiles({ checkoutOf: () => root })
  const listed = await files.list(chat, '')
  assert.ok(listed.ok)
  const byName = Object.fromEntries(listed.entries.map((entry) => [entry.name, entry]))
  assert.deepEqual(byName.src, { name: 'src', kind: 'folder' })
  assert.deepEqual(byName.dist, { name: 'dist', kind: 'folder', ignored: true })
  assert.deepEqual(byName['.gitignore'], { name: '.gitignore', kind: 'file' })
  // A link inside the folder is what it points at; one leading out is a file that cannot open.
  assert.equal(byName['src-link']?.kind, 'folder')
  assert.equal(byName.away?.kind, 'file')
  assert.equal(listed.root.name, root.split('/').pop())
  assert.equal(listed.truncated, false)
  const nested = await files.list(chat, 'src')
  assert.ok(nested.ok)
  assert.deepEqual(nested.entries, [{ name: 'app.ts', kind: 'file' }])
  // Nothing outside is listed, through a link or otherwise.
  const away = await files.list(chat, 'away')
  assert.equal(away.ok, false)
  const none = createConversationCheckoutFiles({ checkoutOf: () => null })
  assert.equal((await none.list(chat, '')).ok, false)
})

test('a file reads as its text, too large, or not text, and never through a link out', async () => {
  const { root, outside } = folders()
  writeFileSync(join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]))
  writeFileSync(join(root, 'huge.log'), Buffer.alloc(CONVERSATION_MAX_CHECKOUT_FILE_BYTES + 1, 0x61))
  symlinkSync(join(outside, 'secret.txt'), join(root, 'secret-link'))
  symlinkSync(outside, join(root, 'out'))
  const files = createConversationCheckoutFiles({ checkoutOf: () => root })
  assert.deepEqual(await files.read(chat, 'src/app.ts'), { ok: true, kind: 'text', content: 'export const app = 1\n' })
  assert.deepEqual(await files.read(chat, 'image.png'), { ok: true, kind: 'binary' })
  assert.deepEqual(await files.read(chat, 'huge.log'), {
    ok: true,
    kind: 'too-large',
    size: CONVERSATION_MAX_CHECKOUT_FILE_BYTES + 1,
  })
  const viaLink = await files.read(chat, 'secret-link')
  assert.equal(viaLink.ok, false)
  const viaFolder = await files.read(chat, 'out/secret.txt')
  assert.equal(viaFolder.ok, false)
  assert.equal((await files.read(chat, 'src')).ok, false)
})

test('the Files tab’s changes are made in the chat’s folder, and none outside it', async () => {
  const { root, outside } = folders()
  symlinkSync(outside, join(root, 'out'))
  const trashed: string[] = []
  const files = createConversationCheckoutFiles({
    checkoutOf: () => root,
    trashItem: async (path) => {
      trashed.push(path)
      rmSync(path, { recursive: true, force: true })
    },
  })
  assert.deepEqual(await files.change(chat, { kind: 'write', path: 'src/app.ts', content: 'saved\n' }), {
    ok: true,
    path: 'src/app.ts',
  })
  assert.equal(readFileSync(join(root, 'src', 'app.ts'), 'utf8'), 'saved\n')
  assert.deepEqual(await files.change(chat, { kind: 'createFile', path: 'src/new.ts' }), {
    ok: true,
    path: 'src/new.ts',
  })
  assert.equal((await files.change(chat, { kind: 'createFile', path: 'src/new.ts' })).ok, false)
  assert.deepEqual(await files.change(chat, { kind: 'createFolder', path: 'lib' }), { ok: true, path: 'lib' })
  assert.deepEqual(await files.change(chat, { kind: 'rename', path: 'src/new.ts', to: 'lib/new.ts' }), {
    ok: true,
    path: 'lib/new.ts',
  })
  assert.ok(existsSync(join(root, 'lib', 'new.ts')))
  const taken = await files.change(chat, { kind: 'rename', path: 'lib/new.ts', to: 'src/app.ts' })
  assert.equal(taken.ok, false)
  assert.equal((await files.change(chat, { kind: 'rename', path: 'lib', to: 'lib/inner' })).ok, false)
  assert.deepEqual(await files.change(chat, { kind: 'delete', path: 'lib' }), { ok: true, path: '' })
  assert.equal(trashed.length, 1)
  assert.ok(!existsSync(join(root, 'lib')))
  // Through a link out of the folder, nothing is written, made, moved or deleted.
  assert.equal((await files.change(chat, { kind: 'write', path: 'out/secret.txt', content: 'x' })).ok, false)
  assert.equal((await files.change(chat, { kind: 'createFile', path: 'out/planted.ts' })).ok, false)
  assert.equal((await files.change(chat, { kind: 'rename', path: 'src/app.ts', to: 'out/app.ts' })).ok, false)
  assert.equal((await files.change(chat, { kind: 'delete', path: 'out/secret.txt' })).ok, false)
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'not for a paired device\n')
  assert.ok(!existsSync(join(outside, 'planted.ts')))
})

test('a delete on a machine with no Trash is refused in words, and nothing is deleted', async () => {
  const { root } = folders()
  const files = createConversationCheckoutFiles({ checkoutOf: () => root })
  const refused = await files.change(chat, { kind: 'delete', path: 'src/app.ts' })
  assert.equal(refused.ok, false)
  assert.match(refused.ok ? '' : refused.message, /no Trash/)
  assert.ok(existsSync(join(root, 'src', 'app.ts')))
})

test('a watch is one per folder, batched, and stops with its last listener', async () => {
  const { root } = folders()
  const listeners: Array<(event: FileWatchEvent) => void> = []
  let closed = 0
  const hub: WatchHub = {
    subscribe: (_root, listener) => {
      listeners.push(listener)
      return { close: () => void (closed += 1) }
    },
    watcherCount: () => listeners.length - closed,
  }
  const pending: Array<() => void> = []
  const files = createConversationCheckoutFiles({
    checkoutOf: () => root,
    watchHub: hub,
    timers: {
      setTimeout: (run) => {
        pending.push(run)
        return pending.length
      },
      clearTimeout: () => {},
    },
  })
  const told: Array<string[] | null> = []
  const other: Array<string[] | null> = []
  const stop = files.watch(chat, (paths) => told.push(paths))
  const stopOther = files.watch(chat, (paths) => other.push(paths))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(listeners.length, 1)
  listeners[0]!({ eventType: 'change', path: 'src/app.ts', paths: ['src/app.ts'] })
  listeners[0]!({ eventType: 'rename', path: 'src/new.ts', paths: ['src/new.ts', 'src/app.ts'] })
  assert.equal(pending.length, 1)
  pending.shift()!()
  assert.deepEqual(told, [['src/app.ts', 'src/new.ts']])
  assert.deepEqual(other, told)
  listeners[0]!({ eventType: 'rename', path: null, overflow: true })
  pending.shift()!()
  assert.deepEqual(told.at(-1), null)
  stop()
  assert.equal(closed, 0)
  stopOther()
  assert.equal(closed, 1)
})
