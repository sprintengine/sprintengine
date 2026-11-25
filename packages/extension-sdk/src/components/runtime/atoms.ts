// Observable state for components panels: reading an atom while rendering
// subscribes the render to it. There are no hooks; state lives in atoms.

const ATOM = Symbol.for('sprintengine.components.atom')

/**
 * Where a keyed atom's value lives: `memory` (this panel run, and a
 * development folder's reloads), `plugin` (every run of the extension),
 * `workspace` (per workspace) or `storage` (the extension's own storage under
 * the atom's key, which its worker reads too).
 */
export type PersistScope = 'memory' | 'plugin' | 'workspace' | 'storage'
export type AtomOptions<T> = {
  persist?: PersistScope
  /**
   * Bump when the stored shape changes; `migrate` then turns an older value
   * into the new one. A value a newer version stored is left alone: the atom
   * starts from `initial`, and is stored only once it changes.
   */
  version?: number
  migrate?: (stored: unknown, fromVersion: number) => T
}
export type StoredValue = { version: number; value: unknown }

type AtomState<T> = {
  value: T
  initial: T
  listeners: Set<() => void>
  readonly: boolean
  /** A derived atom computes on every read, so what it reads subscribes the render. */
  compute?: () => T
  key?: string
  persist: PersistScope
  version: number
  migrate?: (stored: unknown, fromVersion: number) => T
}

export type Atom<T> = { readonly [ATOM]: AtomState<T> }

type Tracker = (atom: Atom<unknown>) => void
let activeTracker: Tracker | null = null

const ATOM_KEY = /^[A-Za-z0-9_.:-]{1,128}$/u
const keyed = new Map<string, Atom<unknown>>()
type SnapshotScope = Exclude<PersistScope, 'storage'>
/** Values Studio handed over, by scope; atoms created later start from them too. */
const snapshot: Record<SnapshotScope, Map<string, StoredValue>> = {
  memory: new Map(),
  plugin: new Map(),
  workspace: new Map(),
}
let onPersistedChange: ((atom: Atom<unknown>) => void) | null = null
let onMemoryChange: ((atom: Atom<unknown>) => void) | null = null
let onStorageAtom: ((key: string) => void) | null = null
let onAtomError: ((error: unknown, context: string) => void) | null = null
const writable = new Set<AtomState<unknown>>()

function create<T>(initial: T, fields: Partial<AtomState<T>> = {}): Atom<T> {
  const created = Object.freeze({
    [ATOM]: {
      value: initial,
      initial,
      listeners: new Set<() => void>(),
      readonly: false,
      persist: 'memory' as const,
      version: 1,
      ...fields,
    },
  })
  if (!created[ATOM].readonly) writable.add(created[ATOM] as AtomState<unknown>)
  return created
}

/** Every atom back to its initial value, every snapshot forgotten: one mount after another in a test. */
export function resetAtoms(): void {
  snapshot.memory = new Map()
  snapshot.plugin = new Map()
  snapshot.workspace = new Map()
  for (const inner of writable) inner.value = inner.initial
}

/** Forget every keyed atom: a test process loads the same module again. */
export function forgetKeyedAtoms(): void {
  keyed.clear()
}

type Found<T> = { found: true; value: T } | { found: false }

function stored<T>(inner: AtomState<T>): Found<T> {
  if (!inner.key || inner.persist === 'storage') return { found: false }
  const entry = snapshot[inner.persist].get(inner.key)
  if (!entry) return { found: false }
  if (entry.version === inner.version) return { found: true, value: entry.value as T }
  // A reload's hand-over never migrates: a new version there means "start this atom over".
  // Only an older version migrates; a newer one is another build's, and stays as it is stored.
  if (!inner.migrate || inner.persist === 'memory' || entry.version > inner.version) return { found: false }
  try {
    return { found: true, value: inner.migrate(entry.value, entry.version) }
  } catch (error) {
    // This atom starts from its initial value; every other atom still loads.
    const context = `migrate() for the atom "${inner.key}" threw; it starts from its initial value`
    if (onAtomError) onAtomError(error, context)
    else console.error(context, error)
    return { found: false }
  }
}

/** Hear an atom's `migrate` throwing (the runtime reports it as the panel's error). */
export function watchAtomErrors(listener: ((error: unknown, context: string) => void) | null): void {
  onAtomError = listener
}

/**
 * `atom(initial)` lives for this panel run. `atom(key, initial, options)` is
 * named (unique per extension) and may persist.
 */
export function atom<T>(initial: T): Atom<T>
export function atom<T>(key: string, initial: T, options?: AtomOptions<T>): Atom<T>
export function atom<T>(...args: [T] | [string, T, AtomOptions<T>?]): Atom<T> {
  if (args.length === 1) return create(args[0])
  const [key, initial, options = {}] = args
  if (typeof key !== 'string' || !ATOM_KEY.test(key))
    throw new TypeError('An atom key is 1-128 letters, digits or . _ : -')
  if (keyed.has(key)) throw new Error(`The atom key "${key}" is already used.`)
  const persist = options.persist ?? 'memory'
  if (!['memory', 'plugin', 'workspace', 'storage'].includes(persist))
    throw new TypeError('persist is "memory", "plugin", "workspace" or "storage".')
  const version = options.version ?? 1
  if (!Number.isSafeInteger(version) || version < 1) throw new TypeError('An atom version is a whole number from 1.')
  const result = create(initial, { key, persist, version, ...(options.migrate ? { migrate: options.migrate } : {}) })
  const inner = result[ATOM]
  const hydrated = stored(inner)
  if (hydrated.found) inner.value = hydrated.value
  keyed.set(key, result as Atom<unknown>)
  if (persist === 'storage') onStorageAtom?.(key)
  return result
}

/** A read-only atom computed from others. */
export function derived<T>(compute: () => T): Atom<T> {
  if (typeof compute !== 'function') throw new TypeError('derived() takes a function.')
  return create(compute(), { readonly: true, compute })
}

/** A read-only atom only Studio changes (`ctx.visible`, the theme). */
export function hostAtom<T>(initial: T): { atom: Atom<T>; set: (value: T) => void } {
  const result = create(initial, { readonly: true })
  return { atom: result, set: (value) => assign(result[ATOM], value, false) }
}

function state<T>(target: Atom<T>): AtomState<T> {
  const inner = typeof target === 'object' && target !== null ? target[ATOM] : undefined
  if (!inner) throw new TypeError('Expected an atom made by atom().')
  return inner
}

export function read<T>(target: Atom<T>): T {
  const inner = state(target)
  if (inner.compute) return inner.compute()
  activeTracker?.(target as Atom<unknown>)
  return inner.value
}

function assign<T>(inner: AtomState<T>, value: T, fromPanel: boolean): void {
  if (Object.is(value, inner.value)) return
  inner.value = value
  for (const listener of [...inner.listeners]) listener()
  const target = fromPanel && inner.key ? keyed.get(inner.key) : undefined
  if (target) (inner.persist === 'memory' ? onMemoryChange : onPersistedChange)?.(target)
}

function writableState<T>(target: Atom<T>, verb: string): AtomState<T> {
  // A write while rendering would schedule another render, for ever.
  if (activeTracker) throw new Error(`${verb}() was called while rendering; call it from an event handler instead.`)
  const inner = state(target)
  if (inner.readonly) throw new TypeError(`${verb}() cannot change a read-only atom.`)
  return inner
}

/** Store `value` as it is, functions included. */
export function set<T>(target: Atom<T>, value: T): void {
  assign(writableState(target, 'set'), value, true)
}

/** Replace the value with `updater(previous)`. */
export function update<T>(target: Atom<T>, updater: (previous: T) => T): void {
  const inner = writableState(target, 'update')
  if (typeof updater !== 'function') throw new TypeError('update() takes a function; use set() to store a value.')
  assign(inner, updater(inner.value), true)
}

export function subscribeAtom(target: Atom<unknown>, listener: () => void): () => void {
  const inner = state(target)
  inner.listeners.add(listener)
  return () => inner.listeners.delete(listener)
}

/** Run `render`, adding every atom it reads to `reads`, even when it throws. */
export function trackAtomReads<R>(reads: Set<Atom<unknown>>, render: () => R): R {
  const previous = activeTracker
  activeTracker = (target) => reads.add(target)
  try {
    return render()
  } finally {
    activeTracker = previous
  }
}

export type PersistedEntry = { scope: 'plugin' | 'workspace' | 'storage'; key: string; version: number; value: unknown }

export function persistedEntry(target: Atom<unknown>): PersistedEntry | null {
  const inner = state(target)
  return inner.key && inner.persist !== 'memory'
    ? { scope: inner.persist, key: inner.key, version: inner.version, value: inner.value }
    : null
}

/** Hear each persisted atom the panel changes (not Studio's hydration). */
export function watchPersistedAtoms(listener: ((atom: Atom<unknown>) => void) | null): void {
  onPersistedChange = listener
}

/** A keyed memory atom's value, for the next guest of a development folder's reload. */
export function memoryEntry(target: Atom<unknown>): { key: string; version: number; value: unknown } | null {
  const inner = state(target)
  return inner.key && inner.persist === 'memory' ? { key: inner.key, version: inner.version, value: inner.value } : null
}

/** Every keyed memory atom, for the hand-over when a reload is asked for after changes. */
export function keyedMemoryAtoms(): Atom<unknown>[] {
  return [...keyed.values()].filter((target) => target[ATOM].persist === 'memory')
}

export function watchMemoryAtoms(listener: ((atom: Atom<unknown>) => void) | null): void {
  onMemoryChange = listener
}

/** `storage` atoms: `listener` hears every key, including those made before it was set. */
export function watchStorageAtoms(listener: ((key: string) => void) | null): void {
  onStorageAtom = listener
  if (!listener) return
  for (const [key, target] of keyed) if (target[ATOM].persist === 'storage') listener(key)
}

/** The stored value of a `storage` atom; `undefined` puts it back to its initial value. */
export function applyStorageValue(key: string, value: unknown): void {
  const inner = keyed.get(key)?.[ATOM]
  if (inner?.persist === 'storage') assign(inner, value === undefined ? inner.initial : value, false)
}

/** Values Studio stored for a scope; a key the new values lack goes back to its initial value. */
export function hydrateAtoms(scope: SnapshotScope, values: ReadonlyMap<string, StoredValue>): void {
  snapshot[scope] = new Map(values)
  for (const target of keyed.values()) {
    const inner = target[ATOM]
    if (inner.persist !== scope) continue
    const hydrated = stored(inner)
    // A hand-over only ever adds values.
    if (hydrated.found || scope !== 'memory') assign(inner, hydrated.found ? hydrated.value : inner.initial, false)
  }
}
