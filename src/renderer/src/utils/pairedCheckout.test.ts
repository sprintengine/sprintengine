// @vitest-environment jsdom
import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'

import type { FileWatchEvent } from '../../../shared/ipc/filesystem'
import type { MeshConversationFrame } from '../../../shared/tailnet-mesh'
import { checkoutFs } from './checkoutFs'
import {
  isPairedCheckoutPath,
  pairedCheckoutOf,
  pairedCheckoutPath,
  pairedCheckoutRoot,
  parsePairedCheckoutPath,
} from './pairedCheckout'

// A paired chat's folder as the Files tab and editor here read and change it:
// a root no folder of this disk can have, and every call by such a path asked
// of the machine over the chat's follow, never of this disk.

const key = { connectionId: 'connection-1', workspaceId: 'far-workspace', agentId: 'agent-1' }
const root = pairedCheckoutRoot(key)

function stubApi() {
  const session: Array<(frame: MeshConversationFrame) => void> = []
  const asked: string[] = []
  const api = {
    onMeshConversationSession: vi.fn((_input: unknown, cb: (frame: MeshConversationFrame) => void) => {
      session.push(cb)
      return () => {}
    }),
    meshConversationWatchCheckoutFiles: vi.fn(async (input: { watching: boolean }) => {
      asked.push(`watch:${input.watching}`)
      return { ok: true as const }
    }),
    meshConversationCheckoutFolder: vi.fn(async (input: { path: string }) => {
      asked.push(`list:${input.path}`)
      return {
        ok: true as const,
        root: { name: 'app', path: '/Users/dev/app' },
        entries: [
          { name: 'src', kind: 'folder' as const },
          { name: 'dist', kind: 'folder' as const, ignored: true as const },
          { name: 'a.ts', kind: 'file' as const },
        ],
        truncated: false,
      }
    }),
    meshConversationCheckoutFile: vi.fn(async (input: { path: string }) => {
      asked.push(`read:${input.path}`)
      return input.path === 'logo.png'
        ? { ok: true as const, file: { kind: 'binary' as const } }
        : { ok: true as const, file: { kind: 'text' as const, content: 'a\n' } }
    }),
    meshConversationChangeCheckoutFile: vi.fn(
      async (input: { change: { kind: string; path: string; to?: string } }) => {
        asked.push(`change:${input.change.kind}:${input.change.path}${input.change.to ? `>${input.change.to}` : ''}`)
        return { ok: true as const, path: input.change.kind === 'delete' ? '' : (input.change.to ?? input.change.path) }
      },
    ),
    readdir: vi.fn(async () => [{ name: 'here.ts', isDir: false }]),
    readfile: vi.fn(async () => 'on this disk'),
  }
  ;(window as unknown as { api: typeof api }).api = api
  return { api, asked, session }
}

afterEach(() => {
  vi.restoreAllMocks()
})

test('a paired root names the chat and no folder of this disk, and reads back', () => {
  assert.equal(root, 'paired:connection-1/far-workspace/agent-1')
  assert.ok(isPairedCheckoutPath(root))
  assert.ok(!isPairedCheckoutPath('/Users/dev/app'))
  assert.deepEqual(parsePairedCheckoutPath(pairedCheckoutPath(root, 'src/a.ts')), { key, root, relative: 'src/a.ts' })
  assert.deepEqual(parsePairedCheckoutPath(root), { key, root, relative: '' })
  assert.equal(parsePairedCheckoutPath('paired:only-one'), null)
  assert.deepEqual(
    pairedCheckoutOf({
      remoteOrigin: {
        connectionId: 'connection-1',
        machineName: 'mac-mini',
        workspaceId: 'far-workspace',
        workspaceName: 'app',
        workspaceRoot: '/Users/dev/app',
        sessionId: 'conversation:far-workspace:agent-1',
      },
    }),
    { key, root, machineName: 'mac-mini' },
  )
  // A row from before the chat's id was kept names no chat to read.
  assert.equal(
    pairedCheckoutOf({
      remoteOrigin: {
        connectionId: 'c',
        machineName: 'mac-mini',
        workspaceId: 'w',
        workspaceName: '',
        workspaceRoot: null,
      },
    }),
    null,
  )
  assert.equal(pairedCheckoutOf({ remoteOrigin: null }), null)
})

test('a paired path is asked of its machine, and every other path of this disk', async () => {
  const { api, asked } = stubApi()
  assert.deepEqual(await checkoutFs.readdir(root), [
    { name: 'src', isDir: true },
    { name: 'dist', isDir: true, ignored: true },
    { name: 'a.ts', isDir: false },
  ])
  assert.equal(await checkoutFs.readfile(`${root}/src/a.ts`), 'a\n')
  await assert.rejects(checkoutFs.readfile(`${root}/logo.png`), /not text/u)
  assert.deepEqual(await checkoutFs.readdir('/Users/dev/app'), [{ name: 'here.ts', isDir: false }])
  assert.equal(await checkoutFs.readfile('/Users/dev/app/here.ts'), 'on this disk')
  assert.deepEqual(asked, ['list:', 'read:src/a.ts', 'read:logo.png'])
  assert.equal(api.readdir.mock.calls.length, 1)
})

test('the Files tab’s changes go to the machine as paths relative to the chat’s folder', async () => {
  const { asked } = stubApi()
  assert.equal(await checkoutFs.createFile(`${root}/src`, 'b.ts'), `${root}/src/b.ts`)
  assert.equal(await checkoutFs.createDir(root, 'lib'), `${root}/lib`)
  assert.equal(await checkoutFs.renamePath(`${root}/src/b.ts`, 'c.ts'), `${root}/src/c.ts`)
  assert.equal(await checkoutFs.movePath(`${root}/src/c.ts`, `${root}/lib`), `${root}/lib/c.ts`)
  await checkoutFs.writefile(`${root}/lib/c.ts`, 'saved\n')
  await checkoutFs.deletePath(`${root}/lib`)
  assert.deepEqual(asked, [
    'change:createFile:src/b.ts',
    'change:createFolder:lib',
    'change:rename:src/b.ts>src/c.ts',
    'change:rename:src/c.ts>lib/c.ts',
    'change:write:lib/c.ts',
    'change:delete:lib',
  ])
  // A move between two chats' folders is not a move inside either.
  const other = pairedCheckoutRoot({ ...key, agentId: 'agent-2' })
  await assert.rejects(checkoutFs.movePath(`${root}/a.ts`, other), /within one chat’s folder/u)
})

test('a watch hears what moved under the folder it is on, relative to it, and lets go', async () => {
  const { asked, session } = stubApi()
  const heard: FileWatchEvent[] = []
  // A chat of its own: a follow outlives its last reader for a moment.
  const watched = pairedCheckoutRoot({ ...key, agentId: 'agent-watched' })
  const stop = await checkoutFs.watchPath(`${watched}/src`, (event) => heard.push(event))
  assert.deepEqual(asked, ['watch:true'])
  for (const cb of session) cb({ type: 'checkoutFiles', paths: ['src/a.ts', 'docs/b.md'] })
  for (const cb of session) cb({ type: 'checkoutFiles', paths: ['docs/c.md'] })
  for (const cb of session) cb({ type: 'checkoutFiles', paths: null })
  assert.deepEqual(heard, [
    { eventType: 'rename', path: 'a.ts', paths: ['a.ts'] },
    { eventType: 'rename', path: null, paths: [], overflow: true },
  ])
  await stop()
  assert.deepEqual(asked, ['watch:true', 'watch:false'])
})
