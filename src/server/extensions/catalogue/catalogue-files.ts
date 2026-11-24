import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  readKillList,
  readOwnerRecords,
  readReleaseLock,
  type Catalogue,
  type CatalogueSource,
  type KillList,
  type OwnerRecords,
  type ReleaseLock,
} from '../../../../packages/extension-sdk/src/catalogue'

// What the catalogue keeps in a Studio's data folder, beside the approvals:
// the catalogues the person added, the last copy of each catalogue and of the
// lists beside them, where each extension was installed from, the release
// lock, and the updates waiting for review. Each file is small JSON, read
// whole and written whole through a temporary file, one write at a time per
// file. A damaged file reads as empty: it only costs what it cached, never
// lets anything run (what runs is decided from the bytes on disk).

/** A catalogue's id: `official`, `community`, or `git:<url>` for one the person added. */
export type CatalogueId = string
export const OFFICIAL_CATALOGUE: CatalogueId = 'official'
export const COMMUNITY_CATALOGUE: CatalogueId = 'community'
export const addedCatalogueId = (url: string): CatalogueId => `git:${url.trim()}`
export const addedCatalogueUrl = (id: CatalogueId): string | null => (id.startsWith('git:') ? id.slice(4) : null)

/** Where an installed extension came from, which decides where it updates from. */
export type ExtensionInstallOrigin =
  { kind: 'catalogue'; catalogue: CatalogueId; source: CatalogueSource } | { kind: 'git'; source: CatalogueSource }

export type ExtensionInstallRecord = {
  origin: ExtensionInstallOrigin
  version: string
  commit: string
  contentHash: string
  /** The repository owner's numeric id at the first install, when the catalogue knew it. */
  ownerId?: number
  installedAt: number
  /**
   * Installed from outside the window (an agent, the command line), from
   * anywhere but the official catalogue: nobody saw what it hands agents, so
   * it waits for the person's approval even when its tier alone would ask
   * nothing (skills, hosted MCP servers). Content never waits. Its updates
   * keep it; an install from the official catalogue drops it.
   */
  askPerson?: true
}

/** One version as Studio first saw it: a listed version never moves. */
export type LockedRelease = { commit: string; contentHash: string; firstSeenAt: number }

/**
 * An update left uninstalled for the person: it asks for more, moved, or its
 * owner changed. It names the exact release that was checked, so reviewing it
 * installs that release and no other.
 */
export type HeldUpdate = {
  version: string
  reason: 'access' | 'repository' | 'owner'
  growth?: string[]
  commit?: string
  contentHash?: string
}

export type CachedCatalogue = { fetchedAt: number; catalogue: Catalogue }

const FILES = {
  added: 'extension-catalogues.json',
  cache: 'extension-catalogue-cache.json',
  installs: 'extension-installs.json',
  lock: 'extension-release-lock.json',
  killList: 'extension-kill-list.json',
  held: 'extension-updates.json',
  owners: 'extension-owners.json',
  remoteLock: 'extension-catalogue-release-lock.json',
} as const

function readJsonSync(dataDir: string, name: string): unknown {
  try {
    return JSON.parse(readFileSync(join(dataDir, name), 'utf8')) as unknown
  } catch {
    return null
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const chains = new Map<string, Promise<unknown>>()

/** Read-modify-write one file, one change at a time. */
async function update<T>(dataDir: string, name: string, read: () => T, change: (value: T) => T | null): Promise<void> {
  const path = join(dataDir, name)
  const previous = chains.get(path) ?? Promise.resolve()
  const run = previous.then(async () => {
    const next = change(read())
    if (next === null) return
    await mkdir(dataDir, { recursive: true })
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, path)
  })
  chains.set(
    path,
    run.catch(() => undefined),
  )
  return run
}

// ── Catalogues the person added ─────────────────────────────────────────────

type AddedCatalogues = { added: string[]; communityRemoved?: true }

function readAddedSync(dataDir: string): AddedCatalogues {
  const raw = readJsonSync(dataDir, FILES.added)
  if (!isRecord(raw)) return { added: [] }
  const added = Array.isArray(raw.added)
    ? raw.added.filter((url): url is string => typeof url === 'string').slice(0, 64)
    : []
  return { added, ...(raw.communityRemoved === true ? { communityRemoved: true as const } : {}) }
}

export function readAddedCataloguesSync(dataDir: string): string[] {
  return readAddedSync(dataDir).added
}

export function writeAddedCatalogues(dataDir: string, change: (urls: string[]) => string[]): Promise<void> {
  return update<AddedCatalogues>(
    dataDir,
    FILES.added,
    () => readAddedSync(dataDir),
    (current) => ({
      ...current,
      added: change(current.added),
    }),
  )
}

/** The community catalogue is there from the start, until the person removes it. */
export function readCommunityRemovedSync(dataDir: string): boolean {
  return readAddedSync(dataDir).communityRemoved === true
}

export function writeCommunityRemoved(dataDir: string, removed: boolean): Promise<void> {
  return update<AddedCatalogues>(
    dataDir,
    FILES.added,
    () => readAddedSync(dataDir),
    (current) => {
      const { communityRemoved: _was, ...rest } = current
      return removed ? { ...rest, communityRemoved: true } : rest
    },
  )
}

// ── The last copy of each catalogue ─────────────────────────────────────────

export function readCatalogueCacheSync(dataDir: string): Record<CatalogueId, CachedCatalogue> {
  const raw = readJsonSync(dataDir, FILES.cache)
  return isRecord(raw) ? (raw as Record<CatalogueId, CachedCatalogue>) : {}
}

export function writeCatalogueCache(
  dataDir: string,
  change: (cache: Record<CatalogueId, CachedCatalogue>) => Record<CatalogueId, CachedCatalogue>,
): Promise<void> {
  return update(dataDir, FILES.cache, () => readCatalogueCacheSync(dataDir), change)
}

// ── Where each extension was installed from ─────────────────────────────────

export function readInstallRecordsSync(dataDir: string): Record<string, ExtensionInstallRecord> {
  const raw = readJsonSync(dataDir, FILES.installs)
  if (!isRecord(raw)) return {}
  const out: Record<string, ExtensionInstallRecord> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value) || !isRecord(value.origin) || typeof value.version !== 'string') continue
    out[key] = value as ExtensionInstallRecord
  }
  return out
}

export function writeInstallRecord(dataDir: string, key: string, record: ExtensionInstallRecord | null): Promise<void> {
  return update(
    dataDir,
    FILES.installs,
    () => readInstallRecordsSync(dataDir),
    (records) => {
      const next = { ...records }
      if (record) next[key] = record
      else if (key in next) delete next[key]
      else return null
      return next
    },
  )
}

// ── The release lock ────────────────────────────────────────────────────────

export function readReleaseLockSync(dataDir: string): Record<string, Record<string, LockedRelease>> {
  const raw = readJsonSync(dataDir, FILES.lock)
  return isRecord(raw) ? (raw as Record<string, Record<string, LockedRelease>>) : {}
}

/** Forget every version of one key: an uninstall starts its next install afresh. */
export function forgetLockedReleases(dataDir: string, key: string): Promise<void> {
  return update(
    dataDir,
    FILES.lock,
    () => readReleaseLockSync(dataDir),
    (lock) => {
      if (!(key in lock)) return null
      const next = { ...lock }
      delete next[key]
      return next
    },
  )
}

/**
 * Record each version the first time it is seen; a version seen before keeps
 * its first record, whatever is seen now.
 */
export function lockReleases(
  dataDir: string,
  releases: ReadonlyArray<{ key: string; version: string; commit: string; contentHash: string }>,
  now: number,
): Promise<void> {
  return update(
    dataDir,
    FILES.lock,
    () => readReleaseLockSync(dataDir),
    (lock) => {
      let changed = false
      const next = { ...lock }
      for (const release of releases) {
        const versions = { ...next[release.key] }
        if (versions[release.version]) continue
        versions[release.version] = { commit: release.commit, contentHash: release.contentHash, firstSeenAt: now }
        next[release.key] = versions
        changed = true
      }
      return changed ? next : null
    },
  )
}

// ── The kill list ───────────────────────────────────────────────────────────

export function readKillListCacheSync(dataDir: string): KillList | null {
  const raw = readJsonSync(dataDir, FILES.killList)
  if (raw === null) return null
  const read = readKillList(raw)
  return read.ok ? read.list : null
}

export function writeKillListCache(dataDir: string, list: KillList): Promise<void> {
  return update(
    dataDir,
    FILES.killList,
    () => null,
    () => list,
  )
}

// ── The owner records and the catalogue's release lock ──────────────────────
// Their last copies, so a restart with no network still knows who owns what
// and which versions are pinned.

export function readOwnerRecordsCacheSync(dataDir: string): OwnerRecords | null {
  const raw = readJsonSync(dataDir, FILES.owners)
  return raw === null ? null : readOwnerRecords(raw)
}

export function writeOwnerRecordsCache(dataDir: string, records: OwnerRecords): Promise<void> {
  return update(
    dataDir,
    FILES.owners,
    () => null,
    () => records,
  )
}

export function readRemoteReleaseLockCacheSync(dataDir: string): ReleaseLock | null {
  const raw = readJsonSync(dataDir, FILES.remoteLock)
  return raw === null ? null : readReleaseLock(raw)
}

export function writeRemoteReleaseLockCache(dataDir: string, lock: ReleaseLock): Promise<void> {
  return update(
    dataDir,
    FILES.remoteLock,
    () => null,
    () => lock,
  )
}

// ── Updates held for review ─────────────────────────────────────────────────

export function readHeldUpdatesSync(dataDir: string): Record<string, HeldUpdate> {
  const raw = readJsonSync(dataDir, FILES.held)
  return isRecord(raw) ? (raw as Record<string, HeldUpdate>) : {}
}

export function writeHeldUpdates(
  dataDir: string,
  change: (held: Record<string, HeldUpdate>) => Record<string, HeldUpdate> | null,
): Promise<void> {
  return update(dataDir, FILES.held, () => readHeldUpdatesSync(dataDir), change)
}
