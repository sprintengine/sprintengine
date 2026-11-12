import type { StudioModuleEvent, StudioModuleNotification } from '../../../packages/studio-protocol/src/public'

// What a Studio's modules say to its clients, between the module kernel and
// the Studio RPC: the kernel delivers each event and bell row here, and every
// connection following `module.events` or `module.notifications` listens.
// The kernel keeps the recent bell rows; a new `module.notifications`
// subscriber is sent those first, read from the kernel through `readRecentFrom`.
//
// Delivery is best effort per listener: one connection whose send throws does
// not keep the row or event from the others.

export type StudioModules = {
  /** One event a module emitted, to every listener, in the order delivered. */
  deliverEvent(event: StudioModuleEvent): void
  /** One bell row, to every listener. The kernel has already kept it. */
  deliverNotification(notification: StudioModuleNotification): void
  /** Hear each event from now on; returns the unsubscriber. */
  onEvent(listener: (event: StudioModuleEvent) => void): () => void
  /** Hear each bell row from now on; returns the unsubscriber. */
  onNotification(listener: (notification: StudioModuleNotification) => void): () => void
  /** The rows the kernel still keeps, oldest first, as copies. Empty before a kernel is wired. */
  recentNotifications(): StudioModuleNotification[]
  /** Where the kept rows are read from: the kernel, once it exists. */
  readRecentFrom(read: () => ReadonlyArray<StudioModuleNotification>): void
}

export function createStudioModuleHub(options: { log?: (message: string) => void } = {}): StudioModules {
  const eventListeners = new Set<(event: StudioModuleEvent) => void>()
  const notificationListeners = new Set<(notification: StudioModuleNotification) => void>()
  let readRecent: () => ReadonlyArray<StudioModuleNotification> = () => []

  function each<T>(listeners: Set<(value: T) => void>, value: T, what: string): void {
    // A copy, so a listener that unsubscribes (or subscribes) while hearing does not skip another.
    for (const listener of [...listeners]) {
      try {
        listener(value)
      } catch (error) {
        options.log?.(
          `A module ${what} could not be sent to a client: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  return {
    deliverEvent: (event) => each(eventListeners, event, 'event'),
    deliverNotification: (notification) => each(notificationListeners, notification, 'notification'),
    onEvent(listener) {
      eventListeners.add(listener)
      return () => {
        eventListeners.delete(listener)
      }
    },
    onNotification(listener) {
      notificationListeners.add(listener)
      return () => {
        notificationListeners.delete(listener)
      }
    },
    recentNotifications: () => readRecent().map((notification) => structuredClone(notification)),
    readRecentFrom(read) {
      readRecent = read
    },
  }
}
