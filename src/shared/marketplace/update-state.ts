import type { MarketplaceUpdateAvailability, ModuleUpdateState } from '../../../packages/studio-protocol/src/public'

export type {
  MarketplaceUpdateAvailability,
  MarketplaceUpdateStateEntry,
  ModuleUpdateState,
} from '../../../packages/studio-protocol/src/public'

// Update detection for installed marketplace content.
//
// Node-free and pure so both processes can use it. Versions are plain
// integers (CapabilityManifest.version / MarketplacePluginEntry.latest) —
// never semver, no ranges. `ahead-of-registry` is a real state (a locally
// installed dev build) and must never render as an update or an error.
// Detection is NOT gated on module enablement: an installed-but-disabled
// module still needs an accurate update state.

export function moduleUpdateState(installedVersion: number, registryLatest: number): ModuleUpdateState {
  if (installedVersion < registryLatest) return 'update-available'
  if (installedVersion > registryLatest) return 'ahead-of-registry'
  return 'current'
}

// Why a check can not answer: the registry read failed outright, or it
// succeeded but carries no entry for this id (delisted, or a purely local
// install). Neither may ever read as "up to date".
export function marketplaceUpdateAvailability(
  installedVersion: number,
  registryLatest: number | undefined,
): MarketplaceUpdateAvailability {
  if (registryLatest === undefined) {
    return { state: 'unknown', installedVersion, reason: 'not-in-registry' }
  }
  return {
    state: moduleUpdateState(installedVersion, registryLatest),
    installedVersion,
    latestVersion: registryLatest,
  }
}
