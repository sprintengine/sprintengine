import { app, shell } from 'electron'

import type { StudioCardMarketplace } from '../../server/core/studio-agent-skills'
import { createMarketplacePluginPipeline } from '../ipc/marketplace-plugin-ipc'
import { createDefaultMarketplaceRegistryClient } from '../ipc/marketplace-registry-ipc'
import {
  defaultMarketplacePluginInstallStorePath,
  readMarketplacePluginInstallReceipts,
} from '../marketplace/plugin-lifecycle'
import type { McpConfigService } from '../mcp-config-service'

// What a card's Go needs of the desktop's shell, which the Studio server cannot
// do itself: a module's install through the marketplace and the module trust
// store the shell keeps (`install.module` goes through the same lifecycle the
// storefront does: same trust gate, same receipts, same rollback), and moving
// a removed skill to the Trash. In process the core is handed these; out of
// process the server asks for them over the control channel.

export function createShellCardMarketplace(mcpConfigService: McpConfigService): StudioCardMarketplace {
  // Built when first needed: a card that installs no module pays for neither.
  let registry: ReturnType<typeof createDefaultMarketplaceRegistryClient> | undefined
  let pipeline: ReturnType<typeof createMarketplacePluginPipeline> | undefined
  return {
    readMarketplaceRegistry: () => (registry ??= createDefaultMarketplaceRegistryClient()).read(),
    listMarketplaceReceipts: () =>
      readMarketplacePluginInstallReceipts(defaultMarketplacePluginInstallStorePath(app.getPath('userData'))),
    installMarketplaceEntry: (input) =>
      (pipeline ??= createMarketplacePluginPipeline({ mcpConfigService })).lifecycle.install(input),
  }
}

/** This computer's Trash, which only the shell (Electron's `shell`) can reach. */
export function shellTrash(path: string): Promise<void> {
  return shell.trashItem(path)
}
