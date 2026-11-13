import { existsSync } from 'node:fs'

import type {
  HostedCardFeedReadResult,
  HostedSourcesFeedReadResult,
} from '../../../packages/studio-protocol/src/public'
import type { HostedFeedReadInput } from '../../shared/ipc/hosted-feeds'
import type { StudioPaths } from '../../server/platform/studio-paths'
import {
  HostedCardFeedClient,
  cardFeedSeedCandidates,
  configuredCardFeedUrl,
  defaultCardFeedCachePath,
} from './card-feed-client'
import {
  HostedSourcesFeedClient,
  configuredSourcesFeedUrl,
  defaultSourcesFeedCachePath,
  sourcesFeedSeedCandidates,
} from './sources-feed-client'

// The hosted feeds a Studio holds: the Extensions home's cards and the
// recommended skill sources, each one client per Studio, so a scheduled
// refresh and a client's read share the client's in-flight guard, cache and
// retry gap. A client reads only what is on disk (`cardFeed.get`,
// `sourcesFeed.get`): the door draws before anyone could wait out a fetch.
// What fetches is `refresh`, which the desktop's hourly poller calls; a card
// feed read that wrote a different copy is told to every follower
// (`cardFeed.changed`), and one that served the same copy back is not news.

export type HostedFeedClients = {
  cards: Pick<HostedCardFeedClient, 'read'>
  sources: Pick<HostedSourcesFeedClient, 'read'>
}

export type HostedFeeds = {
  /** The cards as this machine holds them (cache, else seed); never fetches. */
  cardFeed(): Promise<HostedCardFeedReadResult>
  /** The recommended sources as this machine holds them; never fetches. */
  sourcesFeed(): Promise<HostedSourcesFeedReadResult>
  /** Fetch both when due; the first failure is rethrown once both were tried. */
  refresh(): Promise<void>
  /** Each card feed read that changed what this machine holds. */
  onCardFeedChanged(listener: (result: HostedCardFeedReadResult) => void): () => void
}

function seed(candidates: string[]): string | null {
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/** The clients over a Studio's paths: its data folder for the caches, its resources for the seeds. */
export function hostedFeedClients(paths: StudioPaths): HostedFeedClients {
  const where = {
    isPackaged: paths.isPackaged(),
    ...(paths.resourcesDir() ? { resourcesPath: paths.resourcesDir() as string } : {}),
    appPath: paths.appRoot(),
    cwd: process.cwd(),
  }
  return {
    cards: new HostedCardFeedClient({
      feedUrl: configuredCardFeedUrl(),
      cachePath: defaultCardFeedCachePath(paths.dataDir()),
      packagedSeedPath: seed(cardFeedSeedCandidates(where)),
    }),
    sources: new HostedSourcesFeedClient({
      feedUrl: configuredSourcesFeedUrl(),
      cachePath: defaultSourcesFeedCachePath(paths.dataDir()),
      packagedSeedPath: seed(sourcesFeedSeedCandidates(where)),
    }),
  }
}

export function createHostedFeeds(clients: () => HostedFeedClients): HostedFeeds {
  let built: HostedFeedClients | undefined
  const feeds = () => (built ??= clients())
  const listeners = new Set<(result: HostedCardFeedReadResult) => void>()

  async function readCards(input: HostedFeedReadInput): Promise<HostedCardFeedReadResult> {
    const result = await feeds().cards.read(input)
    if (result.ok && result.changed) for (const listener of [...listeners]) listener(result)
    return result
  }

  return {
    cardFeed: () => readCards({ cachedOnly: true }),
    sourcesFeed: () => feeds().sources.read({ cachedOnly: true }),
    async refresh() {
      const failures: unknown[] = []
      await readCards({}).catch((error: unknown) => void failures.push(error))
      await feeds()
        .sources.read({})
        .catch((error: unknown) => void failures.push(error))
      if (failures.length > 0) throw failures[0]
    },
    onCardFeedChanged(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** A failed read, in the shape a feed answers. */
export function cardFeedFailure(error: unknown): HostedCardFeedReadResult {
  return {
    ok: false,
    state: 'fetch-error',
    feedUrl: configuredCardFeedUrl(),
    message: error instanceof Error ? error.message : String(error),
  }
}

export function sourcesFeedFailure(error: unknown): HostedSourcesFeedReadResult {
  return {
    ok: false,
    state: 'fetch-error',
    feedUrl: configuredSourcesFeedUrl(),
    message: error instanceof Error ? error.message : String(error),
  }
}
