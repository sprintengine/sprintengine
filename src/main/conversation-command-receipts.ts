import { openConfinedExistingFile } from './conversation-file-access'
import { conversationConfinementRoot } from './workspace-store'
import type { ConversationLogRecord } from './conversation-event-log'
import type { ConversationSessionActionResult } from '../shared/conversation-runtime'

/**
 * A chat's command receipts, kept in the chat's own log.
 *
 * A receipt is a line of the transcript that is not an event: `{"receipt":
 * {...}}`, with no `type`, which every transcript reader passes over. It is
 * written in the same append as what the command committed, so the log never
 * holds a command's effect without its receipt or the other way round:
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

/** How many receipts of one chat are kept in memory: retries come within minutes, not thousands of commands later. */
const MAX_RECEIPTS = 1024
const PREFIX = Buffer.from('{"receipt":')
const READ_CHUNK = 1024 * 1024

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
  // Moved to the end: the oldest command is the one let go of.
  receipts.delete(line.id)
  receipts.set(line.id, {
    ...(fingerprint ? { fingerprint } : {}),
    ...(turnId ? { turnId } : {}),
    ...(answer ? { answer } : {}),
  })
  while (receipts.size > MAX_RECEIPTS) receipts.delete(receipts.keys().next().value!)
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

/**
 * Every receipt in one chat's log, oldest first, the newest {@link MAX_RECEIPTS}
 * kept. Only lines that open as a receipt are parsed, so a long chat costs one
 * pass over its bytes. A chat with no log yet has none.
 */
export async function readConversationReceipts(
  root: string,
  path: string,
): Promise<Map<string, ConversationCommandReceipt>> {
  const receipts = new Map<string, ConversationCommandReceipt>()
  let file: Awaited<ReturnType<typeof openConfinedExistingFile>>
  try {
    file = await openConfinedExistingFile(await conversationConfinementRoot(root, path), path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return receipts
    throw error
  }
  try {
    const buffer = Buffer.alloc(READ_CHUNK)
    let carry = Buffer.alloc(0)
    let position = 0
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, READ_CHUNK, position)
      if (bytesRead === 0) break
      position += bytesRead
      const data =
        carry.length > 0 ? Buffer.concat([carry, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead)
      let start = 0
      for (let end = data.indexOf(0x0a, start); end !== -1; end = data.indexOf(0x0a, start)) {
        foldLine(receipts, data.subarray(start, end))
        start = end + 1
      }
      // The rest is a line still being read, or a torn last line, which is no receipt.
      carry = Buffer.from(data.subarray(start))
    }
  } finally {
    await file.close()
  }
  return receipts
}

function foldLine(receipts: Map<string, ConversationCommandReceipt>, line: Buffer): void {
  if (line.length < PREFIX.length || !line.subarray(0, PREFIX.length).equals(PREFIX)) return
  try {
    foldReceiptRecord(receipts, JSON.parse(line.toString('utf8')))
  } catch {
    // A torn or damaged line is no receipt.
  }
}
