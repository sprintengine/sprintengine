// The marketplace's installs, as the Studio protocol defines them
// (`extensions-types.ts`), under the names the app has always used.
// ../electron-api.ts re-exports everything here.

import type { McpClientTarget } from './agent-runtime'
import type { McpSettings } from './mcp'
import type { SkillHarness } from '../skills'

export type {
  GithubExtensionInstalledState,
  GithubExtensionInstallInput,
  GithubExtensionOrigin,
  GithubExtensionPreview,
  GithubExtensionResolveInput,
  GithubExtensionResolveResult,
  GithubExtensionReviewChange,
  MarketplaceInstallSource,
  MarketplaceMcpServerDisclosure,
  MarketplacePluginInstalledComponent,
  MarketplacePluginInstallResult,
  MarketplacePluginRegistryInstallInput,
  MarketplacePluginRegistryInstallResult,
  MarketplacePluginTrustClassification,
  MarketplacePluginUninstallInput,
  MarketplacePluginUninstallResult,
  MarketplacePluginVerifyInput,
  MarketplacePluginVerifyResult,
  MarketplaceRegistryState,
  MarketplaceTrustPin,
} from '../../../packages/studio-protocol/src/public'

/** A bundle install from a folder on this machine, as the plugin lifecycle runs it. */
export type MarketplacePluginInstallInput = {
  localFolder: string
  workspaceRoot?: string
  mcpSettings?: McpSettings
  mcpClients?: McpClientTarget[]
  skillHarnesses?: SkillHarness[]
}
