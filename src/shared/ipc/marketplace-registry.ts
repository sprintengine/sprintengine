// Reading the marketplace registry and its update states, as the Studio
// protocol defines them (`extensions-types.ts`), under the names the app has
// always used. ../electron-api.ts re-exports everything here.

export type {
  MarketplaceRegistryReadInput,
  MarketplaceRegistryReadResult,
  MarketplaceUpdateStatesResult,
} from '../../../packages/studio-protocol/src/public'
