import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'vitest'

import type {
  HostedCardFeed,
  HostedCardFeedReadResult,
  HostedSourcesFeedReadResult,
} from '../../../packages/studio-protocol/src/public'
import type { HostedFeedReadInput } from '../../shared/ipc/hosted-feeds'
import { createHostedFeeds, type HostedFeedClients } from './hosted-feeds'

// The hosted feeds as a Studio holds them: a client's read never touches the
// network, a refresh does, and only a read that changed the cards is told to
// the followers.

const FEED: HostedCardFeed = { schemaVersion: 1, updatedAt: '2026-09-06T00:00:00.000Z', cards: [] }

function ok(changed: boolean): HostedCardFeedReadResult {
  return {
    ok: true,
    state: 'ok',
    feedUrl: 'https://example.invalid/cards-feed.json',
    source: 'cache',
    fetchedAt: '2026-09-06T00:00:00.000Z',
    changed,
    feed: FEED,
  }
}

const SOURCES: HostedSourcesFeedReadResult = {
  ok: true,
  state: 'ok',
  feedUrl: 'https://example.invalid/sources.json',
  source: 'seed',
  fetchedAt: '2026-09-06T00:00:00.000Z',
  changed: false,
  feed: { schemaVersion: 1, updatedAt: '2026-09-06T00:00:00.000Z', sources: [] },
}

/** Clients that count a read without `cachedOnly` as a fetch, which is the distinction a client's read makes. */
function fakeClients(cards: (input: HostedFeedReadInput) => HostedCardFeedReadResult) {
  const reads = { cards: [] as HostedFeedReadInput[], sources: [] as HostedFeedReadInput[] }
  const clients: HostedFeedClients = {
    cards: {
      read: async (input = {}) => {
        reads.cards.push(input)
        return cards(input)
      },
    },
    sources: {
      read: async (input = {}) => {
        reads.sources.push(input)
        return SOURCES
      },
    },
  }
  return { clients, reads }
}

test('a client reads what is on disk and never fetches', async () => {
  const { clients, reads } = fakeClients(() => ok(false))
  const feeds = createHostedFeeds(() => clients)
  assert.equal((await feeds.cardFeed()).ok, true)
  assert.equal((await feeds.sourcesFeed()).ok, true)
  assert.deepEqual(reads.cards, [{ cachedOnly: true }])
  assert.deepEqual(reads.sources, [{ cachedOnly: true }])
})

test('a refresh fetches both feeds, and tries the second when the first fails', async () => {
  const { clients, reads } = fakeClients(() => {
    throw new Error('offline')
  })
  const feeds = createHostedFeeds(() => clients)
  await assert.rejects(feeds.refresh(), /offline/)
  assert.deepEqual(reads.cards, [{}])
  assert.deepEqual(reads.sources, [{}], 'the sources were still read')
})

test('only a read that changed the cards is told to the followers', async () => {
  let next = ok(true)
  const { clients } = fakeClients(() => next)
  const feeds = createHostedFeeds(() => clients)
  const heard: HostedCardFeedReadResult[] = []
  const stop = feeds.onCardFeedChanged((result) => heard.push(result))
  await feeds.refresh()
  assert.equal(heard.length, 1, 'a changed feed is told once')
  next = ok(false)
  await feeds.refresh()
  await feeds.cardFeed()
  assert.equal(heard.length, 1, 'the same copy served back is not news')
  next = { ok: false, state: 'offline', feedUrl: 'https://example.invalid/cards-feed.json', message: 'offline' }
  await feeds.refresh()
  assert.equal(heard.length, 1, 'a failed read pushes nothing')
  stop()
  next = ok(true)
  await feeds.refresh()
  assert.equal(heard.length, 1, 'an unsubscribed follower hears nothing')
})

test('the desktop’s hourly poller is what refreshes the feeds', async () => {
  // `app-lifecycle` cannot be imported into a node test (it is the whole main
  // process), so the line that makes a hosted feed hosted at all is pinned by
  // reading it: without it a shipped machine serves the bundled seed forever.
  const lifecycle = await readFile(join(process.cwd(), 'src', 'main', 'app-lifecycle.ts'), 'utf8')
  const code = lifecycle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(
    /refreshFeed:[\s\S]{0,600}?refreshHostedFeeds\s*\(/.test(code),
    'the poller’s feed leg refreshes the hosted feeds',
  )
})
