import { isRecord } from '../../../shared/records'
import { MAX_WEBSOCKET_MESSAGE_BYTES } from './websocket-frames'

// The canvas lane's wire (`canvas-live-boards`): one WebSocket between a paired
// desktop and the machine whose boards it edits, on which the desktop opens
// boards, sends the person's scenes and hears every accepted write, the agent's
// presence and the agent's `canvas.open`.
//
// What makes it different from the other lanes is size. A WebSocket message on
// the tailnet is at most 1 MiB, a board's drawing may be 25 MB and one picture
// on it 15 MB. So:
//
// - Pictures travel on their own, as `file` messages, once each way: a board's
//   scene names its pictures by id, and each side says which ids it already
//   holds, so a board full of screenshots costs its pictures once, not on every
//   push. The scene that names a picture always comes after the picture.
// - Any message past `CANVAS_LANE_PLAIN_BYTES` is cut into `part` messages,
//   each its own WebSocket message under the 1 MiB cap, and put back together
//   at the other end. Parts of one message are written back to back on one
//   socket, so the parts of two messages never interleave.
//
// Everything a message names is checked at the end it reaches: a part may not
// grow past `CANVAS_LANE_MAX_MESSAGE_BYTES`, and a board is a ref the canvas
// service would take from its own pane (`canvasRefOf`).

/** A message up to this goes as it is; past it, in parts. Kept well under the 1 MiB cap for the envelope. */
export const CANVAS_LANE_PLAIN_BYTES = 768 * 1024
/** The bytes of one part, before base64: 4/3 of this plus its envelope stays under the cap. */
const CANVAS_LANE_PART_BYTES = 576 * 1024
/**
 * The largest message the lane carries: a drawing at the 25 MB a commit may
 * hold, or one 15 MB picture, with room for the JSON around either.
 */
export const CANVAS_LANE_MAX_MESSAGE_BYTES = 32 * 1024 * 1024

// Checked once, where the numbers meet: a part has to be one message.
if (Math.ceil(CANVAS_LANE_PART_BYTES / 3) * 4 + 256 > MAX_WEBSOCKET_MESSAGE_BYTES) {
  throw new Error('A canvas lane part would not fit in one WebSocket message.')
}

/** A board ref as it crosses the lane: the far machine's workspace, and its store when it is another project's. */
export type CanvasLaneRef = { workspaceId: string; path: string; store?: string }

/** One message's text, as the WebSocket messages that carry it: itself, or its parts. */
export function canvasLaneMessages(message: Record<string, unknown>, streamId: () => number): string[] {
  const text = JSON.stringify(message)
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= CANVAS_LANE_PLAIN_BYTES) return [text]
  const stream = streamId()
  const parts: string[] = []
  const count = Math.ceil(bytes.length / CANVAS_LANE_PART_BYTES)
  for (let seq = 0; seq < count; seq += 1) {
    const slice = bytes.subarray(seq * CANVAS_LANE_PART_BYTES, (seq + 1) * CANVAS_LANE_PART_BYTES)
    parts.push(JSON.stringify({ type: 'part', stream, seq, last: seq === count - 1, data: slice.toString('base64') }))
  }
  return parts
}

/** Whether a message is too big for the lane at all, before it is cut up: the words say so instead. */
export function canvasLaneTooLarge(message: Record<string, unknown>): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(message), 'utf8') > CANVAS_LANE_MAX_MESSAGE_BYTES
  } catch {
    return true
  }
}

export type CanvasLaneAssembly =
  { kind: 'message'; message: Record<string, unknown> } | { kind: 'pending' } | { kind: 'error'; reason: string }

/**
 * Puts parted messages back together, one stream at a time. A part out of
 * order, a stream that starts before the last one ended, or a message past the
 * ceiling is an error: the lane has no use for a peer that sends either.
 */
export function createCanvasLaneAssembler(maxBytes: () => number = () => CANVAS_LANE_MAX_MESSAGE_BYTES) {
  let current: { stream: number; next: number; parts: Buffer[]; bytes: number } | null = null
  return {
    push(frame: Record<string, unknown>): CanvasLaneAssembly {
      if (frame.type !== 'part') return { kind: 'message', message: frame }
      const { stream, seq, last, data } = frame
      if (!Number.isInteger(stream) || !Number.isInteger(seq) || typeof data !== 'string' || typeof last !== 'boolean')
        return { kind: 'error', reason: 'A canvas part was not one this lane sends.' }
      if (seq === 0) {
        if (current) return { kind: 'error', reason: 'A canvas message began before the last one ended.' }
        current = { stream: stream as number, next: 0, parts: [], bytes: 0 }
      }
      if (!current || current.stream !== stream || current.next !== seq)
        return { kind: 'error', reason: 'A canvas part arrived out of order.' }
      const piece = Buffer.from(data, 'base64')
      current.bytes += piece.length
      if (current.bytes > maxBytes()) {
        current = null
        return { kind: 'error', reason: 'A canvas message was larger than this lane carries.' }
      }
      current.parts.push(piece)
      current.next += 1
      if (!last) return { kind: 'pending' }
      const text = Buffer.concat(current.parts).toString('utf8')
      current = null
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return { kind: 'error', reason: 'A canvas message was not JSON.' }
      }
      if (!isRecord(parsed) || parsed.type === 'part')
        return { kind: 'error', reason: 'A canvas message was not one this lane sends.' }
      return { kind: 'message', message: parsed }
    },
  }
}

/** The ids of a scene's pictures, from a record a peer sent: strings only, and not too many. */
export function canvasLaneFileIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 256)
    .slice(0, 20_000)
}

/** A peer's board ref, read member by member. Its path and store are checked again where they are used. */
export function canvasLaneRefOf(value: unknown): CanvasLaneRef | null {
  if (!isRecord(value)) return null
  if (typeof value.workspaceId !== 'string' || typeof value.path !== 'string') return null
  if (value.store !== undefined && typeof value.store !== 'string') return null
  return {
    workspaceId: value.workspaceId,
    path: value.path,
    ...(typeof value.store === 'string' ? { store: value.store } : {}),
  }
}
