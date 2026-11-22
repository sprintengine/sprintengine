import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

import type { MarketplaceTrustPin } from '../../shared/electron-api'
import type { MarketplacePluginEntry } from '../../shared/marketplace'
import { findMarketplaceResourcePath, type MarketplaceResourceResolver } from './resources'
import { verifyBundledSkillFolder } from './skill-content'

// Staging a Claude Code plugin's skills for a review or an install. Nothing
// here touches the network: the skill content ships with the app, beside the
// catalogue, and is digest-checked before it is staged.

const DEFAULT_MARKETPLACE_PLUGIN_STAGING_DIR = 'marketplace-plugin-staging'

export function defaultMarketplacePluginStagingRoot(userDataDir?: string): string {
  return join(userDataDir?.trim() || tmpdir(), DEFAULT_MARKETPLACE_PLUGIN_STAGING_DIR)
}

/**
 * Structured log hook for the marketplace verify/install pipeline. Events are
 * short kebab-ish identifiers with a small detail record; the IPC layer wires
 * them into the diagnostics log so a failed verify or install is never
 * invisible.
 */
export type MarketplaceInstallLog = (event: string, detail?: Record<string, unknown>) => void

export type ClaudeCodePluginDownloadOptions = {
  entry: MarketplacePluginEntry
  stagingRoot?: string
  /**
   * Refuse to stage when the bundled content identity differs from this pin.
   * The install passes the identity the pre-trust verify disclosed, so the
   * user can never trust listing A and install content B (an app/catalogue
   * update swapping the bundled payload between the prompt and the install).
   */
  refOverride?: string
  /** Test seam for packaged resource resolution. */
  packagedResourceResolver?: MarketplaceResourceResolver
  log?: MarketplaceInstallLog
}

export type ClaudeCodePluginDownloadResult =
  | {
      ok: true
      sourceUrl: string
      /** Staged copy of the plugin subtree (`.claude-plugin/` + `skills/`). */
      stagedPath: string
      /** Skill folder names under the plugin's skills/ dir (each has a SKILL.md). */
      skillDirs: string[]
      /** The plugin's own name from .claude-plugin/plugin.json. */
      claudeName: string
      /** The bundled content identity (`bundled:<digest>`) the pin is taken from. */
      resolvedRef: string
      /** The staged listing, for a trust prompt to disclose and an install to re-check. */
      pin: MarketplaceTrustPin
      /**
       * Names of skills the entry lists but that shipped metadata-only (no
       * bundled content — a snapshot capture cap), so the install can tell the
       * user which listed skills it did NOT install rather than silently
       * dropping them.
       */
      metadataOnlySkills: string[]
    }
  | { ok: false; sourceUrl: string; message: string; statusCode?: number }

const CLAUDE_PLUGIN_NOT_BUNDLED_MESSAGE =
  'This plugin isn’t installable offline yet — its skill content isn’t bundled with this version of SprintEngine. It may become installable after an app update refreshes the catalogue.'

/**
 * Identity of a bundled content set: a digest over the (sorted) per-skill
 * contentDigests. This is what verify pins and install re-checks — the
 * bundled analogue of the old commit-sha TOCTOU pin (bundled bytes only
 * change when the app or its catalogue update, and that must send the user
 * back through the trust prompt, not silently install different content).
 */
function bundledClaudeContentRef(contentDigests: readonly string[]): string {
  const digest = createHash('sha256')
    .update([...contentDigests].sort().join('\n'), 'utf8')
    .digest('hex')
  return `bundled:${digest.slice(0, 16)}`
}

/**
 * Stage a Claude Code plugin's installable skill content from the BUNDLED
 * catalogue payload (resources/marketplace/skills/<entryId>/), never the
 * network: the old GitHub contents-API walk needed ~2x60 unauthenticated
 * calls for a large plugin against a 60/hour cap and died mid-"Verifying…".
 * Every staged folder is verified byte-for-byte against the entry's digest
 * listing before it is offered for install; an entry whose content did not
 * ship in the snapshot gets an honest "not installable offline yet" failure.
 * Commands/agents/hooks in the plugin are NOT staged or installed; skills are
 * the one component the studio can honestly deliver today.
 */
export async function downloadClaudeCodePluginSource(
  options: ClaudeCodePluginDownloadOptions,
): Promise<ClaudeCodePluginDownloadResult> {
  const log = options.log ?? (() => undefined)
  const entry = options.entry
  const sourceUrl = entry.source?.trim() ?? ''

  const bundledSkills = (entry.skills ?? []).filter(
    (skill) => skill.files !== undefined && skill.contentDigest !== undefined && typeof skill.path === 'string',
  )
  log('claude-plugin:resolve', {
    entryId: entry.id,
    skills: entry.skills?.length ?? 0,
    bundledSkills: bundledSkills.length,
  })
  if (bundledSkills.length === 0) {
    log('claude-plugin:not-bundled', { entryId: entry.id, reason: 'entry carries no content digests' })
    return { ok: false, sourceUrl, message: CLAUDE_PLUGIN_NOT_BUNDLED_MESSAGE }
  }

  const resolveResource = options.packagedResourceResolver ?? findMarketplaceResourcePath
  const resourceDir = resolveResource(`skills/${entry.id}`)
  if (resourceDir === null) {
    log('claude-plugin:not-bundled', { entryId: entry.id, reason: 'no packaged payload dir' })
    return { ok: false, sourceUrl, message: CLAUDE_PLUGIN_NOT_BUNDLED_MESSAGE }
  }

  const stagingRoot = options.stagingRoot ?? defaultMarketplacePluginStagingRoot()
  let stage: string | null = null
  try {
    await mkdir(stagingRoot, { recursive: true })
    stage = await mkdtemp(join(stagingRoot, `${entry.id}-claude-`))
    const contentDigests: string[] = []
    const resourceRoot = resolve(resourceDir)
    const stageSkillsRoot = resolve(join(stage, 'skills'))
    for (const skill of bundledSkills) {
      // The payload folder is the basename of the skill's repo-relative path;
      // the validator guarantees a safe path on digest-bearing skills, but
      // re-derive and containment-check here so a mis-generated catalogue can
      // never make cp read or write outside the payload/staging roots.
      const folder =
        (skill.path as string)
          .split('/')
          .filter((segment) => segment.length > 0)
          .pop() ?? ''
      if (folder === '' || folder === '.' || folder === '..' || folder.includes('\\')) {
        return { ok: false, sourceUrl, message: `Skill “${skill.name}” has an unusable bundled folder path.` }
      }
      const payloadDir = resolve(resourceRoot, folder)
      const stageDir = resolve(stageSkillsRoot, folder)
      if (!payloadDir.startsWith(`${resourceRoot}${sep}`) || !stageDir.startsWith(`${stageSkillsRoot}${sep}`)) {
        return {
          ok: false,
          sourceUrl,
          message: `Skill “${skill.name}” resolves outside its bundled payload directory.`,
        }
      }
      const verification = await verifyBundledSkillFolder(payloadDir, skill.files ?? [], skill.contentDigest ?? '')
      if (!verification.ok) {
        log('claude-plugin:integrity-failure', { entryId: entry.id, skill: folder, message: verification.message })
        return {
          ok: false,
          sourceUrl,
          message: `Bundled content for skill “${skill.name}” failed integrity verification: ${verification.message} Reinstalling or updating SprintEngine restores the packaged catalogue.`,
        }
      }
      await mkdir(join(stage, 'skills'), { recursive: true })
      await cp(payloadDir, join(stage, 'skills', folder), { recursive: true })
      contentDigests.push(skill.contentDigest as string)
    }

    const skillDirs = await stagedSkillDirs(join(stage, 'skills'))
    if (skillDirs.length === 0) {
      return {
        ok: false,
        sourceUrl,
        message:
          'This Claude Code plugin bundles no skills. SprintEngine installs plugin skills only; its commands run inside Claude Code sessions.',
      }
    }

    const resolvedRef = bundledClaudeContentRef(contentDigests)
    if (options.refOverride !== undefined && options.refOverride !== resolvedRef) {
      log('claude-plugin:pin-mismatch', { entryId: entry.id, pinned: options.refOverride, actual: resolvedRef })
      return {
        ok: false,
        sourceUrl,
        message:
          'The bundled skill content changed since it was verified (the app or its catalogue updated). Review and trust the plugin again.',
      }
    }

    // Skills the entry advertises but that shipped without content (a capture
    // cap) install nothing — name them so the caller can disclose the gap
    // instead of the storefront listing a skill the user never receives.
    const bundledNames = new Set(bundledSkills.map((skill) => skill.name))
    const metadataOnlySkills = (entry.skills ?? []).map((skill) => skill.name).filter((name) => !bundledNames.has(name))
    if (metadataOnlySkills.length > 0) {
      log('claude-plugin:metadata-only-skills', { entryId: entry.id, skills: metadataOnlySkills })
    }

    log('claude-plugin:staged', { entryId: entry.id, skillDirs, resolvedRef })
    const result: ClaudeCodePluginDownloadResult = {
      ok: true,
      sourceUrl,
      stagedPath: stage,
      skillDirs,
      metadataOnlySkills,
      claudeName: entry.name,
      resolvedRef,
      pin: {
        manifestSha256: sha256Hex(Buffer.from(resolvedRef, 'utf8')),
        componentDigests: Object.fromEntries(
          bundledSkills.map((skill) => [
            `skills/${(skill.path as string).split('/').filter(Boolean).pop()}`,
            skill.contentDigest as string,
          ]),
        ),
      },
    }
    stage = null // ownership transfers to the caller, which removes it
    return result
  } catch (error) {
    log('claude-plugin:stage-failed', { entryId: entry.id, message: formatError(error) })
    return { ok: false, sourceUrl, message: formatError(error) }
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function stagedSkillDirs(skillsRoot: string): Promise<string[]> {
  let dirents
  try {
    dirents = await readdir(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const dirs: string[] = []
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    try {
      await readFile(join(skillsRoot, dirent.name, 'SKILL.md'), 'utf8')
      dirs.push(dirent.name)
    } catch {
      // a folder without SKILL.md is not a skill
    }
  }
  return dirs.sort()
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
