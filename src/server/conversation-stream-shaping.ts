import {
  CONVERSATION_MAX_FRAME_BYTES,
  type ConversationServerFrame,
} from '../../packages/conversation-protocol/src/public'
import type { ConversationEvent, ConversationPage } from '../shared/conversation-runtime'

// What a conversation sends over a wire, shared by every transport that
// carries one: the window's IPC, the Studio protocol's sockets and the tailnet
// lane (and so the phone and a paired desktop). Pure, so no transport has
// shaping of its own: where a snapshot splits, what an event carries, which
// deltas are one message. Server code, not shared code: it measures with
// Node's Buffer, and no renderer streams a conversation out.
//
// The stored log stays whole. What crosses is a projection of it: each event
// without the bodies a reader fetches when it opens them (`toolDetail`), and
// a snapshot or page of the newest of those within a budget, older ones
// behind `loadEarlier`. Everything here is readable by every client in the
// field, so it is the one wire shape rather than an option a client asks for.

/**
 * The bytes of projected events one snapshot or earlier page carries. Its
 * newest events are kept within this and anything older pages in. A long
 * chat's newest turns, which is what a reader opens it to see, fit; a chat of
 * heavy turns sends fewer of them, never megabytes before its first paint.
 */
export const CONVERSATION_WIRE_PAGE_BYTES = 2 * 1024 * 1024
// The target size of one snapshot part, leaving room for its envelope.
const SNAPSHOT_PART_BYTES = CONVERSATION_MAX_FRAME_BYTES - 32 * 1024

/**
 * Characters of a tool's result an event carries: the runtime's stored
 * preview (`TOOL_PREVIEW_CHARS`), which it cut from the end of output that
 * streamed and from the start of a one-shot result. Longer text, from an
 * event that did not go through the runtime's preview, is cut the same way.
 */
export const CONVERSATION_WIRE_PREVIEW_CHARS = 4000
/**
 * Characters of a file change's body, or of a command, a tool's input
 * carries. The row's title reads the head; the rest is the detail, read when
 * the row is opened. What the collapsed transcript draws from an input (a
 * todo list, a plan, the questions asked, an agent's description) is under
 * other names and stays whole.
 */
export const CONVERSATION_WIRE_INPUT_FIELD_CHARS = 1024
// The names an input's file-change bodies and commands go by, at its top
// level and in each of its `edits`: the ones `deriveEditHunks` reads, a
// Codex patch (`input`), and a command.
const INPUT_BODY_FIELDS = [
  'content',
  'old_string',
  'new_string',
  'oldText',
  'newText',
  'patch',
  'input',
  'command',
  'cmd',
]
// Pictures a step returned, as paths on the machine that ran it: the runtime
// keeps eight, and a path is a path.
const MAX_WIRE_IMAGES = 8
const MAX_WIRE_IMAGE_PATH_CHARS = 4096

type Payload = Record<string, unknown>

/** `text` cut to `chars`: its end while it is still streaming, its start once it is whole. */
function clipText(text: string, chars: number, fromEnd: boolean): string {
  return fromEnd ? text.slice(-chars) : text.slice(0, chars)
}

function toolOutputForWire(payload: Payload): Payload {
  let next = payload
  const set = (key: string, value: unknown) => {
    if (next === payload) next = { ...payload }
    next[key] = value
  }
  const fromEnd = payload.partial === true
  let cut = false
  for (const key of ['preview', 'output'] as const) {
    const value = payload[key]
    if (value === undefined || value === null) continue
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (text.length <= CONVERSATION_WIRE_PREVIEW_CHARS) continue
    set(key, clipText(text, CONVERSATION_WIRE_PREVIEW_CHARS, fromEnd))
    cut = true
  }
  // One copy of the text: the stored result carries it as `preview` and again
  // as `output` for readers that know one name, and every reader reads
  // `preview` first.
  if (typeof next.preview === 'string' && next.output === next.preview) {
    const { output: _copy, ...rest } = next
    next = rest
  }
  if (cut) set('truncated', true)
  const images = payload.images
  if (
    Array.isArray(images) &&
    (images.length > MAX_WIRE_IMAGES ||
      images.some((path) => typeof path !== 'string' || path.length > MAX_WIRE_IMAGE_PATH_CHARS))
  )
    set(
      'images',
      images
        .filter((path): path is string => typeof path === 'string' && path.length <= MAX_WIRE_IMAGE_PATH_CHARS)
        .slice(0, MAX_WIRE_IMAGES),
    )
  return next
}

/** An input's file-change bodies and command, each cut to its head; null when nothing needed cutting. */
function clipInputBodies(input: Payload): Payload | null {
  let next: Payload | null = null
  for (const key of INPUT_BODY_FIELDS) {
    const value = input[key]
    if (typeof value !== 'string' || value.length <= CONVERSATION_WIRE_INPUT_FIELD_CHARS) continue
    next ??= { ...input }
    next[key] = value.slice(0, CONVERSATION_WIRE_INPUT_FIELD_CHARS)
  }
  if (Array.isArray(input.edits)) {
    let edits: unknown[] | null = null
    input.edits.forEach((edit, index) => {
      if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return
      const clipped = clipInputBodies(edit as Payload)
      if (!clipped) return
      edits ??= [...(input.edits as unknown[])]
      edits[index] = clipped
    })
    if (edits) {
      next ??= { ...input }
      next.edits = edits
    }
  }
  return next
}

function toolStartedForWire(payload: Payload): Payload {
  const input = payload.input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return payload
  const clipped = clipInputBodies(input as Payload)
  return clipped ? { ...payload, input: clipped, inputTruncated: true } : payload
}

// Each event's projection, by the event itself: every subscriber of a chat is
// sent the same event objects, and a projection is the same for all of them.
// A projection projects to itself, so a frame that went through once (a
// paired machine's, relayed to a window here) costs nothing the second time.
const projections = new WeakMap<ConversationEvent, ConversationEvent>()

/**
 * An event as it crosses a wire: a tool's result once, within its preview,
 * and a tool's input without its file-change bodies, both marked as cut
 * (`truncated`, `inputTruncated`) so a reader fetches the whole with
 * `toolDetail` when it opens the step. Every other event is sent as stored.
 * The stored event is never changed.
 */
export function projectConversationEvent(event: ConversationEvent): ConversationEvent {
  if ((event.type !== 'tool_output' && event.type !== 'tool_started') || !event.payload) return event
  const known = projections.get(event)
  if (known) return known
  const payload = event.type === 'tool_output' ? toolOutputForWire(event.payload) : toolStartedForWire(event.payload)
  const projected = payload === event.payload ? event : { ...event, payload }
  projections.set(event, projected)
  projections.set(projected, projected)
  return projected
}

/**
 * The text one `chunk` frame carries. A chunk's text is re-escaped inside its
 * envelope; at 3 bytes per UTF-16 unit at worst this stays well under the
 * frame cap.
 */
export const CONVERSATION_CHUNK_CHARS = 48_000

// What each event measures as JSON, by the event itself: every subscriber's
// snapshot of a chat holds the same events, and measuring them is a
// stringify each. A merged delta run grows in place, and its seq moves with
// it, so a size is good only while the seq it was taken at holds.
const measured = new WeakMap<ConversationEvent, { seq: number | undefined; bytes: number }>()

function eventBytes(event: ConversationEvent): number {
  const known = measured.get(event)
  if (known && known.seq === event.seq) return known.bytes
  const bytes = Buffer.byteLength(JSON.stringify(event))
  measured.set(event, { seq: event.seq, bytes })
  return bytes
}

export type ConversationSnapshotFrame = Extract<ConversationServerFrame, { type: 'snapshot' }> & {
  page: ConversationPage
}

/**
 * A merge key for a text delta whose payload is only its text and turn, or
 * null. Two deltas with the same key are one message, and the stored log
 * merges exactly these runs too.
 */
export function conversationDeltaKey(event: ConversationEvent): string | null {
  if (event.type !== 'content_delta' && event.type !== 'reasoning_delta') return null
  const payload = event.payload
  if (!payload || typeof payload.text !== 'string') return null
  for (const key of Object.keys(payload)) if (key !== 'text' && key !== 'turnId') return null
  return JSON.stringify([
    event.type,
    event.sessionId,
    event.workspaceId,
    event.agentId,
    event.providerId,
    event.modelId,
    payload.turnId ?? null,
  ])
}

/**
 * A page as it crosses a wire: its events projected, and only the newest of
 * them that fit the page budget. Anything older is left to `loadEarlier`,
 * with the page's `beforeCursor` moved to match. Measured from the newest
 * back, and only as far as the budget reaches: what is left behind is never
 * measured at all. One event larger than a whole page is kept, and ends the
 * page: otherwise the page before it would hold only what came after it, and
 * the page that pages it in would hold it alone.
 */
export function boundConversationPage(
  page: ConversationPage,
  budget: number = CONVERSATION_WIRE_PAGE_BYTES,
): { page: ConversationPage; bytes: number; sizes: number[] } {
  const events = page.events
  const kept: ConversationEvent[] = []
  const sizes: number[] = []
  let bytes = 0
  for (let index = events.length - 1; index >= 0; index--) {
    const event = projectConversationEvent(events[index])
    const size = eventBytes(event)
    const over = kept.length > 0 && bytes + size > budget
    if (over && size <= budget) break
    bytes += size
    kept.push(event)
    sizes.push(size)
    if (over) break
  }
  kept.reverse()
  sizes.reverse()
  const changed = kept.length !== events.length || kept.some((event, index) => event !== events[index])
  if (!changed) return { page, bytes, sizes }
  if (kept.length === events.length) return { page: { ...page, events: kept }, bytes, sizes }
  // Paging back returns what ends before the cursor. The oldest kept event's
  // own sequence is that boundary even for a merged run, which is numbered
  // with its last delta and so covers everything after the previous record.
  const boundary = kept[0]?.seq ?? (events.at(-1)?.seq ?? 0) + 1
  return { page: { ...page, events: kept, hasMore: true, beforeCursor: boundary }, bytes, sizes }
}

/**
 * A conversation frame as it crosses a wire whole (the window's IPC, a live
 * frame on a socket, a paired machine's frame relayed to a window): an
 * event projected, a snapshot bounded. Any other frame is sent as it is.
 */
export function conversationWireFrame<F extends { type: string }>(frame: F): F {
  if (frame.type === 'event') {
    const event = (frame as unknown as { event: ConversationEvent }).event
    const projected = projectConversationEvent(event)
    return projected === event ? frame : { ...frame, event: projected }
  }
  if (frame.type === 'snapshot') {
    const page = (frame as unknown as { page: ConversationPage }).page
    const bounded = boundConversationPage(page).page
    return bounded === page ? frame : { ...frame, page: bounded }
  }
  return frame
}

/**
 * A snapshot as the frames that carry it: its page bounded
 * (`boundConversationPage`) and split into parts that each fit one frame. A
 * snapshot that fits one frame is sent whole, without `part`.
 */
export function conversationSnapshotParts(
  frame: ConversationSnapshotFrame,
  redact: (part: ConversationSnapshotFrame) => ConversationSnapshotFrame,
): {
  bytes: number
  frames(wire: (json: string) => Generator<string>, current: () => boolean): Generator<string>
} {
  const { page, bytes, sizes } = boundConversationPage(frame.page)
  const events = page.events
  const parts: ConversationEvent[][] = []
  let size = 0
  for (let index = 0; index < events.length; index++) {
    if (!parts.length || (size + sizes[index] > SNAPSHOT_PART_BYTES && parts.at(-1)!.length)) {
      parts.push([])
      size = 0
    }
    parts.at(-1)!.push(events[index])
    size += sizes[index]
  }
  if (!parts.length) parts.push([])
  return {
    bytes,
    *frames(wire, current) {
      for (let index = 0; index < parts.length; index++) {
        if (!current()) return
        yield* wire(
          JSON.stringify(
            redact({
              ...frame,
              page: { ...page, events: parts[index] },
              ...(parts.length > 1 ? { part: { index, total: parts.length } } : {}),
            }),
          ),
        )
      }
    },
  }
}
