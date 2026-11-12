// What one client has seen of one chat, in one shape whatever its wire: the
// events by their sequence number, the scheduled sends and sub-agents its
// side frames named, and whether a reconnect came back by its cursor (no reset
// snapshot) without handing an event over twice.

export type GateEvent = { seq?: number; type: string; payload?: Record<string, unknown> }

export type ScheduledSend = { id: string; text: string }

export class Feed {
  private readonly bySeq = new Map<number, GateEvent>()
  private readonly waiters = new Set<() => void>()
  /** An event frame for a sequence number this feed already held. */
  duplicates = 0
  /** Snapshots after the first: a client that came back by a page, not by its cursor. */
  resets = 0
  private snapshots = 0
  /** The newest list of scheduled sends a side frame named; null until one did. */
  scheduled: ScheduledSend[] | null = null
  /** The sub-agents a side frame named as running, by the call that started each. */
  subagents: string[] = []
  generation: string | undefined
  /** Set while the client's own connection reads as live (where it says). */
  live = false
  lastError: string | null = null

  constructor(readonly client: string) {}

  snapshot(events: readonly GateEvent[], options: { reset?: boolean; generation?: string } = {}): void {
    this.snapshots += 1
    // A resume by cursor hands over the events after it, never a page: any
    // snapshot after the first counts, whatever the client says it is.
    if (this.snapshots > 1) {
      this.resets += 1
      if (options.reset) this.bySeq.clear()
    }
    if (options.generation) this.generation = options.generation
    for (const event of events) if (typeof event.seq === 'number') this.bySeq.set(event.seq, event)
    this.changed()
  }

  event(event: GateEvent): void {
    if (typeof event.seq === 'number') {
      if (this.bySeq.has(event.seq)) this.duplicates += 1
      this.bySeq.set(event.seq, event)
    }
    this.changed()
  }

  side(update: Partial<Pick<Feed, 'scheduled' | 'subagents' | 'live' | 'lastError'>>): void {
    Object.assign(this, update)
    this.changed()
  }

  /** The newest sequence number held: the cursor a resume names. */
  get cursor(): number | undefined {
    let max: number | undefined
    for (const seq of this.bySeq.keys()) if (max === undefined || seq > max) max = seq
    return max
  }

  get seqs(): number[] {
    return [...this.bySeq.keys()].sort((a, b) => a - b)
  }

  events(): GateEvent[] {
    return this.seqs.map((seq) => this.bySeq.get(seq)!)
  }

  find(test: (event: GateEvent) => boolean): GateEvent | undefined {
    return this.events().find(test)
  }

  /** Resolves once `test` holds, or rejects naming the client and what it waited for. */
  until(test: (feed: Feed) => boolean, what: string, ms = 20_000): Promise<void> {
    if (test(this)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!test(this)) return
        clearTimeout(timer)
        this.waiters.delete(check)
        resolve()
      }
      const timer = setTimeout(() => {
        this.waiters.delete(check)
        reject(
          new Error(
            `${this.client} did not see ${what} in ${ms / 1000} s${this.lastError ? ` (${this.lastError})` : ''}`,
          ),
        )
      }, ms)
      this.waiters.add(check)
    })
  }

  private changed(): void {
    for (const waiter of [...this.waiters]) waiter()
  }
}

export const isUserMessage = (text: string) => (event: GateEvent) =>
  event.type === 'user_message' && String(event.payload?.text ?? '').includes(text)

export const isReplyTo = (text: string) => (event: GateEvent) =>
  event.type === 'content_delta' && String(event.payload?.text ?? '') === `Mock response for: ${text}`

/** The approval a turn on the mock provider waits on, after the message that said `text`. */
export function approvalAfter(feed: Feed, text: string): GateEvent | undefined {
  const events = feed.events()
  const sent = events.findIndex(isUserMessage(text))
  if (sent < 0) return undefined
  return events.slice(sent).find((event) => event.type === 'approval_requested')
}

export function resolvedAfter(feed: Feed, requestId: string): boolean {
  const events = feed.events()
  const resolved = events.findIndex(
    (event) => event.type === 'approval_resolved' && event.payload?.requestId === requestId,
  )
  return resolved >= 0 && events.slice(resolved).some((event) => event.type === 'turn_completed')
}
