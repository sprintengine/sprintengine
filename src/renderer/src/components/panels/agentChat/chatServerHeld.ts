import { useEffect, useMemo, useState } from 'react'

import {
  STUDIO_CONVERSATIONS_CAPABILITY,
  type StudioConversationKey,
} from '../../../../../../packages/studio-protocol/src/public'
import type {
  MeshConversationUsageLimits,
  MeshQueuedMessage,
  MeshScheduledMessage,
} from '../../../../../shared/tailnet-mesh'
import { followWindowStudioPush } from '../../../studio/windowStudioPush'
import type { ChatBinding } from './chatBinding'
import { hostUsageLimitsOf } from './hostUsageLimits'

// What the window's own Studio holds for one of its chats: the messages it
// holds for the turn to end, those it keeps for a time, and what it knows of
// the chat's usage limits. Followed on the per-chat push topics every client
// reads (`conversation.queued`, `conversation.scheduled`,
// `conversation.usageLimits`), as a paired machine's chat reads the same
// from its own frames. Each payload is the whole list; a reconnect follows
// again and is answered whole.

/** How the chat view names the window's own Studio where it names who holds a message. */
export const WINDOW_STUDIO_NAME = 'Studio'

const NO_MESSAGES: never[] = []

export function useStudioChatHeld(
  key: StudioConversationKey | null,
): Pick<ChatBinding, 'hostQueue' | 'hostSchedule' | 'hostUsageLimits'> {
  const workspaceId = key?.workspaceId ?? null
  const agentId = key?.agentId ?? null
  const workspaceRoot = key?.workspaceRoot
  const [queued, setQueued] = useState<MeshQueuedMessage[]>(NO_MESSAGES)
  const [scheduled, setScheduled] = useState<MeshScheduledMessage[]>(NO_MESSAGES)
  const [usage, setUsage] = useState<MeshConversationUsageLimits | null>(null)
  useEffect(() => {
    setQueued(NO_MESSAGES)
    setScheduled(NO_MESSAGES)
    setUsage(null)
    if (workspaceId === null || agentId === null) return
    const params = { key: { workspaceId, agentId, ...(workspaceRoot ? { workspaceRoot } : {}) } }
    const stops = [
      followWindowStudioPush({
        topic: 'conversation.queued',
        params,
        capability: STUDIO_CONVERSATIONS_CAPABILITY,
        onPayload: (frame) => setQueued(frame.messages),
      }),
      followWindowStudioPush({
        topic: 'conversation.scheduled',
        params,
        capability: STUDIO_CONVERSATIONS_CAPABILITY,
        onPayload: (frame) => setScheduled(frame.messages),
      }),
      followWindowStudioPush({
        topic: 'conversation.usageLimits',
        params,
        capability: STUDIO_CONVERSATIONS_CAPABILITY,
        onPayload: (frame) => setUsage(frame),
      }),
    ]
    return () => {
      for (const stop of stops) stop()
    }
  }, [workspaceId, agentId, workspaceRoot])
  return useMemo(
    () => ({
      hostQueue: { machineName: WINDOW_STUDIO_NAME, messages: queued },
      hostSchedule: { machineName: WINDOW_STUDIO_NAME, messages: scheduled },
      ...(usage ? { hostUsageLimits: hostUsageLimitsOf(WINDOW_STUDIO_NAME, usage) } : {}),
    }),
    [queued, scheduled, usage],
  )
}
