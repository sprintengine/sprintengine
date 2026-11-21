// A bounded number of running workers, handed out first come, first served.
// On-demand workers share one pool (WORKER_MAX_ACTIVE) and an idle one gives
// its place back when it is stopped; `background` workers share another
// (WORKER_MAX_BACKGROUND) and keep theirs while they are switched on.

export type WorkerSlot = { release(): void }

export class WorkerSlotPool {
  private readonly waiters: Array<{
    resolve: (slot: WorkerSlot) => void
    reject: (error: Error) => void
    signal: AbortSignal
    onAbort: () => void
  }> = []
  private leased = 0
  private closed = false

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error('A worker pool holds at least one worker.')
  }

  get inUse(): number {
    return this.leased
  }

  /** Whether a slot is free now, with nobody ahead in line. */
  hasRoom(): boolean {
    return this.leased < this.capacity && this.waiters.length === 0
  }

  acquire(signal: AbortSignal): Promise<WorkerSlot> {
    if (this.closed) return Promise.reject(new Error('Extension workers are shut down.'))
    if (signal.aborted) return Promise.reject(new Error('The worker was stopped while it waited to start.'))
    if (this.hasRoom()) {
      this.leased += 1
      return Promise.resolve(this.slot())
    }
    return new Promise<WorkerSlot>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const at = this.waiters.indexOf(waiter)
          if (at >= 0) this.waiters.splice(at, 1)
          reject(new Error('The worker was stopped while it waited to start.'))
          this.drain()
        },
      }
      this.waiters.push(waiter)
      signal.addEventListener('abort', waiter.onAbort, { once: true })
    })
  }

  close(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.reject(new Error('Extension workers are shut down.'))
    }
  }

  private slot(): WorkerSlot {
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.leased -= 1
        this.drain()
      },
    }
  }

  private drain(): void {
    while (!this.closed && this.leased < this.capacity && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal.aborted) continue
      this.leased += 1
      waiter.resolve(this.slot())
    }
  }
}
