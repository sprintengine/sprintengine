import type {
  StudioModuleAnswer,
  StudioModuleEvent,
  StudioModuleNotification,
} from '../../../packages/studio-protocol/src/public'
import type { ExtensionInvoker } from '../../main/module-host/extension-invocation'
import type { ExtensionFrameCallRequest } from '../../main/module-host/extension-frame-calls'
import type { StudioExtensionCallAnswer } from '../../../packages/studio-protocol/src/public'
import type { ModuleLifecycle } from '../../main/modules/module-lifecycle'

// What a Studio's modules say to its clients, between the module kernel and
// the Studio RPC: the kernel delivers each event and bell row here, and every
// connection following `extension.events` or `extension.notifications` listens.
// The kernel keeps the recent bell rows; a new `extension.notifications`
// subscriber is sent those first, read from the kernel through `readRecentFrom`.
//
// A module's declared methods are called through here too: the router hands
// `extension.read` / `extension.operate` to `call`, which the kernel serves once it
// exists (`serveCallsFrom`); before then, and on a Studio with no kernel, a
// call is answered `extension_unavailable`.
//
// So are the host calls an extension's frames make (`extension.call`): the
// router hands each to `frameCall`, as the connection whose client drew the
// frame, which the kernel answers once it exists (`serveFrameCallsFrom`).
// Each call is held to the extension's approval and to that connection's own
// grant.
//
// What runs here (`extension.list`, and the owner's `extension.setEnabled`,
// `.install`, `.approve`, `.uninstall`) is the lifecycle's, served once the
// kernel exists (`serveLifecycleFrom`).
//
// What is installed or approved here changing (the lifecycle's install,
// approval and uninstall, a marketplace install) is told to every connection following
// `extension.changed` (`deliverChanged`), so its windows list and load the
// extensions again.
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
  /** The connection that sent it, on whose behalf the handler runs. */
  invoker: ExtensionInvoker
}

/** The module's answer, or the host's refusal before the module heard the call. */
export type StudioModuleCallOutcome =
  | { ok: true; answer: StudioModuleAnswer }
  | { ok: false; code: 'extension_unavailable' | 'extension_method_unknown' | 'invalid_params'; message: string }

export type StudioModules = {
  /** Call a module's declared method. Rejects when its handler throws. */
  call(request: StudioModuleCallRequest): Promise<StudioModuleCallOutcome>
  /** Where calls are served from: the kernel, once it exists. */
  serveCallsFrom(serve: (request: StudioModuleCallRequest) => Promise<StudioModuleCallOutcome>): void
  /** One host call a frame made; refused `unavailable` before a kernel. */
  frameCall(request: ExtensionFrameCallRequest): Promise<StudioExtensionCallAnswer>
  /** Where frame calls are served from: the kernel, once it exists. */
  serveFrameCallsFrom(serve: (request: ExtensionFrameCallRequest) => Promise<StudioExtensionCallAnswer>): void
  /** What lists and changes the modules that run here; null before a kernel is wired. */
  lifecycle(): ModuleLifecycle | null
  serveLifecycleFrom(lifecycle: ModuleLifecycle): void
  /** One event a module emitted, to every listener, in the order delivered. */
  deliverEvent(event: StudioModuleEvent): void
  /** One bell row, to every listener. The kernel has already kept it. */
  deliverNotification(notification: StudioModuleNotification): void
  /** Hear each event from now on; returns the unsubscriber. */
  onEvent(listener: (event: StudioModuleEvent) => void): () => void
  /** What is installed or approved here changed, to every listener. */
  deliverChanged(): void
  /** Hear each change of what is installed or approved; returns the unsubscriber. */
  onChanged(listener: () => void): () => void
  /** One extension's settings values changed, to every listener. */
  deliverSettingsChanged(moduleId: string): void
  /** Hear whose settings values changed; returns the unsubscriber. */
  onSettingsChanged(listener: (moduleId: string) => void): () => void
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
  const changedListeners = new Set<(value: null) => void>()
  const settingsListeners = new Set<(moduleId: string) => void>()
  let readRecent: () => ReadonlyArray<StudioModuleNotification> = () => []
  let serve: ((request: StudioModuleCallRequest) => Promise<StudioModuleCallOutcome>) | null = null
  let serveFrameCall: ((request: ExtensionFrameCallRequest) => Promise<StudioExtensionCallAnswer>) | null = null
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
          code: 'extension_unavailable',
          message: `Extension "${request.moduleId}" is not running on this Studio: its extensions have not loaded.`,
        }
      return serve(request)
    },
    serveCallsFrom(next) {
      serve = next
    },
    async frameCall(request) {
      if (!serveFrameCall)
        return {
          ok: false,
          code: 'unavailable',
          message: `Extension "${request.moduleId}" is not running on this Studio: its extensions have not loaded.`,
        }
      return serveFrameCall(request)
    },
    serveFrameCallsFrom(serve) {
      serveFrameCall = serve
    },
    lifecycle: () => lifecycle,
    serveLifecycleFrom(next) {
      lifecycle = next
    },
    deliverEvent: (event) => each(eventListeners, event, 'event'),
    deliverNotification: (notification) => each(notificationListeners, notification, 'notification'),
    deliverChanged: () => each(changedListeners, null, 'change'),
    deliverSettingsChanged: (moduleId) => each(settingsListeners, moduleId, 'settings change'),
    onSettingsChanged(listener) {
      settingsListeners.add(listener)
      return () => {
        settingsListeners.delete(listener)
      }
    },
    onChanged(listener) {
      const heard = () => listener()
      changedListeners.add(heard)
      return () => {
        changedListeners.delete(heard)
      }
    },
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
