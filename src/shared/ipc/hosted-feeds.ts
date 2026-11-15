// The hosted sources and card feeds, as the Studio protocol defines what a
// read of each answers (`extensions-types.ts`), under the names the app has
// always used. ../electron-api.ts re-exports everything here.

export type {
  HostedCardFeedReadResult,
  HostedSourcesFeedReadResult,
} from '../../../packages/studio-protocol/src/public'

/** How a feed is read: from the network when due (or `forceRefresh`), or only what is on disk (`cachedOnly`). */
export type HostedFeedReadInput = {
  forceRefresh?: boolean
  cachedOnly?: boolean
}
export type HostedCardFeedReadInput = HostedFeedReadInput
export type HostedSourcesFeedReadInput = HostedFeedReadInput
