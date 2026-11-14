import { useCallback, useSyncExternalStore } from 'react'

import type { ConversationSessionSummary } from '../../../../../shared/conversation-runtime'
import { conversationSessionsStore } from '../../../hooks/conversationSessionsStore'

/**
 * The live session its Studio lists for a chat, or null: one still running or
 * waiting, not one that stopped or failed. Read by id, so a chat view renders
 * again only when the session it would adopt changes, not on every event the
 * list hears.
 *
 * Why a view needs it: a view keeps its session in its own state, set when it
 * starts or adopts one for a send. A view that mounts on a chat whose session
 * is already live (the window reloaded, the tab reopened, a second window)
 * held none, so Stop and the request cards, which address the session, did
 * nothing until a message was sent.
 */
export function useListedSession(
  workspaceId: string,
  agentId: string,
  enabled: boolean,
): ConversationSessionSummary | null {
  const store = conversationSessionsStore()
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? store.subscribe(listener) : () => undefined),
    [store, enabled],
  )
  const find = useCallback(
    () =>
      enabled
        ? (store
            .getWorkspaceSnapshot(workspaceId)
            .find(
              (session) => session.agentId === agentId && session.status !== 'stopped' && session.status !== 'failed',
            ) ?? null)
        : null,
    [store, enabled, workspaceId, agentId],
  )
  const sessionId = useSyncExternalStore(
    subscribe,
    () => find()?.sessionId ?? null,
    () => null,
  )
  return sessionId === null ? null : (find() ?? null)
}
