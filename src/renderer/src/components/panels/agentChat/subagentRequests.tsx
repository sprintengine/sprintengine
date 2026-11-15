import { memo, useDeferredValue, useMemo, type JSX } from 'react'

import { useConversationSessions } from '../../../hooks/conversationSessionsStore'
import { InlineNotice } from '../../ui'
import {
  latestSessionOf,
  studioSubagentsOf,
  useAnswerSubagentRequest,
  useStudioSubagents,
  type StudioSubagent,
} from './chatSubagents'
import { useChatSource, type ChatSource } from './chatSource'
import { projectConversation, type TranscriptEntry } from './conversationProjection'
import { ConversationTransportProvider, useConversationTransport } from './conversationTransport'
import { ConversationPendingDock } from './pendingDock'
import { SubagentIcon } from './subagentIcon'
import { useRemoteChat } from './remoteChatRegistry'
import { useConversationSession } from './useConversationSession'
import { copy } from '../../../../../shared/copy'

// What a sub-agent Studio started is waiting on the person for, above its
// parent's box. A sub-agent is a chat of its own, so its parent's transcript
// holds none of it, and a person working in the parent would otherwise not meet
// it until going in. An agent the chat's CLI spawned needs none of this: what
// one asks arrives in the chat's own session and its own dock. It is answered
// through the sub-agent's own session, on whichever machine that runs.

function ChildRequests({
  workspaceId,
  subagent,
  source,
}: {
  workspaceId: string
  subagent: StudioSubagent
  source: ChatSource
}): JSX.Element | null {
  const session = useConversationSession(source.root, workspaceId, subagent.id, { active: true })
  const events = useDeferredValue(session.events)
  const { entries } = useMemo(() => projectConversation(events), [events])
  const pending = useMemo(
    () =>
      entries.filter(
        (entry): entry is Extract<TranscriptEntry, { kind: 'approval' }> =>
          entry.kind === 'approval' && entry.status === 'pending',
      ),
    [entries],
  )
  const localSession = latestSessionOf(useConversationSessions(), workspaceId, subagent.id)
  const { responding, refusal, respond } = useAnswerSubagentRequest(subagent.sessionId ?? localSession?.sessionId)
  const { operate } = useConversationTransport().capabilities
  if (pending.length === 0) return null
  return (
    <div data-subagent-request={subagent.id} className="mb-2">
      <p className="mb-1 flex min-w-0 items-center gap-1.5 text-meta text-[color:var(--text-muted)]">
        <SubagentIcon cli={subagent.cli} />
        <span className="min-w-0 truncate">
          {subagent.name}
          {copy.panels.agentChat.subagentRequests.isAsking}
        </span>
      </p>
      <ConversationPendingDock
        pendingApprovals={pending}
        onApprove={respond}
        // A pairing that may only follow sees what is asked, and cannot answer.
        busy={responding || !operate}
      />
      {refusal ? (
        <InlineNotice
          tone="error"
          title={copy.panels.agentChat.subagentRequests.theAnswerDidNotGo}
          detail={refusal}
          className="mt-2"
        />
      ) : null}
    </div>
  )
}

function WaitingChild({
  workspaceId,
  subagent,
}: {
  workspaceId: string
  subagent: StudioSubagent
}): JSX.Element | null {
  const source = useChatSource(workspaceId, subagent.id)
  if (!source) return null
  const child = <ChildRequests workspaceId={workspaceId} subagent={subagent} source={source} />
  return source.transport ? (
    <ConversationTransportProvider value={source.transport}>{child}</ConversationTransportProvider>
  ) : (
    child
  )
}

/**
 * Every sub-agent of this chat that is waiting on the person, each with what it
 * asks. Memoized: the chat redraws on every keystroke, and has nothing to say here.
 */
export const SubagentRequests = memo(function SubagentRequests({
  workspaceId,
  agentId,
}: {
  workspaceId: string
  agentId: string
}): JSX.Element {
  const here = useStudioSubagents(workspaceId, agentId)
  const remote = useRemoteChat(workspaceId, agentId)
  const named = remote?.agentId === agentId ? remote.subagents : undefined
  const subagents = useMemo(() => (named ? studioSubagentsOf(named) : here), [named, here])
  return (
    <>
      {subagents
        .filter((subagent) => subagent.status === 'needs_input')
        .map((subagent) => (
          <WaitingChild key={subagent.id} workspaceId={workspaceId} subagent={subagent} />
        ))}
    </>
  )
})
