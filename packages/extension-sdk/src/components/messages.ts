// The events a components panel's hidden guest and the window that draws it
// send each other, inside the frame envelope (`{ se: 1, kind: 'evt', event,
// payload }`, shared/extension-frames.ts). Every payload names the guest's
// `document`, a fresh id per guest, so nothing crosses a reload.

export const COMPONENT_MESSAGES = {
  /** guest → window, `{ document }`: the runtime is up and waits for `ui.hydrate` to render. */
  ready: 'ui.ready',
  /**
   * window → guest, `{ document, visible, memory?, retain? }`: the context the
   * first render waits for. `memory` hands keyed memory atoms to a
   * development folder's reload; `retain` asks the guest to post them
   * (`ui.retain`). The guest reads its persisted atoms itself (`atoms.read`).
   */
  hydrate: 'ui.hydrate',
  /** guest → window, `{ document, revision, tree }`: a whole tree; null unmounts. */
  render: 'ui.render',
  /** window → guest, `{ document, revision, accepted, retryAfterMs? }`: whether a render is shown. */
  ack: 'ui.ack',
  /** window → guest, `{ document, revision, callback, args, edit? }`: `revision` is the tree on screen. */
  event: 'ui.event',
  /** guest → window, `{ document, revision, message, stack? }`: the panel threw; the last good tree stays. */
  error: 'ui.error',
  /** window → guest, `{ visible }` */
  visibility: 'ui.visibility',
  /** guest → window, `{ document, entries: [{ key, version, value? }] }`: keyed memory atoms changed. */
  retain: 'ui.retain',
} as const

export type ComponentMessage = (typeof COMPONENT_MESSAGES)[keyof typeof COMPONENT_MESSAGES]

/** Event names a panel may not follow with `on()`: the panel's own wire traffic. */
export function isReservedComponentEvent(name: string): boolean {
  return (
    name.startsWith('ui.') ||
    name.startsWith('document') ||
    ['ready', 'hello', 'push', 'studio', 'failed', 'leaving', 'paint', 'surface.ready'].includes(name)
  )
}

/** The per-guest budget for the `ui.*` events: bigger than a frame call's, and its own. */
export const COMPONENT_RENDER_LANE = {
  maxBytes: 640 * 1024,
  maxMessages: 200,
  perMs: 10_000,
  // Every tree the checker accepts is measured, not refused: a node nests two
  // levels (node, children) plus its props; the byte cap still bounds the walk.
  maxDepth: 64 * 2 + 24,
  maxObjects: 5000 * 8 + 1024,
} as const

/**
 * The per-guest budget for its persisted writes (`atoms.write`): a lane apart
 * from renders and from other calls, so a large atom is stored and a busy
 * panel's writes never starve its calls. The runtime splits its writes to fit.
 */
export const COMPONENT_ATOMS_LANE = {
  maxBytes: 640 * 1024,
  maxMessages: 60,
  perMs: 10_000,
  maxDepth: 64,
  maxObjects: 100_000,
} as const

/** The most one persisted atom's value may measure (measureComponentValue): it is kept for the run alone past it. */
export const COMPONENT_ATOM_VALUE_MAX_BYTES = 512 * 1024

/** What a lane refusal for too many messages asks the guest to wait before it sends again. */
export const COMPONENT_LANE_RETRY_MS = 1000

const encoder = new TextEncoder()

/**
 * A value's size as the window's lanes measure a frame's message
 * (extensionFrameMessageBytes, shared/extension-frames.ts): a string's UTF-8
 * bytes, 8 for a number, 1 for null, undefined or a boolean, 8 for an array
 * and 4 more for each item, 4 plus its name's bytes for each field. `depth`
 * is where the value sits in the message; past `stopAfter` bytes, or deeper
 * or more objects than the walk follows, `bytes` is over `stopAfter`.
 */
export function measureComponentValue(
  value: unknown,
  walk: { stopAfter: number; maxDepth: number; maxObjects: number; depth?: number },
): { bytes: number; objects: number } {
  const seen = new WeakSet<object>()
  let bytes = 0
  let objects = 0
  const over = () => bytes > walk.stopAfter
  const add = (more: number) => {
    bytes = Math.min(walk.stopAfter + 1, bytes + more)
  }
  const visit = (item: unknown, depth: number): void => {
    if (over()) return
    if (item === null || item === undefined || typeof item === 'boolean') return add(1)
    if (typeof item === 'number') return add(8)
    if (typeof item === 'string')
      return add(item.length > walk.stopAfter ? walk.stopAfter + 1 : encoder.encode(item).byteLength)
    if (typeof item !== 'object') return add(walk.stopAfter + 1)
    if (seen.has(item)) return add(8)
    seen.add(item)
    objects += 1
    if (objects > walk.maxObjects || depth > walk.maxDepth) return add(walk.stopAfter + 1)
    if (Array.isArray(item)) {
      add(8)
      for (const entry of item) {
        add(4)
        visit(entry, depth + 1)
        if (over()) return
      }
      return
    }
    const prototype: unknown = Object.getPrototypeOf(item)
    if (prototype !== Object.prototype && prototype !== null) return add(walk.stopAfter + 1)
    for (const key of Object.keys(item)) {
      add(4 + encoder.encode(key).byteLength)
      visit((item as Record<string, unknown>)[key], depth + 1)
      if (over()) return
    }
  }
  visit(value, walk.depth ?? 0)
  return { bytes, objects }
}

/** The scopes a keyed atom persists in. */
export type ComponentPersistScope = 'memory' | 'plugin' | 'workspace' | 'storage'

/** One persisted atom's value as it is stored. */
export type ComponentStoredValue = { version: number; value: unknown }

/** What `atoms.read` answers: the plugin's and the workspace's stored atoms, by key. */
export type ComponentAtomsSnapshot = {
  plugin: Record<string, ComponentStoredValue>
  workspace: Record<string, ComponentStoredValue>
}
