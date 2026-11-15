import { appendFile, mkdir, mkdtemp, realpath, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ConversationTranscriptReader } from './conversation-transcript-reader'
import type { ConversationEvent, ConversationPage } from '../shared/conversation-runtime'
import { boundConversationPage } from '../server/conversation-stream-shaping'

let root: string
let path: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'transcript-reader-')))
  await mkdir(join(root, 'conversations'))
  path = join(root, 'conversations', 'chat.jsonl')
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

test('opening a chat again parses only what was appended since, and reads what a cold reader reads', async () => {
  await writeFile(path, turns(1, 30))
  const reader = new ConversationTranscriptReader()
  const parses = countParses()
  // Opening a chat reads its last turn for its sequence (and the turn before,
  // to know there is one), then its snapshot.
  await reader.sync(root, path, { turnLimit: 1 })
  const opened = parses()
  expect(opened).toBe(8)
  const snapshot = await reader.sync(root, path, { turnLimit: 10 })
  expect(parses() - opened, 'the turn the first read parsed is not parsed again').toBe(36)
  const again = parses()
  expect(await reader.sync(root, path, { turnLimit: 10 })).toEqual(snapshot)
  expect(parses(), 'opened again unchanged: nothing is parsed').toBe(again)

  await appendFile(path, turn(121))
  const grown = await reader.sync(root, path, { turnLimit: 10 })
  expect(parses() - again, 'only the appended turn').toBe(4)
  vi.restoreAllMocks()
  expect(grown).toEqual(await new ConversationTranscriptReader().sync(root, path, { turnLimit: 10 }))
  if (grown.kind !== 'snapshot') throw new Error('expected a snapshot')
  expect(seqs(grown.page.events).at(-1)).toBe(124)
  // Paging back joins the held tail to the file's older records.
  const earlier = await reader.before(root, path, grown.page.beforeCursor!, 10)
  expect(earlier).toEqual(await new ConversationTranscriptReader().before(root, path, grown.page.beforeCursor!, 10))
  expect(seqs(earlier.events)).toEqual(Array.from({ length: 40 }, (_, index) => 45 + index))
})

test('a record still being written is read once it is whole, not lost at the held tail’s edge', async () => {
  const reader = new ConversationTranscriptReader()
  const torn = record(5, 'user_message', { turnId: 'turn-5', text: 'question 5' })
  await writeFile(path, turn(1) + torn.slice(0, 20))
  const before = await reader.tail(root, path)
  expect(seqs(before)).toEqual([1, 2, 3, 4])
  await appendFile(path, torn.slice(20) + record(6, 'turn_completed', { turnId: 'turn-5' }))
  expect(seqs(await reader.tail(root, path))).toEqual([1, 2, 3, 4, 5, 6])
})

test('a transcript recreated, shrunk or corrupted is read afresh', async () => {
  const reader = new ConversationTranscriptReader()
  await writeFile(path, turns(1, 3))
  expect(seqs(await reader.tail(root, path))).toHaveLength(12)

  // Deleted and started again: another file with another first record.
  await rm(path)
  await writeFile(path, turn(1, 'other'))
  const recreated = await reader.tail(root, path)
  expect(seqs(recreated)).toEqual([1, 2, 3, 4])
  expect(recreated[2].payload?.output).toBe('other')

  // Cut back below what was held.
  await writeFile(path, turns(1, 3))
  await reader.tail(root, path)
  await truncate(path, turn(1).length * 2)
  expect(seqs(await reader.tail(root, path))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

  // A torn record left by a crash is skipped, as it always was.
  await appendFile(path, '{"broken\n' + turn(9))
  expect(seqs(await reader.tail(root, path))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
})

test('what a reader is handed is its own: changing it does not change the next read', async () => {
  const reader = new ConversationTranscriptReader()
  await writeFile(path, turns(1, 2))
  const first = await reader.tail(root, path)
  first[0].type = 'turn_failed'
  const found = await reader.findLast(root, path, (event) => event.seq === 2)
  found!.seq = 99
  const again = await reader.tail(root, path)
  expect(again[0].type).toBe('user_message')
  expect(seqs(again)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
})

test('the parsed tails stay within their budget', async () => {
  const reader = new ConversationTranscriptReader({ pageBytes: 4 * 1024 })
  await writeFile(path, Array.from({ length: 40 }, (_, index) => turn(1 + index * 4, 'y'.repeat(1000))).join(''))
  const parses = countParses()
  const snapshot = await reader.sync(root, path, { turnLimit: 100 })
  if (snapshot.kind !== 'snapshot') throw new Error('expected a snapshot')
  const held = (reader as unknown as { tails: Map<string, { bytes: number }> }).tails.get(path)!
  expect(held.bytes).toBeLessThanOrEqual(5 * 1024)
  const read = parses()
  expect(await reader.sync(root, path, { turnLimit: 100 })).toEqual(snapshot)
  expect(parses() - read, 'only the record past the budget, which says there is more').toBeLessThanOrEqual(1)
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
  const reader = new ConversationTranscriptReader({ pageBytes: 64 * 1024 })
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
  const reader = new ConversationTranscriptReader()
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

test('the offsets kept for paging are the most recently paged chats’, within a bound', async () => {
  const reader = new ConversationTranscriptReader({ pageBytes: 4 * 1024 })
  for (let chat = 0; chat < 40; chat++) {
    const other = join(root, 'conversations', `chat-${chat}.jsonl`)
    await writeFile(other, turns(1, 30))
    await reader.sync(root, other, {})
  }
  const offsets = (reader as unknown as { offsets: Map<string, unknown> }).offsets
  expect(offsets.size).toBe(32)
  expect([...offsets.keys()].at(-1)).toBe(join(root, 'conversations', 'chat-39.jsonl'))
})
