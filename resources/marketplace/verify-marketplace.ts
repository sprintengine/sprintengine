import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { readStudioEnv } from '../../src/shared/studio-env'
import { verifyBundledSkillFolder } from '../../src/main/marketplace/skill-content'
import {
  MARKETPLACE_EXTRA_HOSTS_ENV,
  isMarketplaceSourceHostAllowed,
  parseMarketplaceExtraHosts,
  parseMarketplaceIndex,
  type MarketplaceManifestIssue,
  type MarketplacePluginEntry,
} from '../../src/shared/marketplace'

// Checks a marketplace registry the way the app will read it. The index holds
// two kinds of row: the agent CLIs the app ships (`cli`) and Claude Code
// plugins (`claude-plugin`, their skills bundled under skills/<id>/). Skills,
// MCP servers and model providers of an extension are contributions in its
// extension.json and never appear here.

type TrustedPublisher = {
  name: string
  verified: boolean
  publicKey: string
  fingerprint: string
}

type TrustedPublishers = {
  schemaVersion: 1
  publishers: TrustedPublisher[]
}

type VerifyOptions = {
  root: string
}

type VerificationIssue = {
  path: string
  message: string
}

function parseArgs(args: string[]): VerifyOptions {
  let root: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    switch (arg) {
      case '--root':
        root = args[++index]
        break
      case '--help':
      case '-h':
        console.log('Usage: node marketplace-registry-verify.cjs [--root <marketplace-root>]')
        process.exit(0)
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return { root: resolve(root ?? defaultMarketplaceRoot()) }
}

function defaultMarketplaceRoot(): string {
  const repoSeedRoot = join(process.cwd(), 'resources', 'marketplace')
  if (existsSync(join(repoSeedRoot, 'marketplace.json'))) return repoSeedRoot
  return process.cwd()
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function issue(path: string, message: string): VerificationIssue {
  return { path, message }
}

function formatValidatorIssues(prefix: string, issues: MarketplaceManifestIssue[]): VerificationIssue[] {
  return issues.map((entry) => issue(entry.path ? `${prefix}.${entry.path}` : prefix, entry.message))
}

function isInsideOrEqual(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function assertNoKeyMaterial(path: string, root: string, issues: VerificationIssue[]): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      assertNoKeyMaterial(child, root, issues)
      continue
    }
    if (entry.name.endsWith('.key') || entry.name.endsWith('.pem')) {
      issues.push(issue(relative(root, child), 'private key material must not be committed to the marketplace registry.'))
    }
  }
}

function readTrustedPublishers(root: string, issues: VerificationIssue[]): TrustedPublisher[] {
  const path = join(root, 'trusted-publishers.json')
  if (!existsSync(path)) return []
  try {
    const payload = readJson<TrustedPublishers>(path)
    if (payload.schemaVersion !== 1 || !Array.isArray(payload.publishers)) {
      issues.push(issue('trusted-publishers.json', 'must contain schemaVersion 1 and publishers[].'))
      return []
    }
    return payload.publishers
  } catch (error) {
    issues.push(issue('trusted-publishers.json', error instanceof Error ? error.message : 'could not parse JSON.'))
    return []
  }
}

function validateEntrySource(entryId: string, source: string, issues: VerificationIssue[]): void {
  let parsed: URL
  try {
    parsed = new URL(source)
  } catch {
    issues.push(issue(`plugins.${entryId}.source`, 'source must be a valid HTTPS URL.'))
    return
  }
  if (parsed.protocol !== 'https:') {
    issues.push(issue(`plugins.${entryId}.source`, 'source must be an HTTPS URL.'))
    return
  }
  const extraHosts = parseMarketplaceExtraHosts(readStudioEnv(MARKETPLACE_EXTRA_HOSTS_ENV))
  if (!isMarketplaceSourceHostAllowed(parsed.hostname, extraHosts)) {
    issues.push(issue(
      `plugins.${entryId}.source`,
      `source host "${parsed.hostname}" is not on the marketplace allowlist.`
    ))
  }
}

/**
 * Generated/unsigned entries carry self-contained icons (data: URI or an
 * https URL); only registry-relative icon paths must resolve to a committed
 * file. A remote icon is display-only, never fetched at verify time.
 *
 * A data URI renders offline and needs no registry base to resolve, which is
 * why the inline agent-CLI entries use one — but a base64 blob is unreviewable,
 * so those entries also commit the mark at `icons/<id>.svg`. When both exist they
 * must be the same bytes: otherwise the reviewed mark and the shipped mark
 * quietly diverge.
 */
function validateEntryIcon(root: string, index: number, entryId: string, icon: string, issues: VerificationIssue[]): void {
  if (icon.startsWith('data:image/')) {
    assertInlineIconMatchesCommittedMark(root, index, entryId, icon, issues)
    return
  }
  if (URL.canParse(icon) && new URL(icon).protocol === 'https:') return
  const iconPath = join(root, icon)
  if (!isInsideOrEqual(root, iconPath) || !existsSync(iconPath)) {
    issues.push(issue(`marketplace.json.plugins[${index}].icon`, `icon path "${icon}" must exist inside the registry.`))
  }
}

function assertInlineIconMatchesCommittedMark(
  root: string,
  index: number,
  entryId: string,
  icon: string,
  issues: VerificationIssue[]
): void {
  const markPath = join(root, 'icons', `${entryId}.svg`)
  if (!isInsideOrEqual(root, markPath) || !existsSync(markPath)) return
  const encoded = /^data:image\/svg\+xml;base64,(.*)$/s.exec(icon)?.[1]
  if (encoded === undefined) {
    issues.push(issue(
      `marketplace.json.plugins[${index}].icon`,
      `icons/${entryId}.svg is committed, so the entry icon must be the base64 SVG data URI of those bytes.`
    ))
    return
  }
  if (!Buffer.from(encoded, 'base64').equals(readFileSync(markPath))) {
    issues.push(issue(
      `marketplace.json.plugins[${index}].icon`,
      `inline icon does not match the committed mark at icons/${entryId}.svg.`
    ))
  }
}

/**
 * An inline-CLI entry surfaces an app-bundled agent CLI plugin as
 * marketplace content: no bundle, no bytes to download — the install action is
 * the bundled plugin's `install` spec executed by the CLI runtime installer.
 * Two rules replace the signature gate:
 *
 * - `publisher.verified` may be claimed only when the named publisher is a
 *   verified publisher in trusted-publishers.json: identity is proven by the
 *   signed app bundle the plugin ships inside, and the trust-anchor file keeps
 *   an arbitrary index entry from wearing the badge under an unknown name.
 * - The referenced bundled plugin manifest must exist. This is checkable only
 *   in the app repo, where the registry root sits beside resources/plugins;
 *   the standalone registry repo has no bundled plugin tree, so there the
 *   entry's contract is the schema plus the app-side seed-drift test
 *   (cli-entries.test.ts), which regenerates every entry from the manifests.
 */
function validateInlineCliEntry(
  root: string,
  entry: MarketplacePluginEntry,
  index: number,
  trustedPublishers: TrustedPublisher[],
  issues: VerificationIssue[]
): void {
  if (entry.cli === undefined) return
  if (entry.publisher.verified) {
    const trusted = trustedPublishers.find(
      (publisher) => publisher.verified && publisher.name === entry.publisher.name
    )
    if (!trusted) {
      issues.push(issue(
        `marketplace.json.plugins[${index}].publisher.verified`,
        'an inline-CLI entry may claim a verified publisher only under a name listed as verified in trusted-publishers.json.'
      ))
    }
  }
  const bundledPluginsRoot = join(root, '..', 'plugins')
  if (existsSync(bundledPluginsRoot)) {
    const manifestPath = join(bundledPluginsRoot, entry.cli.pluginId, 'plugin.json')
    if (!existsSync(manifestPath)) {
      issues.push(issue(
        `marketplace.json.plugins[${index}].cli.pluginId`,
        `no bundled plugin manifest at resources/plugins/${entry.cli.pluginId}/plugin.json; an inline-CLI entry must reference an app-bundled plugin.`
      ))
    }
  }
}

// Bundled skill payloads: every digest-bearing skill must have its
// payload dir present and byte-identical to the recorded digests, and every
// payload folder must be claimed by a digest-bearing entry — a skew in either
// direction ships a broken or undisclosed offline install with a green diff.
async function validateBundledSkillPayloads(
  root: string,
  marketplace: { plugins: Array<{ id: string; skills?: Array<{ name: string; path?: string; files?: Array<{ path: string; sha256: string; size: number }>; contentDigest?: string }> }> },
  issues: VerificationIssue[]
): Promise<void> {
  const skillsRoot = join(root, 'skills')
  const claimedDirs = new Map<string, Set<string>>()
  for (const entry of marketplace.plugins) {
    const digestSkills = (entry.skills ?? []).filter((skill) => skill.files !== undefined && skill.contentDigest !== undefined)
    if (digestSkills.length === 0) continue
    const payloadRoot = join(skillsRoot, entry.id)
    if (!existsSync(payloadRoot)) {
      issues.push(issue(`skills/${entry.id}`, 'entry records skill content digests but its payload dir is missing.'))
      continue
    }
    const claimed = new Set<string>()
    claimedDirs.set(entry.id, claimed)
    for (const skill of digestSkills) {
      const folder = (skill.path ?? '').split('/').filter(Boolean).pop() ?? ''
      if (!folder) {
        issues.push(issue(`skills/${entry.id}`, `skill "${skill.name}" has no usable folder path.`))
        continue
      }
      claimed.add(folder)
      const verification = await verifyBundledSkillFolder(join(payloadRoot, folder), skill.files ?? [], skill.contentDigest ?? '')
      if (!verification.ok) {
        issues.push(issue(`skills/${entry.id}/${folder}`, `bundled payload fails digest verification: ${verification.message}`))
      }
    }
    for (const dirent of readdirSync(payloadRoot, { withFileTypes: true })) {
      if (!dirent.isDirectory()) {
        issues.push(issue(`skills/${entry.id}/${dirent.name}`, 'payload roots may contain only skill folders.'))
        continue
      }
      if (!claimed.has(dirent.name)) {
        issues.push(issue(`skills/${entry.id}/${dirent.name}`, 'payload folder is not claimed by any digest-bearing skill on its entry.'))
      }
    }
  }
  if (existsSync(skillsRoot)) {
    for (const dirent of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!dirent.isDirectory() || claimedDirs.has(dirent.name)) continue
      issues.push(issue(`skills/${dirent.name}`, 'committed skill payload has no digest-bearing marketplace.json entry.'))
    }
  }
}

async function validateMarketplace(root: string): Promise<VerificationIssue[]> {
  const issues: VerificationIssue[] = []
  const marketplacePath = join(root, 'marketplace.json')
  const trustedPublishers = readTrustedPublishers(root, issues)

  if (!existsSync(marketplacePath)) {
    return [issue('marketplace.json', 'file is required at the marketplace registry root.')]
  }

  const marketplaceResult = parseMarketplaceIndex(readFileSync(marketplacePath, 'utf8'))
  if (!marketplaceResult.ok) {
    return [...issues, ...formatValidatorIssues('marketplace.json', marketplaceResult.issues)]
  }

  const { marketplace } = marketplaceResult
  const ids = new Set<string>()
  for (const [index, entry] of marketplace.plugins.entries()) {
    if (ids.has(entry.id)) issues.push(issue(`marketplace.json.plugins[${index}].id`, 'plugin ids must be unique.'))
    ids.add(entry.id)

    if (entry.source !== undefined) validateEntrySource(entry.id, entry.source, issues)
    validateEntryIcon(root, index, entry.id, entry.icon, issues)

    // Only an inline-CLI entry may claim a verified publisher: the plugin it
    // names lives inside the signed app bundle, so the app build itself is the
    // identity proof, and the claim is gated on trusted-publishers.json (see
    // validateInlineCliEntry). A Claude Code plugin's content is nobody's
    // signed work, so it installs only on the person's approval.
    if (entry.cli !== undefined) {
      validateInlineCliEntry(root, entry, index, trustedPublishers, issues)
    } else if (entry.publisher.verified) {
      issues.push(issue(
        `marketplace.json.plugins[${index}].publisher.verified`,
        'only an inline-CLI entry may claim a verified publisher.'
      ))
    }
  }

  await validateBundledSkillPayloads(root, marketplace, issues)
  assertNoKeyMaterial(root, root, issues)
  return issues
}

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2))
    const issues = await validateMarketplace(options.root)
    if (issues.length > 0) {
      console.error(`Marketplace registry validation failed for ${options.root}:`)
      for (const entry of issues) {
        console.error(`  - ${entry.path}: ${entry.message}`)
      }
      process.exit(1)
    }
    const marketplace = parseMarketplaceIndex(readFileSync(join(options.root, 'marketplace.json'), 'utf8'))
    const count = marketplace.ok ? marketplace.marketplace.plugins.length : 0
    console.log(`marketplace registry verified (${count} plugins)`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
