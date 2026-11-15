import type React from 'react'

import { useWorkspaceStore } from '../../../store/workspaceStore'
import { ConversationTransportProvider } from './conversationTransport'
import { useEnvironmentConversationTransport } from './environmentChat'

/**
 * A chat's view, given the transport of the environment its record says it
 * is on: a chat another environment's Studio holds is followed and driven
 * there, over this window's client of it. A chat this window's own Studio
 * holds keeps the window's transport.
 */
export function EnvironmentChatScope({
  workspaceId,
  children,
}: {
  workspaceId: string
  children: React.ReactNode
}): React.JSX.Element {
  const environment = useWorkspaceStore(
    (state) => state.workspaces.find((workspace) => workspace.id === workspaceId)?.environment ?? null,
  )
  const transport = useEnvironmentConversationTransport(environment)
  return transport ? (
    <ConversationTransportProvider value={transport}>{children}</ConversationTransportProvider>
  ) : (
    <>{children}</>
  )
}
