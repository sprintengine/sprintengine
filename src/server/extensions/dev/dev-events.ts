// What happened to each extension lately, one numbered event at a time, for
// `sprintengine-extension dev watch` to follow (`extension.dev.events`): the
// lines its worker and its frames printed, each reload, each change of
// status, and an edit that asks for new access. Kept in memory per server,
// the newest few hundred per extension; the worker's log file keeps more.

export type ExtensionDevEventKind =
  /** A line its worker or one of its frames printed (`[worker]`, `[frame]`, `[studio]`). */
  | 'log'
  /** Studio read it again after an edit: its worker restarted and its frames redraw. */
  | 'reloaded'
  /** How it stands now: `running`, `waiting`, `errored`, `invalid` … with the reason. */
  | 'status'
  /** An edit asks for access it was not approved for: it waits for the person. */
  | 'approval'
  /** A development folder was registered or removed. */
  | 'loaded'
  | 'unloaded'

export type ExtensionDevEvent = {
  /** Numbered per server, rising: read the ones after the last you saw. */
  seq: number
  at: string
  /** Its install key. */
  key: string
  kind: ExtensionDevEventKind
  message: string
  /** For `log`: where it came from, and how loud. */
  source?: 'worker' | 'frame' | 'studio'
  level?: 'info' | 'warn' | 'error'
  /** For `status` and `approval`: the state, and for `approval` what it asks beyond its approval. */
  state?: string
  growth?: string[]
  fingerprint?: string
}

const KEPT_PER_EXTENSION = 500

export type ExtensionDevEvents = {
  add(event: Omit<ExtensionDevEvent, 'seq' | 'at'>): ExtensionDevEvent
  /** Events after `after` (0: all kept), for one extension or every one, oldest first, at most `limit`. */
  since(after: number, key?: string, limit?: number): ExtensionDevEvent[]
  /** The newest number given out, 0 before any. */
  latest(): number
  subscribe(listener: (event: ExtensionDevEvent) => void): () => void
}

export function createExtensionDevEvents(now: () => Date = () => new Date()): ExtensionDevEvents {
  const byKey = new Map<string, ExtensionDevEvent[]>()
  const listeners = new Set<(event: ExtensionDevEvent) => void>()
  let seq = 0
  return {
    add(input) {
      seq += 1
      const event: ExtensionDevEvent = { ...input, seq, at: now().toISOString() }
      const kept = byKey.get(input.key) ?? []
      kept.push(event)
      if (kept.length > KEPT_PER_EXTENSION) kept.splice(0, kept.length - KEPT_PER_EXTENSION)
      byKey.set(input.key, kept)
      for (const listener of [...listeners]) {
        try {
          listener(event)
        } catch {
          // A listener's failure is its own.
        }
      }
      return event
    },
    since(after, key, limit = 200) {
      const pool = key ? (byKey.get(key) ?? []) : [...byKey.values()].flat().sort((a, b) => a.seq - b.seq)
      return pool.filter((event) => event.seq > after).slice(0, Math.max(1, limit))
    },
    latest: () => seq,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** This server's events: one process holds one Studio's extensions. */
export const extensionDevEvents = createExtensionDevEvents()
