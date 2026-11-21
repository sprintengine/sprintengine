// Per-installed-entry update detection: compares what is installed
// (the install receipts) against the registry's
// `latest`, through the pure shared detector. Honest failure is part of the
// contract — a registry that cannot be read yields `unknown` on every entry,
// never "up to date".

import type {
  MarketplaceRegistryReadInput,
  MarketplaceRegistryReadResult,
  MarketplaceUpdateStatesResult,
} from '../../shared/electron-api'
import { marketplaceUpdateAvailability, type MarketplaceUpdateStateEntry } from '../../shared/marketplace'
import { readMarketplacePluginInstallReceipts } from './plugin-lifecycle'

export type MarketplaceUpdateStatesServices = {
  registryReader: { read(input?: MarketplaceRegistryReadInput): Promise<MarketplaceRegistryReadResult> }
  receiptStorePath: string
}

type InstalledEntry = { id: string; displayName: string; installedVersion: number }

export async function readMarketplaceUpdateStates(
  services: MarketplaceUpdateStatesServices,
  input: MarketplaceRegistryReadInput = {},
): Promise<MarketplaceUpdateStatesResult> {
  const receiptsRead = await readMarketplacePluginInstallReceipts(services.receiptStorePath)
  if (!receiptsRead.ok) return { ok: false, message: receiptsRead.message }

  // Receipts are the authoritative installed set for marketplace installs;
  // their version is pinned to the registry `latest` that was installed.
  const installed: InstalledEntry[] = []
  for (const receipt of receiptsRead.receipts) {
    // An extension installed from a GitHub URL updates from its repository
    // (a new `marketplace.resolveGithub` review), not the registry: a registry entry
    // that happens to share its id says nothing about it.
    if (receipt.source?.kind !== 'github') {
      installed.push({ id: receipt.id, displayName: receipt.displayName, installedVersion: receipt.version })
    }
  }

  const registry = await services.registryReader.read(input)
  if (!registry.ok) {
    // Couldn't check: every installed entry reads unknown, asserted distinct
    // from `current` by the shared availability type.
    return {
      ok: true,
      checked: false,
      registryState: registry.state,
      ...(registry.message ? { registryMessage: registry.message } : {}),
      entries: installed.map((entry): MarketplaceUpdateStateEntry => ({
        id: entry.id,
        displayName: entry.displayName,
        availability: { state: 'unknown', installedVersion: entry.installedVersion, reason: 'registry-unreachable' },
      })),
    }
  }

  const latestById = new Map(registry.marketplace.plugins.map((plugin) => [plugin.id, plugin.latest]))
  const registryMessage = registry.state === 'offline' ? registry.message : undefined
  return {
    ok: true,
    checked: true,
    registryState: registry.state,
    registrySource: registry.source,
    stale: registry.stale,
    fetchedAt: registry.fetchedAt,
    ...(registryMessage ? { registryMessage } : {}),
    entries: installed.map((entry): MarketplaceUpdateStateEntry => ({
      id: entry.id,
      displayName: entry.displayName,
      availability: marketplaceUpdateAvailability(entry.installedVersion, latestById.get(entry.id)),
    })),
  }
}
