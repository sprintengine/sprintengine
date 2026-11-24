import { readTrustedMarketplacePublisherFingerprintsSync } from '../marketplace/trusted-publishers'
import { readExtensionApprovalsSync } from './extension-approvals'
import { readDevFoldersSync } from './extension-dev-folders'
import type { ExtensionStandingContext } from './module-signature'
import {
  OFFICIAL_CATALOGUE,
  readInstallRecordsSync,
  readKillListCacheSync,
} from '../../server/extensions/catalogue/catalogue-files'

// Everything an installed extension's standing is decided against, read fresh
// from this machine: the person's approvals, the trusted publisher keys, and
// the development folders registered here, the kill list, and where each was
// installed from (an install nobody watched asks the person).
// One reader, so no caller can classify an extension against part of it.
export function readExtensionStandingContextSync(dataDir: string): ExtensionStandingContext {
  const installs = readInstallRecordsSync(dataDir)
  return {
    approvals: readExtensionApprovalsSync(dataDir),
    trustedKeyFingerprints: readTrustedMarketplacePublisherFingerprintsSync(),
    devFolders: readDevFoldersSync(dataDir),
    dataDir,
    killList: readKillListCacheSync(dataDir),
    askPerson: new Set(Object.keys(installs).filter((key) => installs[key]!.askPerson === true)),
    installedFrom: new Map(
      Object.entries(installs).map(([key, record]) => [
        key,
        record.origin.kind === 'catalogue' && record.origin.catalogue === OFFICIAL_CATALOGUE ? 'official' : 'other',
      ]),
    ),
  }
}
