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
   * open, once the topic is followed again there. A push feed carries
   * changes, not what is: whatever changed while the window was away (its
   * Studio restarted, and every push of the old run went with it) is not
   * pushed again, so a caller that holds state from the feed reads it
   * afresh here. The one place a window re-reads on reconnect.
   */
  onReopen?: () => void
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
  const follow = () => {
    void windowStudioClient(api)
      .then((client) => {
        if (!alive || client === subscribed || !client.supports(input.capability)) return
        stop?.()
        subscribed = client
        stop = client.subscribe(input.topic, input.params, {
          onPayload: input.onPayload,
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
  }
  follow()
  let wasOpen = windowStudioState(api) === 'open'
  const unwatch = watchWindowStudio(api, () => {
    const open = windowStudioState(api) === 'open'
    if (open) follow()
    if (open && !wasOpen && alive) input.onReopen?.()
    wasOpen = open
  })
  return () => {
    alive = false
    stop?.()
    unwatch()
  }
}

/**
 * An `onReopen` that reads a topic's state afresh and hands it on as a push
 * would be; a read that fails is passed over (the next push or reopen tries).
 */
export function rereadOnReopen<T>(read: () => Promise<T>, deliver: (state: T) => void): () => void {
  return () => void read().then(deliver, () => undefined)
}
