// A message a person wrote in an open chat and asked to go out later: at a
// time they picked, into that chat, as if they had pressed Send then. Main
// keeps them (src/main/scheduled-messages/scheduled-messages.ts) and sends
// them through the chat's own send path, which brings back an agent that is
// no longer running; the chat's composer tray draws its own
// (agentChat/scheduledMessages.tsx).
//
// What a scheduled message carries is the text alone: a picture or a file
// attached by path belongs to the moment it was attached, and is not kept on
// this computer's disk for later. A message a paired machine queued for a
// turn's end is the exception: that machine handed over its pictures and files
// with it, which this computer keeps until the message goes (`carries`).

import { isProviderWideUsageWindow, type UsageLimitSnapshot } from './usage-limits'
import type {
  ScheduledMessage,
  ScheduledMessageChat,
  ScheduledMessagesState,
} from '../../packages/studio-protocol/src/public'

export { MAX_SCHEDULED_MESSAGE_LENGTH, parseScheduledMessageUpdate } from '../../packages/studio-protocol/src/public'
export type {
  ScheduledMessage,
  ScheduledMessageCarries,
  ScheduledMessageChat,
  ScheduledMessageHoldAnswer,
  ScheduledMessageHoldRequest,
  ScheduledMessagesState,
  ScheduledMessageUpdate,
} from '../../packages/studio-protocol/src/public'

/**
 * After a limit's reset, how long a message waiting on it waits more: the
 * provider's clock and this computer's can disagree by seconds, and a turn
 * sent on the stroke of the reset can still be refused.
 */
export const LIMIT_RESET_SEND_BUFFER_MS = 60_000

/**
 * When a message to go once the provider's limit lifts would go, from what the
 * provider last said: after the latest reset of the account-wide windows at
 * their limit, or, with none at its limit, of the soonest one ahead. Null when
 * no window says when it resets.
 */
export function limitResetSendAt(snapshot: UsageLimitSnapshot | null, now: number): number | null {
  const ahead = (snapshot?.windows ?? []).filter(
    (window) => isProviderWideUsageWindow(window) && window.resetsAt !== null && window.resetsAt > now,
  )
  const limited = ahead.filter((window) => window.status === 'rejected')
  const resets = (limited.length ? limited : ahead).map((window) => window.resetsAt!)
  if (!resets.length) return null
  const reset = limited.length ? Math.max(...resets) : Math.min(...resets)
  return reset + LIMIT_RESET_SEND_BUFFER_MS
}

/** The chat's scheduled messages, soonest first. */
export function selectChatScheduledMessages(
  state: ScheduledMessagesState | null,
  chat: ScheduledMessageChat,
): ScheduledMessage[] {
  return (state?.messages ?? [])
    .filter((message) => message.workspaceId === chat.workspaceId && message.agentId === chat.agentId)
    .sort((a, b) => a.sendAt - b.sendAt)
}

/** Ids are minted by the app and short; this only keeps a strange one out. */
const MAX_ID_LENGTH = 200

export function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

export function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}
