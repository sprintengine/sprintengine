import assert from 'node:assert/strict'
import { createWriteStream } from 'node:fs'
import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'vitest'

import { openTestDatabase } from '../../../tests/studio-database'
import { ConversationIndex } from '../../main/conversation-index'
import { ConversationTranscriptReader } from '../../main/conversation-transcript-reader'
import { workspaceStorePath } from '../../main/workspace-store'
import { chatGeneration, chatLogKey, createChatLogs, importSource } from './chat-logs'
import type { StudioDatabase, StudioTransaction } from './database'

// A chat's transcript from before the database, as old builds wrote it (and
// as a crash or a hand edit left it), imported the first time its log is
// taken up.

const event = (seq: number | undefined, type: string, payload: Record<string, unknown> = {}, id = `e${seq}`) =>
  JSON.stringify({
    id,
    ...(seq === undefined ? {} : { seq }),
    sessionId: 's',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'p',
    modelId: 'm',
    createdAt: seq ?? 0,
    type,
    payload,
  })

/** A chat's transcript path as a store lays it out, in a fresh folder. */
async function transcriptAt(lines: string): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'chat-logs-'))
  const path = join(root, 'store', 'conversations', 'workspace', 'agent.jsonl')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, lines)
  return { root, path }
}

test('an old transcript is imported once: numbers kept, merged runs kept, receipts kept, damage skipped and counted', async () => {
  const merged = JSON.stringify({
    ...JSON.parse(event(2, 'content_delta', { turnId: 't', text: 'abcd' })),
    parts: [
      ['d2', 2, 2, 2],
      ['d3', 3, 2, 3],
    ],
  })
  const lines = [
    event(1, 'user_message', { turnId: 't', text: 'hi' }),
    merged,
    JSON.stringify({ receipt: { id: 'cmd', at: 1, turnId: 't' } }),
    '{"broken',
    event(4, 'turn_completed', { turnId: 't' }),
    JSON.stringify({ receipt: { id: 'cmd', at: 2, answer: { ok: true } } }),
  ]
  const torn = event(5, 'user_message', { text: 'never published' }).slice(0, 25)
  const { root, path } = await transcriptAt(`${lines.join('\n')}\n${torn}`)
  const database = openTestDatabase()
  const logs = createChatLogs({ database })
  const info = await logs.info(path, root)
  assert.deepEqual(info, { generation: chatGeneration(lines[0]!), lastSeq: 4 })
  assert.deepEqual(
    (await logs.oldest(path, root, 0, 10)).map((row) => [row.firstSeq, row.seq]),
    [
      [1, 1],
      [2, 3],
      [4, 4],
    ],
  )
  assert.deepEqual(await logs.receipts(path, root), [{ id: 'cmd', at: 2, turnId: 't', answer: { ok: true } }])
  assert.deepEqual(
    await database.get('SELECT records, skipped FROM imports WHERE source = ?', [importSource(chatLogKey(path))]),
    { records: 5, skipped: 2 },
    'the damaged line and the torn last one are counted',
  )
  // Never read again: a build before the database appending to it changes nothing here.
  await writeFile(path, `${lines.join('\n')}\n${event(9, 'user_message')}\n`)
  assert.equal((await createChatLogs({ database }).info(path, root))?.lastSeq, 4)
})

test('an import commits a batch at a time; one a stop cuts short is not retried at once, and runs again whole', async () => {
  const lines = Array.from({ length: 1200 }, (_, index) => event(index + 1, 'tool_output', { output: 'x' }))
  const { root, path } = await transcriptAt(`${lines.join('\n')}\n`)
  const database = openTestDatabase()
  // A database whose writes stop part way through the import, as a crash would.
  let writes = 0
  let transactions = 0
  const failing: StudioDatabase = {
    path: database.path,
    all: (sql, params) => database.all(sql, params),
    get: (sql, params) => database.get(sql, params),
    run: (sql, params) => database.run(sql, params),
    batch: (statements) => database.batch(statements),
    readNow: (sql, params) => database.readNow(sql, params),
    close: () => database.close(),
    transaction: (work) => {
      transactions += 1
      return database.transaction((tx) => {
        const cut: StudioTransaction = {
          all: (sql, params) => tx.all(sql, params),
          get: (sql, params) => tx.get(sql, params),
          run: (sql, params) => {
            if (sql.startsWith('INSERT INTO chat_events') && ++writes === 2) throw new Error('the power went')
            return tx.run(sql, params)
          },
        }
        return work(cut)
      })
    },
  }
  const cut = createChatLogs({ database: failing })
  await assert.rejects(cut.ensure(path, root), /the power went/u)
  // Its first batch was committed on its own, so other chats' writes were not held behind the whole file.
  assert.equal((await database.get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_events'))?.n, 400)
  assert.equal(
    await database.get('SELECT 1 FROM imports WHERE source = ?', [importSource(chatLogKey(path))]),
    undefined,
    'not noted as imported',
  )
  // Not tried again on the next read.
  const before = transactions
  await assert.rejects(cut.info(path, root), /the power went/u)
  assert.equal(transactions, before)

  const logs = createChatLogs({ database })
  assert.equal((await logs.info(path, root))?.lastSeq, 1200)
  assert.equal((await database.get<{ n: number }>('SELECT COUNT(*) AS n FROM chat_events'))?.n, 1200)
})

test('deltas out of order are numbered each after the one before, and a log that could not be imported is still deleted', async () => {
  const merged = JSON.stringify({
    ...JSON.parse(event(3, 'content_delta', { turnId: 't', text: 'ab' })),
    parts: [
      ['d7', 7, 1, 7],
      ['d6', 6, 1, 6],
    ],
  })
  const { root, path } = await transcriptAt(`${[event(5, 'user_message'), merged].join('\n')}\n`)
  const logs = createChatLogs({ database: openTestDatabase() })
  assert.deepEqual(
    (await logs.oldest(path, root, 0, 10)).map((row) => row.seq),
    [5, 7, 8],
  )

  const refused = await transcriptAt(`${event(1, 'user_message')}\n`)
  const outside = join(await mkdtemp(join(tmpdir(), 'chat-logs-outside-')), 'agent.jsonl')
  await writeFile(outside, `${event(1, 'user_message')}\n`)
  await rm(refused.path)
  // A file a link shares is refused, as every transcript read refused it.
  await link(outside, refused.path)
  // (Its own database: a log is named by its store, chat and agent, which the first one shares.)
  const others = createChatLogs({ database: openTestDatabase() })
  await assert.rejects(others.ensure(refused.path, refused.root))
  await others.remove(refused.path, refused.root)
  assert.equal(await others.exists(refused.path, refused.root), false, 'gone, and its file never taken up')
})

test('a log with no transcript notes nothing: one that arrives later is imported', async () => {
  const { root, path } = await transcriptAt('')
  await rm(path)
  const database = openTestDatabase()
  assert.equal(await createChatLogs({ database }).exists(path, root), false)
  await writeFile(path, `${event(1, 'user_message')}\n`)
  assert.equal((await createChatLogs({ database }).info(path, root))?.lastSeq, 1)
})

test('a chat larger than the old read limit is imported whole, searched in its middle and paged to its start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-logs-'))
  const path = workspaceStorePath(root, 'conversations', 'workspace', 'agent.jsonl')
  await mkdir(dirname(path), { recursive: true })
  // About 66 MiB: past the 64 MiB a transcript was searched within, a needle in its middle.
  const reply = 'filler '.repeat(9_800)
  const stream = createWriteStream(path)
  let seq = 0
  for (let turn = 0; turn < 1000; turn++) {
    stream.write(`${event(++seq, 'user_message', { turnId: `t${turn}`, text: `question ${turn}` })}\n`)
    const text = turn === 500 ? `${reply}the hidden needle ${reply}` : reply
    stream.write(`${event(++seq, 'content_delta', { turnId: `t${turn}`, text })}\n`)
    stream.write(`${event(++seq, 'turn_completed', { turnId: `t${turn}` })}\n`)
  }
  await new Promise((resolve) => stream.end(resolve))
  const database = openTestDatabase()
  const logs = createChatLogs({ database })
  const index = new ConversationIndex(database, logs)
  const key = { workspaceRoot: root, workspaceId: 'workspace' }
  // Listing the chat imports its transcript and indexes it; the needle is in its middle.
  assert.deepEqual(
    (await index.list(key)).map((thread) => [thread.agentId, thread.turnCount, thread.lastSeq]),
    [['agent', 1000, 3000]],
  )
  const hits = await index.search({ ...key, query: 'hidden needle' })
  assert.deepEqual(
    hits.map((hit) => [hit.agentId, hit.turnId, hit.from, hit.seq]),
    [['agent', 't500', 'agent', 1501]],
  )
  const reader = new ConversationTranscriptReader(logs)
  let page = await reader.before(root, path, 3001, 100)
  let pages = 1
  while (page.hasMore && page.beforeCursor !== null) {
    page = await reader.before(root, path, page.beforeCursor, 100)
    pages += 1
  }
  assert.equal(page.events[0]?.seq, 1, 'paged back to the first event')
  assert.ok(pages > 1)
})
