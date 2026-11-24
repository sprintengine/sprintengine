import {
  STUDIO_EXTENSION_VERSION,
  compareStudioVersions,
  parseExtensionInstallKey,
  type ExtensionManifest,
} from '../../../../packages/extension-sdk/src/extension-manifest'
import {
  catalogueReleaseMismatch,
  findKilled,
  isReservedInstallKey,
  isSameCatalogueSource,
  parseGitRepository,
  readCatalogue,
  readOwnerRecords,
  readReleaseLock,
  selectCatalogueRelease,
  type Catalogue,
  type CatalogueEntry,
  type CatalogueRelease,
  type CatalogueSource,
  type KillList,
  type OwnerRecords,
  type ReleaseLock,
} from '../../../../packages/extension-sdk/src/catalogue'
import {
  isFetchableGitUrl,
  type FetchedCommit,
  type GitOptions,
} from '../../../../packages/extension-sdk/src/git-source'
import type {
  StudioCatalogueEntryView,
  StudioCatalogueListing,
  StudioCatalogueView,
  StudioExtensionApproval,
  StudioExtensionInstallSource,
  StudioExtensionOrigin,
  StudioExtensionUpdate,
  StudioModuleNotification,
  ThirdPartyModuleView,
} from '../../../../packages/studio-protocol/src/public'
import {
  accessGrowth,
  extensionAccess,
  extensionNeedsApproval,
  readExtensionApprovalsSync,
  writeExtensionApproval,
} from '../../../main/modules/extension-approvals'
import {
  COMMUNITY_CATALOGUE,
  OFFICIAL_CATALOGUE,
  addedCatalogueId,
  addedCatalogueUrl,
  forgetLockedReleases,
  lockReleases,
  readAddedCataloguesSync,
  readCatalogueCacheSync,
  readCommunityRemovedSync,
  readHeldUpdatesSync,
  readInstallRecordsSync,
  readOwnerRecordsCacheSync,
  readReleaseLockSync,
  readRemoteReleaseLockCacheSync,
  writeAddedCatalogues,
  writeCatalogueCache,
  writeCommunityRemoved,
  writeHeldUpdates,
  writeInstallRecord,
  writeOwnerRecordsCache,
  writeRemoteReleaseLockCache,
  type CatalogueId,
  type ExtensionInstallRecord,
  type HeldUpdate,
} from './catalogue-files'
import { checkOutExtension, sourcePublisher, type CheckedOut } from './catalogue-checkout'
import {
  defaultGitOptions,
  extensionCatalogueUrls,
  fetchCatalogueBytes,
  fetchCatalogueJson,
  fetchGitCatalogue,
  readFetchedFile,
  type CatalogueUrls,
} from './catalogue-fetch'
import { createKillListService, type KillListService } from './kill-list'

// The extension catalogue on one Studio: browsing the catalogues, installing
// from a catalogue entry or a git URL, updating, and the kill list. Every
// install goes through the lifecycle's install of the folder Studio checked
// out (`installChecked`), so approvals, the projection of what extensions hand
// agents and `changed()` work as for a folder install. What this adds before
// that install:
//
// - the publisher is the repository's owner (the catalogue's `id` says it,
//   and for every catalogue it must be the source URL's owner, the host
//   first on a host other than github.com); reserved publishers and ids
//   install only from the official catalogue, and a catalogue listing one
//   otherwise is refused whole;
// - the checked-out bytes must be the release's (`contentHash`) and its
//   manifest what the release declares;
// - a version keeps the commit and hash it was first seen with, here
//   (`extension-release-lock.json`) and in the catalogue repository's release
//   lock: a moved tag never replaces a listed version;
// - every install records where it came from, and an update comes only from
//   there; the owner's numeric id is recorded at the first install, and a
//   rename or a transfer pauses updates;
// - the kill list: a killed version is refused, and one installed is held
//   back from running (module-signature.ts).

/** A release a community or added catalogue lists installs unasked only after this long, so a takedown can land. */
export const AUTO_UPDATE_HOLD_BACK_MS = 12 * 60 * 60 * 1000
/** Half the hold-back: a release first seen one pass ago is old enough by the next. */
export const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000
const IMAGE_MAX_BYTES = 2 * 1024 * 1024
/** The images Studio keeps in memory, by sha256, so a view drawn again fetches nothing. */
const IMAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024
/** A refresh asked for within this long of the last one is answered from that one. */
const REFRESH_MIN_INTERVAL_MS = 30_000
const OFFICIAL_OWNER = 'sprintengine'

type InstallAnswer =
  | { ok: true; moduleId: string; approval: StudioExtensionApproval; strippedLinks: string[] }
  | {
      ok: false
      message: string
      issues?: Array<{ path: string; message: string }>
      /** The folders of a Claude Code plugin marketplace, one of which to name. */
      folders?: string[]
    }

export type CatalogueNotice = {
  key: string
  name: string
  severity: 'info' | 'warning' | 'error'
  title: string
  body?: string
}

/** An installed extension as the catalogue needs it: its manifest, and how its approval stands. */
export type InstalledForCatalogue = {
  key: string
  manifest: ExtensionManifest
  approval: 'approved' | 'not-needed' | 'pending' | 'unavailable'
  development: boolean
  killed: boolean
  /** Switched on here: one switched off is not updated on its own. */
  enabled: boolean
}

export type ExtensionCatalogueDeps = {
  dataDir: string
  /** Install the extension in this checked-out folder, under this publisher (the lifecycle's folder install). */
  installChecked: (dir: string, options: { publisher: string; official: boolean }) => Promise<InstallAnswer>
  /** The extensions installed here now, development folders standing in for one included. */
  installed: () => Promise<InstalledForCatalogue[]>
  /** The kill list changed: judge every extension again and retract what a killed one added. */
  killListChanged: () => Promise<void>
  notify?: (notice: CatalogueNotice) => void
  urls?: CatalogueUrls
  fetchJson?: (url: string) => Promise<unknown>
  fetchBytes?: (url: string, maxBytes: number) => Promise<Buffer>
  git?: GitOptions
  now?: () => number
  studioVersion?: string
  warn?: (message: string) => void
}

export type ExtensionCatalogue = {
  catalogues(refresh?: boolean): Promise<StudioCatalogueView[]>
  entry(
    catalogue: CatalogueId,
    key: string,
  ): Promise<{ ok: true; entry: StudioCatalogueEntryView } | { ok: false; message: string }>
  image(
    catalogue: CatalogueId,
    path: string,
    sha256: string,
  ): Promise<{ ok: true; mime: string; base64: string } | { ok: false; message: string }>
  add(url: string): Promise<{ ok: true; catalogue: StudioCatalogueView } | { ok: false; message: string }>
  remove(url: string): Promise<{ ok: true } | { ok: false; message: string }>
  /**
   * A catalogue install from a client names the whole release its page
   * showed (`StudioExtensionInstallSource`); only Studio's own callers name
   * just the entry, to install what the catalogue lists now.
   */
  installFrom(
    from: StudioExtensionInstallSource | { catalogue: string; id: string },
  ): Promise<InstallAnswer & { leftOut?: string[] }>
  /** Install the newer release of an installed extension; `version` is the one the person was shown. */
  update(key: string, version?: string): Promise<InstallAnswer>
  /** An installed extension's origin, its update and its kill, for `extension.installed`. */
  annotate(views: ThirdPartyModuleView[]): ThirdPartyModuleView[]
  /** An uninstall forgets where it came from and any update it held. */
  forget(key: string): Promise<void>
  /** One pass of automatic updates. */
  runUpdates(): Promise<void>
  readonly killList: KillListService
  /** Refresh the kill list and check for updates periodically; returns the stopper. */
  start(): () => void
  /** Let go of what is kept in temporary folders (an added catalogue's repository). */
  dispose(): Promise<void>
}

const mimeOf = (path: string) =>
  path.toLowerCase().endsWith('.png')
    ? 'image/png'
    : path.toLowerCase().endsWith('.webp')
      ? 'image/webp'
      : /\.jpe?g$/i.test(path)
        ? 'image/jpeg'
        : null

/** `host/owner` of a git URL, for an added catalogue's label. */
function ownerLabel(url: string): string {
  const identity = parseGitRepository(url)
  return identity ? `${identity.host}/${identity.owner.toLowerCase()}` : url
}

export function createExtensionCatalogue(deps: ExtensionCatalogueDeps): ExtensionCatalogue {
  const urls = deps.urls ?? extensionCatalogueUrls()
  const git = deps.git ?? defaultGitOptions()
  const fetchJson = deps.fetchJson ?? fetchCatalogueJson
  const fetchBytes = deps.fetchBytes ?? fetchCatalogueBytes
  const now = deps.now ?? Date.now
  const studioVersion = deps.studioVersion ?? STUDIO_EXTENSION_VERSION
  const errors = new Map<CatalogueId, string>()
  // The last copies, read from disk at start, so a restart without network
  // still knows who owns what (an owner check that cannot read fails closed).
  let owners: OwnerRecords | null = readOwnerRecordsCacheSync(deps.dataDir)
  let remoteLock: ReleaseLock | null = readRemoteReleaseLockCacheSync(deps.dataDir)
  /** Each added catalogue's repository as last fetched: its images are read from it. */
  const addedRepositories = new Map<CatalogueId, FetchedCommit>()
  const images = new Map<string, { mime: string; bytes: Buffer }>()
  let imageBytes = 0

  const killList = createKillListService({
    dataDir: deps.dataDir,
    fetch: () => fetchJson(urls.killList),
    now,
    ...(deps.warn ? { warn: deps.warn } : {}),
    changed: async (previous, next) => {
      await deps.killListChanged()
      // A clear notice for each installed version the new list kills.
      for (const module of await deps.installed()) {
        const entry = findKilled(next, module.key, module.manifest.version)
        if (!entry || findKilled(previous, module.key, module.manifest.version)) continue
        deps.notify?.({
          key: module.key,
          name: module.manifest.name,
          severity: 'error',
          title: `${module.manifest.name} was switched off`,
          body: `Studio’s kill list removed version ${module.manifest.version}: ${entry.reason}${entry.advisoryUrl ? ` (${entry.advisoryUrl})` : ''}`,
        })
      }
    },
  })

  // ── Catalogues ────────────────────────────────────────────────────────────

  // The community catalogue is there from the start, until the person removes it.
  const catalogueIds = (): CatalogueId[] => [
    OFFICIAL_CATALOGUE,
    ...(readCommunityRemovedSync(deps.dataDir) ? [] : [COMMUNITY_CATALOGUE]),
    ...readAddedCataloguesSync(deps.dataDir).map(addedCatalogueId),
  ]
  const isKnownCatalogue = (id: CatalogueId) => catalogueIds().includes(id)

  /** Why a catalogue Studio read is refused whole, or null. */
  function provenanceProblem(id: CatalogueId, catalogue: Catalogue): string | null {
    const official = id === OFFICIAL_CATALOGUE
    if (official && catalogue.owner.toLowerCase() !== OFFICIAL_OWNER)
      return 'The official catalogue names an unexpected owner, so it was refused.'
    for (const entry of catalogue.extensions) {
      if (isReservedInstallKey(entry.id) && !official)
        return `It lists ${entry.id}, a name only Studio’s official catalogue may list, so it was refused.`
      // Every catalogue, an added one too, lists each extension under its
      // repository's owner: one listing another owner's name would install
      // as them, block their own and share their kills.
      const owner = sourcePublisher(entry.source.url)
      if (owner !== parseExtensionInstallKey(entry.id)!.publisher)
        return owner === null
          ? `It lists ${entry.id} from a repository Studio cannot tell the owner of, so it was refused.`
          : `It lists ${entry.id} from a repository owned by ${owner}, so it was refused.`
    }
    return null
  }

  /** A catalogue as read now; an added one's repository is kept, for its images. */
  async function fetchCatalogue(id: CatalogueId): Promise<{ catalogue: Catalogue; fetched?: FetchedCommit }> {
    const added = addedCatalogueUrl(id)
    let raw: unknown
    let fetched: FetchedCommit | undefined
    if (added) ({ raw, fetched } = await fetchGitCatalogue(added, git))
    else raw = await fetchJson(id === OFFICIAL_CATALOGUE ? urls.official : urls.community)
    const read = readCatalogue(raw, { fetchable: (url) => isFetchableGitUrl(url, git) })
    const problem = !read.ok ? read.message : provenanceProblem(id, read.catalogue)
    if (problem || !read.ok) {
      await fetched?.dispose()
      throw new Error(problem ?? 'The catalogue could not be read.')
    }
    return { catalogue: read.catalogue, ...(fetched ? { fetched } : {}) }
  }

  // Set once Studio lets go of its checkouts: a read that lands after is not kept.
  let disposed = false

  async function keepRepository(id: CatalogueId, fetched: FetchedCommit | undefined): Promise<void> {
    if (disposed) {
      await fetched?.dispose()
      return
    }
    const before = addedRepositories.get(id)
    if (fetched) addedRepositories.set(id, fetched)
    else addedRepositories.delete(id)
    if (before && before !== fetched) await before.dispose()
  }

  // One read of a catalogue at a time: the images and a refresh share it.
  const refreshing = new Map<CatalogueId, Promise<void>>()
  function refreshOne(id: CatalogueId): Promise<void> {
    const running = refreshing.get(id)
    if (running) return running
    const run = (async () => {
      try {
        const { catalogue, fetched } = await fetchCatalogue(id)
        await writeCatalogueCache(deps.dataDir, (cache) => ({ ...cache, [id]: { fetchedAt: now(), catalogue } }))
        await keepRepository(id, fetched)
        errors.delete(id)
      } catch (error) {
        errors.set(id, (error as Error).message)
      }
    })().finally(() => refreshing.delete(id))
    refreshing.set(id, run)
    return run
  }

  async function refreshLists(): Promise<void> {
    const [ownersRaw, lockRaw] = await Promise.allSettled([fetchJson(urls.owners), fetchJson(urls.releaseLock)])
    const readOwners = ownersRaw.status === 'fulfilled' ? readOwnerRecords(ownersRaw.value) : null
    if (readOwners) {
      owners = readOwners
      await writeOwnerRecordsCache(deps.dataDir, readOwners)
    }
    const readLock = lockRaw.status === 'fulfilled' ? readReleaseLock(lockRaw.value) : null
    if (readLock) {
      remoteLock = readLock
      await writeRemoteReleaseLockCache(deps.dataDir, readLock)
    }
  }

  let lastRefreshAll = Number.NEGATIVE_INFINITY
  let refreshAllRunning: Promise<void> | null = null
  /** Read every catalogue and list again; a refresh asked for while one runs is that one. */
  function refreshAll(): Promise<void> {
    if (refreshAllRunning) return refreshAllRunning
    lastRefreshAll = now()
    refreshAllRunning = (async () => {
      await Promise.all([...catalogueIds().map(refreshOne), refreshLists()])
      // The first time a release of something installed here is seen in the
      // catalogue it came from, it is locked. Other catalogues' listings of
      // the same id are not kept: they never decide what installs here.
      const records = readInstallRecordsSync(deps.dataDir)
      const cache = readCatalogueCacheSync(deps.dataDir)
      const seen: Array<{ key: string; version: string; commit: string; contentHash: string }> = []
      for (const module of await deps.installed()) {
        const record = records[module.key]
        if (module.development || record?.origin.kind !== 'catalogue') continue
        const entry = cache[record.origin.catalogue]?.catalogue.extensions.find((item) => item.id === module.key)
        if (!entry || !isSameCatalogueSource(record.origin.source, entry.source)) continue
        for (const release of entry.releases)
          seen.push({
            key: entry.id,
            version: release.version,
            commit: release.commit,
            contentHash: release.contentHash,
          })
      }
      await lockReleases(deps.dataDir, seen, now())
    })().finally(() => {
      refreshAllRunning = null
    })
    return refreshAllRunning
  }

  const cached = (id: CatalogueId) => readCatalogueCacheSync(deps.dataDir)[id]
  const findEntry = (id: CatalogueId, key: string): CatalogueEntry | null =>
    cached(id)?.catalogue.extensions.find((entry) => entry.id === key) ?? null
  const catalogueName = (id: CatalogueId): string =>
    cached(id)?.catalogue.name ??
    (id === OFFICIAL_CATALOGUE ? 'Official' : id === COMMUNITY_CATALOGUE ? 'Community' : (addedCatalogueUrl(id) ?? id))
  const catalogueKind = (id: CatalogueId): StudioCatalogueView['kind'] =>
    id === OFFICIAL_CATALOGUE ? 'official' : id === COMMUNITY_CATALOGUE ? 'community' : 'added'

  /** The trust label, from the catalogue's address and never from the extension's own words. */
  function trustLabel(id: CatalogueId, key: string): string {
    if (id === OFFICIAL_CATALOGUE) return 'Official'
    const publisher = parseExtensionInstallKey(key)?.publisher ?? key
    if (id === COMMUNITY_CATALOGUE) return `Community · ${publisher}`
    const url = addedCatalogueUrl(id) ?? id
    return `${catalogueName(id)} · ${ownerLabel(url)}`
  }

  function listing(
    id: CatalogueId,
    entry: CatalogueEntry,
    installed: ReadonlyMap<string, InstalledForCatalogue>,
    records: Record<string, ExtensionInstallRecord>,
  ): StudioCatalogueListing | null {
    const chosen = selectCatalogueRelease(entry.releases, studioVersion)
    if (!chosen) return null
    const { release } = chosen
    const here = installed.get(entry.id)
    const record = records[entry.id]
    const killed = findKilled(killList.current(), entry.id, release.version)
    return {
      id: entry.id,
      name: release.name ?? parseExtensionInstallKey(entry.id)?.id ?? entry.id,
      publisher: parseExtensionInstallKey(entry.id)?.publisher ?? '',
      ...(entry.description ? { description: entry.description } : {}),
      categories: entry.categories,
      version: release.version,
      installable: chosen.installable,
      ...(chosen.installable ? {} : { needsStudio: release.minimumStudio }),
      tier: release.tier,
      permissions: release.permissions,
      contributes: release.contributes,
      label: trustLabel(id, entry.id),
      ...(release.images?.icon ? { icon: release.images.icon } : {}),
      ...(here && !here.development
        ? {
            installed: {
              version: here.manifest.version,
              fromHere: record?.origin.kind === 'catalogue' && record.origin.catalogue === id,
            },
          }
        : {}),
      ...(killed
        ? { killed: { reason: killed.reason, ...(killed.advisoryUrl ? { advisoryUrl: killed.advisoryUrl } : {}) } }
        : {}),
    }
  }

  const installedMap = async () => new Map((await deps.installed()).map((module) => [module.key, module]))

  // ── Checks before an install ──────────────────────────────────────────────

  /** Why this version may not be installed with these bytes: a version keeps what it was first seen with. */
  function lockProblem(
    key: string,
    version: string,
    pinned: { commit?: string; contentHash: string },
    origin: 'catalogue' | 'git',
  ): string | null {
    const moved = (first: { commit: string; contentHash: string }) =>
      first.contentHash !== pinned.contentHash || (pinned.commit !== undefined && first.commit !== pinned.commit)
    // A git URL install is the person's own choice of commit, so only a
    // catalogue install is held to what this Studio saw before.
    const local = origin === 'catalogue' ? readReleaseLockSync(deps.dataDir)[key]?.[version] : undefined
    if (local && moved(local))
      return `${key} ${version} was first seen here at commit ${local.commit.slice(0, 12)}, and a listed version never moves, so these bytes were refused. Its author must publish a new version; or remove ${key} and install it again to start afresh.`
    const remote = remoteLock?.releases.find((entry) => entry.id === key && entry.version === version)
    if (remote && moved(remote))
      return `${key} ${version} is locked to commit ${remote.commit.slice(0, 12)} in Studio’s release lock, so these bytes were refused. Its author must publish a new version.`
    return null
  }

  /** The owner id an entry names now: the catalogue's, else the owner records' for the publisher. */
  function currentOwnerId(entry: CatalogueEntry): number | undefined {
    if (entry.ownerId !== undefined) return entry.ownerId
    const publisher = parseExtensionInstallKey(entry.id)?.publisher
    return owners?.owners.find((owner) => owner.login.toLowerCase() === publisher)?.id
  }

  /** Why updates of an install are paused: its owner was renamed, the name changed hands, or it cannot be told. */
  function ownerPause(record: ExtensionInstallRecord, entry: CatalogueEntry): string | null {
    if (record.ownerId === undefined) return null
    const current = currentOwnerId(entry)
    if (current === undefined)
      return `Studio cannot read who owns ${entry.id} now, so it does not update it until it can.`
    if (current !== record.ownerId)
      return `The account that owns ${entry.id} is not the one it was installed from (it changed hands, or the name was taken again). Updates are paused; install it again to trust the new owner.`
    const renamed = owners?.owners.find((owner) => owner.id === record.ownerId)
    const publisher = parseExtensionInstallKey(entry.id)?.publisher
    if (renamed && renamed.login.toLowerCase() !== publisher)
      return `The account that owned ${entry.id} is now named ${renamed.login}. Updates are paused; install it again from its new name.`
    return null
  }

  /**
   * The kill list as it stands now, read again before every install. Without
   * a fresh one: the kept copy, with a warning, unless `fresh` is asked for
   * (an install nobody is watching waits for the next pass). With none at
   * all, nothing installs: a takedown could not stop it.
   */
  async function killListForInstall(
    fresh: boolean,
  ): Promise<{ ok: true; list: KillList | null } | { ok: false; message: string }> {
    try {
      return { ok: true, list: await killList.refresh() }
    } catch (error) {
      const kept = killList.current()
      const why = (error as Error).message
      if (!kept || fresh)
        return { ok: false, message: `Studio could not read its kill list, so nothing installs until it can: ${why}` }
      deps.warn?.(`The kill list could not be read; the install was checked against the kept copy: ${why}`)
      return { ok: true, list: kept }
    }
  }

  /** The release an install was checked against: what may be installed, and nothing else. */
  type CheckedRelease = {
    version: string
    commit?: string
    contentHash?: string
    source?: CatalogueSource
    /** The owner id checked; null when the check found none. */
    ownerId?: number | null
  }

  /** Why the release a catalogue lists now is not the one that was checked, or null. */
  function changedSince(
    key: string,
    id: CatalogueId,
    entry: CatalogueEntry,
    release: CatalogueRelease,
    checked: CheckedRelease,
  ): string | null {
    const again = `${catalogueName(id)} changed ${key} since it was checked`
    if (release.version !== checked.version)
      return `${catalogueName(id)} now lists ${key} ${release.version}, not ${checked.version}. Look at it again before you install it.`
    if (
      (checked.commit !== undefined && checked.commit !== release.commit) ||
      (checked.contentHash !== undefined && checked.contentHash !== release.contentHash)
    )
      return `${again}: version ${release.version} now points at other bytes. Look at it again before you install it.`
    if (checked.source && !isSameCatalogueSource(checked.source, entry.source))
      return `${again}: it moved to another repository or folder. Look at it again before you install it.`
    if (checked.ownerId !== undefined && (currentOwnerId(entry) ?? null) !== checked.ownerId)
      return `${again}: its owner changed. Look at it again before you install it.`
    return null
  }

  type Prepared = { checkedOut: CheckedOut; release: CatalogueRelease; entry: CatalogueEntry }

  /**
   * Check out the release a catalogue lists now, read again, and check it.
   * With `checked`, only that exact release (its version, commit, hash,
   * source and owner) is prepared: a catalogue that changed since is refused
   * with `changed`, never installed in its place.
   */
  async function prepareCatalogueRelease(
    id: CatalogueId,
    key: string,
    options: { checked?: CheckedRelease; automatic?: boolean } = {},
  ): Promise<{ ok: true; prepared: Prepared } | { ok: false; message: string; changed?: true }> {
    if (!isKnownCatalogue(id)) return { ok: false, message: 'That catalogue has not been added here.' }
    if (isReservedInstallKey(key) && id !== OFFICIAL_CATALOGUE)
      return { ok: false, message: `${key} uses a name only Studio’s official catalogue installs.` }
    // What the catalogue lists now; its last copy when it cannot be read.
    await refreshOne(id)
    await refreshLists()
    const entry = findEntry(id, key)
    if (!entry) return { ok: false, message: `${catalogueName(id)} does not list ${key}.` }
    const chosen = selectCatalogueRelease(entry.releases, studioVersion)
    if (!chosen) return { ok: false, message: `${catalogueName(id)} lists no release of ${key} Studio can read.` }
    if (!chosen.installable)
      return {
        ok: false,
        message: `${key} ${chosen.release.version} needs Studio ${chosen.release.minimumStudio} or newer.`,
      }
    const { release } = chosen
    if (options.checked) {
      const changed = changedSince(key, id, entry, release, options.checked)
      if (changed) return { ok: false, message: changed, changed: true }
    }
    const list = await killListForInstall(options.automatic === true)
    if (!list.ok) return list
    const killed = findKilled(list.list, key, release.version)
    if (killed) return { ok: false, message: `Studio’s kill list removed ${key} ${release.version}: ${killed.reason}` }
    const locked = lockProblem(key, release.version, release, 'catalogue')
    if (locked) return { ok: false, message: locked }
    const checked = await checkOutExtension({
      url: entry.source.url,
      ref: release.commit,
      ...(entry.source.path ? { path: entry.source.path } : {}),
      git,
    })
    if (!checked.ok) return checked
    const { checkedOut } = checked
    const mismatch =
      checkedOut.manifest.id !== parseExtensionInstallKey(key)?.id
        ? `Its extension.json says id "${checkedOut.manifest.id}", and the catalogue lists ${key}.`
        : catalogueReleaseMismatch({
            release,
            manifest: checkedOut.manifest,
            commit: checkedOut.commit,
            contentHash: checkedOut.contentHash,
          })
    if (mismatch) {
      await checkedOut.dispose()
      return { ok: false, message: `${key} was refused: ${mismatch}` }
    }
    return { ok: true, prepared: { checkedOut, release, entry } }
  }

  /** Install what was checked out, and record where it came from. */
  async function installPrepared(
    checkedOut: CheckedOut,
    key: string,
    origin: ExtensionInstallRecord['origin'],
    ownerId: number | undefined,
  ): Promise<InstallAnswer> {
    const previous = readInstallRecordsSync(deps.dataDir)[key] ?? null
    try {
      const publisher = parseExtensionInstallKey(key)!.publisher
      const official = origin.kind === 'catalogue' && origin.catalogue === OFFICIAL_CATALOGUE
      // Recorded first: discovery admits a key under a repository owner only
      // once Studio recorded where it came from, and the install discovers it.
      await writeInstallRecord(deps.dataDir, key, {
        origin,
        version: checkedOut.manifest.version,
        commit: checkedOut.commit,
        contentHash: checkedOut.contentHash,
        ...(ownerId !== undefined ? { ownerId } : {}),
        installedAt: now(),
      })
      const answer = await deps.installChecked(checkedOut.dir, { publisher, official })
      if (!answer.ok) {
        await writeInstallRecord(deps.dataDir, key, previous)
        return answer
      }
      // A catalogue's version keeps the bytes it was installed with; a git
      // URL install is the person's choice of commit each time.
      if (origin.kind === 'catalogue')
        await lockReleases(
          deps.dataDir,
          [
            {
              key,
              version: checkedOut.manifest.version,
              commit: checkedOut.commit,
              contentHash: checkedOut.contentHash,
            },
          ],
          now(),
        )
      await writeHeldUpdates(deps.dataDir, (held) => {
        if (!(key in held)) return null
        const next = { ...held }
        delete next[key]
        return next
      })
      return { ...answer, strippedLinks: [...new Set([...answer.strippedLinks, ...checkedOut.strippedLinks])].sort() }
    } catch (error) {
      await writeInstallRecord(deps.dataDir, key, previous)
      throw error
    } finally {
      await checkedOut.dispose()
    }
  }

  const originWords = (origin: ExtensionInstallRecord['origin']) =>
    origin.kind === 'catalogue'
      ? catalogueName(origin.catalogue)
      : `the git URL ${origin.source.url}${origin.source.path ? ` (folder ${origin.source.path})` : ''}`

  /**
   * Why an install from `next` may not replace what is installed under the
   * key: another kind of source, another catalogue, or another repository or
   * folder behind a git URL. Its approval was given to the first source and
   * never carries to another; the person removes it first. (A catalogue's own
   * entry moving is an update, reviewed with its approval asked again.)
   */
  async function originChange(key: string, next: ExtensionInstallRecord['origin']): Promise<string | null> {
    const record = readInstallRecordsSync(deps.dataDir)[key]
    const there = originWords(next)
    if (!record) {
      const here = (await deps.installed()).some((module) => module.key === key && !module.development)
      return here ? `${key} is already installed; remove it first to install it from ${there}.` : null
    }
    const from = record.origin
    const same =
      from.kind === 'catalogue' && next.kind === 'catalogue'
        ? from.catalogue === next.catalogue
        : from.kind === 'git' && next.kind === 'git' && isSameCatalogueSource(from.source, next.source)
    return same ? null : `${key} is installed from ${originWords(from)}; remove it first to install it from ${there}.`
  }

  async function installFromCatalogue(id: CatalogueId, key: string, checked?: CheckedRelease): Promise<InstallAnswer> {
    const entryNow = findEntry(id, key)
    const change = await originChange(key, {
      kind: 'catalogue',
      catalogue: id,
      source: entryNow?.source ?? { url: '', ref: '' },
    })
    if (change) return { ok: false, message: change }
    const prepared = await prepareCatalogueRelease(id, key, checked ? { checked } : {})
    if (!prepared.ok) return prepared
    const { checkedOut, entry } = prepared.prepared
    const record = readInstallRecordsSync(deps.dataDir)[key]
    // The person looked at this release, its source and its owner: installing
    // it trusts the owner as it is now.
    const ownerId = currentOwnerId(entry) ?? record?.ownerId
    // Moving to another repository or folder is reviewed again, whatever it asks for.
    if (
      record?.origin.kind === 'catalogue' &&
      !isSameCatalogueSource(record.origin.source, entry.source) &&
      readExtensionApprovalsSync(deps.dataDir).has(key)
    )
      await writeExtensionApproval(deps.dataDir, key, null)
    return installPrepared(checkedOut, key, { kind: 'catalogue', catalogue: id, source: entry.source }, ownerId)
  }

  async function installFromGit(source: { git: string; ref?: string; path?: string }) {
    const url = source.git.trim()
    const ref = source.ref?.trim() || 'HEAD'
    const path = source.path?.trim().replace(/^\/+|\/+$/g, '') || undefined
    const publisher = sourcePublisher(url)
    if (!publisher) return { ok: false as const, message: 'Studio cannot tell who owns that repository from its URL.' }
    const list = await killListForInstall(false)
    if (!list.ok) return list
    const checked = await checkOutExtension({ url, ref, ...(path ? { path } : {}), claudePlugins: true, git })
    if (!checked.ok) return checked
    const { checkedOut } = checked
    const key = `${publisher}.${checkedOut.manifest.id}`
    const refuse = async (message: string) => {
      await checkedOut.dispose()
      return { ok: false as const, message }
    }
    if (isReservedInstallKey(key)) return refuse(`${key} uses a name only Studio’s official catalogue installs.`)
    const killed = findKilled(list.list, key, checkedOut.manifest.version)
    if (killed) return refuse(`Studio’s kill list removed ${key} ${checkedOut.manifest.version}: ${killed.reason}`)
    const origin = { kind: 'git' as const, source: { url, ref, ...(path ? { path } : {}) } }
    const change = await originChange(key, origin)
    if (change) return refuse(change)
    await refreshLists()
    const locked = lockProblem(key, checkedOut.manifest.version, { contentHash: checkedOut.contentHash }, 'git')
    if (locked) return refuse(locked)
    const leftOut = checkedOut.leftOut
    const answer = await installPrepared(checkedOut, key, origin, undefined)
    return answer.ok && leftOut.length > 0 ? { ...answer, leftOut } : answer
  }

  // ── Updates ───────────────────────────────────────────────────────────────

  /** The newer release an install's own catalogue lists, or why there is none to install. */
  function newerRelease(
    key: string,
    installedVersion: string,
  ): {
    record: ExtensionInstallRecord
    entry: CatalogueEntry
    release: CatalogueRelease
    catalogue: CatalogueId
  } | null {
    const record = readInstallRecordsSync(deps.dataDir)[key]
    if (record?.origin.kind !== 'catalogue') return null
    const catalogue = record.origin.catalogue
    if (!isKnownCatalogue(catalogue)) return null
    const entry = findEntry(catalogue, key)
    const chosen = entry ? selectCatalogueRelease(entry.releases, studioVersion) : null
    if (!entry || !chosen?.installable) return null
    if (compareStudioVersions(chosen.release.version, installedVersion) <= 0) return null
    if (findKilled(killList.current(), key, chosen.release.version)) return null
    return { record, entry, release: chosen.release, catalogue }
  }

  /**
   * "Review version X": install exactly the release the person was shown
   * (and, when it was held, the commit and bytes it was held with). A
   * catalogue that lists another now is refused, and the row then shows the
   * new one.
   */
  async function update(key: string, version?: string): Promise<InstallAnswer> {
    const module = (await deps.installed()).find((candidate) => candidate.key === key && !candidate.development)
    if (!module) return { ok: false, message: `${key} is not installed.` }
    const record = readInstallRecordsSync(deps.dataDir)[key]
    if (record?.origin.kind !== 'catalogue')
      return { ok: false, message: `${key} was not installed from a catalogue; install it again to update it.` }
    await refreshOne(record.origin.catalogue)
    await refreshLists()
    const found = newerRelease(key, module.manifest.version)
    if (!found)
      return { ok: false, message: `${catalogueName(record.origin.catalogue)} lists no newer release of ${key}.` }
    if (version !== undefined && found.release.version !== version)
      return {
        ok: false,
        message: `${catalogueName(found.catalogue)} now lists ${key} ${found.release.version}, not ${version}. Look at it again before you install it.`,
      }
    const held = readHeldUpdatesSync(deps.dataDir)[key]
    const heldThis = held?.version === found.release.version ? held : undefined
    if (
      heldThis &&
      ((heldThis.commit !== undefined && heldThis.commit !== found.release.commit) ||
        (heldThis.contentHash !== undefined && heldThis.contentHash !== found.release.contentHash))
    )
      return {
        ok: false,
        message: `${catalogueName(found.catalogue)} changed ${key} ${found.release.version} since it was held. Look at it again before you install it.`,
      }
    const paused = ownerPause(record, found.entry)
    if (paused) return { ok: false, message: paused }
    return installFromCatalogue(found.catalogue, key, {
      version: found.release.version,
      commit: found.release.commit,
      contentHash: found.release.contentHash,
      source: found.entry.source,
      ownerId: currentOwnerId(found.entry) ?? null,
    })
  }

  async function hold(key: string, name: string, update: HeldUpdate): Promise<void> {
    const before = readHeldUpdatesSync(deps.dataDir)[key]
    await writeHeldUpdates(deps.dataDir, (held) => ({ ...held, [key]: update }))
    if (before?.version === update.version && before.reason === update.reason && before.commit === update.commit) return
    const why =
      update.reason === 'access'
        ? `It asks for more: ${(update.growth ?? []).join(', ')}.`
        : update.reason === 'repository'
          ? 'It moved to another repository or folder.'
          : 'Its owner was renamed or changed hands, so updates are paused.'
    deps.notify?.({
      key,
      name,
      severity: 'warning',
      title: `${name} ${update.version} waits for your review`,
      body: `${why} Review it in Settings → Extensions.`,
    })
  }

  async function updateOne(module: InstalledForCatalogue, startedAt: number): Promise<void> {
    if (module.development || module.killed || !module.enabled) return
    // An extension waiting for approval, or never approved, is the person's to update.
    if (module.approval !== 'approved' && module.approval !== 'not-needed') return
    const found = newerRelease(module.key, module.manifest.version)
    if (!found) return
    const { record, entry, release, catalogue } = found
    const exact = { version: release.version, commit: release.commit, contentHash: release.contentHash }
    if (record.ownerId !== undefined && currentOwnerId(entry) === undefined) {
      deps.warn?.(`Update of ${module.key} skipped: Studio cannot read who owns it now.`)
      return
    }
    const paused = ownerPause(record, entry)
    if (paused) return hold(module.key, module.manifest.name, { ...exact, reason: 'owner' })
    if (record.origin.kind !== 'catalogue' || !isSameCatalogueSource(record.origin.source, entry.source))
      return hold(module.key, module.manifest.name, { ...exact, reason: 'repository' })
    if (catalogue !== OFFICIAL_CATALOGUE) {
      await lockReleases(deps.dataDir, [{ key: module.key, ...exact }], startedAt)
      const firstSeen = readReleaseLockSync(deps.dataDir)[module.key]?.[release.version]?.firstSeenAt ?? startedAt
      if (startedAt - firstSeen < AUTO_UPDATE_HOLD_BACK_MS) return
    }
    // Exactly the release checked here: one the catalogue lists in its place
    // since is the next pass's, held back and checked in turn.
    const prepared = await prepareCatalogueRelease(catalogue, module.key, {
      automatic: true,
      checked: { ...exact, source: record.origin.source, ownerId: currentOwnerId(entry) ?? null },
    })
    if (!prepared.ok) {
      deps.warn?.(`Update of ${module.key} skipped: ${prepared.message}`)
      return
    }
    const { checkedOut } = prepared.prepared
    const next = checkedOut.manifest
    const approval = readExtensionApprovalsSync(deps.dataDir).get(module.key)
    const growth =
      module.approval === 'not-needed'
        ? extensionNeedsApproval(next)
          ? ['your approval, which it did not need before']
          : []
        : approval
          ? accessGrowth(approval.access, extensionAccess(next, checkedOut.files))
          : ['your approval']
    // An official release that asks for more goes through too, approved as
    // it installs (module-lifecycle.ts), and its notice says what it now has.
    if (growth.length > 0 && catalogue !== OFFICIAL_CATALOGUE) {
      await checkedOut.dispose()
      return hold(module.key, module.manifest.name, { ...exact, reason: 'access', growth })
    }
    // Nobody reviewed this one: it keeps the source and the owner the person installed.
    const answer = await installPrepared(checkedOut, module.key, record.origin, record.ownerId ?? currentOwnerId(entry))
    if (!answer.ok) {
      deps.warn?.(`Update of ${module.key} failed: ${answer.message}`)
      return
    }
    const grew = growth.length > 0 ? `It now also has: ${growth.join(', ')}.` : ''
    const body = [grew, release.changelog ?? ''].filter(Boolean).join('\n\n')
    deps.notify?.({
      key: module.key,
      name: next.name,
      severity: 'info',
      title: `${next.name} updated to ${next.version}`,
      ...(body ? { body } : {}),
    })
  }

  /** An install whose owner id was not known at install takes it at the first pass that can read one. */
  async function recordMissingOwners(): Promise<void> {
    for (const [key, record] of Object.entries(readInstallRecordsSync(deps.dataDir))) {
      if (record.origin.kind !== 'catalogue' || record.ownerId !== undefined) continue
      const entry = findEntry(record.origin.catalogue, key)
      if (!entry || !isSameCatalogueSource(record.origin.source, entry.source)) continue
      const ownerId = currentOwnerId(entry)
      if (ownerId !== undefined) await writeInstallRecord(deps.dataDir, key, { ...record, ownerId })
    }
  }

  let running: Promise<void> | null = null
  const runUpdates = (): Promise<void> => {
    running ??= (async () => {
      const startedAt = now()
      await refreshAll()
      await recordMissingOwners()
      for (const module of await deps.installed()) {
        try {
          await updateOne(module, startedAt)
        } catch (error) {
          deps.warn?.(`Update of ${module.key} skipped: ${(error as Error).message}`)
        }
      }
    })().finally(() => {
      running = null
    })
    return running
  }

  // ── Views ─────────────────────────────────────────────────────────────────

  function originOf(
    key: string,
    development: boolean,
    record: ExtensionInstallRecord | undefined,
  ): StudioExtensionOrigin {
    if (development) return { kind: 'development', label: 'Dev' }
    if (record?.origin.kind === 'catalogue') {
      const id = record.origin.catalogue
      return {
        kind: id === OFFICIAL_CATALOGUE ? 'official' : id === COMMUNITY_CATALOGUE ? 'community' : 'catalogue',
        label: trustLabel(id, key),
        catalogue: id,
        catalogueName: catalogueName(id),
        source: record.origin.source,
        commit: record.commit,
      }
    }
    if (record?.origin.kind === 'git')
      return { kind: 'git', label: 'Unverified', source: record.origin.source, commit: record.commit }
    if (parseExtensionInstallKey(key)?.publisher === 'local') return { kind: 'folder', label: 'Local' }
    return { kind: 'git', label: 'Unverified' }
  }

  async function catalogues(refresh?: boolean): Promise<StudioCatalogueView[]> {
    // Any client that reads the extensions may ask; one asking often is answered from the last read.
    if (refresh && now() - lastRefreshAll >= REFRESH_MIN_INTERVAL_MS) await refreshAll()
    else if (refresh && refreshAllRunning) await refreshAllRunning
    const installed = await installedMap()
    const records = readInstallRecordsSync(deps.dataDir)
    const cache = readCatalogueCacheSync(deps.dataDir)
    return catalogueIds().map((id) => {
      const copy = cache[id]
      const error = errors.get(id)
      return {
        id,
        kind: catalogueKind(id),
        name: catalogueName(id),
        ...(addedCatalogueUrl(id) ? { url: addedCatalogueUrl(id)! } : {}),
        ...(copy ? { fetchedAt: copy.fetchedAt } : {}),
        ...(error ? { error } : !copy ? { error: 'Not read yet.' } : {}),
        entries: (copy?.catalogue.extensions ?? []).flatMap((entry) => {
          const view = listing(id, entry, installed, records)
          return view ? [view] : []
        }),
      }
    })
  }

  return {
    killList,
    catalogues,

    async entry(id, key) {
      if (!isKnownCatalogue(id)) return { ok: false, message: 'That catalogue has not been added here.' }
      // Read with the owner records, so the owner id the page shows is the one an install checks.
      // The page of one installed from this catalogue previews its update, so
      // the catalogue is read again first (unless it was a moment ago): a
      // release published since the last read is the one shown, not "up to
      // date". Offline, the last copy is shown.
      const copy = cached(id)
      const from = readInstallRecordsSync(deps.dataDir)[key]?.origin
      const previewsUpdate = from?.kind === 'catalogue' && from.catalogue === id
      if (!copy || (previewsUpdate && now() - copy.fetchedAt >= REFRESH_MIN_INTERVAL_MS))
        await Promise.all([refreshOne(id), refreshLists()])
      const entry = findEntry(id, key)
      if (!entry) return { ok: false, message: `${catalogueName(id)} does not list ${key}.` }
      const installed = await installedMap()
      const records = readInstallRecordsSync(deps.dataDir)
      const view = listing(id, entry, installed, records)
      if (!view) return { ok: false, message: `${catalogueName(id)} lists no release of ${key} Studio can read.` }
      const release = selectCatalogueRelease(entry.releases, studioVersion)!.release
      const record = records[key]
      const here = installed.get(key)
      return {
        ok: true,
        entry: {
          ...view,
          catalogue: id,
          catalogueName: catalogueName(id),
          source: entry.source,
          commit: release.commit,
          contentHash: release.contentHash,
          ...(currentOwnerId(entry) !== undefined ? { ownerId: currentOwnerId(entry)! } : {}),
          ...(release.license ? { license: release.license } : {}),
          ...(release.repository ? { repository: release.repository } : {}),
          ...(release.homepage ? { homepage: release.homepage } : {}),
          ...(release.updatedAt ? { updatedAt: release.updatedAt } : {}),
          ...(release.changelog ? { changelog: release.changelog } : {}),
          ...(release.images?.cover || release.images?.screenshots
            ? {
                images: {
                  ...(release.images.cover ? { cover: release.images.cover } : {}),
                  ...(release.images.screenshots ? { screenshots: release.images.screenshots } : {}),
                },
              }
            : {}),
          releases: entry.releases.map((item) => ({
            version: item.version,
            minimumStudio: item.minimumStudio,
            ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
          })),
          alsoListedBy: catalogueIds()
            .filter((other) => other !== id && findEntry(other, key))
            .map((other) => ({ id: other, name: catalogueName(other) })),
          ...(here && !here.development && !view.installed?.fromHere
            ? { installedFrom: originOf(key, false, record) }
            : {}),
        },
      }
    },

    async image(id, path, sha256) {
      if (!isKnownCatalogue(id)) return { ok: false, message: 'That catalogue has not been added here.' }
      const mime = mimeOf(path)
      // No `%`: an escaped `..` would pass the segment check and climb once the URL is read.
      if (
        !mime ||
        path.includes('%') ||
        path.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')
      )
        return { ok: false, message: 'That is not an image a catalogue may name.' }
      // Only images a catalogue's own entries name.
      const named = (cached(id)?.catalogue.extensions ?? []).some((entry) =>
        entry.releases.some((release) => {
          const images = release.images
          return [images?.icon, images?.cover, ...(images?.screenshots ?? [])].some(
            (image) => image?.path === path && image.sha256 === sha256,
          )
        }),
      )
      if (!named) return { ok: false, message: 'The catalogue names no such image.' }
      const kept = images.get(sha256)
      if (kept) return { ok: true, mime: kept.mime, base64: kept.bytes.toString('base64') }
      try {
        let bytes: Buffer
        if (addedCatalogueUrl(id)) {
          // From the repository the catalogue was last read from: one fetch per refresh, not per image.
          if (!addedRepositories.has(id)) await refreshOne(id)
          const repository = addedRepositories.get(id)
          if (!repository) return { ok: false, message: errors.get(id) ?? 'The catalogue could not be read.' }
          bytes = await readFetchedFile(repository, path, IMAGE_MAX_BYTES, git)
        } else bytes = await fetchBytes(`${urls.base}/${path}`, IMAGE_MAX_BYTES)
        const { createHash } = await import('node:crypto')
        if (createHash('sha256').update(bytes).digest('hex') !== sha256)
          return { ok: false, message: 'The image’s bytes are not the ones the catalogue lists.' }
        images.set(sha256, { mime, bytes })
        imageBytes += bytes.byteLength
        // The oldest go first once the kept images pass their budget.
        for (const [digest, image] of images) {
          if (imageBytes <= IMAGE_CACHE_MAX_BYTES) break
          images.delete(digest)
          imageBytes -= image.bytes.byteLength
        }
        return { ok: true, mime, base64: bytes.toString('base64') }
      } catch (error) {
        return { ok: false, message: (error as Error).message }
      }
    },

    async add(url) {
      const trimmed = url.trim()
      // The community catalogue, removed before, comes back by its name.
      const id = trimmed === COMMUNITY_CATALOGUE ? COMMUNITY_CATALOGUE : addedCatalogueId(trimmed)
      if (isKnownCatalogue(id)) {
        await refreshOne(id)
        const view = (await catalogues()).find((catalogue) => catalogue.id === id)!
        return { ok: true, catalogue: view }
      }
      let read: { catalogue: Catalogue; fetched?: FetchedCommit }
      try {
        read = await fetchCatalogue(id)
      } catch (error) {
        return { ok: false, message: `Studio could not read a catalogue at ${trimmed}: ${(error as Error).message}` }
      }
      if (id === COMMUNITY_CATALOGUE) await writeCommunityRemoved(deps.dataDir, false)
      else
        await writeAddedCatalogues(deps.dataDir, (urlsNow) => [
          ...urlsNow.filter((other) => other !== trimmed),
          trimmed,
        ])
      await writeCatalogueCache(deps.dataDir, (cache) => ({
        ...cache,
        [id]: { fetchedAt: now(), catalogue: read.catalogue },
      }))
      await keepRepository(id, read.fetched)
      errors.delete(id)
      const view = (await catalogues()).find((candidate) => candidate.id === id)!
      return { ok: true, catalogue: view }
    },

    async remove(url) {
      const trimmed = url.trim()
      const id = trimmed === COMMUNITY_CATALOGUE ? COMMUNITY_CATALOGUE : addedCatalogueId(trimmed)
      if (id === COMMUNITY_CATALOGUE) {
        if (!isKnownCatalogue(id)) return { ok: false, message: 'The community catalogue was removed already.' }
        await writeCommunityRemoved(deps.dataDir, true)
      } else {
        if (!readAddedCataloguesSync(deps.dataDir).includes(trimmed))
          return { ok: false, message: 'That catalogue was not added here.' }
        await writeAddedCatalogues(deps.dataDir, (urlsNow) => urlsNow.filter((other) => other !== trimmed))
      }
      await writeCatalogueCache(deps.dataDir, (cache) => {
        const next = { ...cache }
        delete next[id]
        return next
      })
      await keepRepository(id, undefined)
      errors.delete(id)
      return { ok: true }
    },

    // A page's Install names the whole release it showed: that installs, or nothing.
    installFrom: (from) =>
      'git' in from
        ? installFromGit(from)
        : installFromCatalogue(
            from.catalogue,
            from.id,
            'version' in from
              ? {
                  version: from.version,
                  commit: from.commit,
                  contentHash: from.contentHash,
                  source: from.source,
                  ownerId: from.ownerId,
                }
              : undefined,
          ),

    update,

    annotate(views) {
      const records = readInstallRecordsSync(deps.dataDir)
      const held = readHeldUpdatesSync(deps.dataDir)
      return views.map((view) => {
        const key = view.manifest.id
        const record = records[key]
        const origin = originOf(key, view.development !== undefined, record)
        let update: StudioExtensionUpdate | undefined
        if (!view.development) {
          const heldUpdate = held[key]
          const found = newerRelease(key, view.extension.version)
          if (heldUpdate && found && heldUpdate.version === found.release.version)
            update = {
              version: heldUpdate.version,
              held: heldUpdate.reason,
              ...(heldUpdate.growth ? { growth: heldUpdate.growth } : {}),
            }
          else if (found) {
            // An owner Studio cannot read now is not shown as a changed one.
            const paused = currentOwnerId(found.entry) !== undefined && ownerPause(found.record, found.entry)
            update = paused ? { version: found.release.version, held: 'owner' } : { version: found.release.version }
          }
        }
        return { ...view, origin, ...(update ? { update } : {}) }
      })
    },

    async forget(key) {
      await writeInstallRecord(deps.dataDir, key, null)
      // Its next install starts afresh: a version re-pointed since is not held against it.
      await forgetLockedReleases(deps.dataDir, key)
      await writeHeldUpdates(deps.dataDir, (held) => {
        if (!(key in held)) return null
        const next = { ...held }
        delete next[key]
        return next
      })
    },

    runUpdates,

    start() {
      const stopKillList = killList.startPeriodic()
      const run = () =>
        void runUpdates().catch((error: unknown) => deps.warn?.(`Automatic updates failed: ${String(error)}`))
      const first = setTimeout(run, 60_000)
      first.unref?.()
      const timer = setInterval(run, AUTO_UPDATE_INTERVAL_MS)
      timer.unref?.()
      return () => {
        stopKillList()
        clearTimeout(first)
        clearInterval(timer)
      }
    },

    async dispose() {
      disposed = true
      const kept = [...addedRepositories.values()]
      addedRepositories.clear()
      await Promise.all(kept.map((repository) => repository.dispose()))
    },
  }
}

let noticeCount = 0

/** A catalogue notice as a bell row, under the extension it is about. */
export function catalogueNotification(notice: CatalogueNotice): StudioModuleNotification {
  noticeCount += 1
  return {
    id: `extension-catalogue-${Date.now().toString(36)}-${noticeCount}`,
    sourceModuleId: notice.key,
    sourceModuleName: notice.name,
    severity: notice.severity,
    title: notice.title,
    ...(notice.body ? { body: notice.body } : {}),
    emittedAt: Date.now(),
  }
}
