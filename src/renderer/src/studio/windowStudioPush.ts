import type {
  StudioCapability,
  StudioPushTopic,
  StudioTopicParams,
  StudioTopicPayload,
} from '../../../../packages/studio-protocol/src/public'
import type { StudioClient } from '../../../../packages/client-runtime/src/public'
import type { ElectronApi } from '../../../shared/electron-api'
import { watchWindowStudio, windowStudioClient, windowStudioState } from './windowStudioClient'

type TicketApi = Pick<ElectronApi, 'studioWindowTicket'>

export type WindowStudioPushInput<T extends StudioPushTopic> = {
  topic: T
  params: StudioTopicParams<T>
  /** The capability the topic is served under: a Studio that does not advertise it is not asked. */
  capability: StudioCapability
  onPayload: (payload: StudioTopicPayload<T>) => void
  /**
   * Called each time the window's connection opens again after it was not
   * open. A push feed carries changes, not what is: whatever changed while
   * the window was away (its Studio restarted, and every push of the old run
   * went with it) is not pushed again. For a caller whose pushes carry
   * nothing (it reads on each), or that orders its own read against its
   * pushes; one that holds state from the feed gives `reread` instead. The
   * one place a window learns it should read again on reconnect.
   */
  onReopen?: () => void
  /**
   * The topic's state, read afresh each time the window's connection opens
   * again (made with `rereadOnReopen`), for a caller that holds state from the
   * feed. The read is sent once the topic is followed again, so no change
   * falls between the two. Pushes that arrive while it is out are held and
   * handed on after its answer, in the order they came: the answer may have
   * been taken before any of them. An answer the connection's next reopen has
   * overtaken is dropped, and the newer read's answer goes first instead.
   */
  reread?: StateReread
  /** The window's api; `window.api` unless given (tests). */
  api?: TicketApi
}

/**
 * Follow one push topic on the window's Studio for as long as the caller
 * wants it. The client resubscribes by itself across a reconnect; a stream
 * that ended (the client parked on a refused credential, say) and a client
 * that closed for good and was replaced are followed again once the window's
 * connection opens, and `onReopen` is called then. A window with no Studio,
 * or a Studio that does not serve the capability, hears nothing. Returns the
 * unsubscriber.
 */
export function followWindowStudioPush<T extends StudioPushTopic>(input: WindowStudioPushInput<T>): () => void {
  const api = input.api ?? (typeof window === 'undefined' ? undefined : window.api)
  if (typeof api?.studioWindowTicket !== 'function') return () => undefined
  let alive = true
  let subscribed: StudioClient | null = null
  let stop: (() => void) | null = null
  // Each reopen is a generation: only the newest one's read is answered.
  let generation = 0
  // Pushes held while a reread is out; null when none is.
  let held: Array<StudioTopicPayload<T>> | null = null
  const deliver = (payload: StudioTopicPayload<T>) => {
    if (!alive) return
    if (held) held.push(payload)
    else input.onPayload(payload)
  }
  const follow = (): Promise<void> =>
    windowStudioClient(api)
      .then((client) => {
        if (!alive || client === subscribed || !client.supports(input.capability)) return
        stop?.()
        subscribed = client
        stop = client.subscribe(input.topic, input.params, {
          // A client this follow has let go of is not heard.
          onPayload: (payload) => {
            if (subscribed === client) deliver(payload)
          },
          // Ended for good on this client (a refused credential parks it and
          // ends its streams; a refusal ends one): the next time the window's
          // connection opens, the topic is followed again, on this client too.
          onEnd: () => {
            if (subscribed !== client) return
            subscribed = null
            stop = null
          },
        })
      })
      .catch(() => {
        // No Studio for this window yet: followed when it opens.
      })
  const reread = (feed: StateReread) => {
    const mine = ++generation
    held ??= []
    // Read once the topic is followed again, so a change made after the read
    // was taken is pushed rather than missed.
    void follow()
      .then(() => feed.load())
      .then(
        (apply) => settle(mine, apply),
        () => settle(mine, null),
      )
  }
  const settle = (mine: number, apply: (() => void) | null) => {
    if (!alive || mine !== generation) return
    const pending = held ?? []
    held = null
    apply?.()
    for (const payload of pending) input.onPayload(payload)
  }
  void follow()
  let wasOpen = windowStudioState(api) === 'open'
  const unwatch = watchWindowStudio(api, () => {
    const open = windowStudioState(api) === 'open'
    const reopened = open && !wasOpen && alive
    wasOpen = open
    if (reopened && input.reread) reread(input.reread)
    else if (open) void follow()
    if (reopened) input.onReopen?.()
  })
  return () => {
    alive = false
    held = null
    stop?.()
    unwatch()
  }
}

/** A topic's state read afresh on a reopen: what `rereadOnReopen` makes. */
export type StateReread = {
  /** Reads the state; resolves to what hands it on, called only if no newer read overtook it. */
  load: () => Promise<() => void>
}

/**
 * A `reread` that reads a topic's state afresh and hands it on as a push
 * would be; a read that fails is passed over (the next push or reopen tries).
 */
export function rereadOnReopen<S>(read: () => Promise<S>, deliver: (state: S) => void): StateReread {
  return {
    load: async () => {
      const state = await read()
      return () => deliver(state)
    },
  }
}
