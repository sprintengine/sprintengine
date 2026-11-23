// The extension catalogue, format 1: the JSON lists Studio reads to browse,
// install and update extensions, and the lists beside them (the kill list,
// the owner records and the release lock). One description of each field
// drives the strict validator (what a catalogue's own checks run), the
// tolerant reader (what Studio runs on a catalogue it fetched) and the JSON
// Schema with its reference, as extension.json's field table does.
//
// A catalogue only lists. What runs is decided at install, from the bytes
// Studio checks out at the pinned commit: their content hash and their
// extension.json must be what the release says. So reading is tolerant (an
// entry this Studio cannot read is skipped, never fatal) and validation is
// strict. Pure: no Node or DOM APIs.

import {
  EXTENSION_MANIFEST_SINCE,
  EXTENSION_TIERS,
  STUDIO_EXTENSION_VERSION,
  compareStudioVersions,
  isReservedExtensionId,
  isReservedExtensionPublisher,
  isSafeExtensionPath,
  parseExtensionInstallKey,
  type ExtensionManifest,
  type ExtensionTier,
} from './extension-manifest.js'
import { EXTENSION_PERMISSIONS, type ExtensionPermission } from './permissions.js'
import {
  isPlainObject,
  nodeJsonSchema,
  readNodeTolerant,
  referenceRows,
  validateNode,
  type FieldSpec,
  type JsonSchema,
  type ManifestIssue,
  type ObjectNode,
  type SchemaNode,
} from './manifest-schema.js'

/** The catalogue format this Studio reads. Raised only for a change an older Studio cannot ignore. */
export const CATALOGUE_VERSION = 1
/** The most entries a catalogue lists; extras are ignored. */
export const CATALOGUE_ENTRY_LIMIT = 2048
/** The most releases an entry lists, newest first. */
export const CATALOGUE_RELEASE_LIMIT = 32
/** The most categories an entry names. */
export const CATALOGUE_CATEGORY_LIMIT = 16
/** The most entries a kill list holds. */
export const KILL_LIST_ENTRY_LIMIT = 4096
/** A kill list's clock and Studio's disagree by minutes, never by a day. */
export const KILL_LIST_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000

const SINCE = EXTENSION_MANIFEST_SINCE
const COMMIT_RE = /^[0-9a-f]{40}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const CATEGORY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const HTTPS_RE = /^https:\/\/[^\s]+$/
// Plain text a person reads: no control or direction-override characters.
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/u

const text = (max: number): SchemaNode => ({
  kind: 'string',
  min: 1,
  max,
  check: (value) => (UNSAFE_TEXT_RE.test(value) ? 'must be plain text, with no control characters.' : null),
})
const https = (): SchemaNode => ({
  kind: 'string',
  max: 2048,
  pattern: HTTPS_RE,
  patternMessage: 'must be an https:// address.',
})
const installKey = (): SchemaNode => ({
  kind: 'string',
  min: 3,
  max: 104,
  check: (value) =>
    parseExtensionInstallKey(value) === null
      ? 'must be `<publisher>.<id>`: the repository owner, lowercased, then the extension’s id.'
      : null,
  schemaPattern: String.raw`^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$`,
})
const repositoryPath = (): SchemaNode => ({
  kind: 'string',
  min: 1,
  max: 512,
  check: (value) =>
    isSafeExtensionPath(value) ? null : 'must be a relative path with `/` separators, and no `.`, `..` or leading `/`.',
  schemaPattern: String.raw`^(?!/)(?!.*(?:^|/)\.{1,2}(?:/|$))(?!.*//)[^\\:<>"|?*\u0000-\u001f]+`,
})
const field = (node: SchemaNode, doc: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({
  node,
  doc,
  since: SINCE,
  ...extra,
})

/** The kinds of contribution a release lists: extension.json's contribution points. */
export const CATALOGUE_CONTRIBUTION_KINDS = [
  'commands',
  'menus',
  'topBarItems',
  'panels',
  'doors',
  'settingsSections',
  'mcpTools',
  'hooks',
  'syntaxes',
  'customEditors',
  'keybindings',
  'statusBarItems',
  'settings',
  'skills',
  'mcpServers',
  'providers',
] as const
export type CatalogueContributionKind = (typeof CATALOGUE_CONTRIBUTION_KINDS)[number]

const IMAGE_NODE: ObjectNode = {
  kind: 'object',
  title: 'CatalogueImage',
  fields: {
    path: field(
      repositoryPath(),
      'The file in the catalogue repository, relative to the folder the catalogue file is in. Studio refuses bytes that differ from `sha256`.',
      { required: true, example: 'images/acme.notes/cover.png' },
    ),
    sha256: field(
      { kind: 'string', max: 64, pattern: SHA256_RE, patternMessage: 'must be a lowercase SHA-256 hex digest.' },
      'SHA-256 of the image’s bytes.',
      { required: true },
    ),
    alt: field(text(256), 'What the image shows, for screen readers.', { required: true, example: 'The notes panel' }),
  },
}

const RELEASE_NODE: ObjectNode = {
  kind: 'object',
  title: 'CatalogueRelease',
  fields: {
    version: field(
      { kind: 'string', min: 1, max: 64, pattern: SEMVER_RE, patternMessage: 'must be a semver version.' },
      'The manifest’s `version` for this release.',
      { required: true, example: '1.2.0' },
    ),
    commit: field(
      { kind: 'string', max: 40, pattern: COMMIT_RE, patternMessage: 'must be a full lowercase SHA-1 commit.' },
      'The full commit Studio checks out for this release. A listed version keeps its commit: a tag moved later never replaces it.',
      { required: true },
    ),
    contentHash: field(
      { kind: 'string', max: 64, pattern: SHA256_RE, patternMessage: 'must be a lowercase SHA-256 hex digest.' },
      'The content identity of the extension’s installed files, as Studio computes it at install (`sprintengine-extension release-entry` prints it). Studio refuses bytes that differ.',
      { required: true },
    ),
    tier: field({ kind: 'string', max: 16, enum: EXTENSION_TIERS }, 'The manifest’s `tier`.', {
      required: true,
      example: 'ui',
    }),
    minimumStudio: field(
      { kind: 'string', max: 32, pattern: VERSION_RE, patternMessage: 'must be an x.y.z version.' },
      'The manifest’s `engines.studio` without `>=`. An older Studio lists the extension but does not install this release.',
      { required: true, example: SINCE },
    ),
    permissions: field(
      {
        kind: 'array',
        max: EXTENSION_PERMISSIONS.length,
        items: { kind: 'string', max: 64, enum: EXTENSION_PERMISSIONS },
        unique: { key: (item) => String(item), label: 'permission' },
      },
      'Every permission the release asks for. Studio refuses an install whose manifest asks for different ones.',
      { required: true, example: ['notifications:show'] },
    ),
    contributes: field(
      {
        kind: 'array',
        max: 256,
        items: {
          kind: 'object',
          title: 'CatalogueContribution',
          fields: {
            kind: field({ kind: 'string', max: 32, enum: CATALOGUE_CONTRIBUTION_KINDS }, 'The contribution point.', {
              required: true,
              example: 'panels',
            }),
            name: field(text(160), 'What the item is called: its id, or its command for a menu or keybinding.', {
              required: true,
              example: 'notes',
            }),
          },
        },
      },
      'What the release adds, one item per contribution. Studio refuses an install whose manifest adds something else.',
      { required: true },
    ),
    name: field(text(128), 'The manifest’s `name`.', { example: 'Notes' }),
    license: field(text(128), 'SPDX license expression.', { example: 'MIT' }),
    repository: field(https(), 'Source repository page.', { example: 'https://github.com/acme/notes' }),
    homepage: field(https(), 'Project homepage.'),
    updatedAt: field(
      { kind: 'string', max: 40, pattern: DATE_RE, patternMessage: 'must be an ISO 8601 date or date-time.' },
      'When this release was published.',
      { example: '2026-11-20' },
    ),
    changelog: field(text(2000), 'What changed in this release, as plain text.'),
    images: field(
      {
        kind: 'object',
        title: 'CatalogueImages',
        fields: {
          icon: field(IMAGE_NODE, 'Square icon.'),
          cover: field(IMAGE_NODE, 'Wide cover shown at the top of the extension’s page.'),
          screenshots: field({ kind: 'array', max: 6, items: IMAGE_NODE }, 'Screenshots, at most 6.'),
        },
      },
      'Images stored in the catalogue repository, shown before anything is installed.',
    ),
  },
}

const ENTRY_NODE: ObjectNode = {
  kind: 'object',
  title: 'CatalogueEntry',
  fields: {
    id: field(
      installKey(),
      '`<publisher>.<id>`: the publisher is the repository owner, lowercased, and the id is the manifest’s `id`. Studio installs under this key.',
      { required: true, example: 'acme.notes' },
    ),
    source: field(
      {
        kind: 'object',
        title: 'CatalogueSource',
        fields: {
          url: field({ kind: 'string', min: 1, max: 512 }, 'HTTPS or SSH URL of the extension’s git repository.', {
            required: true,
            example: 'https://github.com/acme/notes.git',
          }),
          ref: field(text(256), 'The branch or tag the author publishes from. Each release pins an exact commit.', {
            required: true,
            example: 'main',
          }),
          path: field(
            repositoryPath(),
            'The folder inside the repository that holds `extension.json`, so one repository can publish many extensions. Omit it at the root.',
            { example: 'extensions/notes' },
          ),
        },
      },
      'Where the extension’s source lives.',
      { required: true },
    ),
    ownerId: field(
      { kind: 'number', integer: true, min: 1, max: Number.MAX_SAFE_INTEGER },
      'The repository owner’s numeric id, recorded when the extension was first listed. A name can be renamed or taken again; the id cannot. An install records it, and a change pauses updates.',
      { example: 1234567 },
    ),
    description: field(text(4096), 'Listing text.'),
    categories: field(
      {
        kind: 'array',
        max: CATALOGUE_CATEGORY_LIMIT,
        items: { kind: 'string', min: 1, max: 32, pattern: CATEGORY_RE, patternMessage: 'must be a lowercase slug.' },
        unique: { key: (item) => String(item), label: 'category' },
      },
      `Lowercase slugs to filter the catalogue by, each listed once, at most ${CATALOGUE_CATEGORY_LIMIT}.`,
      { example: ['productivity'] },
    ),
    releases: field(
      { kind: 'array', max: CATALOGUE_RELEASE_LIMIT, items: RELEASE_NODE },
      `Installable releases, newest first, at most ${CATALOGUE_RELEASE_LIMIT}. Studio installs the first whose \`minimumStudio\` it meets, so keep older releases listed when one raises \`engines.studio\`.`,
      { required: true },
    ),
  },
}

/** catalogue.json, field by field: what the validator, the reader, the schema and the reference are built from. */
export const CATALOGUE_FIELDS: ObjectNode = {
  kind: 'object',
  title: 'SprintEngine Studio extension catalogue',
  fields: {
    $schema: field({ kind: 'string', max: 2048 }, 'JSON Schema URL for editor completion. Studio ignores it.', {
      ignored: true,
    }),
    catalogueVersion: field(
      { kind: 'literal', value: CATALOGUE_VERSION },
      'The catalogue format. Raised only for a change an older Studio cannot ignore.',
      { required: true },
    ),
    name: field(text(128), 'The catalogue’s display name.', { required: true, example: 'Community extensions' }),
    owner: field(
      { kind: 'string', min: 1, max: 39, pattern: OWNER_RE, patternMessage: 'must be an account name.' },
      'The account that publishes the catalogue.',
      { required: true, example: 'sprintengine' },
    ),
    extensions: field(
      { kind: 'array', max: CATALOGUE_ENTRY_LIMIT, items: ENTRY_NODE },
      `Listed extensions, at most ${CATALOGUE_ENTRY_LIMIT}. Each \`id\` appears once; Studio keeps the first. An entry this Studio cannot read is skipped, never fatal.`,
      { required: true },
    ),
  },
}

// ── Types ───────────────────────────────────────────────────────────────────

export type CatalogueImage = { path: string; sha256: string; alt: string }
export type CatalogueContribution = { kind: CatalogueContributionKind; name: string }
export type CatalogueRelease = {
  version: string
  commit: string
  contentHash: string
  tier: ExtensionTier
  minimumStudio: string
  permissions: ExtensionPermission[]
  contributes: CatalogueContribution[]
  name?: string
  license?: string
  repository?: string
  homepage?: string
  updatedAt?: string
  changelog?: string
  images?: { icon?: CatalogueImage; cover?: CatalogueImage; screenshots?: CatalogueImage[] }
}
export type CatalogueSource = { url: string; ref: string; path?: string }
export type CatalogueEntry = {
  id: string
  source: CatalogueSource
  ownerId?: number
  description?: string
  categories: string[]
  releases: CatalogueRelease[]
}
export type Catalogue = { catalogueVersion: 1; name: string; owner: string; extensions: CatalogueEntry[] }

export type CatalogueResult = { ok: true; catalogue: Catalogue } | { ok: false; issues: ManifestIssue[] }

// ── Strict validation ───────────────────────────────────────────────────────

/** Cross-field rules the field table cannot say: one entry per id, a git URL, a release per version. */
function catalogueIssues(catalogue: Catalogue): ManifestIssue[] {
  const issues: ManifestIssue[] = []
  const ids = new Set<string>()
  catalogue.extensions.forEach((entry, index) => {
    const at = `extensions[${index}]`
    if (ids.has(entry.id)) issues.push({ path: `${at}.id`, message: `lists ${entry.id} again.` })
    ids.add(entry.id)
    if (!isAllowedGitUrl(entry.source.url))
      issues.push({ path: `${at}.source.url`, message: 'must be an HTTPS or SSH git URL, with no password or token.' })
    if (entry.releases.length === 0) issues.push({ path: `${at}.releases`, message: 'needs at least one release.' })
    const versions = new Set<string>()
    entry.releases.forEach((release, at2) => {
      if (versions.has(release.version))
        issues.push({ path: `${at}.releases[${at2}].version`, message: `lists ${release.version} twice.` })
      versions.add(release.version)
    })
  })
  return issues
}

/** Check a catalogue as its own checks should: every problem is an issue. */
export function validateCatalogue(value: unknown): CatalogueResult {
  if (!isPlainObject(value)) return { ok: false, issues: [{ path: '', message: 'A catalogue must be a JSON object.' }] }
  const issues: ManifestIssue[] = []
  const cleaned = validateNode(CATALOGUE_FIELDS, value, '', issues) as Catalogue | undefined
  if (issues.length > 0 || !cleaned) return { ok: false, issues }
  const extensions = cleaned.extensions.map((entry) => ({ ...entry, categories: entry.categories ?? [] }))
  const catalogue = { ...cleaned, extensions }
  const cross = catalogueIssues(catalogue)
  return cross.length > 0 ? { ok: false, issues: cross } : { ok: true, catalogue }
}

// ── Tolerant reading ────────────────────────────────────────────────────────

/** Why a catalogue is in a format this Studio cannot read, before reading anything else of it. */
export function catalogueVersionProblem(raw: unknown): string | null {
  const version = isPlainObject(raw) ? raw.catalogueVersion : undefined
  if (typeof version === 'number' && Number.isInteger(version) && version > CATALOGUE_VERSION)
    return `uses catalogue format ${version}; update Studio to browse this catalogue.`
  if (version !== CATALOGUE_VERSION) return 'is not an extension catalogue (no `catalogueVersion: 1`).'
  return null
}

/**
 * Read a catalogue Studio fetched: what it can read of it. Unknown keys are
 * ignored, an entry or a release that does not read is skipped, an invalid
 * display field is dropped, a repeated id keeps the first entry and lists over
 * their limit are trimmed. Only a catalogue whose format or header cannot be
 * read fails.
 */
export function readCatalogue(raw: unknown): { ok: true; catalogue: Catalogue } | { ok: false; message: string } {
  const problem = catalogueVersionProblem(raw)
  if (problem) return { ok: false, message: `The catalogue ${problem}` }
  const record = raw as Record<string, unknown>
  const name = readNodeTolerant(CATALOGUE_FIELDS.fields.name!.node, record.name)
  const owner = readNodeTolerant(CATALOGUE_FIELDS.fields.owner!.node, record.owner)
  if (typeof name !== 'string' || typeof owner !== 'string')
    return { ok: false, message: 'The catalogue has no readable `name` and `owner`.' }
  if (!Array.isArray(record.extensions)) return { ok: false, message: 'The catalogue has no `extensions` list.' }
  const seen = new Set<string>()
  const extensions: CatalogueEntry[] = []
  for (const item of record.extensions) {
    if (extensions.length >= CATALOGUE_ENTRY_LIMIT) break
    const entry = readNodeTolerant(ENTRY_NODE, item) as CatalogueEntry | undefined
    if (!entry || seen.has(entry.id)) continue
    if (!isAllowedGitUrl(entry.source.url) || entry.releases.length === 0) continue
    seen.add(entry.id)
    extensions.push({ ...entry, categories: entry.categories ?? [] })
  }
  return { ok: true, catalogue: { catalogueVersion: CATALOGUE_VERSION, name, owner, extensions } }
}

/**
 * The release this Studio should offer: the first (newest) whose
 * `minimumStudio` it meets; else the one needing the least newer Studio, so a
 * listing can say "Needs Studio X" with the smallest X.
 */
export function selectCatalogueRelease(
  releases: readonly CatalogueRelease[],
  studioVersion: string = STUDIO_EXTENSION_VERSION,
): { release: CatalogueRelease; installable: boolean } | null {
  const installable = releases.find((release) => compareStudioVersions(release.minimumStudio, studioVersion) <= 0)
  if (installable) return { release: installable, installable: true }
  const least = [...releases].sort((a, b) => compareStudioVersions(a.minimumStudio, b.minimumStudio))[0]
  return least ? { release: least, installable: false } : null
}

// ── Releases and manifests ──────────────────────────────────────────────────

function contributionName(kind: CatalogueContributionKind, item: Record<string, unknown>): string {
  if (kind === 'menus') return `${String(item.where)} ${String(item.command)}`
  if (kind === 'keybindings') return `${String(item.key)} ${String(item.command)}`
  if (kind === 'hooks') return String(item.point)
  if (kind === 'settings') return String(item.key)
  if (kind === 'mcpTools') return String(item.name)
  return String(item.id)
}

/** What a manifest adds, one item per contribution, in a stable order: what a release lists. */
export function catalogueContributions(manifest: Pick<ExtensionManifest, 'contributes'>): CatalogueContribution[] {
  const out: CatalogueContribution[] = []
  for (const kind of CATALOGUE_CONTRIBUTION_KINDS) {
    const items = (manifest.contributes as Record<string, unknown>)[kind]
    if (!Array.isArray(items)) continue
    for (const item of items)
      if (isPlainObject(item)) out.push({ kind, name: contributionName(kind, item).slice(0, 160) })
  }
  return out
}

const contributionsKey = (items: readonly CatalogueContribution[]) =>
  items
    .map((item) => `${item.kind}\u0000${item.name}`)
    .sort()
    .join('\n')

/** The release entry a catalogue lists for these exact bytes, so authors paste it rather than copy fields by hand. */
export function catalogueReleaseEntry(
  manifest: ExtensionManifest,
  pinned: { commit: string; contentHash: string },
): CatalogueRelease {
  return {
    version: manifest.version,
    commit: pinned.commit,
    contentHash: pinned.contentHash,
    tier: manifest.tier,
    minimumStudio: manifest.engines.studio.replace(/^>=/, ''),
    permissions: [...new Set(manifest.permissions)].sort(),
    contributes: catalogueContributions(manifest),
    name: manifest.name,
    ...(manifest.license ? { license: manifest.license } : {}),
    ...(manifest.repository && HTTPS_RE.test(manifest.repository) ? { repository: manifest.repository } : {}),
    ...(manifest.homepage && HTTPS_RE.test(manifest.homepage) ? { homepage: manifest.homepage } : {}),
  }
}

/**
 * Why the bytes Studio checked out are not the release a catalogue vouches
 * for, or null when they are: the commit, the content hash, then the manifest
 * against what the release declares. Install and preview say the first
 * mismatch as it is.
 */
export function catalogueReleaseMismatch(input: {
  release: CatalogueRelease
  manifest: ExtensionManifest
  commit: string
  contentHash: string
}): string | null {
  const { release, manifest } = input
  if (input.commit !== release.commit) return 'The source is not at the commit the catalogue lists for this release.'
  if (input.contentHash !== release.contentHash)
    return 'The extension’s files do not match the content hash the catalogue lists for this release.'
  if (manifest.version !== release.version)
    return `extension.json says version ${manifest.version}, and the catalogue lists ${release.version}.`
  if (manifest.tier !== release.tier)
    return `extension.json says tier ${manifest.tier}, and the catalogue lists ${release.tier}.`
  if (manifest.engines.studio !== `>=${release.minimumStudio}`)
    return `extension.json needs Studio ${manifest.engines.studio}, and the catalogue lists >=${release.minimumStudio}.`
  const asked = [...new Set(manifest.permissions)].sort().join(', ')
  const listed = [...new Set(release.permissions)].sort().join(', ')
  if (asked !== listed)
    return `extension.json asks for ${asked || 'no permissions'}, and the catalogue lists ${listed || 'none'}.`
  if (contributionsKey(catalogueContributions(manifest)) !== contributionsKey(release.contributes))
    return 'extension.json adds other contributions than the catalogue lists.'
  if (release.name !== undefined && release.name !== manifest.name)
    return `extension.json is named “${manifest.name}”, and the catalogue lists “${release.name}”.`
  return null
}

// ── Publishers and git URLs ─────────────────────────────────────────────────

export type GitRepositoryIdentity = {
  host: string
  /** The first path segment: the account that owns the repository. */
  owner: string
  repository: string
  /** Every path segment, the `.git` dropped; lowercased where the host ignores case. */
  path: string
}

const CASE_INSENSITIVE_GIT_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org'])

// ssh reads a leading '-' as an option, and '..' is never a real host.
const safeAuthority = (user: string, host: string) =>
  !user.startsWith('-') && !host.startsWith('-') && !host.includes('..')

/** Whether a git URL is one Studio fetches: HTTPS (no credentials) or SSH. */
export function isAllowedGitUrl(value: string): boolean {
  const url = value.trim()
  if (url.length === 0 || url.length > 512 || /\s/.test(url)) return false
  const scp = /^([^\s@/:]+)@([A-Za-z0-9.-]+):[^\s]+$/.exec(url)
  if (scp) return safeAuthority(scp[1]!, scp[2]!)
  try {
    const parsed = new URL(url)
    if (!parsed.hostname || parsed.password || !safeAuthority(parsed.username, parsed.hostname)) return false
    if (parsed.protocol === 'https:') return parsed.username.length === 0
    return parsed.protocol === 'ssh:'
  } catch {
    return false
  }
}

function repositoryIdentity(host: string, repositoryPath: string): GitRepositoryIdentity | null {
  const segments = repositoryPath
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
  if (segments.length < 2 || segments.includes('..') || segments.includes('.')) return null
  const repository = segments.at(-1)!.replace(/\.git$/i, '')
  if (!repository) return null
  const lowerHost = host.toLowerCase()
  const exact = [...segments.slice(0, -1), repository].join('/')
  return {
    host: lowerHost,
    owner: segments[0]!,
    repository,
    path: CASE_INSENSITIVE_GIT_HOSTS.has(lowerHost) ? exact.toLowerCase() : exact,
  }
}

/** The host, owner and repository of an HTTPS or SSH git URL; null for anything else. */
export function parseGitRepository(url: string): GitRepositoryIdentity | null {
  const trimmed = url.trim()
  const scp = /^[^\s@/:]+@([^\s:]+):(.+)$/.exec(trimmed)
  if (scp) return repositoryIdentity(scp[1]!, scp[2]!)
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'ssh:') return null
    return repositoryIdentity(parsed.hostname, parsed.pathname)
  } catch {
    return null
  }
}

/** An owner's name as a publisher: lowercased, `.` and `_` folded to `-`; null when it cannot be one. */
export function publisherFromOwner(owner: string): string | null {
  const slug = owner
    .toLowerCase()
    .replace(/[._]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return parseExtensionInstallKey(`${slug}.x`) ? slug : null
}

/** The publisher a git URL install takes: the repository's owner (`github.com/Acme/notes` is `acme`). */
export function gitUrlPublisher(url: string): string | null {
  const identity = parseGitRepository(url)
  return identity ? publisherFromOwner(identity.owner) : null
}

/** One repository however its URL is spelled (https or scp, `.git`, case where the host ignores it). */
export function isSameGitRepository(left: string, right: string): boolean {
  const a = parseGitRepository(left)
  const b = parseGitRepository(right)
  if (!a || !b) return left.trim() === right.trim()
  return a.host === b.host && a.path === b.path
}

/** One extension's place: one repository and one folder in it. A moved folder is a move. */
export function isSameCatalogueSource(left: CatalogueSource, right: CatalogueSource): boolean {
  return isSameGitRepository(left.url, right.url) && (left.path ?? '') === (right.path ?? '')
}

/** Whether a key may install only from Studio's official catalogue: a reserved publisher, or a reserved id. */
export function isReservedInstallKey(key: string): boolean {
  const parts = parseExtensionInstallKey(key)
  return parts !== null && (isReservedExtensionPublisher(parts.publisher) || isReservedExtensionId(parts.id))
}

// ── The kill list ───────────────────────────────────────────────────────────

export type KillListEntry = {
  /** The install key. */
  id: string
  /** The versions killed; absent, every version. */
  versions?: string[]
  reason: string
  advisoryUrl?: string
}
export type KillList = { killListVersion: 1; generatedAt: string; extensions: KillListEntry[] }

const KILL_ENTRY_NODE: ObjectNode = {
  kind: 'object',
  title: 'KillListEntry',
  fields: {
    id: field(installKey(), 'The killed extension’s install key.', { required: true }),
    versions: field(
      { kind: 'array', max: 256, items: { kind: 'string', min: 1, max: 64, pattern: SEMVER_RE } },
      'The versions killed. Absent, every version is.',
    ),
    reason: field(text(1024), 'Why, as Studio tells the person.', { required: true }),
    advisoryUrl: field(https(), 'An advisory to read more.'),
  },
}

export const KILL_LIST_FIELDS: ObjectNode = {
  kind: 'object',
  title: 'SprintEngine Studio extension kill list',
  fields: {
    killListVersion: field({ kind: 'literal', value: 1 }, 'The kill list format.', { required: true }),
    generatedAt: field(
      { kind: 'string', max: 40, pattern: DATETIME_RE, patternMessage: 'must be an ISO 8601 date-time.' },
      'When the list was written. Studio never replaces a list with an older one.',
      { required: true },
    ),
    extensions: field(
      { kind: 'array', max: KILL_LIST_ENTRY_LIMIT, items: KILL_ENTRY_NODE },
      'The killed extensions and versions.',
      { required: true },
    ),
  },
}

/**
 * Read a kill list. Entries are read one by one, so one this Studio cannot
 * read never discards the others, and unknown keys are ignored. A `versions`
 * that does not read in full kills every version: narrowing is the field to
 * distrust, so a list Studio half understands over-kills, never under-kills.
 */
export function readKillList(raw: unknown): { ok: true; list: KillList } | { ok: false; message: string } {
  if (!isPlainObject(raw) || raw.killListVersion !== 1) return { ok: false, message: 'It is not a kill list.' }
  const generatedAt = raw.generatedAt
  if (typeof generatedAt !== 'string' || !DATETIME_RE.test(generatedAt) || Number.isNaN(Date.parse(generatedAt)))
    return { ok: false, message: 'Its `generatedAt` is not a date-time.' }
  if (!Array.isArray(raw.extensions)) return { ok: false, message: 'It has no `extensions` list.' }
  const byId = new Map<string, KillListEntry>()
  for (const item of raw.extensions.slice(0, KILL_LIST_ENTRY_LIMIT)) {
    if (!isPlainObject(item)) continue
    const id = readNodeTolerant(KILL_ENTRY_NODE.fields.id!.node, item.id)
    if (typeof id !== 'string' || byId.has(id)) continue
    const reason = readNodeTolerant(KILL_ENTRY_NODE.fields.reason!.node, item.reason)
    const advisoryUrl = readNodeTolerant(KILL_ENTRY_NODE.fields.advisoryUrl!.node, item.advisoryUrl)
    const versions =
      Array.isArray(item.versions) &&
      item.versions.length > 0 &&
      item.versions.every((version) => typeof version === 'string' && SEMVER_RE.test(version))
        ? [...new Set(item.versions as string[])]
        : undefined
    byId.set(id, {
      id,
      reason: typeof reason === 'string' ? reason : 'Removed for the safety of Studio’s users.',
      ...(versions ? { versions } : {}),
      ...(typeof advisoryUrl === 'string' ? { advisoryUrl } : {}),
    })
  }
  return { ok: true, list: { killListVersion: 1, generatedAt, extensions: [...byId.values()] } }
}

/** The kill list's word on one version of one extension, or null when it is not killed. */
export function findKilled(list: KillList | null, key: string, version: string): KillListEntry | null {
  const entry = list?.extensions.find((candidate) => candidate.id === key)
  if (!entry) return null
  return !entry.versions || entry.versions.includes(version) ? entry : null
}

// ── Owner records and the release lock ──────────────────────────────────────

export type OwnerRecord = { login: string; id: number }
export type OwnerRecords = { ownersVersion: 1; owners: OwnerRecord[] }

export const OWNER_RECORDS_FIELDS: ObjectNode = {
  kind: 'object',
  title: 'SprintEngine Studio catalogue owner records',
  fields: {
    ownersVersion: field({ kind: 'literal', value: 1 }, 'The owner records format.', { required: true }),
    owners: field(
      {
        kind: 'array',
        max: 65536,
        items: {
          kind: 'object',
          title: 'OwnerRecord',
          fields: {
            login: field(
              { kind: 'string', min: 1, max: 39, pattern: OWNER_RE, patternMessage: 'must be an account name.' },
              'The owner’s account name now.',
              { required: true },
            ),
            id: field(
              { kind: 'number', integer: true, min: 1, max: Number.MAX_SAFE_INTEGER },
              'The owner’s numeric id, which a rename keeps.',
              { required: true },
            ),
          },
        },
      },
      'Every listed owner: its account name and numeric id.',
      { required: true },
    ),
  },
}

/** Read the owner records, keeping what reads. */
export function readOwnerRecords(raw: unknown): OwnerRecords | null {
  if (!isPlainObject(raw) || raw.ownersVersion !== 1) return null
  const owners = readNodeTolerant(OWNER_RECORDS_FIELDS.fields.owners!.node, raw.owners) as OwnerRecord[] | undefined
  return owners ? { ownersVersion: 1, owners } : null
}

export type ReleaseLockEntry = { id: string; version: string; commit: string; contentHash: string }
export type ReleaseLock = { lockVersion: 1; releases: ReleaseLockEntry[] }

export const RELEASE_LOCK_FIELDS: ObjectNode = {
  kind: 'object',
  title: 'SprintEngine Studio catalogue release lock',
  fields: {
    lockVersion: field({ kind: 'literal', value: 1 }, 'The release lock format.', { required: true }),
    releases: field(
      {
        kind: 'array',
        max: CATALOGUE_ENTRY_LIMIT * CATALOGUE_RELEASE_LIMIT,
        items: {
          kind: 'object',
          title: 'ReleaseLockEntry',
          fields: {
            id: field(installKey(), 'The install key.', { required: true }),
            version: field({ kind: 'string', min: 1, max: 64, pattern: SEMVER_RE }, 'The version.', {
              required: true,
            }),
            commit: RELEASE_NODE.fields.commit!,
            contentHash: RELEASE_NODE.fields.contentHash!,
          },
        },
      },
      'Every version ever listed, with the commit and content hash it was first listed at. A listed version never moves.',
      { required: true },
    ),
  },
}

/** Read the release lock, keeping what reads; the first record of a version wins. */
export function readReleaseLock(raw: unknown): ReleaseLock | null {
  if (!isPlainObject(raw) || raw.lockVersion !== 1) return null
  const releases = readNodeTolerant(RELEASE_LOCK_FIELDS.fields.releases!.node, raw.releases) as
    ReleaseLockEntry[] | undefined
  if (!releases) return null
  const seen = new Set<string>()
  return {
    lockVersion: 1,
    releases: releases.filter((entry) => {
      const key = `${entry.id}@${entry.version}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
  }
}

// ── Generated artefacts ─────────────────────────────────────────────────────

/** The JSON Schema of a catalogue file, as the SDK ships it in `catalogue.schema.json`. */
export function catalogueJsonSchema(): JsonSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://sprintengine.dev/schemas/catalogue.schema.json',
    ...nodeJsonSchema(CATALOGUE_FIELDS),
  }
}

function referenceTable(node: ObjectNode): string {
  const escape = (value: string) => value.replaceAll('|', '\\|')
  return [
    '| Field | Type | Required | Since | Description |',
    '|---|---|---|---|---|',
    ...referenceRows(node).map(
      (row) => `| \`${row.path}\` | ${row.type} | ${row.required ? 'yes' : ''} | ${row.since} | ${escape(row.doc)} |`,
    ),
  ].join('\n')
}

/** The reference guide/catalogue.md carries between its generated markers. */
export function catalogueReference(): string {
  return [
    '### catalogue.json',
    '',
    referenceTable(CATALOGUE_FIELDS),
    '',
    '### kill-list.json',
    '',
    referenceTable(KILL_LIST_FIELDS),
    '',
    '### owners.json',
    '',
    referenceTable(OWNER_RECORDS_FIELDS),
    '',
    '### release-lock.json',
    '',
    referenceTable(RELEASE_LOCK_FIELDS),
  ].join('\n')
}
