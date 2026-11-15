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

  constructor(private readonly options: { path: string | null; now?: () => number }) {
    this.now = options.now ?? Date.now
    if (!options.path) return
    try {
      const stored = JSON.parse(readFileSync(options.path, 'utf8')) as { receipts?: unknown }
      for (const entry of Array.isArray(stored.receipts) ? stored.receipts : []) {
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
    } catch {
      // None yet, or unreadable: nothing is known, and nothing is lost but the memory.
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
    this.receipts.set(id, { id, fingerprint, at: this.now() })
    this.save()
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

  private save(): void {
    if (!this.options.path) return
    try {
      writeFileAtomicSync(this.options.path, `${JSON.stringify({ receipts: [...this.receipts.values()] })}\n`, {
        mode: 0o600,
      })
    } catch {
      // A full disk loses only the memory of answers, never the work.
    }
  }
}
