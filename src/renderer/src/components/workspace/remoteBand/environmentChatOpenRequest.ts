import type { RemoteSessionOpenSpec } from './remoteSessionsModel'

// "Open this chat of another environment's", from a surface that has no path
// to the manager that opens one (Settings ▸ Settled chats, which the store
// wires). A window event, as the palette's open request is: no store,
// nothing in the eager module graph, and the manager, which is always mounted
// while Settings is, is the one listener.

const ENVIRONMENT_CHAT_OPEN_REQUEST_EVENT = 'sprintengine:environment-chat-open-request'

export function requestEnvironmentChatOpen(spec: RemoteSessionOpenSpec): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<RemoteSessionOpenSpec>(ENVIRONMENT_CHAT_OPEN_REQUEST_EVENT, { detail: spec }))
}

/** The manager subscribes on mount. Returns an unsubscribe fn. */
export function subscribeEnvironmentChatOpenRequest(handler: (spec: RemoteSessionOpenSpec) => void): () => void {
  const listener = (event: Event): void => {
    const spec = (event as CustomEvent<RemoteSessionOpenSpec>).detail
    if (spec) handler(spec)
  }
  window.addEventListener(ENVIRONMENT_CHAT_OPEN_REQUEST_EVENT, listener)
  return () => window.removeEventListener(ENVIRONMENT_CHAT_OPEN_REQUEST_EVENT, listener)
}
