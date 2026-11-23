import { readExtensionStandingContextSync } from '../../main/modules/extension-standing-context'
import type { ExtensionStandingContext } from '../../main/modules/module-signature'
import {
  discoverInstalledModulesSync,
  readDevelopmentFolder,
  withDevelopmentFolders,
  type DevelopmentFolderEntry,
  type UserModuleListResult,
} from '../../main/modules/user-module-registry'

// What a running Studio's extensions are on disk, discovered once per change
// and shared by everything that follows it: the workers' reconcile, the live
// reload and what extensions hand agents. Reading every extension digests
// every file it has, so a save in a development folder reads only that folder
// again; the installed extensions are read again only when the extensions
// folder changes, or an install, approval, uninstall or registration does
// (`invalidate`).

export type ExtensionDiscovery = {
  /** Every extension as it stands: the installed ones, then the development folders. */
  current(): UserModuleListResult
  /** A save in this development folder: read it alone again. */
  folderChanged(folder: string): void
  /** Something else changed (the extensions folder, an approval, a registration): read everything again. */
  invalidate(): void
}

export function createExtensionDiscovery(deps: { moduleRoot: () => string; dataDir: string }): ExtensionDiscovery {
  let context: ExtensionStandingContext | null = null
  let installed: UserModuleListResult | null = null
  const folders = new Map<string, DevelopmentFolderEntry>()
  let combined: UserModuleListResult | null = null

  return {
    current() {
      if (combined) return combined
      context ??= readExtensionStandingContextSync(deps.dataDir)
      const ctx = context
      installed ??= discoverInstalledModulesSync(deps.moduleRoot(), ctx)
      const read = (folder: string) => {
        const cached = folders.get(folder)
        if (cached) return cached
        const entry = readDevelopmentFolder(folder, deps.moduleRoot(), ctx)
        folders.set(folder, entry)
        return entry
      }
      combined = withDevelopmentFolders(installed, ctx, read)
      return combined
    },
    folderChanged(folder) {
      folders.delete(folder)
      combined = null
    },
    invalidate() {
      context = null
      installed = null
      folders.clear()
      combined = null
    },
  }
}
