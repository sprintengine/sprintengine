import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { testChatDatabase } from '../../tests/studio-database'
import { createChatLogs } from '../server/db/chat-logs'
import { ConversationTranscriptReader, type ConversationTranscriptLimits } from './conversation-transcript-reader'
import type { ConversationEvent, ConversationPage } from '../shared/conversation-runtime'
import { boundConversationPage } from '../server/conversation-stream-shaping'

let root: string
let path: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'transcript-reader-')))
  // As a store lays a chat out (`<store>/conversations/<chat>/<agent>.jsonl`): its log is named by the three.
  await mkdir(join(root, 'conversations', 'chat'), { recursive: true })
  path = join(root, 'conversations', 'chat', 'agent.jsonl')
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

const record = (seq: number, type: ConversationEvent['type'], payload: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: `event-${seq}`,
    seq,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock',
    modelId: 'mock',
    createdAt: seq,
    type,
    payload,
  }) + '\n'

// A turn: the message, a tool with its output, and the reply.
function turn(first: number, output = 'x'.repeat(200)): string {
  const turnId = `turn-${first}`
  return [
    record(first, 'user_message', { turnId, text: `question ${first}` }),
    record(first + 1, 'tool_started', { turnId, toolUseId: `tool-${first}`, name: 'Read', kind: 'file_read' }),
    record(first + 2, 'tool_output', { turnId, toolUseId: `tool-${first}`, output }),
    record(first + 3, 'turn_completed', { turnId }),
  ].join('')
}
const turns = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => turn(from + index * 4)).join('')

/** A reader over the test's chat logs (one database per test file). */
const readerOf = (limits: Partial<ConversationTranscriptLimits> = {}) =>
  new ConversationTranscriptReader(createChatLogs({ database: testChatDatabase() }), limits)

function countParses() {
  const parse = JSON.parse
  let count = 0
  vi.spyOn(JSON, 'parse').mockImplementation((...args: Parameters<typeof JSON.parse>) => {
    count++
    return parse(...args)
  })
  return () => count
}

const seqs = (events: ConversationEvent[]) => events.map((event) => event.seq)

test('a transcript from before the database is imported once, then paged from the database alone', async () => {
  await writeFile(path, turns(1, 30))
  const reader = readerOf()
  const snapshot = await reader.sync(root, path, { turnLimit: 10 })
  if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
  expect(seqs(snapshot.page.events).at(-1)).toBe(120)
  expect(snapshot.generation).not.toBe('empty')
  expect(await readerOf().sync(root, path, { turnLimit: 10 })).toEqual(snapshot)
  const earlier = await reader.before(root, path, snapshot.page.beforeCursor!, 10)
  expect(seqs(earlier.events)).toEqual(Array.from({ length: 40 }, (_, index) => 41 + index))

  // The file is never read again: what a build before the database appends to it is not this log.
  await appendFile(path, turn(121))
  const again = await reader.sync(root, path, { turnLimit: 10 })
  expect(again).toEqual(snapshot)
  // A client's cursor from before the upgrade carries over: same generation, its next events.
  const caught = await reader.sync(root, path, { afterSeq: 116, generation: snapshot.generation })
  expect(caught.kind).toBe('events')
  expect(caught.kind === 'events' && seqs(caught.events)).toEqual([117, 118, 119, 120])
})

test('a transcript from before sequence numbers is numbered by position, a merged run split into its deltas', async () => {
  const unnumbered = (type: ConversationEvent['type'], payload: Record<string, unknown>, id: string) =>
    JSON.stringify({ id, sessionId: 's', workspaceId: 'w', agentId: 'a', createdAt: 1, type, payload }) + '\n'
  const run =
    JSON.stringify({
      id: 'd1',
      sessionId: 's',
      workspaceId: 'w',
      agentId: 'a',
      createdAt: 1,
      type: 'content_delta',
      payload: { turnId: 't', text: 'abcd' },
      parts: [
        ['d1', 1, 2],
        ['d2', 2, 2],
      ],
    }) + '\n'
  await writeFile(path, unnumbered('user_message', { turnId: 't', text: 'hi' }, 'u') + run + unnumbered('turn_completed', { turnId: 't' }, 'c'))
  const events = await readerOf().tail(root, path)
  expect(events.map((event) => [event.id, event.seq])).toEqual([
    ['u', 1],
    ['d1', 2],
    ['d2', 3],
    ['c', 4],
  ])
  expect(events.map((event) => event.payload?.text)).toEqual(['hi', 'ab', 'cd', undefined])
})

test('a torn last line and a damaged one are skipped by the import, and the rest is the log', async () => {
  const torn = record(9, 'user_message', { turnId: 'turn-9', text: 'question 9' })
  await writeFile(path, turn(1) + '{"broken\n' + turn(5) + torn.slice(0, 20))
  expect(seqs(await readerOf().tail(root, path))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
})

test('what a reader is handed is its own: changing it does not change the next read', async () => {
  const reader = readerOf()
  await writeFile(path, turns(1, 2))
  const first = await reader.tail(root, path)
  first[0].type = 'turn_failed'
  const found = await reader.findLast(root, path, (event) => event.seq === 2)
  found!.seq = 99
  const again = await reader.tail(root, path)
  expect(again[0].type).toBe('user_message')
  expect(seqs(again)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
})

test('paging back from where a wire cut each page seeks near the cursor, so every page costs about the same', async () => {
  // About 2.4 MB, thirty times the parsed tail of a reader with 64 KiB pages,
  // as a long chat is to the default's: past the tail, a cursor this reader
  // never gave out used to mean parsing down to it from the tail's edge.
  const lines: string[] = []
  let seq = 0
  for (let turn = 0; turn < 150; turn++) {
    lines.push(record(++seq, 'user_message', { turnId: `t${turn}`, text: 'go' }))
    for (let step = 0; step < 20; step++)
      lines.push(record(++seq, 'tool_output', { turnId: `t${turn}`, toolUseId: `u${seq}`, preview: 'o'.repeat(700) }))
  }
  await writeFile(path, lines.join(''))
  const reader = readerOf({ pageBytes: 64 * 1024 })
  // As the wire sends each page: the newest 16 KiB of it, from a turn's start.
  const cut = (page: ConversationPage) => boundConversationPage(page, 16 * 1024).page
  const synced = await reader.sync(root, path, { turnLimit: 10 })
  if (synced.kind !== 'snapshot') throw new Error('expected a snapshot')
  let page = cut(synced.page)
  const parses: number[] = []
  while (page.hasMore && page.beforeCursor !== null && parses.length < 120) {
    const parsed = countParses()
    const read = await reader.before(root, path, page.beforeCursor, 10)
    parses.push(parsed())
    vi.restoreAllMocks()
    expect(read.events.at(-1)!.seq).toBe(page.beforeCursor - 1)
    page = cut(read)
  }
  expect(parses.length).toBeGreaterThan(60)
  const early = Math.max(...parses.slice(0, 5))
  expect(Math.max(...parses.slice(-20))).toBeLessThan(early * 2)
})

test('an event is read back whole by the sequence and id it was sent under, a merged run as the span given out', async () => {
  const run =
    JSON.stringify({
      id: 'delta-2',
      seq: 2,
      sessionId: 'session',
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'mock',
      modelId: 'mock',
      createdAt: 2,
      type: 'content_delta',
      payload: { turnId: 't', text: 'onetwothree' },
      parts: [
        ['delta-2', 2, 3, 2],
        ['delta-3', 3, 3, 3],
        ['delta-4', 4, 5, 4],
      ],
    }) + '\n'
  await writeFile(path, record(1, 'user_message', { turnId: 't', text: 'go' }) + run + record(5, 'turn_completed'))
  const reader = readerOf()
  const read = (seq: number, id: string) => reader.eventAt(root, path, seq, id)
  // As a snapshot gave it out: the whole run, numbered with its last delta.
  expect(await read(4, 'delta-2')).toMatchObject({ id: 'delta-2', seq: 4, payload: { text: 'onetwothree' } })
  // As a catch-up whose cursor fell inside the run gave it out: from that delta on.
  expect(await read(4, 'delta-3')).toMatchObject({ id: 'delta-3', seq: 4, createdAt: 3, payload: { text: 'twothree' } })
  // As the live stream gave out one of its deltas.
  expect(await read(3, 'delta-3')).toMatchObject({ id: 'delta-3', seq: 3, payload: { text: 'two' } })
  expect(await read(5, 'event-5')).toMatchObject({ type: 'turn_completed', seq: 5 })
  expect((await read(4, 'delta-2'))?.payload).not.toHaveProperty('parts')
  expect(await read(5, 'another')).toBeUndefined()
  expect(await read(9, 'event-9')).toBeUndefined()
  expect(await read(2, 'delta-4')).toBeUndefined()
})

