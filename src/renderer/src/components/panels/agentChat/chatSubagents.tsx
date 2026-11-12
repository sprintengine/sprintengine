import { useCallback, useMemo, useState, type JSX } from 'react'
import { cliForConversationProvider } from '../../../../../shared/conversation-harness'
import type { ConversationApprovalDecision } from '../../../../../shared/conversation-runtime'
import {
  subagentEnded,
  subagentLiveStatusOf,
  type SubagentStatus,
} from '../../../../../shared/conversation/subagentStatus'
import type { MeshSubagent } from '../../../../../shared/tailnet-mesh'
import { useConversationSessions, type ConversationSessionEntry } from '../../../hooks/conversationSessionsStore'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { AgentCli } from '../../../types/workspace'
import { useConversationTransport } from './conversationTransport'
import { LiveElapsed } from './liveElapsed'
import { formatStepDuration } from './stepDuration'

// The sub-agents Studio started for a chat, as anything beside that chat reads
// them. A sub-agent is a chat of its own that belongs to this one
// (subagent-tools.ts), so its row reads from its record and its session. A chat
// on a paired machine has no record here: that machine reads them for it and
// names them (`conversation-subagents`), and each is followed as a chat over
// there.

export type StudioSubagent = {
  id: string
  name: string
  cli: AgentCli | null
  readOnly: boolean
  status: SubagentStatus
  task: string
  startedAt: number
  endedAt: number | null
  error: string | null
  /** What it runs on, for one a machine named; one here reads its record. */
  providerId?: string
  /** The session its answers go to, for one a machine named; one here is found among this window's. */
  sessionId?: string
  /** When the turn a person's follow-up started began, for one working again after it ended. */
  workingSince?: number
}

/** A sub-agent's current session: a follow-up to a rested one starts a new one, so it may have several. */
export function latestSessionOf(
  sessions: readonly ConversationSessionEntry[],
  workspaceId: string,
  agentId: string,
): ConversationSessionEntry | undefined {
  return sessions
    .filter((session) => session.workspaceId === workspaceId && session.agentId === agentId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

/** Every sub-agent of this chat, in the order they were started. */
export function useStudioSubagents(workspaceId: string, agentId: string): StudioSubagent[] {
  const agents = useWorkspaceStore((state) => state.workspaces.find((w) => w.id === workspaceId)?.agents)
  const sessions = useConversationSessions()
  return useMemo(() => {
    const list: StudioSubagent[] = []
    for (const [id, agent] of Object.entries(agents ?? {})) {
      if (agent.subagentOf?.agentId !== agentId) continue
      const summary = latestSessionOf(sessions, workspaceId, id)
      list.push({
        id,
        name: agent.name,
        cli: cliForConversationProvider(agent.conversation?.providerId) as AgentCli | null,
        readOnly: agent.subagentReadOnly === true,
        status: subagentLiveStatusOf(agent, summary),
        task: agent.subagentOf.task ?? '',
        startedAt: agent.subagentOf.startedAt,
        endedAt: agent.subagentEnd?.at ?? null,
        error: agent.subagentEnd?.error ?? null,
        ...(summary?.turnStartedAt !== undefined ? { workingSince: summary.turnStartedAt } : {}),
      })
    }
    return list.sort((a, b) => a.startedAt - b.startedAt)
  }, [agents, agentId, sessions, workspaceId])
}

/**
 * The sub-agents a paired machine named for one of its chats, as this tab draws
 * them. That machine read them as a chat of its own there reads them, so a row
 * says here what it says there. The remote answer ignores the session id, which
 * is the pane's own stand-in for one at rest, as a remote chat's is.
 */
export function studioSubagentsOf(named: readonly MeshSubagent[]): StudioSubagent[] {
  return named.map((subagent) => ({
    id: subagent.agentId,
    name: subagent.title,
    cli: cliForConversationProvider(subagent.providerId) as AgentCli | null,
    readOnly: subagent.readOnly,
    status: subagent.status,
    task: subagent.task,
    startedAt: subagent.startedAt,
    endedAt: subagent.endedAt ?? null,
    error: subagent.error ?? null,
    providerId: subagent.providerId,
    sessionId: subagent.sessionId ?? `remote:${subagent.agentId}`,
  }))
}

/** How it is doing, in words: working and for how long, waiting on the person, or how it ended. */
export function SubagentStatusWords({ subagent }: { subagent: StudioSubagent }): JSX.Element {
  const { status, startedAt, endedAt, workingSince } = subagent
  if (status === 'needs_input') return <span className="text-[color:var(--tone-warn)]">Waiting on you</span>
  if (!subagentEnded(status)) {
    // A task that ended and is working again has no clock of its task's to
    // count; its follow-up has one where its session here says so.
    const since = endedAt === null ? startedAt : workingSince
    return (
      <span className="text-[color:var(--accent-primary)]">
        Working{since !== undefined ? ' · ' : ''}
        {since !== undefined ? <LiveElapsed startedAt={since} /> : null}
      </span>
    )
  }
  const took = endedAt === null ? undefined : formatStepDuration(Math.max(0, endedAt - startedAt))
  if (status === 'failed')
    return <span className="text-[color:var(--tone-error)]">{took ? `Failed after ${took}` : 'Failed'}</span>
  if (status === 'stopped') return <span>{took ? `Stopped after ${took}` : 'Stopped'}</span>
  return <span>{took ? `Done in ${took}` : 'Done'}</span>
}

/**
 * Answering what a subagent asks: a request of the chat `sessionId` names, with
 * the refusal in words where it did not go.
 */
export function useAnswerSubagentRequest(sessionId: string | undefined): {
  responding: boolean
  refusal: string | null
  respond(
    requestId: string,
    approved: boolean,
    answers?: Record<string, string>,
    decision?: ConversationApprovalDecision,
  ): Promise<void>
} {
  const transport = useConversationTransport()
  const [responding, setResponding] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const respond = useCallback(
    async (
      requestId: string,
      approved: boolean,
      answers?: Record<string, string>,
      decision?: ConversationApprovalDecision,
    ) => {
      if (!sessionId) return
      setResponding(true)
      setRefusal(null)
      try {
        const result = await transport.respond({
          sessionId,
          requestId,
          approved,
          ...(answers ? { answers } : {}),
          ...(decision ? { decision } : {}),
        })
        if (!result.ok) setRefusal(result.message)
      } catch (error) {
        setRefusal(error instanceof Error ? error.message : 'Could not record the answer.')
      } finally {
        setResponding(false)
      }
    },
    [sessionId, transport],
  )
  return { responding, refusal, respond }
}
