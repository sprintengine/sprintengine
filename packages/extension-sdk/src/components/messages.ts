// The events a components panel's hidden guest and the window that draws it
// send each other, inside the frame envelope (`{ se: 1, kind: 'evt', event,
// payload }`, shared/extension-frames.ts). Every payload names the guest's
// `document`, a fresh id per guest, so nothing crosses a reload.

export const COMPONENT_MESSAGES = {
  /** guest → window, `{ document }`: the runtime is up and waits for `ui.hydrate` to render. */
  ready: 'ui.ready',
  /**
   * window → guest, `{ visible, plugin?, workspace?, memory?, retain?, hydration? }`:
   * persisted atoms and context. `memory` hands keyed memory atoms to a
   * development folder's reload; `retain` asks the guest to post them (`ui.retain`).
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
  /** guest → window, `{ document, entries: [{ scope, key, version, value }], hydration? }`: persisted atoms changed. */
  persist: 'ui.persist',
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

/** The per-guest budget for renders and persisted writes: bigger than a frame call's, and its own. */
export const COMPONENT_RENDER_LANE = {
  maxBytes: 640 * 1024,
  maxMessages: 200,
  perMs: 10_000,
  // Every tree the checker accepts is measured, not refused: a node nests two
  // levels (node, children) plus its props; the byte cap still bounds the walk.
  maxDepth: 64 * 2 + 24,
  maxObjects: 5000 * 8 + 1024,
} as const

/** How long the window waits for a guest's first render before it says the panel is slow. */
export const COMPONENT_FIRST_RENDER_NOTICE_MS = 5_000

/** The scopes a keyed atom persists in. */
export type ComponentPersistScope = 'memory' | 'plugin' | 'workspace' | 'storage'

/** One persisted atom's value as it is stored. */
export type ComponentStoredValue = { version: number; value: unknown }

/** What `atoms.read` answers: the plugin's and the workspace's stored atoms, by key. */
export type ComponentAtomsSnapshot = {
  plugin: Record<string, ComponentStoredValue>
  workspace: Record<string, ComponentStoredValue>
}
