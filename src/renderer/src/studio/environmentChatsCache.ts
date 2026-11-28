import type { EnvironmentRows } from './environmentChats'

// The last-known rows of each environment, kept in this window's IndexedDB by
// the environment's id: what it holds and its chats as the window last read
// them (`environmentChats.ts`). A window that starts while a machine is away
// draws that machine's rows from here, said to be a last-known list, until it
// answers and its live list replaces them.
//
// The stored shape is versioned: a list of another version is dropped, never
// read, so a change to what a row holds needs no migration of it. Forgetting
// an environment (it leaves the environment list) drops its list.

/** Bump when what is stored changes shape: lists of any other version are dropped. */
export const ENVIRONMENT_CHATS_CACHE_VERSION = 1

/** What of an environment's rows is kept across a restart: what was read of it, not what is happening now. */
export type CachedEnvironmentRows = Pick<EnvironmentRows, 'browse' | 'conversations' | 'access' | 'chatRecord'> & {
  /** When its chats were last read whole; the rows say how old they are by it. */
  listedAt?: number
}

type Stored = { version: number; environmentId: string; savedAt: number; rows: CachedEnvironmentRows }

export type EnvironmentChatsCache = {
  load(environmentId: string): Promise<CachedEnvironmentRows | null>
  save(environmentId: string, rows: CachedEnvironmentRows): Promise<void>
  /** Drop the list of every environment not named. */
  keepOnly(environmentIds: ReadonlySet<string>): Promise<void>
}

/** The rows a window keeps of an environment, from what it last read; null when it has read nothing worth keeping. */
export function cachedRowsOf(rows: EnvironmentRows): CachedEnvironmentRows | null {
  if (!rows.browse && !rows.conversations) return null
  return {
    browse: rows.browse,
    ...(rows.conversations ? { conversations: rows.conversations } : {}),
    ...(rows.access !== undefined ? { access: rows.access } : {}),
    ...(rows.chatRecord ? { chatRecord: rows.chatRecord } : {}),
    ...(rows.listedAt !== undefined ? { listedAt: rows.listedAt } : {}),
  }
}

/** A stored list as this build reads it, or null for one of another version or shape. */
function readStored(environmentId: string, value: unknown): CachedEnvironmentRows | null {
  const stored = value as Partial<Stored> | null | undefined
  if (!stored || stored.version !== ENVIRONMENT_CHATS_CACHE_VERSION || stored.environmentId !== environmentId)
    return null
  const rows = stored.rows as Partial<CachedEnvironmentRows> | undefined
  if (!rows || typeof rows !== 'object') return null
  if (rows.conversations !== undefined && !Array.isArray(rows.conversations)) return null
  const browse = rows.browse ?? null
  if (browse !== null && (typeof browse !== 'object' || !Array.isArray(browse.workspaces))) return null
  return { ...rows, browse } as CachedEnvironmentRows
}

const stamp = (environmentId: string, rows: CachedEnvironmentRows): Stored => ({
  version: ENVIRONMENT_CHATS_CACHE_VERSION,
  environmentId,
  savedAt: Date.now(),
  rows,
})

/** A cache held in memory, for a host without IndexedDB and for tests. */
export function memoryEnvironmentChatsCache(lists: Map<string, unknown> = new Map()): EnvironmentChatsCache {
  return {
    load: async (environmentId) => {
      const rows = readStored(environmentId, lists.get(environmentId))
      if (!rows) lists.delete(environmentId)
      return rows
    },
    save: async (environmentId, rows) => {
      lists.set(environmentId, structuredClone(stamp(environmentId, rows)))
    },
    keepOnly: async (environmentIds) => {
      for (const id of [...lists.keys()]) if (!environmentIds.has(id)) lists.delete(id)
    },
  }
}

const CACHE_DB = 'sprintengine-environment-chats'
const CACHE_STORE = 'lists'

/** The window's cache: one IndexedDB object store of each environment's list, by its id. */
export function indexedDbEnvironmentChatsCache(factory: IDBFactory, name: string = CACHE_DB): EnvironmentChatsCache {
  let opened: Promise<IDBDatabase> | null = null
  const database = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(name, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(CACHE_STORE)) request.result.createObjectStore(CACHE_STORE)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('The chat list store did not open.'))
    }).catch((error: unknown) => {
      opened = null
      throw error
    }))
  const run = <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void) =>
    database().then(
      (db) =>
        new Promise<T | undefined>((resolve, reject) => {
          const transaction = db.transaction(CACHE_STORE, mode)
          const request = work(transaction.objectStore(CACHE_STORE))
          transaction.oncomplete = () => resolve(request ? request.result : undefined)
          transaction.onerror = () => reject(transaction.error ?? new Error('The chat list store refused the change.'))
          transaction.onabort = () => reject(transaction.error ?? new Error('The chat list store refused the change.'))
        }),
    )
  return {
    load: async (environmentId) => {
      const rows = readStored(environmentId, await run<unknown>('readonly', (store) => store.get(environmentId)))
      if (!rows) await run('readwrite', (store) => store.delete(environmentId))
      return rows
    },
    save: async (environmentId, rows) =>
      void (await run('readwrite', (store) => store.put(stamp(environmentId, rows), environmentId))),
    keepOnly: async (environmentIds) => {
      const keys = (await run<IDBValidKey[]>('readonly', (store) => store.getAllKeys())) ?? []
      const gone = keys.filter((key) => typeof key !== 'string' || !environmentIds.has(key))
      if (gone.length === 0) return
      await run('readwrite', (store) => {
        for (const key of gone) store.delete(key)
      })
    },
  }
}

let shared: EnvironmentChatsCache | null | undefined
/** This window's cache; none outside a browser, so a test's sources keep nothing between tests. */
export function windowEnvironmentChatsCache(): EnvironmentChatsCache | null {
  if (shared !== undefined) return shared
  return (shared = typeof indexedDB === 'undefined' ? null : indexedDbEnvironmentChatsCache(indexedDB))
}
