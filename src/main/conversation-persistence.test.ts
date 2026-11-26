import { testChatDatabase } from '../../tests/studio-database'
import { test, expect, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, open, rm, rename, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  readConversationStorage,
  writeConversationStorage,
  openConversationAppendFile,
  removeConversationStorage,
  MAX_CONVERSATION_TRANSCRIPT_BYTES,
} from './conversation-persistence'
import { ToolDetailStore } from './conversation-tool-details'
import { createChatLogs } from '../server/db/chat-logs'
import { ConversationRuntime } from './conversation-runtime'
import { ConversationIndex } from './conversation-index'
import { workspaceStorePath } from './workspace-store'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'conversation-storage-'))
  const root = join(parent, 'workspace'),
    outside = join(parent, 'outside')
  await mkdir(root)
  await mkdir(outside)
  return { root, outside, cleanup: () => rm(parent, { recursive: true, force: true }) }
}

test('selected root aliases remain usable without accepting descendant links', async () => {
  const f = await fixture()
  const alias = join(f.outside, 'selected-workspace')
  try {
    await symlink(f.root, alias, 'dir')
    const path = join(alias, 'nested/file.json')
    await writeConversationStorage(alias, path, 'safe')
    expect((await readConversationStorage(alias, path, 1024)).toString()).toBe('safe')
    await expect(readConversationStorage(alias, join(f.outside, 'private.json'), 1024)).rejects.toThrow('outside')
  } finally {
    await f.cleanup()
  }
})

test('parent replacement during exclusive open never writes content or cleans up an unowned outside path', async () => {
  const f = await fixture()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const parent = join(f.root, 'storage')
  await mkdir(parent)
  try {
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      await rename(parent, `${parent}-saved`)
      await symlink(f.outside, parent, 'dir')
      return actual.open(...args)
    })
    await expect(writeConversationStorage(f.root, join(parent, 'detail.json'), 'private contents')).rejects.toThrow(
      'real directory',
    )
    // Node cannot anchor creation with openat: a racing create can leave an
    // empty temporary file, but verification prevents writing any contents.
    const created = await readdir(f.outside)
    expect(created).toHaveLength(1)
    expect((await stat(join(f.outside, created[0]))).size).toBe(0)
  } finally {
    vi.mocked(open).mockReset().mockImplementation(actual.open)
    await f.cleanup()
  }
})

test('bounded descriptor reads and atomic updates keep regular conversation files usable', async () => {
  const f = await fixture()
  try {
    const path = join(f.root, '.sprintengine/conversations/workspace/handoffs/agent-1.md')
    await writeConversationStorage(f.root, path, 'first')
    await writeConversationStorage(f.root, path, 'second')
    expect((await readConversationStorage(f.root, path, 1024)).toString('utf8')).toBe('second')
    await expect(readConversationStorage(f.root, path, 1)).rejects.toThrow('limit')
    await removeConversationStorage(f.root, path)
    await expect(readConversationStorage(f.root, path, 1024)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await f.cleanup()
  }
})

test('a detail file from before the database that is a link is never imported, nor what it points at changed', async () => {
  const f = await fixture()
  try {
    const secret = join(f.outside, 'secret.json')
    await writeFile(secret, JSON.stringify({ secret: 'outside sentinel' }))
    const folder = join(f.root, '.sprintengine/conversations/workspace/agent.tools')
    await mkdir(folder, { recursive: true })
    const runtime = new ConversationRuntime({
    database: testChatDatabase(), adapters: [] })
    for (const [name, create] of [
      ['symbolic', symlink],
      ['hard', link],
    ] as const) {
      const path = join(folder, `${name}.json`)
      await create(secret, path)
      expect(
        await runtime.getToolDetail({
          workspaceRoot: f.root,
          workspaceId: 'workspace',
          agentId: 'agent',
          toolUseId: name,
        }),
      ).toMatchObject({ ok: false })
      expect(await readFile(secret, 'utf8')).toContain('outside sentinel')
    }
    await runtime.shutdown()
  } finally {
    await f.cleanup()
  }
})

test('sidecar ancestor symlinks refuse reads, writes, append and deletion without outside changes', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.outside, 'target.json'), 'outside sentinel')
    await symlink(f.outside, join(f.root, '.sprintengine'))
    const path = join(f.root, '.sprintengine/target.json')
    await expect(readConversationStorage(f.root, path, 1024)).rejects.toThrow('Symbolic links')
    await expect(writeConversationStorage(f.root, path, 'replacement')).rejects.toThrow('real directory')
    await expect(openConversationAppendFile(f.root, path)).rejects.toThrow('real directory')
    await expect(removeConversationStorage(f.root, path)).rejects.toThrow('real directory')
    expect(await readFile(join(f.outside, 'target.json'), 'utf8')).toBe('outside sentinel')
  } finally {
    await f.cleanup()
  }
})

test('exclusive creation refuses an existing file and append refuses external links', async () => {
  const f = await fixture()
  try {
    const target = join(f.root, 'owned.jsonl'),
      secret = join(f.outside, 'secret.jsonl')
    await writeFile(target, 'owned')
    await writeFile(secret, 'outside')
    await expect(openConversationAppendFile(f.root, target, true)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(target, 'utf8')).toBe('owned')
    await symlink(secret, join(f.root, 'linked.jsonl'))
    await expect(openConversationAppendFile(f.root, join(f.root, 'linked.jsonl'))).rejects.toThrow()
    expect(await readFile(secret, 'utf8')).toBe('outside')
  } finally {
    await f.cleanup()
  }
})

test('oversized detail files fail before allocating their contents and oversized transcripts still open', async () => {
  const f = await fixture()
  try {
    const folder = workspaceStorePath(f.root, 'conversations', 'workspace')
    await mkdir(join(folder, 'agent.tools'), { recursive: true })
    for (const [path, size] of [
      [join(folder, 'agent.tools/large.json'), 6 * 1024 * 1024],
      [join(folder, 'agent.jsonl'), MAX_CONVERSATION_TRANSCRIPT_BYTES + 1],
    ] as const) {
      const file = await open(path, 'wx')
      await file.truncate(size)
      await file.close()
    }
    const database = testChatDatabase()
    expect(await new ToolDetailStore(database).read(f.root, join(folder, 'agent.tools/large.json'))).toMatchObject({
      ok: false,
    })
    const runtime = new ConversationRuntime({
    database: testChatDatabase(), adapters: [] })
    // A transcript past the old whole-file limit still opens: its end is read,
    // and a file with no complete line has no events yet.
    expect(
      await runtime.readTranscript({ workspaceRoot: f.root, workspaceId: 'workspace', agentId: 'agent' }),
    ).toMatchObject({ ok: true, events: [] })
    expect(
      await new ConversationIndex(database, createChatLogs({ database })).list({
        workspaceRoot: f.root,
        workspaceId: 'workspace',
      }),
    ).toEqual([])
    await runtime.shutdown()
  } finally {
    await f.cleanup()
  }
})
