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
  /** The window's api; `window.api` unless given (tests). */
  api?: TicketApi
}

/**
 * Follow one push topic on the window's Studio for as long as the caller
 * wants it. The client resubscribes by itself across a reconnect; a stream
 * that ended (the client parked on a refused credential, say) and a client
 * that closed for good and was replaced are followed again once the window's
 * connection opens. A window with no Studio, or a Studio that
 * does not serve the capability, hears nothing. Returns the unsubscriber.
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
  const unwatch = watchWindowStudio(api, () => {
    if (windowStudioState(api) === 'open') follow()
  })
  return () => {
    alive = false
    stop?.()
    unwatch()
  }
}
