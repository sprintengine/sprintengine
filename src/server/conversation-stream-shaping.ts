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
 * The most one event takes on a wire: a frame, less room for its envelope,
 * so no event is ever chunked and no single event can hold a reader, or a
 * snapshot, to ransom. An event larger than this as stored crosses with its
 * longest text cut to fit and `wireClipped: true`; a reader reads it whole
 * with the conversation's event read (`conversation.event`, the lane's
 * `getEvent`). A long answer, a pasted log, a large approval are the events
 * this reaches; none in a year of this machine's chats was a quarter of it.
 */
export const CONVERSATION_WIRE_EVENT_BYTES = SNAPSHOT_PART_BYTES
// The least a cut string keeps, and the depth a cut walks into a payload.
const MIN_CLIPPED_CHARS = 256
const MAX_CLIP_DEPTH = 16

/**
 * Characters of a tool's result an event carries: the runtime's stored
 * preview (`TOOL_PREVIEW_CHARS`), which it cut from the end of output that
 * streamed and from the start of a one-shot result. Longer text, from an
 * event that did not go through the runtime's preview, is cut the same way.
 */
export const CONVERSATION_WIRE_PREVIEW_CHARS = 4000
/**
 * Characters of a file change's body a tool's input carries; the rest is the
 * detail, read when the row is opened. Only bodies are cut: what the closed
 * transcript draws from an input (a command's title, a todo list, a plan,
 * the questions asked, an agent's description) is under other names and
 * stays whole.
 */
export const CONVERSATION_WIRE_INPUT_FIELD_CHARS = 1024
// The names an input's file-change bodies go by, at its top level and in each
// of its `edits`: the ones `deriveEditHunks` reads, and a Codex patch, which
// is an `input` that begins as one.
const INPUT_BODY_FIELDS = ['content', 'old_string', 'new_string', 'oldText', 'newText', 'patch', 'input']
const PATCH_INPUT = /^\*\*\* Begin Patch/u
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
  // A result the runtime kept no detail for (no step id) has nothing to read
  // back whole: its text crosses as it is, but once, within one event's
  // bound (`capEvent`), and its pictures as any step's.
  const detailed = typeof payload.toolUseId === 'string'
  let next = detailed ? payload : withoutCopy(payload)
  const set = (key: string, value: unknown) => {
    if (next === payload) next = { ...payload }
    next[key] = value
  }
  const fromEnd = payload.partial === true
  let cut = false
  for (const key of detailed ? (['preview', 'output'] as const) : []) {
    const value = payload[key]
    if (value === undefined || value === null) continue
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (text.length <= CONVERSATION_WIRE_PREVIEW_CHARS) continue
    set(key, clipText(text, CONVERSATION_WIRE_PREVIEW_CHARS, fromEnd))
    cut = true
  }
  next = withoutCopy(next)
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

/** An input's file-change bodies, each cut to its head; null when nothing needed cutting. */
function clipInputBodies(input: Payload): Payload | null {
  let next: Payload | null = null
  for (const key of INPUT_BODY_FIELDS) {
    const value = input[key]
    if (typeof value !== 'string' || value.length <= CONVERSATION_WIRE_INPUT_FIELD_CHARS) continue
    if (key === 'input' && !PATCH_INPUT.test(value)) continue
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

// One copy of the text: the stored result carries it as `preview` and again
// as `output` for readers that know one name, and every reader reads
// `preview` first.
function withoutCopy(payload: Payload): Payload {
  if (typeof payload.preview !== 'string' || payload.output !== payload.preview) return payload
  const { output: _copy, ...rest } = payload
  return rest
}

function toolStartedForWire(payload: Payload): Payload {
  const input = payload.input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return payload
  const clipped = clipInputBodies(input as Payload)
  return clipped ? { ...payload, input: clipped, inputTruncated: true } : payload
}

/** `value` with every string longer than `chars` cut to its head. */
function clipStrings(value: unknown, chars: number, depth = 0): unknown {
  if (typeof value === 'string') return value.length > chars ? value.slice(0, chars) : value
  if (!value || typeof value !== 'object' || depth >= MAX_CLIP_DEPTH) return value
  if (Array.isArray(value)) return value.map((item) => clipStrings(item, chars, depth + 1))
  return Object.fromEntries(
    Object.entries(value as Payload).map(([key, item]) => [key, clipStrings(item, chars, depth + 1)]),
  )
}

function longestString(value: unknown, depth = 0): number {
  if (typeof value === 'string') return value.length
  if (!value || typeof value !== 'object' || depth >= MAX_CLIP_DEPTH) return 0
  let longest = 0
  for (const item of Array.isArray(value) ? value : Object.values(value as Payload))
    longest = Math.max(longest, longestString(item, depth + 1))
  return longest
}

/**
 * An event within `CONVERSATION_WIRE_EVENT_BYTES`: as it is when it fits,
 * else with its longest strings cut to the longest length that fits (found
 * by halving), else, for a payload whose bulk is not text, with only its own
 * plain members. Marked `wireClipped` either way.
 */
function capEvent(event: ConversationEvent): ConversationEvent {
  if (!event.payload || eventBytes(event) <= CONVERSATION_WIRE_EVENT_BYTES) return event
  const sized = (payload: unknown) =>
    Buffer.byteLength(JSON.stringify({ ...event, payload: { ...(payload as Payload), wireClipped: true } }))
  let fits = MIN_CLIPPED_CHARS
  if (sized(clipStrings(event.payload, fits)) <= CONVERSATION_WIRE_EVENT_BYTES) {
    let over = longestString(event.payload)
    while (over - fits > 1) {
      const middle = Math.floor((fits + over) / 2)
      if (sized(clipStrings(event.payload, middle)) <= CONVERSATION_WIRE_EVENT_BYTES) fits = middle
      else over = middle
    }
    return { ...event, payload: { ...(clipStrings(event.payload, fits) as Payload), wireClipped: true } }
  }
  const plain = Object.entries(event.payload).filter(([, value]) => value === null || typeof value !== 'object')
  return {
    ...event,
    payload: { ...(clipStrings(Object.fromEntries(plain), MIN_CLIPPED_CHARS) as Payload), wireClipped: true },
  }
}

// Each event's projection, by the event itself and the sequence it was
// projected at: every live subscriber of a chat is sent the same event
// objects, so a live event is projected once for all of them (a page is read
// afresh for each reader, and projected for it), while a merged run of deltas
// grows in place and moves its sequence as it does. A projection projects to
// itself, so a frame that went through once (a paired machine's, relayed to a
// window here) costs nothing the second time.
const projections = new WeakMap<ConversationEvent, { seq: number | undefined; projected: ConversationEvent }>()

/**
 * An event as it crosses a wire: a tool's result once, within its preview,
 * and a tool's input without its file-change bodies, both marked as cut
 * (`truncated`, `inputTruncated`) so a reader fetches the whole with
 * `toolDetail` when it opens the step; and any event within one frame
 * (`CONVERSATION_WIRE_EVENT_BYTES`), marked `wireClipped` when it was cut.
 * Every other event is sent as stored, and the stored event is never changed.
 */
export function projectConversationEvent(event: ConversationEvent): ConversationEvent {
  const known = projections.get(event)
  if (known && known.seq === event.seq) return known.projected
  let projected = event
  if ((event.type === 'tool_output' || event.type === 'tool_started') && event.payload) {
    const payload = event.type === 'tool_output' ? toolOutputForWire(event.payload) : toolStartedForWire(event.payload)
    if (payload !== event.payload) projected = { ...event, payload }
  }
  projected = capEvent(projected)
  projections.set(event, { seq: event.seq, projected })
  if (projected !== event) projections.set(projected, { seq: projected.seq, projected })
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
 * with the page's `beforeCursor` moved to match. The cut falls where a turn
 * begins, so the oldest turn shown has its message and every step's start:
 * mid-turn only when the newest turn alone is over the budget. Measured from
 * the newest back, and only as far as the budget reaches: what is left
 * behind is never measured at all. Every projected event is within one
 * frame, so a page always holds many.
 */
export function boundConversationPage(
  page: ConversationPage,
  budget: number = CONVERSATION_WIRE_PAGE_BYTES,
): { page: ConversationPage; bytes: number; sizes: number[] } {
  const events = page.events
  const kept: ConversationEvent[] = []
  const sizes: number[] = []
  let bytes = 0
  // How many of the newest events reach back to the oldest turn kept whole.
  let whole = 0
  let wholeBytes = 0
  let over = false
  for (let index = events.length - 1; index >= 0; index--) {
    const event = projectConversationEvent(events[index])
    const size = eventBytes(event)
    over = kept.length > 0 && bytes + size > budget
    if (over) break
    bytes += size
    kept.push(event)
    sizes.push(size)
    if (event.type === 'user_message') {
      whole = kept.length
      wholeBytes = bytes
    }
  }
  // Cut back to the oldest whole turn.
  if (over && whole > 0 && whole < kept.length) {
    kept.length = whole
    sizes.length = whole
    bytes = wholeBytes
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
