import assert from 'node:assert/strict'
import { test } from 'vitest'

import { CONVERSATION_MAX_FRAME_BYTES } from '../../packages/conversation-protocol/src/public'
import { projectConversation } from '../../packages/conversation-timeline/src/conversationProjection'
import { DEFAULT_TRANSCRIPT_LIMITS } from '../main/conversation-transcript-reader'
import type { ConversationEvent } from '../shared/conversation-runtime'
import {
  CONVERSATION_WIRE_INPUT_FIELD_CHARS,
  CONVERSATION_WIRE_PAGE_BYTES,
  CONVERSATION_WIRE_PREVIEW_CHARS,
  boundConversationPage,
  conversationSnapshotParts,
  conversationWireFrame,
  projectConversationEvent,
  type ConversationSnapshotFrame,
} from './conversation-stream-shaping'

// A snapshot's events are measured once each, however many subscribers join
// the same chat: every snapshot of it holds the same event objects.

function counted(seq: number, text: string): { event: ConversationEvent; reads: () => number } {
  let reads = 0
  const event = {
    id: `e${seq}`,
    seq,
    sessionId: 's',
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    providerId: 'claude-agent',
    modelId: 'default',
    type: 'content_delta',
    createdAt: seq,
    payload: { text },
  } as unknown as ConversationEvent
  // Counts each time the event is turned into JSON, and is otherwise invisible.
  Object.defineProperty(event, 'toJSON', {
    enumerable: false,
    value(this: ConversationEvent) {
      reads++
      const { ...plain } = this
      return plain
    },
  })
  return { event, reads: () => reads }
}

const snapshot = (events: ConversationEvent[]): ConversationSnapshotFrame =>
  ({
    type: 'snapshot',
    page: { events, hasMore: false, beforeCursor: null },
  }) as unknown as ConversationSnapshotFrame

test('a snapshot measures each event once, for every subscriber after the first', () => {
  const a = counted(1, 'hello')
  const b = counted(2, 'world')
  const events = [a.event, b.event]
  const first = conversationSnapshotParts(snapshot(events), (part) => part)
  const second = conversationSnapshotParts(snapshot(events), (part) => part)
  assert.equal(first.bytes, second.bytes)
  assert.ok(first.bytes > 0)
  assert.deepEqual([a.reads(), b.reads()], [1, 1])
})

test('a merged run that grew in place, with its seq moved, is measured again', () => {
  const run = counted(3, 'part')
  const before = conversationSnapshotParts(snapshot([run.event]), (part) => part).bytes
  ;(run.event.payload as { text: string }).text = 'part, and more of it'
  ;(run.event as { seq: number }).seq = 4
  const after = conversationSnapshotParts(snapshot([run.event]), (part) => part).bytes
  assert.ok(after > before)
  assert.equal(run.reads(), 2)
})

// What crosses a wire: one projection for every transport. The stored event
// stays whole; a reader fetches what was left off with `toolDetail`.

const base = { sessionId: 's', workspaceId: 'w', agentId: 'a', providerId: 'p', modelId: 'm', createdAt: 1 }
const event = (seq: number, type: ConversationEvent['type'], payload?: Record<string, unknown>) =>
  ({ ...base, id: String(seq), seq, type, ...(payload ? { payload } : {}) }) as ConversationEvent

test('a tool result crosses once, as its preview, and draws the same', () => {
  const text = 'line one\nline two'
  const events = [
    event(1, 'user_message', { turnId: 't', text: 'go' }),
    event(2, 'tool_started', { turnId: 't', toolUseId: 'u', name: 'Bash', input: {} }),
    event(3, 'tool_output', { turnId: 't', toolUseId: 'u', preview: text, output: text, status: 'ok', totalBytes: 17 }),
    // Output that is not a copy of the preview is the reader's to read.
    event(4, 'tool_output', { turnId: 't', toolUseId: 'v', output: 'only' }),
    event(5, 'turn_completed', { turnId: 't' }),
  ]
  const shown = events.map(projectConversationEvent)
  assert.equal(shown[2].payload?.output, undefined)
  assert.equal(shown[2].payload?.preview, text)
  assert.equal(shown[2].payload?.truncated, undefined, 'nothing was cut')
  assert.equal(shown[3], events[3])
  assert.equal(events[2].payload?.output, text, 'the stored event is left as it was')
  assert.deepEqual(projectConversation(shown), projectConversation(events))
  const frame = conversationWireFrame({ type: 'snapshot', page: { events, hasMore: false, beforeCursor: null } })
  assert.deepEqual(frame.page.events, shown)
  const live = conversationWireFrame({ type: 'event', event: events[2] })
  assert.equal(live.event, shown[2])
})

test('a large tool output crosses as its preview, cut from its end while it streams', () => {
  const long = `HEAD${'x'.repeat(20_000)}TAIL`
  const done = projectConversationEvent(event(1, 'tool_output', { toolUseId: 'u', output: long, isError: false }))
  assert.equal(String(done.payload?.output).length, CONVERSATION_WIRE_PREVIEW_CHARS)
  assert.ok(String(done.payload?.output).startsWith('HEAD'))
  assert.equal(done.payload?.truncated, true)
  const streaming = projectConversationEvent(
    event(2, 'tool_output', { toolUseId: 'u', preview: long, output: long, partial: true, isError: false }),
  )
  assert.ok(String(streaming.payload?.preview).endsWith('TAIL'))
  assert.equal(String(streaming.payload?.preview).length, CONVERSATION_WIRE_PREVIEW_CHARS)
  assert.equal(streaming.payload?.output, undefined, 'one copy of the text')
  // Content blocks a provider sent as they were cross as text within the preview.
  const blocks = projectConversationEvent(
    event(3, 'tool_output', { toolUseId: 'u', output: [{ type: 'text', text: long }], isError: false }),
  )
  assert.equal(typeof blocks.payload?.output, 'string')
  assert.ok(String(blocks.payload?.output).length <= CONVERSATION_WIRE_PREVIEW_CHARS)
})

test('a result the runtime kept no detail for crosses whole, but once', () => {
  const long = 'n'.repeat(20_000)
  const shown = projectConversationEvent(event(1, 'tool_output', { preview: long, output: long, isError: false }))
  assert.deepEqual(shown.payload, { preview: long, isError: false })
})

test('a step’s pictures cross as at most eight paths, never their bytes', () => {
  const paths = Array.from({ length: 12 }, (_, index) => `/Users/dev/.sprintengine/pictures/shot-${index}.png`)
  const shown = projectConversationEvent(
    event(1, 'tool_output', { toolUseId: 'u', output: '', images: [...paths, 'x'.repeat(5000), 7] }),
  )
  assert.deepEqual(shown.payload?.images, paths.slice(0, 8))
  const few = event(2, 'tool_output', { toolUseId: 'v', output: '', images: paths.slice(0, 2) })
  assert.equal(projectConversationEvent(few), few, 'a step within the bound crosses as stored')
})

test('a file change crosses without its bodies, and what the transcript draws closed stays whole', () => {
  const body = 'line\n'.repeat(6_000)
  const write = event(1, 'tool_started', {
    toolUseId: 'w',
    name: 'Write',
    addedLines: 6000,
    input: { file_path: '/Users/dev/app/a.ts', content: body },
  })
  const shown = projectConversationEvent(write)
  const input = shown.payload?.input as Record<string, string>
  assert.equal(input.file_path, '/Users/dev/app/a.ts')
  assert.equal(input.content.length, CONVERSATION_WIRE_INPUT_FIELD_CHARS)
  assert.equal(shown.payload?.inputTruncated, true)
  assert.equal(shown.payload?.addedLines, 6000, 'the counts a closed row shows are the step’s own')
  assert.equal((write.payload?.input as Record<string, string>).content, body, 'the stored event is left as it was')

  const multi = projectConversationEvent(
    event(2, 'tool_started', {
      toolUseId: 'm',
      name: 'MultiEdit',
      input: {
        file_path: 'b.ts',
        edits: [
          { old_string: 'a', new_string: body },
          { old_string: 'b', new_string: 'c' },
        ],
      },
    }),
  )
  const edits = (multi.payload?.input as { edits: Array<Record<string, string>> }).edits
  assert.equal(edits[0].new_string.length, CONVERSATION_WIRE_INPUT_FIELD_CHARS)
  assert.deepEqual(edits[1], { old_string: 'b', new_string: 'c' })
  assert.equal(multi.payload?.inputTruncated, true)

  const patch = projectConversationEvent(
    event(3, 'tool_started', { toolUseId: 'p', name: 'apply_patch', input: { input: `*** Begin Patch\n${body}` } }),
  )
  assert.equal((patch.payload?.input as { input: string }).input.length, CONVERSATION_WIRE_INPUT_FIELD_CHARS)
  assert.equal(patch.payload?.inputTruncated, true)

  // A command's title, a plan, a todo list, the questions asked and an
  // agent's prompt are drawn without opening the step, so they cross whole.
  for (const input of [
    { command: `cd app && cat <<EOF\n${body}EOF`, description: 'Write it' },
    { input: body },
    { plan: body },
    { todos: [{ content: body, status: 'pending' }] },
    { questions: [{ question: body }] },
    { prompt: body, description: 'Explore', subagent_type: 'Explore' },
  ]) {
    const kept = event(4, 'tool_started', { toolUseId: 'k', name: 'Tool', input })
    assert.equal(projectConversationEvent(kept), kept)
  }
})

test('a checkpoint crosses as its summary, which is all an event carries of it', () => {
  const completed = event(1, 'turn_completed', {
    turnId: 't',
    checkpointTurnSeq: 1,
    checkpointAvailable: true,
    checkpointSummary: { files: 3, addedLines: 40, removedLines: 2 },
  })
  assert.equal(projectConversationEvent(completed), completed)
  assert.equal(conversationWireFrame({ type: 'event', event: completed }).event, completed)
})

test('a projection projects to itself, so a relayed frame costs nothing the second time', () => {
  const stored = event(1, 'tool_output', { toolUseId: 'u', preview: 'x'.repeat(9000), output: 'x'.repeat(9000) })
  const once = projectConversationEvent(stored)
  assert.notEqual(once, stored)
  assert.equal(projectConversationEvent(once), once)
  assert.deepEqual(projectConversationEvent(structuredClone(once)), once)
})

test('a snapshot keeps its newest projected events within the page budget, the rest paging in', () => {
  // Sixty megabytes as stored, each step's result twice and a 100 KB file
  // write; projected, still more than one page.
  const events: ConversationEvent[] = []
  for (let index = 1; index <= 1200; index++) {
    const preview = `${index}:`.padEnd(4000, 'o')
    events.push(
      index % 2
        ? event(index, 'tool_output', { toolUseId: `u${index}`, preview, output: preview, truncated: true })
        : event(index, 'tool_started', {
            toolUseId: `u${index}`,
            name: 'Write',
            input: { file_path: 'a', content: 'w'.repeat(100_000) },
          }),
    )
  }
  const stored = events.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0)
  assert.ok(stored > 60 * 1024 * 1024)
  const parts = conversationSnapshotParts(snapshot(events), (part) => part)
  assert.ok(parts.bytes <= CONVERSATION_WIRE_PAGE_BYTES, `${parts.bytes} within the budget`)
  const frames = [
    ...parts.frames(
      function* (json) {
        yield json
      },
      () => true,
    ),
  ].map((json) => JSON.parse(json) as ConversationSnapshotFrame)
  const sent = frames.flatMap((frame) => frame.page.events)
  assert.equal(sent.at(-1)?.seq, 1200, 'the newest event is kept')
  assert.ok(sent.length < events.length)
  for (const frame of frames) {
    assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= CONVERSATION_MAX_FRAME_BYTES)
    assert.equal(frame.page.hasMore, true)
    assert.equal(frame.page.beforeCursor, sent[0].seq, 'older events page in from the oldest kept one')
  }
  assert.equal((sent.find((item) => item.type === 'tool_output')?.payload as Record<string, unknown>).output, undefined)
  // An earlier page is bounded the same way.
  const earlier = boundConversationPage({ events, hasMore: false, beforeCursor: 1 })
  assert.deepEqual(earlier.page.events, sent)
  assert.equal(earlier.page.beforeCursor, sent[0].seq)
  // A page within the budget crosses as it came, history flags and all.
  const small = { events: events.slice(0, 2), hasMore: true, beforeCursor: 1 }
  assert.deepEqual(boundConversationPage(small).page, { ...small, events: small.events.map(projectConversationEvent) })
})

test('one event larger than a whole page is sent, and ends its page', () => {
  const huge = event(9, 'content_delta', { text: 'z'.repeat(CONVERSATION_WIRE_PAGE_BYTES + 10) })
  const alone = boundConversationPage({ events: [event(8, 'turn_started', {}), huge], hasMore: false, beforeCursor: 8 })
  assert.deepEqual(alone.page.events, [huge])
  assert.equal(alone.page.beforeCursor, 9)
  assert.equal(alone.page.hasMore, true)
  // Not left for the page before, which would then hold it alone and leave
  // this one with only what followed it.
  const end = event(10, 'turn_completed', { turnId: 't' })
  const behind = boundConversationPage({
    events: [event(8, 'turn_started', {}), huge, end],
    hasMore: false,
    beforeCursor: 8,
  })
  assert.deepEqual(behind.page.events, [huge, end])
})

test('a catch-up is bounded by the page budget, so a replay is never larger than a snapshot', () => {
  // As stored; projected it is no larger.
  assert.equal(DEFAULT_TRANSCRIPT_LIMITS.catchUpBytes, CONVERSATION_WIRE_PAGE_BYTES)
})

test('a page is cut where a turn begins, mid-turn only when the newest turn alone is over the budget', () => {
  const step = (seq: number, turnId: string) =>
    event(seq, 'tool_output', { turnId, toolUseId: `u${seq}`, preview: 'p'.repeat(3900), truncated: true })
  const turnOf = (first: number, steps: number) => [
    event(first, 'user_message', { turnId: `t${first}`, text: 'go' }),
    ...Array.from({ length: steps }, (_, index) => step(first + 1 + index, `t${first}`)),
  ]
  // Three turns of about 1.2 MB: the budget ends inside the second newest.
  const events = [...turnOf(1, 300), ...turnOf(302, 300), ...turnOf(603, 300)]
  const bounded = boundConversationPage({ events, hasMore: false, beforeCursor: 1 })
  assert.equal(bounded.page.events[0].seq, 603, 'the page begins with the newest turn’s message')
  assert.equal(bounded.page.beforeCursor, 603)
  assert.equal(bounded.page.events.length, 301)
  // One turn of 2.4 MB: cut inside it, its newest steps kept.
  const giant = turnOf(1, 600)
  const inside = boundConversationPage({ events: giant, hasMore: false, beforeCursor: 1 })
  assert.equal(inside.page.events.at(-1)?.seq, 601)
  assert.ok(inside.page.events[0].type === 'tool_output' && inside.page.events.length < 600)
  assert.ok(inside.bytes <= CONVERSATION_WIRE_PAGE_BYTES)
})
