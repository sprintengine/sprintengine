import { readTrustedMarketplacePublisherFingerprintsSync } from '../marketplace/trusted-publishers'
import { readExtensionApprovalsSync } from './extension-approvals'
import type { ExtensionStandingContext } from './module-signature'

// Everything an installed extension's standing is decided against, read fresh
// from this machine: the person's approvals and the trusted publisher keys.
// One reader, so no caller can classify an extension against part of it.
export function readExtensionStandingContextSync(dataDir: string): ExtensionStandingContext {
  return {
    approvals: readExtensionApprovalsSync(dataDir),
    trustedKeyFingerprints: readTrustedMarketplacePublisherFingerprintsSync(),
  }
}
