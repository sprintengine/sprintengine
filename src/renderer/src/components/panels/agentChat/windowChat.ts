import { watchWindowStudio, windowStudioClient, windowStudioState } from '../../../studio/windowStudioClient'
import type { ChatServices } from './chatServices'
import { createStudioChatServices, createStudioConversationParts } from './studioChat'

// This window's chats over its Studio client: the conversation parts a chat
// view on the protocol follows a chat with, and the services every window
// reaches its Studio's chats through. Kept apart from the transport so a store
// can ask for a session list without importing the chat view's modules.

type StudioImplementation = { parts: ReturnType<typeof createStudioConversationParts>; services: ChatServices }

// One implementation per window object, so its client and the subscriptions
// keyed by it are this window's.
const implementations = new WeakMap<object, StudioImplementation>()

export function windowStudioImplementation(): StudioImplementation {
  const api = window.api as object
  let known = implementations.get(api)
  if (!known) {
    const client = () => windowStudioClient(window.api)
    const watchOpen = (listener: () => void) =>
      watchWindowStudio(api, () => {
        if (windowStudioState(api) === 'open') listener()
      })
    known = { parts: createStudioConversationParts(client), services: createStudioChatServices(client, watchOpen) }
    implementations.set(api, known)
  }
  return known
}

/**
 * The window's services: always over the Studio protocol, whichever way its
 * chat views follow a conversation, as every other client reaches them.
 */
export function windowChatServices(): ChatServices {
  return windowStudioImplementation().services
}
