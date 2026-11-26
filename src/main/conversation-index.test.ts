import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link } from 'node:fs/promises'
import { workspaceStorePath } from './workspace-store'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ConversationIndex, conversationIndexTranscriptPath, firstMessageTitle } from './conversation-index'
import type { ConversationEvent } from '../shared/conversation-runtime'
import { testChatDatabase } from '../../tests/studio-database'
import { chatLogKey, createChatLogs } from '../server/db/chat-logs'
import type { StudioDatabase, StudioTransaction } from '../server/db/database'
import type { SqlParams } from '../server/db/sqlite'

/** Events appended to a log after its import, as the runtime's log appends them. */
async function appendEvents(key: { workspaceRoot: string }, path: string, events: ConversationEvent[]): Promise<void> {
  await createChatLogs({ database: testChatDatabase() }).append(
    path,
    key.workspaceRoot,
    events.map((item) => ({
      seq: item.seq!,
      firstSeq: item.seq!,
      type: item.type,
      turnId: typeof item.payload?.turnId === 'string' ? item.payload.turnId : null,
      body: JSON.stringify(item),
    })),
    [],
  )
}

/** An index over the test's database, as the runtime makes it. */
function makeIndex(hooks: ConstructorParameters<typeof ConversationIndex>[2] = {}) {
  const database = testChatDatabase()
  return new ConversationIndex(database, createChatLogs({ database }), hooks)
}

async function fixture(
  run: (key: { workspaceRoot: string; workspaceId: string; agentId: string }, path: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-index-'))
  const key = { workspaceRoot: root, workspaceId: 'workspace', agentId: 'agent' }
  const path = conversationIndexTranscriptPath(key)
  await mkdir(workspaceStorePath(root, 'conversations', 'workspace'), { recursive: true })
  try {
    await run(key, path)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
function event(
  seq: number,
  type: ConversationEvent['type'],
  payload: Record<string, unknown>,
  agentId = 'agent',
): ConversationEvent {
  return {
    id: `event-${seq}`,
    seq,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId,
    providerId: 'provider',
    modelId: 'model',
    createdAt: seq * 1000,
    type,
    payload,
  }
}
const lines = (events: ConversationEvent[]) => `${events.map((value) => JSON.stringify(value)).join('\n')}\n`

test('conversation cost includes old turns and deduplicates completion records', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines([
        event(1, 'turn_completed', { turnId: 'first', costUsd: 0.25 }),
        event(2, 'turn_completed', { turnId: 'second', costUsd: 0.5 }),
        event(3, 'turn_completed', { turnId: 'first', costUsd: 0.25 }),
        event(4, 'turn_completed', { turnId: 'third', costUsd: -1 }),
      ]),
    )
    expect((await makeIndex().list(key))[0]?.totalCostUsd).toBe(0.75)
    expect((await makeIndex().list(key))[0]?.totalCostUsd).toBe(0.75)
  }))

test('user rename survives rebuild and always wins over a generated title', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines([
        event(1, 'user_message', { text: 'Initial title' }),
        event(2, 'session_updated', { conversationTitle: 'My title', titleSource: 'user' }),
        event(3, 'session_updated', { conversationTitle: 'Generated later', titleSource: 'generated' }),
      ]),
    )
    expect((await makeIndex().list(key))[0]).toMatchObject({ title: 'My title', titleSource: 'user' })
    expect(firstMessageTitle('  one\n two  ')).toBe('one two')
    expect(firstMessageTitle('x'.repeat(100))).toHaveLength(60)
  }))

test('search joins split assistant deltas and returns a jumpable user-turn sequence', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines([
        event(1, 'user_message', { turnId: 'turn', text: 'Question' }),
        event(2, 'content_delta', { turnId: 'turn', text: 'The alpha ' }),
        event(3, 'content_delta', { turnId: 'turn', text: 'beta answer.' }),
      ]),
    )
    const batches: unknown[] = []
    expect(
      await makeIndex().search({ ...key, query: 'ALPHA BETA' }, { onBatch: (batch) => batches.push(batch) }),
    ).toEqual([{ agentId: 'agent', seq: 1, turnId: 'turn', snippet: 'The alpha beta answer.', from: 'agent' }])
    expect(batches).toHaveLength(1)
  }))

test('a reply going on across listings is searched whole, from the deltas the fold reads: no turn reads the log again', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines([
        event(1, 'user_message', { turnId: 'turn', text: 'Question' }),
        event(2, 'content_delta', { turnId: 'turn', text: 'The alpha ' }),
      ]),
    )
    const database = testChatDatabase()
    // What the index itself asks of the database (the log's pages come through its history).
    const asked: string[] = []
    const spy = (target: Pick<StudioTransaction, 'all' | 'get' | 'run'>) => ({
      all: (sql: string, params?: SqlParams) => (asked.push(sql), target.all(sql, params)),
      get: (sql: string, params?: SqlParams) => (asked.push(sql), target.get(sql, params)),
      run: (sql: string, params?: SqlParams) => (asked.push(sql), target.run(sql, params)),
    })
    const watched = {
      ...database,
      ...spy(database),
      transaction: (work: (tx: StudioTransaction) => Promise<unknown>) =>
        database.transaction((tx) => work(spy(tx) as StudioTransaction)),
    } as StudioDatabase
    const index = new ConversationIndex(watched, createChatLogs({ database }))
    expect(await index.search({ ...key, query: 'alpha' })).toHaveLength(1)
    await appendEvents(key, path, [event(3, 'content_delta', { turnId: 'turn', text: 'beta answer.' })])
    expect(await index.search({ ...key, query: 'alpha beta' })).toEqual([
      { agentId: 'agent', seq: 1, turnId: 'turn', snippet: 'The alpha beta answer.', from: 'agent' },
    ])
    expect(asked.filter((sql) => sql.includes('chat_events'))).toEqual([])
  }))

test('a log deleted while its row is folded gets no row back', async () =>
  fixture(async (key, path) => {
    await writeFile(path, lines([event(1, 'user_message', { turnId: 'turn', text: 'Question' })]))
    const database = testChatDatabase()
    const logs = createChatLogs({ database })
    const index = new ConversationIndex(database, {
      ...logs,
      // The fork or import this log was is given up while the listing reads it.
      oldest: async (...args) => {
        const rows = await logs.oldest(...args)
        await logs.remove(path, key.workspaceRoot)
        return rows
      },
    })
    expect(await index.list(key)).toEqual([])
    for (const table of ['chat_threads', 'chat_search_docs'])
      expect(await database.all(`SELECT 1 FROM ${table} WHERE log_key = ?`, [chatLogKey(path)])).toEqual([])
  }))

test('search caps hits, emits bounded batches and honours cancellation', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines(
        Array.from({ length: 500 }, (_, index) =>
          event(index + 1, 'user_message', { turnId: `turn-${index}`, text: 'match' }),
        ),
      ),
    )
    const index = makeIndex(),
      batches: number[] = []
    expect(
      await index.search({ ...key, query: 'match' }, { onBatch: (batch) => batches.push(batch.length) }),
    ).toHaveLength(200)
    expect(batches).toEqual(Array.from({ length: 10 }, () => 20))
    const controller = new AbortController()
    controller.abort()
    await expect(index.search({ ...key, query: 'match' }, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
  }))

test('delete closes the log and removes only its rows; the files from before the database are left as they were', async () =>
  fixture(async (key, path) => {
    await writeFile(path, lines([event(1, 'user_message', { text: 'One' })]))
    const other = conversationIndexTranscriptPath({ ...key, agentId: 'other' })
    await writeFile(other, lines([event(1, 'user_message', { text: 'Other' }, 'other')]))
    const tools = path.replace(/\.jsonl$/, '.tools')
    await mkdir(tools)
    await writeFile(join(tools, 'tool.json'), '{}')
    const closed: string[] = [],
      index = makeIndex({
        close: async (value) => {
          closed.push(value)
        },
      })
    await index.list(key)
    await index.delete(key)
    expect(closed).toEqual([path])
    expect(await index.list(key)).toMatchObject([{ agentId: 'other' }])
    expect(await index.search({ ...key, query: 'one' })).toEqual([])
    // Imported once: the deleted log's old file is never taken up again.
    expect(await readFile(path, 'utf8')).toContain('One')
    expect(await readFile(other, 'utf8')).toContain('Other')
  }))

test('cancellation during a streamed batch stops without leaking a stream error', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines(
        Array.from({ length: 1000 }, (_, index) =>
          event(index + 1, 'user_message', { turnId: `turn-${index}`, text: `match ${'padding '.repeat(200)}` }),
        ),
      ),
    )
    const controller = new AbortController()
    await expect(
      makeIndex().search(
        { ...key, query: 'match' },
        {
          signal: controller.signal,
          onBatch: () => controller.abort(),
        },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  }))

test('a symlink transcript is neither searched nor deleted through', async () =>
  fixture(async (key, path) => {
    const outside = join(key.workspaceRoot, 'private.jsonl')
    await writeFile(outside, lines([event(1, 'user_message', { text: 'private match' })]))
    await symlink(outside, path)
    const index = makeIndex()
    expect(await index.search({ ...key, query: 'private' })).toEqual([])
    await expect(index.delete(key)).rejects.toThrow(/symbolic link/iu)
    expect(await readFile(outside, 'utf8')).toContain('private match')
  }))

test('coalesced delta sequence ranges survive index rebuild', async () =>
  fixture(async (key, path) => {
    const merged = {
      ...event(2, 'content_delta', { turnId: 'turn', text: 'ab' }),
      parts: [
        ['first', 2000, 1, 2],
        ['second', 3000, 1, 3],
      ],
    }
    await writeFile(
      path,
      lines([
        event(1, 'user_message', { turnId: 'turn', text: 'Question' }),
        merged,
        event(4, 'turn_completed', { turnId: 'turn' }),
      ]),
    )
    expect((await makeIndex().list(key))[0]?.lastSeq).toBe(4)
  }))

test('an unreadable transcript gets a row of its own instead of failing the whole list and search', async () =>
  fixture(async (key, path) => {
    await writeFile(path, lines([event(1, 'user_message', { turnId: 't', text: 'Readable chat' })]))
    const folder = workspaceStorePath(key.workspaceRoot, 'conversations', key.workspaceId)
    const other = join(folder, 'other.jsonl')
    await writeFile(other, lines([event(1, 'user_message', { turnId: 't', text: 'Readable chat too' }, 'other')]))
    // A hard link is refused by confined file access, like any other unsafe file.
    const linked = join(tmpdir(), `conversation-index-link-${process.pid}-${Date.now()}`)
    await link(other, linked)
    try {
      const threads = await makeIndex().list(key)
      expect(threads.map((thread) => [thread.agentId, thread.title]).sort()).toEqual([
        ['agent', 'Readable chat'],
        ['other', 'Unreadable conversation'],
      ])
    } finally {
      await rm(linked, { force: true })
    }
    await link(other, linked)
    try {
      expect(await makeIndex().search({ ...key, query: 'readable' })).toMatchObject([{ agentId: 'agent' }])
    } finally {
      await rm(linked, { force: true })
    }
  }))

test('an unreadable transcript whose file name is not valid percent-encoding still gets its row', async () =>
  fixture(async (key, path) => {
    await writeFile(path, lines([event(1, 'user_message', { turnId: 't', text: 'Readable chat' })]))
    const folder = workspaceStorePath(key.workspaceRoot, 'conversations', key.workspaceId)
    const odd = join(folder, '50%.jsonl')
    await writeFile(odd, lines([event(1, 'user_message', { turnId: 't', text: 'Hidden' }, '50%')]))
    const linked = join(tmpdir(), `conversation-index-link-${process.pid}-${Date.now()}`)
    await link(odd, linked)
    try {
      const threads = await makeIndex().list(key)
      expect(threads.map((thread) => [thread.agentId, thread.title]).sort()).toEqual([
        ['50%', 'Unreadable conversation'],
        ['agent', 'Readable chat'],
      ])
    } finally {
      await rm(linked, { force: true })
    }
  }))

test('costs and turns are counted once across an append', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines([
        event(1, 'user_message', { turnId: 'first', text: 'Question' }),
        event(2, 'turn_completed', { turnId: 'first', costUsd: 0.25 }),
      ]),
    )
    const index = makeIndex()
    expect((await index.list(key))[0]).toMatchObject({ turnCount: 1, totalCostUsd: 0.25 })
    await appendEvents(key, path, [
      event(3, 'turn_completed', { turnId: 'first', costUsd: 0.25 }),
      event(4, 'user_message', { turnId: 'second', text: 'Another' }),
      event(5, 'turn_completed', { turnId: 'second', costUsd: 0.5 }),
    ])
    expect((await index.list(key))[0]).toMatchObject({ turnCount: 2, totalCostUsd: 0.75, lastSeq: 5 })
  }))

test('a row says when its agent last finished a turn, a steered end aside, and keeps it across an append', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines([
        event(1, 'user_message', { turnId: 'one', text: 'Question' }),
        event(2, 'turn_completed', { turnId: 'one' }),
        event(3, 'user_message', { turnId: 'two', text: 'More' }),
        // A message steered into a running turn ends nothing: the work goes on.
        event(4, 'turn_completed', { turnId: 'two', steered: true }),
        event(5, 'session_updated', { conversationTitle: 'Renamed', titleSource: 'user' }),
      ]),
    )
    const index = makeIndex()
    const [first] = await index.list(key)
    expect(first?.lastTurnEndedAt).toBe(2000)
    // A rename moves `updatedAt`, never the turn end.
    expect(first?.updatedAt).toBe(5000)
    await appendEvents(key, path, [event(6, 'turn_failed', { turnId: 'two' })])
    expect((await index.list(key))[0]?.lastTurnEndedAt).toBe(6000)
  }))

test('a chat keeps the opening of its last reply, cleared when the person writes again', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines([
        event(1, 'user_message', { turnId: 'one', text: 'Question' }),
        event(2, 'content_delta', { turnId: 'one', text: 'The answer ' }),
        event(3, 'content_delta', { turnId: 'one', text: 'is here.' }),
        event(4, 'turn_completed', { turnId: 'one' }),
      ]),
    )
    const index = makeIndex()
    expect((await index.list(key))[0]?.lastAssistantText).toBe('The answer is here.')
    await appendEvents(key, path, [event(5, 'user_message', { turnId: 'two', text: 'And then?' })])
    expect((await index.list(key))[0]?.lastAssistantText).toBe('')
    // The opening only, as the runtime's session keeps it.
    await appendEvents(key, path, [event(6, 'content_delta', { turnId: 'two', text: 'x'.repeat(300) })])
    expect((await index.list(key))[0]?.lastAssistantText).toHaveLength(240)
  }))

test('a chat whose agent never finished a turn names no turn end', async () =>
  fixture(async (key, path) => {
    await writeFile(path, lines([event(1, 'user_message', { turnId: 'one', text: 'Question' })]))
    expect('lastTurnEndedAt' in (await makeIndex().list(key))[0]!).toBe(false)
  }))

test('search says who wrote each match, and reads past tool output it never parses', async () =>
  fixture(async (key, path) => {
    await writeFile(
      path,
      lines([
        event(1, 'user_message', { turnId: 'one', text: 'Is the wave model wired up?' }),
        event(2, 'tool_output', { turnId: 'one', text: 'wave '.repeat(50) }),
        event(3, 'content_delta', { turnId: 'one', text: 'The wave model is wired up.' }),
        event(4, 'user_message', { turnId: 'two', text: 'Wave check', origin: { kind: 'studio' } }),
      ]),
    )
    const hits = await makeIndex().search({ ...key, query: 'wave' })
    expect(hits.map((hit) => [hit.seq, hit.from])).toEqual([
      [1, 'person'],
      [1, 'agent'],
      [4, 'studio'],
    ])
  }))
