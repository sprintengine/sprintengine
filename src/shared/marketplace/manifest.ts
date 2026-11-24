// The marketplace.json registry index contract the app reads.
//
// The index lists two kinds of row: an agent CLI the app already ships
// (`cli`, surfaced as catalogue content) and a Claude Code plugin (tagged
// `claude-plugin`, its skills bundled with the app). Skills, MCP servers and
// model providers of an extension arrive as contributions in that
// extension's own extension.json, never as a registry row.

import type {
  MarketplaceIndex,
  MarketplaceManifestIssue,
  MarketplacePluginEntry,
  MarketplacePluginSkill,
  MarketplacePluginSkillFile,
  MarketplaceProvidesKind,
  MarketplacePublisher,
  ModuleSignature,
} from '../../../packages/studio-protocol/src/public'
import {
  validateBundleBaseManifest,
  type ThirdPartyManifestIssue,
} from '../../../packages/extension-sdk/src/manifest-validate'
import { isRecord } from '../records'

// What a registry entry may say it provides: the skills a Claude Code plugin
// carries, or `cli` for the inline-CLI lane — a first-party agent CLI the app
// already ships. An extension can neither add an agent CLI nor replace one.
export const MARKETPLACE_PROVIDES_KINDS: readonly MarketplaceProvidesKind[] = ['skills', 'cli']

type MarketplaceInlineCli = NonNullable<MarketplacePluginEntry['cli']>

export type {
  MarketplaceIndex,
  MarketplaceManifestIssue,
  MarketplacePluginEntry,
  MarketplacePluginSkill,
  MarketplacePluginSkillFile,
  MarketplaceProvidesKind,
  MarketplacePublisher,
} from '../../../packages/studio-protocol/src/public'

// Machine tag the generated catalogue stamps on Claude Code plugin entries
// (content in Claude's plugin format — `.claude-plugin/plugin.json` + skills
// dirs). Both the storefront affordance and the install pipeline branch on
// it, so the check lives here, once.
const CLAUDE_PLUGIN_TAG = 'claude-plugin'

export function isClaudeCodePluginEntry(entry: Pick<MarketplacePluginEntry, 'tags'>): boolean {
  return entry.tags?.includes(CLAUDE_PLUGIN_TAG) ?? false
}

export type MarketplaceIndexResult =
  { ok: true; marketplace: MarketplaceIndex } | { ok: false; issues: MarketplaceManifestIssue[] }

const PROVIDES_KIND_SET = new Set<string>(MARKETPLACE_PROVIDES_KINDS)
// Kinds a registry row once provided and this Studio no longer installs: the
// automation starters, retired when automations became scheduled agents, and
// MCP servers, which an extension now contributes in its extension.json.
const RETIRED_PROVIDES_KINDS = new Set<string>(['automation', 'mcp'])

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
}

function pushSdkIssues(
  issues: MarketplaceManifestIssue[],
  sdkIssues: ThirdPartyManifestIssue[],
  pathPrefix = '',
  remap: Record<string, string> = {},
): void {
  for (const issue of sdkIssues) {
    const mappedPath = remap[issue.path] ?? issue.path
    issues.push({ path: pathPrefix ? `${pathPrefix}.${mappedPath}` : mappedPath, message: issue.message })
  }
}

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/

// Payload file paths (and the skill folder path used to locate the payload
// dir) are joined into filesystem paths at install time, so they must be plain
// forward-slash relative paths — no traversal, no absolute paths, no
// backslashes (a backslash segment survives a '/'-only split and escapes on
// Windows join()), no empty segments.
function isSafeSkillFilePath(value: unknown): value is string {
  if (!isNonEmptyString(value) || value.includes('\\')) return false
  const path = value.trim()
  if (path.startsWith('/')) return false
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function validateSkillFiles(
  value: unknown,
  path: string,
  issues: MarketplaceManifestIssue[],
): MarketplacePluginSkillFile[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path, message: 'skill files, when present, must be a non-empty array.' })
    return undefined
  }
  const files: MarketplacePluginSkillFile[] = []
  const seenPaths = new Set<string>()
  let ok = true
  value.forEach((file, index) => {
    if (
      !isRecord(file) ||
      !isSafeSkillFilePath(file.path) ||
      typeof file.sha256 !== 'string' ||
      !SHA256_HEX_PATTERN.test(file.sha256) ||
      typeof file.size !== 'number' ||
      !Number.isInteger(file.size) ||
      file.size < 0
    ) {
      issues.push({
        path: `${path}[${index}]`,
        message:
          'each skill file must carry a safe relative path, a lowercase 64-hex sha256, and a non-negative integer size.',
      })
      ok = false
      return
    }
    const filePath = file.path.trim()
    if (seenPaths.has(filePath)) {
      issues.push({ path: `${path}[${index}].path`, message: 'skill file paths must be unique.' })
      ok = false
      return
    }
    seenPaths.add(filePath)
    files.push({ path: filePath, sha256: file.sha256, size: file.size })
  })
  return ok ? files : undefined
}

function validateSkills(
  value: unknown,
  path: string,
  issues: MarketplaceManifestIssue[],
): MarketplacePluginSkill[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'skills must be an array.' })
    return undefined
  }
  const skills: MarketplacePluginSkill[] = []
  value.forEach((skill, index) => {
    if (!isRecord(skill) || !isNonEmptyString(skill.name) || typeof skill.description !== 'string') {
      issues.push({
        path: `${path}[${index}]`,
        message: 'each skill must be an object with a non-empty name and a string description.',
      })
      return
    }
    if (skill.path !== undefined && !isNonEmptyString(skill.path)) {
      issues.push({ path: `${path}[${index}].path`, message: 'skill path, when present, must be a non-empty string.' })
      return
    }
    // The path locates the bundled payload folder (its basename), so it must
    // be a safe relative path even for metadata-only skills — a backslash or
    // traversal segment would escape the payload root on the install side.
    if (skill.path !== undefined && !isSafeSkillFilePath(skill.path)) {
      issues.push({
        path: `${path}[${index}].path`,
        message: 'skill path must be a safe relative path (no traversal, absolute, or backslash segments).',
      })
      return
    }
    // Payload digests come as a unit: files + contentDigest + the folder path
    // needed to locate the bundled bytes. A digest listing that could not be
    // fully validated must fail the index, never ship half-verified.
    const hasFiles = skill.files !== undefined
    const hasDigest = skill.contentDigest !== undefined
    if (hasFiles !== hasDigest) {
      issues.push({
        path: `${path}[${index}]`,
        message: 'skill files and contentDigest must be present together.',
      })
      return
    }
    let files: MarketplacePluginSkillFile[] | undefined
    let contentDigest: string | undefined
    if (hasFiles) {
      if (!isNonEmptyString(skill.path)) {
        issues.push({
          path: `${path}[${index}].path`,
          message: 'a skill with bundled content digests requires a path.',
        })
        return
      }
      if (typeof skill.contentDigest !== 'string' || !SHA256_HEX_PATTERN.test(skill.contentDigest)) {
        issues.push({
          path: `${path}[${index}].contentDigest`,
          message: 'contentDigest must be a lowercase 64-hex sha256.',
        })
        return
      }
      files = validateSkillFiles(skill.files, `${path}[${index}].files`, issues)
      if (files === undefined) return
      contentDigest = skill.contentDigest
    }
    skills.push({
      name: skill.name.trim(),
      description: skill.description.trim(),
      ...(isNonEmptyString(skill.path) ? { path: skill.path.trim() } : {}),
      ...(files !== undefined && contentDigest !== undefined ? { files, contentDigest } : {}),
    })
  })
  return skills
}

function validatePublisher(
  value: unknown,
  path: string,
  issues: MarketplaceManifestIssue[],
): MarketplacePublisher | undefined {
  if (!isRecord(value)) {
    issues.push({ path, message: 'publisher must be an object.' })
    return undefined
  }
  if (!isNonEmptyString(value.name)) {
    issues.push({ path: `${path}.name`, message: 'publisher.name is required and must be a non-empty string.' })
  }
  if (typeof value.verified !== 'boolean') {
    issues.push({ path: `${path}.verified`, message: 'publisher.verified must be a boolean.' })
  }
  if (!isNonEmptyString(value.name) || typeof value.verified !== 'boolean') return undefined
  return { name: value.name.trim(), verified: value.verified }
}

function validateProvides(
  value: unknown,
  path: string,
  issues: MarketplaceManifestIssue[],
): MarketplaceProvidesKind[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({ path, message: 'provides must be an array.' })
    return undefined
  }
  if (value.length === 0) {
    issues.push({ path, message: 'provides must contain at least one component kind.' })
    return undefined
  }
  const seen = new Set<MarketplaceProvidesKind>()
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !PROVIDES_KIND_SET.has(entry)) {
      issues.push({
        path: `${path}[${index}]`,
        message: `provides entries must be one of: ${MARKETPLACE_PROVIDES_KINDS.join(', ')}.`,
      })
      return
    }
    seen.add(entry as MarketplaceProvidesKind)
  })
  return seen.size > 0 ? Array.from(seen) : undefined
}

function validateStringArray(
  value: unknown,
  path: string,
  field: string,
  issues: MarketplaceManifestIssue[],
): string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({ path, message: `${field} must be an array of strings.` })
    return undefined
  }
  const items: string[] = []
  value.forEach((entry, index) => {
    if (!isNonEmptyString(entry)) {
      issues.push({ path: `${path}[${index}]`, message: `${field} entries must be non-empty strings.` })
      return
    }
    items.push(entry.trim())
  })
  return items.length === value.length ? items : undefined
}

// Same shape the SDK bundle manifest probe enforces for entry ids; an inline
// CLI's pluginId is a plugin-registry directory name, so it obeys the same
// lowercase id grammar.
const INLINE_CLI_PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

function validateInlineCli(
  value: unknown,
  path: string,
  issues: MarketplaceManifestIssue[],
): MarketplaceInlineCli | undefined {
  if (!isRecord(value)) {
    issues.push({ path, message: 'cli must be an object.' })
    return undefined
  }
  if (typeof value.pluginId !== 'string' || !INLINE_CLI_PLUGIN_ID_PATTERN.test(value.pluginId)) {
    issues.push({
      path: `${path}.pluginId`,
      message: 'cli.pluginId must be a lowercase plugin id (a–z, 0–9, hyphen), 1–63 chars.',
    })
    return undefined
  }
  return { pluginId: value.pluginId }
}

function validateMarketplaceEntry(
  value: unknown,
  index: number,
  issues: MarketplaceManifestIssue[],
): MarketplacePluginEntry | undefined {
  const path = `plugins[${index}]`
  if (!isRecord(value)) {
    issues.push({ path, message: 'marketplace plugin entry must be an object.' })
    return undefined
  }
  // A row for a retired kind is left off the shelf rather than failing the
  // index: a published registry that still lists one must not take every other
  // row down with it. That includes a plugin bundle (a `source` row that is not
  // a Claude Code plugin) and an inline MCP server list (`mcp`), both of which
  // an extension's contributions replaced.
  if (Array.isArray(value.provides) && value.provides.some((kind) => RETIRED_PROVIDES_KINDS.has(String(kind)))) {
    return undefined
  }
  if (value.mcp !== undefined) return undefined
  const claudePlugin = Array.isArray(value.tags) && value.tags.includes(CLAUDE_PLUGIN_TAG)
  if (value.source !== undefined && value.cli === undefined && !claudePlugin) {
    return undefined
  }
  const startIssues = issues.length

  // signature is optional here; the SDK probe validates its shape when present.
  const baseProbe = validateBundleBaseManifest({
    id: value.id,
    displayName: value.name,
    version: value.latest,
    permissions: [],
    signature: value.signature,
  })
  if (!baseProbe.ok) {
    pushSdkIssues(issues, baseProbe.issues, path, { displayName: 'name', version: 'latest' })
  }

  const publisher = validatePublisher(value.publisher, `${path}.publisher`, issues)
  for (const key of ['summary', 'icon'] as const) {
    if (!isNonEmptyString(value[key])) {
      issues.push({ path: `${path}.${key}`, message: `${key} is required and must be a non-empty string.` })
    }
  }
  const provides = validateProvides(value.provides, `${path}.provides`, issues)

  // Categories: accept the legacy singular `category` and/or a `categories[]`
  // array, and keep `category` populated (from categories[0]) for back-compat.
  const categories =
    value.categories !== undefined
      ? validateStringArray(value.categories, `${path}.categories`, 'categories', issues)
      : undefined
  const tags = value.tags !== undefined ? validateStringArray(value.tags, `${path}.tags`, 'tags', issues) : undefined
  let category: string | undefined
  if (value.category !== undefined && !isNonEmptyString(value.category)) {
    issues.push({ path: `${path}.category`, message: 'category must be a non-empty string.' })
  } else if (isNonEmptyString(value.category)) {
    category = value.category.trim()
  }
  if (category === undefined && categories && categories.length > 0) category = categories[0]
  if (category === undefined) {
    issues.push({ path: `${path}.category`, message: 'category or categories[] is required.' })
  }

  // Claude Code plugin (source) XOR inline-CLI (cli): exactly one shape.
  const hasSource = value.source !== undefined
  const hasCli = value.cli !== undefined
  if (hasSource && hasCli) {
    issues.push({ path, message: 'entry must be exactly one of: Claude Code plugin (source), inline-CLI (cli).' })
  } else if (!hasSource && !hasCli) {
    issues.push({ path, message: 'entry must declare a Claude Code plugin source or an inline cli block.' })
  }

  let source: string | undefined
  if (hasSource) {
    if (!isNonEmptyString(value.source)) {
      issues.push({ path: `${path}.source`, message: 'source is required and must be a non-empty string.' })
    } else {
      source = value.source.trim()
    }
    if (provides?.includes('cli')) {
      issues.push({
        path: `${path}.provides`,
        message: 'Claude Code plugin entries cannot provide cli: agent CLIs ship with the app.',
      })
    }
  }

  let cli: MarketplaceInlineCli | undefined
  if (hasCli) {
    cli = validateInlineCli(value.cli, `${path}.cli`, issues)
    if (provides && (provides.length !== 1 || provides[0] !== 'cli')) {
      issues.push({ path: `${path}.provides`, message: "inline-CLI entries must set provides to ['cli']." })
    }
  }

  // Bundled-skill summaries (optional, generated by the catalogue snapshot):
  // validated here so they survive the field-by-field entry rebuild below —
  // an unknown key would otherwise be silently dropped.
  const skills = value.skills !== undefined ? validateSkills(value.skills, `${path}.skills`, issues) : undefined

  if (!baseProbe.ok || !publisher || !provides || category === undefined || issues.length > startIssues) {
    return undefined
  }

  const entry: MarketplacePluginEntry = {
    id: baseProbe.manifest.id,
    name: baseProbe.manifest.displayName,
    publisher,
    summary: (value.summary as string).trim(),
    category,
    icon: (value.icon as string).trim(),
    latest: baseProbe.manifest.version,
    provides,
  }
  if (categories && categories.length > 0) entry.categories = categories
  if (tags && tags.length > 0) entry.tags = tags
  if (source !== undefined) entry.source = source
  if (baseProbe.manifest.signature) entry.signature = baseProbe.manifest.signature as ModuleSignature
  if (cli) entry.cli = cli
  if (skills && skills.length > 0) entry.skills = skills
  return entry
}

export function validateMarketplaceIndex(value: unknown): MarketplaceIndexResult {
  const issues: MarketplaceManifestIssue[] = []
  if (!isRecord(value)) {
    return { ok: false, issues: [{ path: '', message: 'Marketplace index must be a JSON object.' }] }
  }
  if (value.schemaVersion !== 1) {
    issues.push({ path: 'schemaVersion', message: 'schemaVersion must be 1.' })
  }
  if (!Array.isArray(value.plugins)) {
    issues.push({ path: 'plugins', message: 'plugins must be an array.' })
  }

  const plugins = Array.isArray(value.plugins)
    ? value.plugins
        .map((entry, index) => validateMarketplaceEntry(entry, index, issues))
        .filter((entry): entry is MarketplacePluginEntry => entry !== undefined)
    : []

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, marketplace: { schemaVersion: 1, plugins } }
}

export function parseMarketplaceIndex(source: string): MarketplaceIndexResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    return {
      ok: false,
      issues: [{ path: '', message: `Invalid JSON: ${error instanceof Error ? error.message : 'parse error'}.` }],
    }
  }
  return validateMarketplaceIndex(parsed)
}
