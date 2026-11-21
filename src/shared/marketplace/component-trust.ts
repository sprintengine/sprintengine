// How the two gates that decide whether a marketplace bundle may proceed read
// its plugin.json: the download/stage path (src/main/marketplace/plugin-download.ts)
// and the installer preflight (src/main/modules/plugin-bundle-installer.ts).
// The rule lives here once so the two cannot drift.

import {
  parseMarketplacePluginAuthoringManifest,
  parseMarketplacePluginManifest,
  type MarketplaceManifestIssue,
  type MarketplacePluginAuthoringManifest,
} from './manifest'

export type OptionallySignedManifestResult =
  { ok: true; manifest: MarketplacePluginAuthoringManifest } | { ok: false; issues: MarketplaceManifestIssue[] }

// Resolve a plugin.json under the optionally-signed contract: a signed manifest
// is validated strictly; a manifest whose only defect is a missing signature is
// accepted as unsigned, which installs only on the person's approval;
// anything else (a present-but-malformed signature, structural errors) is
// rejected. Trust classification is layered on top by the download path, not
// decided here.
export function resolveOptionallySignedManifest(source: string): OptionallySignedManifestResult {
  const signed = parseMarketplacePluginManifest(source)
  if (signed.ok) return { ok: true, manifest: signed.manifest }
  const authoring = parseMarketplacePluginAuthoringManifest(source)
  if (authoring.ok && authoring.manifest.signature === undefined) {
    return { ok: true, manifest: authoring.manifest }
  }
  return { ok: false, issues: signed.issues }
}
