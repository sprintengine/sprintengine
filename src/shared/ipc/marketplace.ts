// The marketplace's installs, as the Studio protocol defines them
// (`extensions-types.ts`), under the names the app has always used.
// ../electron-api.ts re-exports everything here.

export type {
  MarketplaceInstallEnvelope,
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
