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
  type OwnerRecords,
  type ReleaseLock,
} from '../../../../packages/extension-sdk/src/catalogue'
import { isFetchableGitUrl, type GitOptions } from '../../../../packages/extension-sdk/src/git-source'
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
  lockReleases,
  readAddedCataloguesSync,
  readCatalogueCacheSync,
  readHeldUpdatesSync,
  readInstallRecordsSync,
  readReleaseLockSync,
  writeAddedCatalogues,
  writeCatalogueCache,
  writeHeldUpdates,
  writeInstallRecord,
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
  readGitCatalogueFile,
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
//   and for the official and community catalogues it must be the source
//   URL's owner); reserved publishers and ids install only from the official
//   catalogue, and a catalogue listing one otherwise is refused whole;
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
const OFFICIAL_OWNER = 'sprintengine'

type InstallAnswer =
  | { ok: true; moduleId: string; approval: StudioExtensionApproval; strippedLinks: string[] }
  | { ok: false; message: string; issues?: Array<{ path: string; message: string }> }

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
  installFrom(from: StudioExtensionInstallSource): Promise<InstallAnswer & { leftOut?: string[] }>
  update(key: string): Promise<InstallAnswer>
  /** An installed extension's origin, its update and its kill, for `extension.installed`. */
  annotate(views: ThirdPartyModuleView[]): ThirdPartyModuleView[]
  /** An uninstall forgets where it came from and any update it held. */
  forget(key: string): Promise<void>
  /** One pass of automatic updates. */
  runUpdates(): Promise<void>
  readonly killList: KillListService
  /** Refresh the kill list and check for updates periodically; returns the stopper. */
  start(): () => void
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
  let owners: OwnerRecords | null = null
  let remoteLock: ReleaseLock | null = null

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

  const catalogueIds = (): CatalogueId[] => [
    OFFICIAL_CATALOGUE,
    COMMUNITY_CATALOGUE,
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
      // Studio's own catalogues list each extension under its repository's owner.
      if (official || id === COMMUNITY_CATALOGUE) {
        const owner = sourcePublisher(entry.source.url)
        if (owner !== null && owner !== parseExtensionInstallKey(entry.id)!.publisher)
          return `It lists ${entry.id} from a repository owned by ${owner}, so it was refused.`
      }
    }
    return null
  }

  async function fetchCatalogue(id: CatalogueId): Promise<Catalogue> {
    const added = addedCatalogueUrl(id)
    const raw = added
      ? await fetchGitCatalogue(added, git)
      : await fetchJson(id === OFFICIAL_CATALOGUE ? urls.official : urls.community)
    const read = readCatalogue(raw, { fetchable: (url) => isFetchableGitUrl(url, git) })
    if (!read.ok) throw new Error(read.message)
    const problem = provenanceProblem(id, read.catalogue)
    if (problem) throw new Error(problem)
    return read.catalogue
  }

  async function refreshOne(id: CatalogueId): Promise<void> {
    try {
      const catalogue = await fetchCatalogue(id)
      await writeCatalogueCache(deps.dataDir, (cache) => ({ ...cache, [id]: { fetchedAt: now(), catalogue } }))
      errors.delete(id)
    } catch (error) {
      errors.set(id, (error as Error).message)
    }
  }

  async function refreshLists(): Promise<void> {
    const [ownersRaw, lockRaw] = await Promise.allSettled([fetchJson(urls.owners), fetchJson(urls.releaseLock)])
    if (ownersRaw.status === 'fulfilled') owners = readOwnerRecords(ownersRaw.value) ?? owners
    if (lockRaw.status === 'fulfilled') remoteLock = readReleaseLock(lockRaw.value) ?? remoteLock
  }

  async function refreshAll(): Promise<void> {
    await Promise.all([...catalogueIds().map(refreshOne), refreshLists()])
    // The first time a release of something installed here is seen, it is locked.
    const installedKeys = new Set((await deps.installed()).map((module) => module.key))
    const cache = readCatalogueCacheSync(deps.dataDir)
    const seen: Array<{ key: string; version: string; commit: string; contentHash: string }> = []
    for (const id of catalogueIds())
      for (const entry of cache[id]?.catalogue.extensions ?? [])
        if (installedKeys.has(entry.id))
          for (const release of entry.releases)
            seen.push({
              key: entry.id,
              version: release.version,
              commit: release.commit,
              contentHash: release.contentHash,
            })
    await lockReleases(deps.dataDir, seen, now())
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
  function lockProblem(key: string, version: string, pinned: { commit?: string; contentHash: string }): string | null {
    const local = readReleaseLockSync(deps.dataDir)[key]?.[version]
    const moved = (first: { commit: string; contentHash: string }) =>
      first.contentHash !== pinned.contentHash || (pinned.commit !== undefined && first.commit !== pinned.commit)
    if (local && moved(local))
      return `${key} ${version} was first seen at commit ${local.commit.slice(0, 12)}; a listed version never moves, so these bytes were refused. Its author must publish a new version.`
    const remote = remoteLock?.releases.find((entry) => entry.id === key && entry.version === version)
    if (remote && moved(remote))
      return `${key} ${version} is locked to commit ${remote.commit.slice(0, 12)} in the catalogue’s release lock; these bytes were refused.`
    return null
  }

  /** The owner id an entry names now: the catalogue's, else the owner records' for the publisher. */
  function currentOwnerId(entry: CatalogueEntry): number | undefined {
    if (entry.ownerId !== undefined) return entry.ownerId
    const publisher = parseExtensionInstallKey(entry.id)?.publisher
    return owners?.owners.find((owner) => owner.login.toLowerCase() === publisher)?.id
  }

  /** Why updates of an install are paused: its owner was renamed or the name changed hands. */
  function ownerPause(record: ExtensionInstallRecord, entry: CatalogueEntry): string | null {
    if (record.ownerId === undefined) return null
    const current = currentOwnerId(entry)
    if (current !== undefined && current !== record.ownerId)
      return `The account that owns ${entry.id} is not the one it was installed from (it changed hands, or the name was taken again). Updates are paused; install it again to trust the new owner.`
    const renamed = owners?.owners.find((owner) => owner.id === record.ownerId)
    const publisher = parseExtensionInstallKey(entry.id)?.publisher
    if (renamed && renamed.login.toLowerCase() !== publisher)
      return `The account that owned ${entry.id} is now named ${renamed.login}. Updates are paused; install it again from its new name.`
    return null
  }

  type Prepared = { checkedOut: CheckedOut; release: CatalogueRelease; entry: CatalogueEntry }

  async function prepareCatalogueRelease(
    id: CatalogueId,
    key: string,
  ): Promise<{ ok: true; prepared: Prepared } | { ok: false; message: string }> {
    if (!isKnownCatalogue(id)) return { ok: false, message: 'That catalogue has not been added here.' }
    if (isReservedInstallKey(key) && id !== OFFICIAL_CATALOGUE)
      return { ok: false, message: `${key} uses a name only Studio’s official catalogue installs.` }
    // What the catalogue lists now; its last copy when it cannot be read.
    await refreshOne(id)
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
    const killed = findKilled(killList.current(), key, release.version)
    if (killed) return { ok: false, message: `Studio’s kill list removed ${key} ${release.version}: ${killed.reason}` }
    await refreshLists()
    const locked = lockProblem(key, release.version, release)
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
      await lockReleases(
        deps.dataDir,
        [{ key, version: checkedOut.manifest.version, commit: checkedOut.commit, contentHash: checkedOut.contentHash }],
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

  /** An install that would move a catalogue install to another source is refused: it would stop its updates. */
  function takeoverProblem(key: string, catalogue: CatalogueId | null): string | null {
    const record = readInstallRecordsSync(deps.dataDir)[key]
    if (record?.origin.kind !== 'catalogue' || record.origin.catalogue === catalogue) return null
    return `${key} is installed from ${catalogueName(record.origin.catalogue)}; remove it first to install it from ${catalogue ? catalogueName(catalogue) : 'a git URL'}.`
  }

  async function installFromCatalogue(id: CatalogueId, key: string): Promise<InstallAnswer> {
    const takeover = takeoverProblem(key, id)
    if (takeover) return { ok: false, message: takeover }
    const prepared = await prepareCatalogueRelease(id, key)
    if (!prepared.ok) return prepared
    const { checkedOut, entry } = prepared.prepared
    const record = readInstallRecordsSync(deps.dataDir)[key]
    // The owner is pinned at the first install from this catalogue; installing again trusts the owner now.
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
    const publisher = sourcePublisher(url)
    if (!publisher) return { ok: false as const, message: 'Studio cannot tell who owns that repository from its URL.' }
    const checked = await checkOutExtension({
      url,
      ref: source.ref?.trim() || 'HEAD',
      ...(source.path ? { path: source.path } : {}),
      claudePlugins: true,
      git,
    })
    if (!checked.ok) return checked
    const { checkedOut } = checked
    const key = `${publisher}.${checkedOut.manifest.id}`
    const refuse = async (message: string) => {
      await checkedOut.dispose()
      return { ok: false as const, message }
    }
    if (isReservedInstallKey(key)) return refuse(`${key} uses a name only Studio’s official catalogue installs.`)
    const killed = findKilled(killList.current(), key, checkedOut.manifest.version)
    if (killed) return refuse(`Studio’s kill list removed ${key} ${checkedOut.manifest.version}: ${killed.reason}`)
    const takeover = takeoverProblem(key, null)
    if (takeover) return refuse(takeover)
    await refreshLists()
    const locked = lockProblem(key, checkedOut.manifest.version, { contentHash: checkedOut.contentHash })
    if (locked) return refuse(locked)
    const leftOut = checkedOut.leftOut
    const answer = await installPrepared(
      checkedOut,
      key,
      {
        kind: 'git',
        source: { url, ref: source.ref?.trim() || 'HEAD', ...(source.path ? { path: source.path } : {}) },
      },
      undefined,
    )
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

  async function update(key: string): Promise<InstallAnswer> {
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
    const paused = ownerPause(record, found.entry)
    if (paused) return { ok: false, message: paused }
    return installFromCatalogue(found.catalogue, key)
  }

  async function hold(key: string, name: string, update: HeldUpdate): Promise<void> {
    const before = readHeldUpdatesSync(deps.dataDir)[key]
    await writeHeldUpdates(deps.dataDir, (held) => ({ ...held, [key]: update }))
    if (before?.version === update.version && before.reason === update.reason) return
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
    if (module.development || module.killed) return
    // An extension waiting for approval, or never approved, is the person's to update.
    if (module.approval !== 'approved' && module.approval !== 'not-needed') return
    const found = newerRelease(module.key, module.manifest.version)
    if (!found) return
    const { record, entry, release, catalogue } = found
    const paused = ownerPause(record, entry)
    if (paused) return hold(module.key, module.manifest.name, { version: release.version, reason: 'owner' })
    if (!isSameCatalogueSource(record.origin.kind === 'catalogue' ? record.origin.source : entry.source, entry.source))
      return hold(module.key, module.manifest.name, { version: release.version, reason: 'repository' })
    if (catalogue !== OFFICIAL_CATALOGUE) {
      await lockReleases(
        deps.dataDir,
        [{ key: module.key, version: release.version, commit: release.commit, contentHash: release.contentHash }],
        startedAt,
      )
      const firstSeen = readReleaseLockSync(deps.dataDir)[module.key]?.[release.version]?.firstSeenAt ?? startedAt
      if (startedAt - firstSeen < AUTO_UPDATE_HOLD_BACK_MS) return
    }
    const prepared = await prepareCatalogueRelease(catalogue, module.key)
    if (!prepared.ok) {
      deps.warn?.(`Update of ${module.key} skipped: ${prepared.message}`)
      return
    }
    const { checkedOut } = prepared.prepared
    const next = checkedOut.manifest
    const record2 = readExtensionApprovalsSync(deps.dataDir).get(module.key)
    const growth =
      module.approval === 'not-needed'
        ? extensionNeedsApproval(next)
          ? ['your approval, which it did not need before']
          : []
        : record2
          ? accessGrowth(record2.access, extensionAccess(next, checkedOut.files))
          : ['your approval']
    if (growth.length > 0) {
      await checkedOut.dispose()
      return hold(module.key, module.manifest.name, { version: release.version, reason: 'access', growth })
    }
    // Without a kill list from now, a takedown could not stop this install.
    try {
      await killList.refresh()
    } catch (error) {
      await checkedOut.dispose()
      deps.warn?.(`Update of ${module.key} waits for the kill list: ${(error as Error).message}`)
      return
    }
    if (findKilled(killList.current(), module.key, release.version)) {
      await checkedOut.dispose()
      return
    }
    const answer = await installPrepared(
      checkedOut,
      module.key,
      { kind: 'catalogue', catalogue, source: entry.source },
      record.ownerId,
    )
    if (!answer.ok) {
      deps.warn?.(`Update of ${module.key} failed: ${answer.message}`)
      return
    }
    deps.notify?.({
      key: module.key,
      name: next.name,
      severity: 'info',
      title: `${next.name} updated to ${next.version}`,
      ...(release.changelog ? { body: release.changelog } : {}),
    })
  }

  let running: Promise<void> | null = null
  const runUpdates = (): Promise<void> => {
    running ??= (async () => {
      const startedAt = now()
      await refreshAll()
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
    if (refresh) await refreshAll()
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
      if (!cached(id)) await refreshOne(id)
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
      if (!mime || path.split('/').some((segment) => segment === '..' || segment === '.' || segment === ''))
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
      try {
        const added = addedCatalogueUrl(id)
        const bytes = added
          ? (await readGitCatalogueFile(added, path, IMAGE_MAX_BYTES, git)).bytes
          : await fetchBytes(`${urls.base}/${path}`, IMAGE_MAX_BYTES)
        const { createHash } = await import('node:crypto')
        if (createHash('sha256').update(bytes).digest('hex') !== sha256)
          return { ok: false, message: 'The image’s bytes are not the ones the catalogue lists.' }
        return { ok: true, mime, base64: bytes.toString('base64') }
      } catch (error) {
        return { ok: false, message: (error as Error).message }
      }
    },

    async add(url) {
      const trimmed = url.trim()
      const id = addedCatalogueId(trimmed)
      if (isKnownCatalogue(id)) {
        await refreshOne(id)
        const view = (await catalogues()).find((catalogue) => catalogue.id === id)!
        return { ok: true, catalogue: view }
      }
      let catalogue: Catalogue
      try {
        catalogue = await fetchCatalogue(id)
      } catch (error) {
        return { ok: false, message: `Studio could not read a catalogue at ${trimmed}: ${(error as Error).message}` }
      }
      await writeAddedCatalogues(deps.dataDir, (urlsNow) => [...urlsNow.filter((other) => other !== trimmed), trimmed])
      await writeCatalogueCache(deps.dataDir, (cache) => ({ ...cache, [id]: { fetchedAt: now(), catalogue } }))
      errors.delete(id)
      const view = (await catalogues()).find((candidate) => candidate.id === id)!
      return { ok: true, catalogue: view }
    },

    async remove(url) {
      const trimmed = url.trim()
      if (!readAddedCataloguesSync(deps.dataDir).includes(trimmed))
        return { ok: false, message: 'That catalogue was not added here.' }
      await writeAddedCatalogues(deps.dataDir, (urlsNow) => urlsNow.filter((other) => other !== trimmed))
      const id = addedCatalogueId(trimmed)
      await writeCatalogueCache(deps.dataDir, (cache) => {
        const next = { ...cache }
        delete next[id]
        return next
      })
      errors.delete(id)
      return { ok: true }
    },

    installFrom: (from) => ('git' in from ? installFromGit(from) : installFromCatalogue(from.catalogue, from.id)),

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
            const paused = ownerPause(found.record, found.entry)
            update = paused ? { version: found.release.version, held: 'owner' } : { version: found.release.version }
          }
        }
        return { ...view, origin, ...(update ? { update } : {}) }
      })
    },

    async forget(key) {
      await writeInstallRecord(deps.dataDir, key, null)
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
