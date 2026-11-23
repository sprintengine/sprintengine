import { rm } from 'node:fs/promises'

import type { MarketplaceManifestIssue, MarketplacePluginEntry } from '../../shared/marketplace'
import { isClaudeCodePluginEntry, validateMarketplaceIndex } from '../../shared/marketplace'
import type { MarketplacePluginVerifyResult } from '../../shared/electron-api'
import {
  defaultMarketplacePluginStagingRoot,
  downloadClaudeCodePluginSource,
  type MarketplaceInstallLog,
} from './plugin-download'
import type { MarketplaceResourceResolver } from './resources'

export type MarketplacePluginVerifierServices = {
  stagingRoot?: string
  /** Test seam for packaged resource resolution (bundled claude-plugin skills). */
  packagedResourceResolver?: MarketplaceResourceResolver
  log?: MarketplaceInstallLog
}

/**
 * Verify reads what an install would put on this machine — without installing
 * it — and answers with everything a trust prompt must disclose and the pin
 * that binds an install to exactly that. It takes an entry main resolved
 * itself; it does not issue the trust token (the caller does, knowing where
 * the entry came from), and the result it returns carries none.
 */
export function createMarketplacePluginVerifier(services: MarketplacePluginVerifierServices) {
  return {
    verify: (entry: MarketplacePluginEntry): Promise<MarketplacePluginVerifyResult> =>
      verifyMarketplacePlugin(entry, services),
  }
}

async function verifyMarketplacePlugin(
  entry: MarketplacePluginEntry,
  services: MarketplacePluginVerifierServices,
): Promise<MarketplacePluginVerifyResult> {
  const registryEntry = validateRegistryEntry(entry)
  if (!registryEntry.ok) {
    return {
      classification: 'invalid',
      permissions: [],
      sourceUrl: sourceUrlFromEntry(entry),
      issues: registryEntry.issues,
      message: registryEntry.message,
    }
  }

  // Claude Code plugins are the one kind of row the marketplace installs.
  if (!isClaudeCodePluginEntry(registryEntry.entry)) {
    const message = `${registryEntry.entry.name} is not a Claude Code plugin, so there is nothing to install.`
    return {
      classification: 'invalid',
      permissions: [],
      sourceUrl: sourceUrlFromEntry(entry),
      issues: [{ path: 'entry', message }],
      message,
    }
  }

  // Claude Code plugins are unsigned by nature (no studio manifest to
  // verify); the pre-trust staging exists to disclose the REAL skill file
  // listing at the trust prompt — never a fabricated one. Content resolves
  // from the bundled catalogue payload and is digest-checked, so this is
  // local file reads: near-instant, zero network.
  services.log?.('claude-plugin:verify-start', { entryId: registryEntry.entry.id })
  const claude = await downloadClaudeCodePluginSource({
    entry: registryEntry.entry,
    stagingRoot: services.stagingRoot ?? defaultMarketplacePluginStagingRoot(),
    packagedResourceResolver: services.packagedResourceResolver,
    log: services.log,
  })
  if (!claude.ok) {
    services.log?.('claude-plugin:verify-failed', { entryId: registryEntry.entry.id, message: claude.message })
    return {
      classification: 'invalid',
      permissions: [],
      sourceUrl: claude.sourceUrl,
      issues: [{ path: 'source', message: claude.message }],
      message: claude.message,
    }
  }
  try {
    services.log?.('claude-plugin:verify-ok', { entryId: registryEntry.entry.id, files: claude.skillDirs.length })
    return {
      classification: 'unsigned',
      permissions: [],
      sourceUrl: claude.sourceUrl,
      files: claude.skillDirs.map((dir) => `skills/${dir}`),
      // The bundled-content identity this listing came from; the install
      // re-checks exactly this pin so a catalogue/app update cannot swap
      // content between the trust grant and the install.
      pin: claude.pin,
    }
  } finally {
    await rm(claude.stagedPath, { recursive: true, force: true })
  }
}

function validateRegistryEntry(
  entry: MarketplacePluginEntry,
): { ok: true; entry: MarketplacePluginEntry } | { ok: false; message: string; issues: MarketplaceManifestIssue[] } {
  const result = validateMarketplaceIndex({ schemaVersion: 1, plugins: [entry] })
  if (!result.ok) {
    return {
      ok: false,
      message: 'Marketplace plugin registry entry is invalid.',
      issues: result.issues,
    }
  }
  const validated = result.marketplace.plugins[0]
  if (!validated) {
    return {
      ok: false,
      message: 'Marketplace plugin registry entry is invalid.',
      issues: [{ path: 'entry', message: 'entry is required.' }],
    }
  }
  return { ok: true, entry: validated }
}

function sourceUrlFromEntry(entry: MarketplacePluginEntry): string {
  return typeof entry?.source === 'string' ? entry.source.trim() : ''
}
