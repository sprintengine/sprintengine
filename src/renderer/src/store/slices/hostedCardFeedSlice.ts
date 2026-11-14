import type { HostedCardFeedReadResult } from '../../../../shared/electron-api'
import type { HostedCard } from '../../../../shared/hosted-card-feed'
import { extensionsApi, type ExtensionsApi, windowHasStudio } from '../../studio/extensions'

// The hosted card feed as the renderer sees it, its own slice and not a
// generalisation over the hosted feeds — they have different schemas and are
// free to drift, and a shared slice would make one feed's change another
// feed's problem. Not persisted: the main process owns the cache on disk and
// serves it at boot, so a stale renderer copy cannot outlive the file.
//
// `cards` is the last GOOD feed and never anything else. A read that failed
// records why in `cardFeedError` and leaves the rows alone, because the
// Extensions home does not apologise for its own network (epic ruling R6) and
// blanking a page of cards because GitHub was slow is exactly that apology.
export interface HostedCardFeedSliceState {
  cards: HostedCard[]
  // `'error'` does not mean "nothing to draw". It means the last READ failed,
  // and `cards` still holds the last good feed — so a consumer writing
  // `status === 'error' ? <Empty/> : <Cards/>` blanks a full page the first
  // time the machine is offline, which is the apology R6 forbids. Draw the
  // cards; `cards.length` is what says whether there is a page.
  cardFeedStatus: 'idle' | 'loading' | 'ready' | 'error'
  // Why the last read failed, kept for diagnostics. The home page reads the
  // cards, not this.
  cardFeedError: string | null
}

interface HostedCardFeedSliceActions {
  // First paint: what is on disk, no network. Never throws; a missing api is a
  // no-op, which is what a test renderer and a detached tool window are.
  loadCards: () => Promise<void>
  // The push handler. Also what tests drive directly.
  applyHostedCardFeedResult: (result: HostedCardFeedReadResult) => void
}

// **There is deliberately no `refreshCards` here** (decided 2026-09-06,
// backlog/2026-09-06-the-seams-that-lead-nowhere.md §1). This slice carried one
// — `refreshCards({ force })`, modelled on a Settings "Check now" action — and
// unlike that action it had no caller anywhere in the app. The card feed has
// no such button, so what shipped was a
// store action that LOOKED like the way to refresh the home page and was wired
// to nothing, which is worse than its absence: the next reader adds a second
// fetch path beside it rather than asking why the first one never ran.
//
// The read/fetch split above is the design, not an accident of wiring. The only
// thing that fetches this feed is the hourly poller leg in app-lifecycle.ts,
// which has the Studio refresh its hosted feeds and tells every follower what
// changed (`cardFeed.changed`); the window reads at first paint
// (`cardFeed.get`) and applies the push. A manual refresh, if the browse
// question ever lands it a button, is a protocol method and an action here.

export type HostedCardFeedSlice = HostedCardFeedSliceState & HostedCardFeedSliceActions

type HostedCardFeedSliceSet = (mutator: (state: HostedCardFeedSliceState) => void) => void

type HostedCardFeedApi = Pick<ExtensionsApi, 'hostedCardFeedGet'>

function getHostedCardFeedApi(): HostedCardFeedApi | null {
  return windowHasStudio() ? extensionsApi : null
}

export function createHostedCardFeedSlice(
  set: HostedCardFeedSliceSet,
  deps: { getApi?: () => HostedCardFeedApi | null } = {},
): HostedCardFeedSlice {
  const getApi = deps.getApi ?? getHostedCardFeedApi

  const apply = (result: HostedCardFeedReadResult): void => {
    set((state) => {
      if (result.ok) {
        state.cards = result.feed.cards
        state.cardFeedStatus = 'ready'
        state.cardFeedError = null
        return
      }
      // A failed read keeps whatever cards were showing: the feed going away
      // must never empty the page.
      state.cardFeedStatus = 'error'
      state.cardFeedError = result.message
    })
  }

  const begin = (): void => {
    set((state) => {
      // Only a page with nothing to draw is loading. A re-read behind cards
      // that are already on screen is not a spinner.
      if (state.cards.length === 0) state.cardFeedStatus = 'loading'
    })
  }

  return {
    cards: [],
    cardFeedStatus: 'idle',
    cardFeedError: null,
    applyHostedCardFeedResult: apply,
    loadCards: async () => {
      const api = getApi()
      if (!api) return
      begin()
      try {
        apply(await api.hostedCardFeedGet())
      } catch (error) {
        apply(failure(error))
      }
    },
  }
}

function failure(error: unknown): HostedCardFeedReadResult {
  return {
    ok: false,
    state: 'fetch-error',
    feedUrl: '',
    message: error instanceof Error ? error.message : String(error),
  }
}

// Wire the Studio's `cardFeed.changed` into the store. Returns the unsubscribe.
export function subscribeHostedCardFeedChanges(
  apply: (result: HostedCardFeedReadResult) => void,
  api: Pick<ExtensionsApi, 'onHostedCardFeedChanged'> | null = windowHasStudio() ? extensionsApi : null,
): () => void {
  if (!api) return () => {}
  return api.onHostedCardFeedChanged(apply)
}
