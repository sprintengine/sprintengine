import { readTrustedMarketplacePublisherFingerprintsSync } from '../marketplace/trusted-publishers'
import type { ModuleTrustContext } from './module-signature'
import { readTrustedModulesSync } from './trust-store'

// Everything an extension's trust is decided against, read fresh from this
// machine: the person's grants and the trusted publisher keys. One reader, so
// no caller can classify an extension against part of it.
export function readModuleTrustContextSync(userDataDir: string): ModuleTrustContext {
  return {
    trustedModules: readTrustedModulesSync(userDataDir),
    trustedKeyFingerprints: readTrustedMarketplacePublisherFingerprintsSync(),
  }
}
