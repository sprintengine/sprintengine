import { useDeferredValue, useMemo, useRef, type JSX, type ReactNode } from 'react'
import { subagentEnded } from '../../../../../shared/conversation/subagentStatus'
import { cliForConversationProvider } from '../../../../../shared/conversation-harness'
import type { AgentCli } from '../../../../../shared/workspace'
import { studioSubagentsOf, SubagentStatusWords, useStudioSubagents, type StudioSubagent } from './chatSubagents'
import { useChatSource, type ChatSource } from './chatSource'
import { projectConversation, type TranscriptEntry, type TranscriptToolEntry } from './conversationProjection'
import { childAgentLanes, collectAgentLanes, directAgentLanes } from './conversationTimeline'
import { ConversationTransportProvider } from './conversationTransport'
import { subagentRunsOn } from './subagentResult'
import { laneAgentState, laneName, laneOutcomeWords, LaneStatus } from './subagentStatus'
import {
  popSubagentView,
  pushSubagentView,
  subagentViewOwner,
  useSubagentViews,
  type SubagentView,
} from './subagentViewStack'
import { useConversationSession } from './useConversationSession'
import { useThrottledValue } from './useThrottledValue'

// What sits beside a chat's tab needs of its family: for the agent being viewed,
// the way up to its parent and its direct children, and only those. A child's
// own children are read by going into it. `SubagentChatHost` reads this for its
// tab and publishes it (`subagentFamilyStore`) to the right-hand panel; it draws
// nothing but a child's status words, which tick.

export type SubagentFamilyState = 'working' | 'waiting' | 'done' | 'failed' | 'stopped' | 'unknown'

export type SubagentFamilyMember = {
  /** Stable among its siblings. */
  key: string
  kind: 'chat' | 'lane'
  name: string
  /** The harness whose logo it wears. */
  cli: AgentCli | null
  state: SubagentFamilyState
  /** How it stands, in words, without a running clock; `SubagentFamilyStatus` adds that. */
  words: string
  /** Go into it, as a full chat in the main pane. */
  open(): void
  /** What `SubagentFamilyStatus` draws from. */
  source: { kind: 'chat'; subagent: StudioSubagent } | { kind: 'lane'; lane: TranscriptToolEntry }
}

export type SubagentFamilyParent = {
  name: string
  /** "Main chat" for the chat the tab holds, "Parent agent" for one between. */
  relation: string
  cli: AgentCli | null
  open(): void
}

/**
 * What a lane says of itself, for the agent in view being one: all there is, as
 * it has no record or session of its own. What it does not say is its parent's
 * to say, and is not said of it.
 */
export type SubagentFamilyLane = {
  name: string
  cli: AgentCli | null
  /** The model and effort its spawn asked for, in words; null where it ran on the conversation's own. */
  runsOn: string | null
  /** What it has spent so far; null before it says. */
  tokens: number | null
}

export type SubagentFamily = {
  parent: SubagentFamilyParent | null
  /** The agent in view, when that is a lane that has been read. */
  lane: SubagentFamilyLane | null
  children: readonly SubagentFamilyMember[]
  /** Older turns are not read yet, and may hold older children. */
  hasMore: boolean
  loadingEarlier: boolean
  loadEarlier(): void
}

const NO_FAMILY: SubagentFamily = {
  parent: null,
  lane: null,
  children: [],
  hasMore: false,
  loadingEarlier: false,
  loadEarlier: () => undefined,
}
const NO_NAMED: readonly StudioSubagent[] = []
const LANE_REFRESH_MS = 400
const isEmpty = (events: readonly unknown[]): boolean => events.length === 0

function chatMemberState(subagent: StudioSubagent): SubagentFamilyState {
  if (subagent.status === 'needs_input') return 'waiting'
  if (subagent.status === 'failed' || subagent.status === 'stopped') return subagent.status
  return subagentEnded(subagent.status) ? 'done' : 'working'
}

function laneMemberState(lane: TranscriptToolEntry): SubagentFamilyState {
  const state = laneAgentState(lane)
  return state === 'working' || state === 'failed' || state === 'stopped' || state === 'unknown' ? state : 'done'
}

const STATE_WORDS: Readonly<Record<SubagentFamilyState, string>> = {
  working: 'Working',
  waiting: 'Waiting on you',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  unknown: 'Ran in the background',
}

/** A family's members and parent from what is read of the chat in view. Pure, so it is tested without a view. */
export function subagentFamilyOf(input: {
  views: readonly SubagentView[]
  /** The chat being read: the one a lane in it opens from. */
  viewedAgentId: string
  rootName: string
  rootCli: AgentCli | null
  viewedCli: AgentCli | null
  nameOfChat: (agentId: string) => string | undefined
  chats: readonly StudioSubagent[]
  entries: readonly TranscriptEntry[]
  push: (view: SubagentView) => void
  pop: () => void
  hasMore: boolean
  loadingEarlier?: boolean
  loadEarlier: () => void
}): SubagentFamily {
  const { views, viewedAgentId, entries, chats, viewedCli, push } = input
  const top = views.at(-1)
  const under = views.at(-2)
  const laneMembers = (lanes: readonly TranscriptToolEntry[], ownerAgentId: string): SubagentFamilyMember[] =>
    lanes.map((lane) => {
      const state = laneMemberState(lane)
      const name = laneName(lane)
      return {
        key: `lane:${lane.id}`,
        kind: 'lane',
        name,
        cli: viewedCli,
        state,
        words: laneOutcomeWords(lane) ?? STATE_WORDS[state],
        open: () => push({ kind: 'lane', ownerAgentId, laneId: lane.id, label: name }),
        source: { kind: 'lane', lane },
      }
    })
  let children: SubagentFamilyMember[]
  let lane: SubagentFamilyLane | null = null
  if (top?.kind === 'lane') {
    const viewed = collectAgentLanes(entries).find((candidate) => candidate.id === top.laneId)
    children = viewed ? laneMembers(childAgentLanes(viewed), top.ownerAgentId) : []
    if (viewed)
      lane = {
        name: laneName(viewed),
        cli: viewedCli,
        runsOn: subagentRunsOn(viewed) || null,
        tokens: viewed.agent?.usage?.totalTokens ?? null,
      }
  } else {
    children = [
      ...chats.map((subagent): SubagentFamilyMember => {
        const state = chatMemberState(subagent)
        return {
          key: `chat:${subagent.id}`,
          kind: 'chat',
          name: subagent.name,
          cli: subagent.cli,
          state,
          words: STATE_WORDS[state],
          open: () => push({ kind: 'chat', agentId: subagent.id, label: subagent.name }),
          source: { kind: 'chat', subagent },
        }
      }),
      ...laneMembers(directAgentLanes(entries), viewedAgentId),
    ]
  }
  const parent: SubagentFamilyParent | null = !top
    ? null
    : !under
      ? { name: input.rootName, relation: 'Main chat', cli: input.rootCli, open: input.pop }
      : {
          name: (under.kind === 'chat' ? input.nameOfChat(under.agentId) : undefined) ?? under.label ?? 'Subagent',
          relation: 'Parent agent',
          cli: viewedCli,
          open: input.pop,
        }
  return {
    parent,
    lane,
    children,
    // A lane's children are all in it; older turns can add none.
    hasMore: top?.kind !== 'lane' && input.hasMore,
    loadingEarlier: input.loadingEarlier === true,
    loadEarlier: input.loadEarlier,
  }
}

// What of a transcript the family says: a streamed token, or a step an agent
// takes, moves none of it, so neither wakes the panel.
function laneKey(lanes: readonly TranscriptToolEntry[]): string {
  return lanes
    .map(
      (lane) =>
        `${lane.id}:${lane.status}:${lane.outputStatus ?? ''}:${lane.completedAt ?? ''}:${lane.agent?.state ?? ''}:${laneName(lane)}:${lane.agent?.usage?.totalTokens ?? ''}`,
    )
    .join('\n')
}

/** How a member stands, with its clock while it works. */
export function SubagentFamilyStatus({ member }: { member: SubagentFamilyMember }): JSX.Element {
  return member.source.kind === 'chat' ? (
    <SubagentStatusWords subagent={member.source.subagent} />
  ) : (
    <LaneStatus lane={member.source.lane} />
  )
}

function FamilyReader({
  workspaceId,
  rootAgentId,
  viewedAgentId,
  views,
  root,
  viewed,
  active,
  children,
}: {
  workspaceId: string
  rootAgentId: string
  viewedAgentId: string
  views: readonly SubagentView[]
  root: ChatSource | null
  viewed: ChatSource
  active: boolean
  children: (family: SubagentFamily) => ReactNode
}): JSX.Element {
  const session = useConversationSession(viewed.root, workspaceId, viewedAgentId, { active })
  const sessionRef = useRef(session)
  sessionRef.current = session
  const events = useDeferredValue(useThrottledValue(session.events, LANE_REFRESH_MS, active, isEmpty))
  const { entries } = useMemo(() => projectConversation(events), [events])
  const lanesKey = laneKey(collectAgentLanes(entries))
  const hereChats = useStudioSubagents(workspaceId, viewedAgentId)
  const named = viewed.remote?.agentId === viewedAgentId ? viewed.remote.subagents : undefined
  const chats = useMemo(
    () => (viewed.remote ? studioSubagentsOf(named ?? NO_NAMED_ROWS) : hereChats),
    [viewed.remote, named, hereChats],
  )
  const rootBinding = root?.binding ?? viewed.binding
  const rootName = rootBinding.agent.name
  const rootProvider = rootBinding.agent.conversation.providerId
  const viewedProvider = viewed.binding.agent.conversation.providerId
  const rootSubagents = root?.remote?.subagents
  const { hasMore, loadingEarlier } = session
  const family = useMemo(
    () =>
      subagentFamilyOf({
        views,
        viewedAgentId,
        rootName,
        rootCli: cliForConversationProvider(rootProvider) as AgentCli | null,
        viewedCli: cliForConversationProvider(viewedProvider) as AgentCli | null,
        nameOfChat: (agentId) =>
          chats.find((chat) => chat.id === agentId)?.name ??
          rootSubagents?.find((row) => row.agentId === agentId)?.title,
        chats: views.at(-1)?.kind === 'lane' ? NO_NAMED : chats,
        entries,
        push: (view) => pushSubagentView(workspaceId, rootAgentId, view),
        pop: () => popSubagentView(workspaceId, rootAgentId),
        hasMore,
        loadingEarlier,
        loadEarlier: () => void sessionRef.current.loadEarlier().catch(() => undefined),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `lanesKey` is what of `entries` the family says
    [
      views,
      viewedAgentId,
      rootName,
      rootProvider,
      viewedProvider,
      rootSubagents,
      chats,
      lanesKey,
      hasMore,
      loadingEarlier,
      workspaceId,
      rootAgentId,
    ],
  )
  return <>{children(family)}</>
}

const NO_NAMED_ROWS: readonly never[] = []

/**
 * The family of the chat being viewed in a tab, for what is drawn beside it,
 * wherever that chat runs: it reads through the chat's own transport. `active`
 * is whether the tab can be seen; hidden, it rests as a hidden chat does.
 */
export function SubagentFamilyScope({
  workspaceId,
  rootAgentId,
  active = true,
  children,
}: {
  workspaceId: string
  rootAgentId: string
  active?: boolean
  children: (family: SubagentFamily) => ReactNode
}): JSX.Element {
  const views = useSubagentViews(workspaceId, rootAgentId)
  const top = views.at(-1)
  const viewedAgentId = top ? subagentViewOwner(top) : rootAgentId
  const root = useChatSource(workspaceId, rootAgentId)
  const viewed = useChatSource(workspaceId, viewedAgentId)
  if (!viewed) return <>{children(NO_FAMILY)}</>
  const reader = (
    <FamilyReader
      key={`${workspaceId}:${viewedAgentId}`}
      workspaceId={workspaceId}
      rootAgentId={rootAgentId}
      viewedAgentId={viewedAgentId}
      views={views}
      root={root}
      viewed={viewed}
      active={active}
    >
      {children}
    </FamilyReader>
  )
  return viewed.transport ? (
    <ConversationTransportProvider value={viewed.transport}>{reader}</ConversationTransportProvider>
  ) : (
    reader
  )
}
