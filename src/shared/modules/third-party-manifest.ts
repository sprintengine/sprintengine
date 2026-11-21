// An installed extension's manifest: extension.json, as the app reads it.
//
// The validator lives in the published SDK
// (packages/extension-sdk/src/extension-manifest.ts) so the app and the
// `sprintengine-extension` CLI read a manifest the same way; this module
// re-exports it for app code, and derives the `CapabilityManifest` the module
// kernel, the enablement resolver and Settings list every module by.

import type { ExtensionManifest } from '../../../packages/extension-sdk/src/extension-manifest'
import type { CapabilityManifest } from './manifest'

export {
  EXTENSION_MANIFEST_FILENAME,
  EXTENSION_SIGNATURE_FILENAME,
  EXTENSION_SURFACE_POINTS,
  LOCAL_EXTENSION_PUBLISHER,
  extensionInstallKey,
  isExtensionInstallKey,
  isReservedExtensionId,
  parseExtensionInstallKey,
  parseExtensionManifest,
  studioReadsManifest,
  type ExtensionCommandContribution,
  type ExtensionIcon,
  type ExtensionManifest,
  type ExtensionMenuContribution,
  type ExtensionSurfaceContribution,
  type ExtensionSurfacePoint,
  type ExtensionTopBarItemContribution,
} from '../../../packages/extension-sdk/src/extension-manifest'

/**
 * An installed extension as the module kernel lists it: its install key as the
 * id, its name and version, the permissions it asks for. Installing it is the
 * person's choice, so it is on unless they switch it off; its code still runs
 * only once it is trusted.
 */
export function capabilityManifestOf(key: string, publisher: string, extension: ExtensionManifest): CapabilityManifest {
  return {
    id: key,
    displayName: extension.name,
    version: extension.version,
    publisher,
    ...(extension.description ? { summary: extension.description } : {}),
    defaultEnabled: true,
    source: 'third-party',
    permissions: [...extension.permissions],
  }
}
