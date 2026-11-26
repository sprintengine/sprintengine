import type { ChatLogs } from '../server/db/chat-logs'
import type { ConversationLogRecord } from './conversation-event-log'
import type { ConversationSessionActionResult } from '../shared/conversation-runtime'

/**
 * A chat's command receipts, kept with the chat's log (`chat_receipts`).
 *
 * A receipt is written in the same transaction as what the command
 * committed, so the log never holds a command's effect without its receipt
 * or the other way round:
 *
 * - A turn command (a send, a steer, a message to one sub-agent) is accepted
 *   when its `user_message` is committed, and its first receipt line, naming
 *   the turn it opened, is in that same write. The provider turn runs after,
 *   and the command's answer is written when the turn has ended.
 * - A control command (an answer to a request, a permission or model change,
 *   a Stop) acts on the live agent process; its answer is written once the
 *   action has given it.
 *
 * The latest line for an id is the receipt. A command id met again is
 * answered from it and never run twice.
 */

/** A command's answer as the log keeps it: the session summary is read again when it is given. */
export type ConversationStoredAnswer = { ok: true; notice?: string } | { ok: false; message: string; code?: string }

export type ConversationCommandReceipt = {
  /** What the caller said the command was, to refuse another command under the same id. */
  fingerprint?: string
  /** A turn command's turn: committed with its message. */
  turnId?: string
  /** The command's answer; absent while a turn command's turn has not ended. */
  answer?: ConversationStoredAnswer
}

type ReceiptLine = { id: string; at: number; fp?: string; turnId?: string; answer?: ConversationStoredAnswer }

export function receiptRecord(
  commandId: string,
  at: number,
  receipt: Omit<ConversationCommandReceipt, 'answer'> & { answer?: ConversationSessionActionResult },
): ConversationLogRecord {
  const line: ReceiptLine = {
    id: commandId,
    at,
    ...(receipt.fingerprint ? { fp: receipt.fingerprint } : {}),
    ...(receipt.turnId ? { turnId: receipt.turnId } : {}),
    ...(receipt.answer ? { answer: storedAnswer(receipt.answer) } : {}),
  }
  return { receipt: line }
}

/** The part of an answer worth keeping: a session summary is stale by the time it is asked for again. */
function storedAnswer(result: ConversationSessionActionResult): ConversationStoredAnswer {
  if (result.ok) return result.notice ? { ok: true, notice: result.notice } : { ok: true }
  return { ok: false, message: result.message, ...(result.code ? { code: result.code } : {}) }
}

/** Fold one receipt record into `receipts`; false when it is not one. */
export function foldReceiptRecord(receipts: Map<string, ConversationCommandReceipt>, record: unknown): boolean {
  const line = readReceiptLine(record)
  if (!line) return false
  const known = receipts.get(line.id)
  const fingerprint = line.fp ?? known?.fingerprint
  const turnId = line.turnId ?? known?.turnId
  const answer = line.answer ?? known?.answer
  receipts.set(line.id, {
    ...(fingerprint ? { fingerprint } : {}),
    ...(turnId ? { turnId } : {}),
    ...(answer ? { answer } : {}),
  })
  return true
}

function readReceiptLine(record: unknown): ReceiptLine | null {
  if (!record || typeof record !== 'object') return null
  const line = (record as { receipt?: unknown }).receipt
  if (!line || typeof line !== 'object') return null
  const { id, at, fp, turnId, answer } = line as Record<string, unknown>
  if (typeof id !== 'string' || !id || typeof at !== 'number') return null
  if (fp !== undefined && typeof fp !== 'string') return null
  if (turnId !== undefined && typeof turnId !== 'string') return null
  const stored = answer === undefined ? undefined : readAnswer(answer)
  if (stored === null) return null
  return {
    id,
    at,
    ...(fp ? { fp } : {}),
    ...(turnId ? { turnId } : {}),
    ...(stored ? { answer: stored } : {}),
  }
}

function readAnswer(value: unknown): ConversationStoredAnswer | null {
  if (!value || typeof value !== 'object') return null
  const { ok, notice, message, code } = value as Record<string, unknown>
  if (ok === true) return typeof notice === 'string' ? { ok: true, notice } : { ok: true }
  if (ok !== false || typeof message !== 'string') return null
  return { ok: false, message, ...(typeof code === 'string' ? { code } : {}) }
}

/** Every receipt in one chat's log, oldest first. A chat with no log yet has none. */
export async function readConversationReceipts(
  history: Pick<ChatLogs, 'receipts'>,
  root: string,
  path: string,
): Promise<Map<string, ConversationCommandReceipt>> {
  const receipts = new Map<string, ConversationCommandReceipt>()
  for (const receipt of await history.receipts(path, root)) foldReceiptRecord(receipts, { receipt })
  return receipts
}
