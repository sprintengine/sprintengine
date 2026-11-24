// The guest's runtime: it loads persisted atoms, runs `setup`, renders the
// panel's component into a tree, sends the tree to the window that draws it
// (`ui.render`), and runs the handler a press or an edit names (`ui.event`).
// It renders again, at most about once a frame, whenever an atom a render
// read changes.
//
// Every tree has a revision. The window answers each with `ui.ack`: shown, or
// refused (over a limit, or malformed) with the last good one kept. An event
// names the revision the person saw, and resolves against that tree's
// handlers only, so a newer render that moved a handler elsewhere is never
// what a press runs.

import { COMPONENT_MESSAGES as M, type ComponentAtomsSnapshot } from '../messages.js'
import {
  applyStorageValue,
  hostAtom,
  hydrateAtoms,
  keyedMemoryAtoms,
  memoryEntry,
  persistedEntry,
  read,
  subscribeAtom,
  trackAtomReads,
  watchMemoryAtoms,
  watchPersistedAtoms,
  watchStorageAtoms,
  type Atom,
  type PersistedEntry,
  type StoredValue,
} from './atoms.js'
import { assertPlainJson, evaluateTree, type Callback, type ComponentFunction } from './evaluate.js'

export type Disposable = { dispose(): void }
export type ColorScheme = 'light' | 'dark'
export type Theme = { colorScheme: ColorScheme }

/** What the frame's bootstrap hands the runtime, or a test's stand-in. */
export type ComponentsBridge = {
  /** One guest → window event. */
  post(event: string, payload: unknown): void
  /** Hear a window → guest event: the `ui.*` messages and `theme`. */
  on(event: string, handler: (payload: unknown) => void): Disposable
  /** A host call, through the window to Studio's gate. */
  call(method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<unknown>
  has(method: string): boolean
  /** Hear one of Studio's events or the worker's (`push`), as `studio.on` does in a frame. */
  listen(event: string, handler: (payload: unknown) => void): Disposable
  surface: { id: string; workspaceId?: string }
  colorScheme: ColorScheme
  locale: string
  client: 'desktop' | 'web'
  /** `file:line:column message` for an error thrown in the extension's own files. */
  describe?(error: unknown): string
}

export type PanelContext = {
  /** Disposed when the run ends. */
  subscriptions: Disposable[]
  /** Aborts when the run ends. */
  signal: AbortSignal
  /** True while the person can see the panel. */
  visible: Atom<boolean>
  panel: { id: string; workspaceId?: string }
}

export type PanelModule = { default?: unknown; setup?: unknown }

// An update loop must not flood the window: about one render per display frame.
export const MIN_RENDER_INTERVAL_MS = 16
// Renders the window has not answered yet whose handlers stay resolvable.
export const MAX_RETAINED_RENDERS = 32
// A window that never answers `ui.ready` must not keep the panel from drawing.
export const HYDRATION_TIMEOUT_MS = 3000
const PERSIST_DEBOUNCE_MS = 400
// Short: the guest is gone right after the save that replaces it.
const RETAIN_DEBOUNCE_MS = 50
const RETAIN_BATCH = 64

export type Schedule = (flush: () => void, delayMs: number) => void

export function defaultSchedule(flush: () => void, delayMs: number): void {
  if (delayMs > 0) setTimeout(flush, delayMs)
  else queueMicrotask(flush)
}

function newDocumentId(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function'
}

function field(payload: unknown, name: string): unknown {
  return typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)[name] : undefined
}

function storedValues(raw: unknown): Map<string, StoredValue> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const values = new Map<string, StoredValue>()
  for (const [key, entry] of Object.entries(raw)) {
    const version = field(entry, 'version')
    if (typeof version === 'number' && typeof entry === 'object' && entry !== null && 'value' in entry)
      values.set(key, { version, value: (entry as { value: unknown }).value })
  }
  return values
}

export type ComponentsRuntime = {
  readonly document: string
  /** Loads persisted atoms, runs `setup`, then mounts the default export. */
  boot(module: PanelModule): Promise<void>
  mount(component: ComponentFunction): void
  unmount(): void
  /** Handles `ui.event`; false unless its callback is in the tree it names. */
  dispatchEvent(payload: unknown): boolean
  acknowledge(payload: unknown): void
  hydrate(payload: unknown): void
  /** Renders now if one is due, and sends pending persisted writes. */
  flush(): void
  rerender(): void
  report(error: unknown): void
  readonly themeAtom: Atom<Theme>
  readonly bridge: ComponentsBridge
  readonly context: PanelContext
  dispose(): void
}

export function createComponentsRuntime(options: {
  bridge: ComponentsBridge
  schedule?: Schedule
  now?: () => number
  /** Wait for the window's `ui.hydrate` (and the stored atoms) before the first render. */
  awaitHydration?: boolean
}): ComponentsRuntime {
  const { bridge } = options
  const schedule = options.schedule ?? defaultSchedule
  const now = options.now ?? (() => Date.now())
  const document = newDocumentId(now())
  const theme = hostAtom<Theme>({ colorScheme: bridge.colorScheme })
  const visibility = hostAtom(true)
  const lifetime = new AbortController()
  const context: PanelContext = {
    subscriptions: [],
    signal: lifetime.signal,
    visible: visibility.atom,
    panel: {
      id: bridge.surface.id,
      ...(bridge.surface.workspaceId ? { workspaceId: bridge.surface.workspaceId } : {}),
    },
  }
  let component: ComponentFunction | null = null
  let revision = 0
  let lastRenderAt = Number.NEGATIVE_INFINITY
  // Handler tables by revision: the one on screen (accepted) and every newer one.
  let renders = new Map<number, Map<string, Callback>>()
  let accepted: number | null = null
  const editsSeen = new Map<string, number>()
  let subscriptions = new Map<Atom<unknown>, () => void>()
  let scheduled = false
  let setupCleanup: (() => void) | null = null
  let disposed = false

  function errorText(error: unknown): string {
    const described = bridge.describe?.(error)
    if (described) return described.slice(0, 4096)
    return (error instanceof Error ? error.message : String(error)).slice(0, 4096)
  }

  function report(error: unknown): void {
    const message = errorText(error)
    console.error(message)
    const stack = error instanceof Error && error.stack ? error.stack.slice(0, 8192) : undefined
    bridge.post(M.error, { document, revision, message, ...(stack ? { stack } : {}) })
  }

  function invalidate(delayMs = 0): void {
    if (scheduled || !component || disposed) return
    scheduled = true
    const wait = Math.max(delayMs, lastRenderAt + MIN_RENDER_INTERVAL_MS - now())
    schedule(() => {
      if (scheduled) render()
    }, wait)
  }

  function resubscribe(reads: Set<Atom<unknown>>): void {
    const next = new Map<Atom<unknown>, () => void>()
    for (const target of reads) next.set(target, subscriptions.get(target) ?? subscribeAtom(target, () => invalidate()))
    for (const [target, unsubscribe] of subscriptions) if (!next.has(target)) unsubscribe()
    subscriptions = next
  }

  function retain(at: number, callbacks: Map<string, Callback>): void {
    renders.set(at, callbacks)
    for (const kept of renders.keys()) {
      if (renders.size <= MAX_RETAINED_RENDERS) break
      if (kept !== accepted) renders.delete(kept)
    }
  }

  function render(): void {
    scheduled = false
    if (!component || disposed) return
    lastRenderAt = now()
    const reads = new Set<Atom<unknown>>()
    const mounted = component
    let evaluation
    try {
      evaluation = trackAtomReads(reads, () => evaluateTree(mounted, editsSeen))
    } catch (error) {
      // Nothing is sent. Old subscriptions stay too, so a fix to either state renders again.
      resubscribe(new Set([...subscriptions.keys(), ...reads]))
      report(error)
      return
    }
    revision += 1
    retain(revision, evaluation.callbacks)
    resubscribe(reads)
    bridge.post(M.render, { document, revision, tree: evaluation.tree })
  }

  function dispatchEvent(payload: unknown): boolean {
    const callback = field(payload, 'callback')
    const args = field(payload, 'args')
    const edit = field(payload, 'edit')
    const at = field(payload, 'revision')
    if (field(payload, 'document') !== document || typeof callback !== 'string') return false
    // Strictly the tree the person saw: a newer render may bind the same id elsewhere.
    const handler = typeof at === 'number' ? renders.get(at)?.get(callback) : undefined
    if (!handler) return false
    if (typeof edit === 'number' && Number.isSafeInteger(edit)) {
      editsSeen.set(callback, Math.max(edit, editsSeen.get(callback) ?? 0))
      // The next render reports the edit as seen, even when the panel ignores it.
      invalidate()
    }
    try {
      const result = handler(...(Array.isArray(args) ? args : []))
      if (result instanceof Promise) result.catch(report)
    } catch (error) {
      report(error)
    }
    return true
  }

  function acknowledge(payload: unknown): void {
    const acked = field(payload, 'revision')
    if (field(payload, 'document') !== document || typeof acked !== 'number' || !renders.has(acked)) return
    if (field(payload, 'accepted') === true) {
      // Older tables retire only now: until this tree showed, theirs was on screen.
      accepted = acked
      for (const kept of renders.keys()) if (kept < acked) renders.delete(kept)
      return
    }
    // A refused render never reached the screen; events keep resolving against the one that did.
    renders.delete(acked)
    const retryAfterMs = field(payload, 'retryAfterMs')
    if (typeof retryAfterMs === 'number' && acked === revision) invalidate(retryAfterMs)
  }

  // ── Persisted atoms: Studio stores them (`atoms.write`), a moment after they change ──
  const workspaceId = bridge.surface.workspaceId
  const pendingPersist = new Set<Atom<unknown>>()
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  const writes = new Set<Promise<unknown>>()
  function track(promise: Promise<unknown>): void {
    const settled = promise.catch(report).finally(() => writes.delete(settled))
    writes.add(settled)
  }
  function flushPersist(): void {
    if (persistTimer !== null) clearTimeout(persistTimer)
    persistTimer = null
    const entries: PersistedEntry[] = []
    for (const target of pendingPersist) {
      const entry = persistedEntry(target)
      if (!entry) continue
      if (entry.scope === 'storage') {
        track(bridge.call('storage.set', { key: entry.key, value: entry.value }))
        continue
      }
      try {
        assertPlainJson(entry.value, `the persisted atom "${entry.key}"`)
        entries.push(entry)
      } catch (error) {
        report(error)
      }
    }
    pendingPersist.clear()
    if (entries.length === 0) return
    const scoped = entries.filter((entry) => entry.scope === 'plugin' || workspaceId !== undefined)
    if (scoped.length < entries.length)
      report(new Error('A workspace atom changed in a panel opened outside a workspace; it is kept for this run only.'))
    if (scoped.length > 0)
      track(bridge.call('atoms.write', { ...(workspaceId ? { workspaceId } : {}), entries: scoped }))
  }
  watchPersistedAtoms((target) => {
    pendingPersist.add(target)
    persistTimer ??= setTimeout(flushPersist, PERSIST_DEBOUNCE_MS)
  })

  // `storage` atoms read the extension's storage before the first render, and as they are made after it.
  const storageLoads = new Set<Promise<void>>()
  watchStorageAtoms((key) => {
    if (!bridge.has('storage.get')) return
    const load = bridge
      .call('storage.get', { key })
      .then((answer) => {
        const found = field(answer, 'found') === true
        applyStorageValue(key, found ? field(answer, 'value') : undefined)
      })
      .catch(report)
    storageLoads.add(load)
  })

  // ── A development folder's reload: keyed memory atoms go to the next guest ──
  const pendingRetain = new Set<Atom<unknown>>()
  let retainTimer: ReturnType<typeof setTimeout> | null = null
  let retaining = false
  function flushRetain(): void {
    if (retainTimer !== null) clearTimeout(retainTimer)
    retainTimer = null
    const entries: Array<{ key: string; version: number; value?: unknown }> = []
    for (const target of pendingRetain) {
      const entry = memoryEntry(target)
      if (!entry) continue
      try {
        assertPlainJson(entry.value, `atom "${entry.key}"`)
        entries.push(entry)
      } catch {
        // Only plain JSON crosses a reload; the next guest starts this one over.
        entries.push({ key: entry.key, version: entry.version })
      }
    }
    pendingRetain.clear()
    for (let start = 0; start < entries.length; start += RETAIN_BATCH)
      bridge.post(M.retain, { document, entries: entries.slice(start, start + RETAIN_BATCH) })
  }
  function startRetaining(): void {
    if (retaining) return
    retaining = true
    watchMemoryAtoms((target) => {
      pendingRetain.add(target)
      retainTimer ??= setTimeout(flushRetain, RETAIN_DEBOUNCE_MS)
    })
    // What the panel already holds, for a save before its next change.
    for (const target of keyedMemoryAtoms()) pendingRetain.add(target)
    flushRetain()
  }

  // ── Hydration: the window's context, and the stored atoms ──
  let hydratedNow = false
  let markHydrated: () => void = () => undefined
  const hydrated = new Promise<void>((done) => {
    markHydrated = () => {
      hydratedNow = true
      done()
    }
  })

  function hydrate(payload: unknown): void {
    const visible = field(payload, 'visible')
    if (typeof visible === 'boolean') visibility.set(visible)
    const memory = storedValues(field(payload, 'memory'))
    if (memory) hydrateAtoms('memory', memory)
    if (field(payload, 'retain') === true) startRetaining()
    windowHydrated()
  }
  let windowHydrated: () => void = () => undefined
  const windowReady = new Promise<void>((done) => {
    windowHydrated = done
  })

  async function loadStoredAtoms(): Promise<void> {
    if (!bridge.has('atoms.read')) return
    try {
      const stored = (await bridge.call('atoms.read', workspaceId ? { workspaceId } : {})) as ComponentAtomsSnapshot
      const plugin = storedValues(stored?.plugin)
      const workspace = storedValues(stored?.workspace)
      if (plugin) hydrateAtoms('plugin', plugin)
      if (workspace) hydrateAtoms('workspace', workspace)
    } catch (error) {
      report(error)
    }
  }

  const bridgeSubscriptions: Disposable[] = [
    bridge.on(M.event, dispatchEvent),
    bridge.on(M.ack, acknowledge),
    bridge.on(M.hydrate, hydrate),
    bridge.on(M.visibility, (payload) => {
      const visible = field(payload, 'visible')
      if (typeof visible === 'boolean') visibility.set(visible)
    }),
    bridge.on('theme', (payload) => {
      const colorScheme = field(payload, 'colorScheme')
      if ((colorScheme === 'light' || colorScheme === 'dark') && read(theme.atom).colorScheme !== colorScheme)
        theme.set({ colorScheme })
    }),
  ]

  if (options.awaitHydration) {
    bridge.post(M.ready, { document })
    const fallback = setTimeout(() => windowHydrated(), HYDRATION_TIMEOUT_MS)
    void Promise.all([windowReady, loadStoredAtoms()]).then(() => {
      clearTimeout(fallback)
      markHydrated()
    })
  } else {
    void loadStoredAtoms().then(markHydrated)
  }

  function unsubscribeAll(): void {
    for (const unsubscribe of subscriptions.values()) unsubscribe()
    subscriptions = new Map()
  }

  const runtime: ComponentsRuntime = {
    document,
    async boot(module) {
      await hydrated
      await Promise.all([...storageLoads])
      if (isCallable(module.setup)) {
        const cleanup = module.setup(context)
        setupCleanup = isCallable(cleanup) ? () => void cleanup() : null
      }
      const panel = module.default
      if (isCallable(panel)) runtime.mount((props) => panel(props))
      else if (!component) {
        const kind = module.default === null ? 'null' : typeof module.default
        throw new Error(
          `A components panel's entry exports its component function as its default export (got ${kind}).`,
        )
      }
    },
    mount(next) {
      component = next
      if (hydratedNow) {
        render()
        return
      }
      void hydrated.then(() => {
        if (component === next) render()
      })
    },
    unmount() {
      component = null
      scheduled = false
      unsubscribeAll()
      renders = new Map()
      accepted = null
      revision += 1
      bridge.post(M.render, { document, revision, tree: null })
    },
    dispatchEvent,
    acknowledge,
    hydrate,
    rerender: () => render(),
    flush() {
      if (scheduled) render()
      flushPersist()
      flushRetain()
    },
    report,
    themeAtom: theme.atom,
    bridge,
    context,
    dispose() {
      if (disposed) return
      flushPersist()
      flushRetain()
      disposed = true
      component = null
      scheduled = false
      unsubscribeAll()
      watchPersistedAtoms(null)
      watchMemoryAtoms(null)
      watchStorageAtoms(null)
      for (const subscription of [...bridgeSubscriptions, ...context.subscriptions]) {
        try {
          subscription.dispose()
        } catch (error) {
          report(error)
        }
      }
      try {
        setupCleanup?.()
      } catch (error) {
        report(error)
      }
      lifetime.abort()
    },
  }
  return runtime
}

/** Pending persisted writes, for a test to wait on. */
export type { PersistedEntry }
