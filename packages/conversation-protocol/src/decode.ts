import { CONVERSATION_MAX_FRAME_BYTES } from './index.js'
import {
  isKnownConversationServerFrameType,
  parseConversationServerFrame,
  type ConversationParsedServerFrame,
} from './serverFrames.js'

// How a client reads what a desktop sends it, a frame at a time, without
// trusting it and without breaking on what a newer desktop adds:
//
// - Members this build does not know are dropped, never refused.
// - A frame of a type this build does not know decodes to an `unknown`
//   marker the client passes over; it is not mistaken for a broken frame.
// - An event of a type this build does not know is an event all the same
//   (`ConversationWireEvent.type` is any event-shaped name), so its sequence
//   number still moves the client's cursor; the client skips what it cannot
//   show.
// - A listed chat whose phase this build does not know is listed with the
//   phase `unknown` rather than dropped.
//
// A frame of a known type in the wrong shape is null: the client neither
// applies half of it nor advances past it. Every limit here is the desktop's
// own, so a frame the desktop could send is never refused for its size.

/** The largest frame a desktop sends once its chunks are joined. */
export const CONVERSATION_MAX_JOINED_FRAME_BYTES = 32 * 1024 * 1024
/** The most parts a snapshot arrives in. */
export const CONVERSATION_MAX_SNAPSHOT_PARTS = 1024

/** A frame of a type this build does not know: the client passes over it. */
export type ConversationUnknownFrame = { type: 'unknown'; frameType: string }

/** What a client reads from one frame: a frame it knows, or the marker for one it does not. */
export type ConversationDecodedFrame = ConversationParsedServerFrame | ConversationUnknownFrame

/** The UTF-8 length of a string, without TextEncoder or Buffer: this runs in a phone and a browser too. */
export function conversationUtf8Length(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

/** One frame as the desktop sent it, its JSON text: decoded, marked unknown, or null when it is broken. */
export function decodeConversationServerFrame(raw: string): ConversationDecodedFrame | null {
  // At most three bytes a UTF-16 unit: a frame that short cannot be over, and is not counted.
  if (
    raw.length > CONVERSATION_MAX_JOINED_FRAME_BYTES ||
    (raw.length * 3 > CONVERSATION_MAX_JOINED_FRAME_BYTES &&
      conversationUtf8Length(raw) > CONVERSATION_MAX_JOINED_FRAME_BYTES)
  )
    return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const type = (value as { type?: unknown }).type
  if (typeof type !== 'string' || !type) return null
  if (!isKnownConversationServerFrameType(value)) return { type: 'unknown', frameType: type.slice(0, 64) }
  const frame = parseConversationServerFrame(value)
  if (!frame) return null
  if (frame.type === 'chunk' && (raw.length > CONVERSATION_MAX_FRAME_BYTES || frame.total > 1024)) return null
  if (frame.type === 'snapshot' && frame.part && frame.part.total > CONVERSATION_MAX_SNAPSHOT_PARTS) return null
  return frame
}
