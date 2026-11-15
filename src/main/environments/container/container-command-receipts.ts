import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { writeFileAtomicSync } from '../../../server/platform/atomic-file'

// What main did for each container command a client sent (`containers.create`,
// `.push`, `.remove`), by the client's own command id, so a command sent again
// is answered with what the first one did and never carried out twice.
//
// A create can take half an hour (the first image build). The desktop's
// server may restart in that time (it runs in a process of its own), and its
// own memory of answers is bounded; the client then sends the command again
// under the same id, as it does for any method whose receipts outlive the
// server. This memory is main's, which outlives the server, and it is kept on
// disk, so a command that was running when Studio itself stopped is answered
// in words that send the person to Settings, never carried out again.

/** One command: what it asked (its fingerprint), when, and its answer once it had one. */
type Receipt = { id: string; fingerprint: string; at: number; answer?: unknown }

const MAX_RECEIPTS = 200
const KEPT_MS = 7 * 24 * 60 * 60_000

/** What a command still running when Studio stopped is answered with. */
export const CONTAINER_COMMAND_INTERRUPTED = {
  ok: false as const,
  message:
    'Studio stopped while this was being done, so it may be half done. See Settings › Machines › Containers for what was made.',
}

/** What a command is answered with when what it does cannot be recorded first: it is not carried out. */
export function containerCommandUnrecorded(path: string, error: unknown) {
  return {
    ok: false as const,
    message: `Studio could not record this request before carrying it out (${path}: ${messageOf(error)}), so it did nothing. Free some disk space or check that folder, then try again.`,
  }
}

/** What every command is answered with while the record of earlier ones cannot be read: nothing is carried out. */
export function containerCommandsUnreadable(path: string, error: unknown) {
  return {
    ok: false as const,
    message: `Studio could not read its record of container requests (${path}: ${messageOf(error)}), so it will not make, push or remove a container until that file is fixed or moved away. Nothing was done.`,
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const CONTAINER_COMMAND_CONFLICT = {
  ok: false as const,
  message: 'That request was sent again with different details. Try it once more.',
}

/** The same command, however its members were ordered. */
export function containerCommandFingerprint(call: string, args: unknown): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
              .sort()
              .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
          )
        : value
  return createHash('sha256')
    .update(`${call}\n${JSON.stringify(canonical(args))}`)
    .digest('base64url')
}

export class ContainerCommandReceipts {
  private readonly receipts = new Map<string, Receipt>()
  private readonly running = new Map<string, Promise<unknown>>()
  private readonly now: () => number
  private readonly write: (path: string, data: string) => void
  /** Why the record on disk could not be read: every command is refused, and the file is left as it is. */
  private unreadable: unknown = null

  constructor(
    private readonly options: {
      path: string | null
      now?: () => number
      /** How the record is written; an atomic, flushed replace unless a test says otherwise. */
      write?: (path: string, data: string) => void
    },
  ) {
    this.now = options.now ?? Date.now
    this.write = options.write ?? ((path, data) => writeFileAtomicSync(path, data, { mode: 0o600, durable: true }))
    if (!options.path) return
    let text: string
    try {
      text = readFileSync(options.path, 'utf8')
    } catch (error) {
      // None yet is a first run; anything else is a record that exists and cannot be read.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.unreadable = error
      return
    }
    try {
      const stored = JSON.parse(text) as { receipts?: unknown }
      if (!stored || typeof stored !== 'object' || !Array.isArray(stored.receipts))
        throw new Error('it is not a record of container requests')
      for (const entry of stored.receipts) {
        const receipt = entry as Partial<Receipt>
        if (typeof receipt.id !== 'string' || typeof receipt.fingerprint !== 'string' || typeof receipt.at !== 'number')
          continue
        // One that had no answer was running when Studio stopped.
        this.receipts.set(receipt.id, {
          id: receipt.id,
          fingerprint: receipt.fingerprint,
          at: receipt.at,
          answer: 'answer' in receipt ? receipt.answer : CONTAINER_COMMAND_INTERRUPTED,
        })
      }
    } catch (error) {
      // Read as empty, a command it holds could be carried out a second time:
      // refused instead, and the file kept for a person to look at.
      this.unreadable = error
      this.receipts.clear()
      return
    }
    this.prune()
  }

  /**
   * Carry out a command once per id: a second ask while it runs waits for it,
   * and one after it ended is answered with its answer, whether this process
   * or an earlier one carried it out.
   */
  run<T>(id: string, fingerprint: string, work: () => Promise<T>): Promise<T> {
    const pending = this.running.get(id)
    const known = this.receipts.get(id)
    if (known && known.fingerprint !== fingerprint) return Promise.resolve(CONTAINER_COMMAND_CONFLICT as T)
    if (pending) return pending as Promise<T>
    if (known && 'answer' in known) return Promise.resolve(known.answer as T)
    if (this.unreadable !== null)
      return Promise.resolve(containerCommandsUnreadable(this.options.path ?? '', this.unreadable) as T)
    // Recorded as started before anything is done: a command whose start is
    // not on disk could be carried out again after a restart, so it is not
    // carried out at all.
    this.receipts.set(id, { id, fingerprint, at: this.now() })
    const unsaved = this.save()
    if (unsaved !== null) {
      this.receipts.delete(id)
      return Promise.resolve(containerCommandUnrecorded(this.options.path ?? '', unsaved) as T)
    }
    const promise = work().then(
      (answer) => this.settle(id, answer),
      (error: unknown) => {
        // Thrown, not answered: forgotten, so the command may be tried again.
        this.receipts.delete(id)
        this.running.delete(id)
        this.save()
        throw error
      },
    )
    this.running.set(id, promise)
    return promise
  }

  private settle<T>(id: string, answer: T): T {
    this.running.delete(id)
    const receipt = this.receipts.get(id)
    if (receipt) receipt.answer = answer
    this.prune()
    this.save()
    return answer
  }

  private prune(): void {
    const oldest = this.now() - KEPT_MS
    for (const [id, receipt] of this.receipts)
      if (receipt.at < oldest && !this.running.has(id)) this.receipts.delete(id)
    for (const id of this.receipts.keys()) {
      if (this.receipts.size <= MAX_RECEIPTS) break
      if (!this.running.has(id)) this.receipts.delete(id)
    }
  }

  /**
   * Write the record whole (a temporary file renamed over it, flushed), or say
   * why not. An answer that cannot be written leaves its command recorded as
   * started, which after a restart is answered in words, never carried out again.
   */
  private save(): unknown {
    if (!this.options.path || this.unreadable !== null) return null
    try {
      this.write(this.options.path, `${JSON.stringify({ receipts: [...this.receipts.values()] })}\n`)
      return null
    } catch (error) {
      return error
    }
  }
}
