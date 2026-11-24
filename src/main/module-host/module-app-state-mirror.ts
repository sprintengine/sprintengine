import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Every extension's Settings values: the `module:<id>` namespaces its
// Settings section writes from its frame (`settings.set`, through the host's
// gate) and reads back (`settings.get`). Studio keeps them in its data folder,
// outside the extension's own reach, so `MainHost.getModuleAppState` /
// `watchModuleAppState` read the values the person chose with no window open
// (a scheduler's run time, a poller's interval).
//
// One store per file, shared by everyone in the process: the frame's host
// call that writes and the worker that reads see the same object, so a change
// is heard in process at once. Another process holding the same data folder
// hears a write by watching the file.

export const MODULE_APP_STATE_FILE = 'module-app-state.json'
const NAMESPACE_PREFIX = 'module:'
const WATCH_INTERVAL_MS = 1000

type Namespaces = Record<string, Record<string, unknown>>

export type ModuleAppStateMirror = {
  /** The module's namespace: an empty object when nothing was ever pushed. */
  get(moduleId: string): Readonly<Record<string, unknown>>
  /**
   * Set one value of the module's namespace (`undefined` removes it), as its
   * Settings section's frame does (`settings.set`); notifies its listeners.
   */
  setValue(moduleId: string, key: string, value: unknown): void
  /** Hear the module's namespace whenever it changes (not on subscribe). */
  subscribe(moduleId: string, listener: (values: Readonly<Record<string, unknown>>) => void): () => void
}

/** The store's own handle: every module's changes, and an end to its watching. */
export type ModuleAppStateStore = ModuleAppStateMirror & {
  /** Hear which module's namespace changed, whichever it is, here or in another process. */
  subscribeAll(listener: (moduleId: string) => void): () => void
  /** Drop the module's whole namespace (an uninstall), on disk and here; its listeners hear it emptied. */
  forget(moduleId: string): void
}

const EMPTY: Readonly<Record<string, unknown>> = Object.freeze({})

/** Only `module:<id>` namespaces holding a plain object; everything else is dropped. */
export function normalizeModuleAppStateBag(value: unknown): Namespaces {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Namespaces = {}
  for (const [namespace, entry] of Object.entries(value as Record<string, unknown>)) {
    const key = namespace.trim()
    if (!key.startsWith(NAMESPACE_PREFIX) || key.length === NAMESPACE_PREFIX.length) continue
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    result[key] = { ...(entry as Record<string, unknown>) }
  }
  return result
}

export function createModuleAppStateMirror(options: {
  filePath: string
  /** Watch the file for a push another process wrote. Defaults to true. */
  watchFile?: boolean
  watchIntervalMs?: number
}): ModuleAppStateStore & { dispose(): void } {
  let namespaces: Namespaces | null = null
  const listeners = new Map<string, Set<(values: Readonly<Record<string, unknown>>) => void>>()
  const anyListeners = new Set<(moduleId: string) => void>()
  let watching: ReturnType<typeof setInterval> | null = null
  // What the file looked like when last read or written, so a read with no
  // watch running still notices a push another process wrote since.
  let seen: string | null = null
  const fileSignature = (): string => {
    try {
      const info = statSync(options.filePath)
      return `${info.mtimeMs}:${info.size}`
    } catch {
      return 'absent'
    }
  }

  const read = (): Namespaces => {
    seen = fileSignature()
    try {
      return normalizeModuleAppStateBag(JSON.parse(readFileSync(options.filePath, 'utf8')))
    } catch {
      return {}
    }
  }
  const current = (): Namespaces => (namespaces ??= read())

  // Hand every namespace whose content moved to its listeners.
  const adopt = (next: Namespaces): boolean => {
    const before = current()
    namespaces = next
    let changed = false
    for (const namespace of new Set([...Object.keys(before), ...Object.keys(next)])) {
      if (JSON.stringify(before[namespace] ?? {}) === JSON.stringify(next[namespace] ?? {})) continue
      changed = true
      const values = Object.freeze({ ...next[namespace] })
      for (const listener of listeners.get(namespace) ?? []) {
        try {
          listener(values)
        } catch (error) {
          console.warn(`[modules] an app-state watcher for "${namespace}" threw:`, error)
        }
      }
      for (const listener of anyListeners) {
        try {
          listener(namespace.slice(NAMESPACE_PREFIX.length))
        } catch (error) {
          console.warn('[modules] an app-state watcher threw:', error)
        }
      }
    }
    return changed
  }

  // Poll the file's signature against the one last read or written rather
  // than using fs.watchFile: watchFile takes its baseline from its first
  // asynchronous stat, so a push another process writes before that stat lands
  // becomes the baseline and is never reported. Comparing against `seen` has
  // no baseline to race.
  const startWatching = (): void => {
    if (watching || options.watchFile === false) return
    watching = setInterval(() => {
      if (fileSignature() !== seen) adopt(read())
    }, options.watchIntervalMs ?? WATCH_INTERVAL_MS)
    watching.unref?.()
  }
  const stopWatching = (): void => {
    if (!watching) return
    clearInterval(watching)
    watching = null
  }

  // A push another process wrote since this one last looked, taken first.
  const catchUp = (): void => {
    if (namespaces !== null && !watching && options.watchFile !== false && fileSignature() !== seen) adopt(read())
  }
  // Hand `next` to the listeners and write it, whole, over the file (a
  // temporary file renamed into place). An unchanged one never rewrites it.
  const commit = (next: Namespaces): void => {
    if (!adopt(next)) return
    const tmp = `${options.filePath}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(options.filePath), { recursive: true })
      writeFileSync(tmp, `${JSON.stringify(next)}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, options.filePath)
      seen = fileSignature()
    } catch {
      // The in-memory copy is current; the file catches up on the next change.
      rmSync(tmp, { force: true })
    }
  }

  return {
    get(moduleId) {
      catchUp()
      const namespace = current()[`${NAMESPACE_PREFIX}${moduleId.trim()}`]
      return namespace ? Object.freeze({ ...namespace }) : EMPTY
    },
    setValue(moduleId, key, value) {
      catchUp()
      const namespace = `${NAMESPACE_PREFIX}${moduleId.trim()}`
      const values = { ...current()[namespace] }
      if (value === undefined) delete values[key]
      else values[key] = structuredClone(value)
      const next = { ...current(), [namespace]: values }
      if (Object.keys(values).length === 0) delete next[namespace]
      commit(next)
    },
    forget(moduleId) {
      catchUp()
      const namespace = `${NAMESPACE_PREFIX}${moduleId.trim()}`
      if (!(namespace in current())) return
      const next = { ...current() }
      delete next[namespace]
      commit(next)
    },
    subscribe(moduleId, listener) {
      const namespace = `${NAMESPACE_PREFIX}${moduleId.trim()}`
      const set = listeners.get(namespace) ?? new Set()
      set.add(listener)
      listeners.set(namespace, set)
      current()
      startWatching()
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(namespace)
        if (listeners.size === 0 && anyListeners.size === 0) stopWatching()
      }
    },
    subscribeAll(listener) {
      anyListeners.add(listener)
      current()
      startWatching()
      return () => {
        anyListeners.delete(listener)
        if (listeners.size === 0 && anyListeners.size === 0) stopWatching()
      }
    },
    dispose() {
      listeners.clear()
      anyListeners.clear()
      stopWatching()
    },
  }
}

const mirrors = new Map<string, ModuleAppStateStore>()

/** The process's one mirror over `<userData>/module-app-state.json`. */
export function moduleAppStateMirrorFor(userDataDir: string): ModuleAppStateStore {
  const filePath = join(userDataDir, MODULE_APP_STATE_FILE)
  let mirror = mirrors.get(filePath)
  if (!mirror) {
    mirror = createModuleAppStateMirror({ filePath })
    mirrors.set(filePath, mirror)
  }
  return mirror
}
