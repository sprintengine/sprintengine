// The window's side of one components panel run: it answers the hidden
// guest's runtime (`ui.*`, packages/extension-sdk/src/components/messages.ts),
// checks every tree before it is drawn, and keeps what the drawing shows.
//
// - `ui.ready` is answered with `ui.hydrate`: whether the panel is seen and,
//   for a development folder, the keyed memory atoms the run before handed
//   over, and the request to keep handing them (`retain`).
// - Each `ui.render` is checked (tree.ts): a tree over a limit, or
//   malformed, is refused with `ui.ack` and the last good one stays; a good
//   one replaces it and is acknowledged.
// - A press or an edit goes back as `ui.event`, naming the revision on screen.
// - `ui.error` is what the panel threw: a banner names the extension; the
//   tree stays.
//
// A development folder's save starts a new run (a new frame) while this
// window keeps the last tree and the memory atoms (`RetainedPanel`): the new
// run's first tree replaces the old with a brief Reloaded mark, and a run
// that fails to load leaves the old tree on screen, inert, with the error at
// its file, line and column. An installed extension's run starts from
// nothing: no kept tree, no Reloaded mark.

import { COMPONENT_MESSAGES as M } from '../../../../../../packages/extension-sdk/src/components/messages'
import { parseComponentTree } from '../../../../../../packages/extension-sdk/src/components/tree'
import type { ComponentsTree } from './componentsViewTypes'

/** What a panel keeps across the runs a development folder's saves start. */
export type RetainedPanel = {
  /** The last tree that loaded, and its revision. */
  tree: ComponentsTree
  /** Keyed memory atoms, by key. */
  memory: Map<string, { version: number; value: unknown }>
  /** Whether a run has drawn before: the next run's first tree shows the Reloaded mark. */
  drawn: boolean
  /** The run that drew `tree`. */
  run: string
}

const retained = new Map<string, RetainedPanel>()

/** The panel's kept state, by its surface and workspace. */
export function retainedPanel(key: string): RetainedPanel {
  let found = retained.get(key)
  if (!found) retained.set(key, (found = { tree: null, memory: new Map(), drawn: false, run: '' }))
  return found
}

/** The panel's tab closed (or its extension went): nothing carries over. */
export function forgetRetainedPanel(key: string): void {
  retained.delete(key)
}

export type ComponentsPanelState = {
  tree: ComponentsTree
  /** The guest's revision of the tree on screen. */
  revision: number
  /** The run (its guest's document) that drew the tree on screen. */
  run: string
  /** The panel threw: a sentence each, newest last, at most a few. */
  errors: string[]
  /** The last render was refused (over a limit, malformed): why, while the last good tree stays. */
  refused: string | null
  /** This run did not load: `file:line:column message`. With a kept tree it is shown inline, and the tree is inert. */
  loadError: string | null
  /** When the Reloaded mark went up (epoch ms), or null. */
  reloadedAt: number | null
  /** The first tree arrived. */
  drawn: boolean
  /** Warnings the window dropped props or drew placeholders for, deduplicated. */
  warnings: string[]
}

// One gesture lasts this long after the press that granted it.
const GESTURE_WINDOW_MS = 1000
// How long a lane-refused render waits before the guest renders again.
const RATE_RETRY_MS = 1000
const MAX_ERRORS = 3
const MAX_WARNINGS = 20

export type ComponentsPanelSession = ReturnType<typeof createComponentsPanelSession>

export function createComponentsPanelSession(options: {
  /** Send the guest one `ui.*` event. */
  send(event: string, payload: unknown): void
  retained: RetainedPanel
  /** A development folder: keep memory atoms for the next save's run. */
  development: boolean
  visible: boolean
  now?: () => number
  /** A warning the window drew around (a dropped prop, a placeholder), once each. */
  warn?: (message: string) => void
}) {
  const now = options.now ?? Date.now
  const kept = options.retained
  let document: string | null = null
  let gestureUntil = 0
  let visible = options.visible
  let state: ComponentsPanelState = {
    // Only a development folder's run takes over the tree the run before drew.
    tree: options.development ? kept.tree : null,
    revision: 0,
    run: options.development ? kept.run : '',
    errors: [],
    refused: null,
    loadError: null,
    reloadedAt: null,
    drawn: false,
    warnings: [],
  }
  const listeners = new Set<() => void>()
  const change = (next: Partial<ComponentsPanelState>) => {
    state = { ...state, ...next }
    for (const listener of [...listeners]) listener()
  }
  const fieldOf = (payload: unknown, name: string): unknown =>
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)[name] : undefined
  const ours = (payload: unknown) => document !== null && fieldOf(payload, 'document') === document

  function ready(payload: unknown) {
    const id = fieldOf(payload, 'document')
    if (typeof id !== 'string' || id.length > 64) return
    // A guest reloads only with its frame; a second `ready` is a new runtime in the same frame.
    document = id
    const memory = options.development && kept.memory.size > 0 ? Object.fromEntries(kept.memory) : undefined
    options.send(M.hydrate, {
      document,
      visible,
      ...(memory ? { memory } : {}),
      ...(options.development ? { retain: true } : {}),
    })
  }

  function render(payload: unknown, refused?: 'too_large' | 'rate_limited') {
    const revision = fieldOf(payload, 'revision')
    if (!ours(payload) || typeof revision !== 'number') return
    const ack = (accepted: boolean, retryAfterMs?: number) =>
      options.send(M.ack, {
        document,
        revision,
        accepted,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      })
    if (refused) {
      ack(false, refused === 'rate_limited' ? RATE_RETRY_MS : undefined)
      change({
        refused:
          refused === 'too_large'
            ? 'The panel drew more than Studio draws at once (about 512 KiB); its last good view stays.'
            : 'The panel drew too often; its last good view stays.',
      })
      return
    }
    const checked = parseComponentTree(fieldOf(payload, 'tree'))
    if (!checked.ok) {
      ack(false)
      change({ refused: `Studio did not draw the panel’s last view: ${checked.error}` })
      return
    }
    const warnings = [...state.warnings]
    for (const warning of checked.warnings) {
      if (warnings.includes(warning) || warnings.length >= MAX_WARNINGS) continue
      warnings.push(warning)
      options.warn?.(warning)
    }
    const reloaded = options.development && !state.drawn && kept.drawn
    if (options.development) {
      kept.tree = checked.tree
      kept.drawn = true
      kept.run = document ?? ''
    }
    ack(true)
    change({
      tree: checked.tree,
      revision,
      run: document ?? '',
      refused: null,
      loadError: null,
      drawn: true,
      warnings,
      ...(reloaded ? { reloadedAt: now() } : {}),
    })
  }

  function error(payload: unknown) {
    if (!ours(payload)) return
    const message = fieldOf(payload, 'message')
    if (typeof message !== 'string') return
    change({ errors: [...state.errors, message.slice(0, 500)].slice(-MAX_ERRORS) })
  }

  function retain(payload: unknown) {
    if (!ours(payload) || !options.development) return
    const entries = fieldOf(payload, 'entries')
    if (!Array.isArray(entries)) return
    for (const entry of entries.slice(0, 64)) {
      const key = fieldOf(entry, 'key')
      const version = fieldOf(entry, 'version')
      if (typeof key !== 'string' || typeof version !== 'number') continue
      // No value: it held something only this run could hold; the next starts it over.
      if (typeof entry === 'object' && entry !== null && 'value' in entry)
        kept.memory.set(key, { version, value: (entry as { value: unknown }).value })
      else kept.memory.delete(key)
    }
  }

  return {
    /** One `ui.*` event from the guest, with the lane's refusal if any. */
    receive(event: string, payload: unknown, refused?: 'too_large' | 'rate_limited') {
      // Over the lane, nothing is taken; a render is answered as refused, so the guest knows.
      if (refused && event !== M.render) return
      if (event === M.ready) ready(payload)
      else if (event === M.render) render(payload, refused)
      else if (event === M.error) error(payload)
      else if (event === M.retain) retain(payload)
    },
    /** A press or an edit on the tree on screen. */
    dispatch(callback: string, args: unknown[], dispatchOptions: { edit?: number } = {}) {
      if (document === null || state.loadError !== null || !state.drawn) return
      options.send(M.event, {
        document,
        revision: state.revision,
        callback,
        args: args.slice(0, 8),
        ...(dispatchOptions.edit === undefined ? {} : { edit: dispatchOptions.edit }),
      })
    },
    /**
     * A press on a still control: one gesture-gated call within a second. A
     * press on one that had not stood still takes back any grant still open,
     * so the press that follows a control moving under the pointer opens nothing.
     */
    grantGesture(stood = true) {
      gestureUntil = stood ? now() + GESTURE_WINDOW_MS : 0
    },
    takeGesture(): boolean {
      const granted = now() <= gestureUntil
      gestureUntil = 0
      return granted
    },
    setVisible(next: boolean) {
      if (next === visible) return
      visible = next
      if (document !== null) options.send(M.visibility, { document, visible })
    },
    /** The run could not load (`file:line:column message`). */
    failed(message: string) {
      change({ loadError: message })
    },
    dismissError() {
      change({ errors: [] })
    },
    /** A development folder's run: a load that fails keeps the run before's tree. */
    development: options.development,
    state: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
