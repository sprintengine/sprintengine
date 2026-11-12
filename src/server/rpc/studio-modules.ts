import type {
  StudioModuleAnswer,
  StudioModuleEvent,
  StudioModuleNotification,
} from '../../../packages/studio-protocol/src/public'
import type { ModuleHostServicesOutcome } from '../../main/module-host/main-host'
import type { ModuleLifecycle } from '../../main/modules/module-lifecycle'

// What a Studio's modules say to its clients, between the module kernel and
// the Studio RPC: the kernel delivers each event and bell row here, and every
// connection following `module.events` or `module.notifications` listens.
// The kernel keeps the recent bell rows; a new `module.notifications`
// subscriber is sent those first, read from the kernel through `readRecentFrom`.
//
// A module's declared methods are called through here too: the router hands
// `module.read` / `module.operate` to `call`, which the kernel serves once it
// exists (`serveCallsFrom`); before then, and on a Studio with no kernel, a
// call is answered `module_unavailable`.
//
// So are the host's services a module's window half calls (the Backlog's
// writes, the usage query): the router asks `hostServices` for the calling
// module's, which the kernel answers once it exists (`serveHostServicesFrom`),
// `module_unavailable` for a module not running here.
//
// What runs here (`module.list`, and the owner's `module.setEnabled`,
// `.install`, `.setTrust`, `.uninstall`) is the lifecycle's, served once the
// kernel exists (`serveLifecycleFrom`).
//
// Delivery is best effort per listener: one connection whose send throws does
// not keep the row or event from the others.

/** One call of a module's method, as the router hands it over. */
export type StudioModuleCallRequest = {
  moduleId: string
  method: string
  access: 'read' | 'operate'
  params: unknown
  clientId: string
  /** An operate's command id, namespaced by the client. */
  commandId?: string
}

/** The module's answer, or the host's refusal before the module heard the call. */
export type StudioModuleCallOutcome =
  | { ok: true; answer: StudioModuleAnswer }
  | { ok: false; code: 'module_unavailable' | 'module_method_unknown' | 'invalid_params'; message: string }

export type StudioModules = {
  /** Call a module's declared method. Rejects when its handler throws. */
  call(request: StudioModuleCallRequest): Promise<StudioModuleCallOutcome>
  /** Where calls are served from: the kernel, once it exists. */
  serveCallsFrom(serve: (request: StudioModuleCallRequest) => Promise<StudioModuleCallOutcome>): void
  /** The host's services, as the module named reaches them here; `module_unavailable` before a kernel. */
  hostServices(moduleId: string): ModuleHostServicesOutcome
  /** Where host services are read from: the kernel, once it exists. */
  serveHostServicesFrom(read: (moduleId: string) => ModuleHostServicesOutcome): void
  /** What lists and changes the modules that run here; null before a kernel is wired. */
  lifecycle(): ModuleLifecycle | null
  serveLifecycleFrom(lifecycle: ModuleLifecycle): void
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
  let serve: ((request: StudioModuleCallRequest) => Promise<StudioModuleCallOutcome>) | null = null
  let readHostServices: ((moduleId: string) => ModuleHostServicesOutcome) | null = null
  let lifecycle: ModuleLifecycle | null = null

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
    async call(request) {
      if (!serve)
        return {
          ok: false,
          code: 'module_unavailable',
          message: `Module "${request.moduleId}" is not running on this Studio: its modules have not loaded.`,
        }
      return serve(request)
    },
    serveCallsFrom(next) {
      serve = next
    },
    hostServices(moduleId) {
      if (!readHostServices)
        return {
          ok: false,
          code: 'module_unavailable',
          message: `Module "${moduleId}" is not running on this Studio: its modules have not loaded.`,
        }
      return readHostServices(moduleId)
    },
    serveHostServicesFrom(read) {
      readHostServices = read
    },
    lifecycle: () => lifecycle,
    serveLifecycleFrom(next) {
      lifecycle = next
    },
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
