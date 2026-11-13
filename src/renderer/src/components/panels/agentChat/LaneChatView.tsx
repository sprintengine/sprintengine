import React, { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { GhostButton, InlineNotice, SendButton, SendGlyph, Spinner } from '../../ui'
import { COMPOSER_SURFACE_CLASS, FOCUS_RING_INSET_CLASS, FOCUS_RING_WITHIN_EDITOR_CLASS } from '../../ui/tokens'
import { useConversationSessions } from '../../../hooks/conversationSessionsStore'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import type { ConversationCliRuntimeOverrides } from '../../../../../shared/conversation-runtime'
import type { AgentCli } from '../../../types/workspace'
import { cliForConversationProvider } from '../../../../../shared/conversation-harness'
import { ConversationLinkProvider } from './conversationLinks'
import { ConversationRowFrame } from './conversationRowFrame'
import { ConversationPendingDock, coversComposer } from './pendingDock'
import { ComposerField, type ComposerFieldHandle } from './ComposerField'
import { latestSessionOf, useAnswerSubagentRequest } from './chatSubagents'
import { useChatSource, type ChatSource } from './chatSource'
import { projectConversation, type TranscriptEntry, type TranscriptToolEntry } from './conversationProjection'
import {
  collectAgentLanes,
  deriveConversationTimelineRows,
  flattenToolEntries,
  laneTranscript,
  type ConversationTimelineRow,
} from './conversationTimeline'
import { ConversationTransportProvider, useConversationTransport } from './conversationTransport'
import { useChatViewActive } from './chatViewActivity'
import { mountedChatViewFor } from './mountedChatViews'
import { subagentRunsOn } from './subagentResult'
import { harnessName } from './subagentIcon'
import { LaneStatus, laneName, SubagentStopProvider, SubagentTypesProvider } from './subagentStatus'
import { laneDelivery, laneSentOutcomes, type LaneSentOutcome } from './subagentDelivery'
import { SubagentBlockedBar, SubagentGone, SubagentViewHeader, type SubagentChatCrumb } from './SubagentChatHost'
import { StopAgentButton, TimelineRow, type TimelineChrome } from './timelineRows'
import { useConversationSession } from './useConversationSession'
import { useThrottledValue } from './useThrottledValue'
import type { SubagentView } from './subagentViewStack'

// An agent a chat's CLI spawned, read as a chat of its own: what it was asked,
// its steps and words, and what it reported, drawn by the chat's own timeline
// over `laneTranscript`. It is not a conversation, only a part of its owner's,
// so it is read through the owner's session and transport, on whichever machine
// that runs, and a hidden owner goes on streaming into it. What it asks the
// person is answered here in the normal dock, since its owner is out of sight.

const LANE_REFRESH_MS = 400
const isEmpty = (events: readonly unknown[]): boolean => events.length === 0
function noop(): void {}

// A draft is kept while the person looks elsewhere, as a chat's is. Session only.
const laneDrafts = new Map<string, string>()

type LaneView = Extract<SubagentView, { kind: 'lane' }>

type LaneViewProps = {
  workspaceId: string
  view: LaneView
  parentName: string
  crumbs: readonly SubagentChatCrumb[]
  onCrumb: (depth: number) => void
  onBack: () => void
}

export function LaneChatView(props: LaneViewProps): React.JSX.Element {
  const source = useChatSource(props.workspaceId, props.view.ownerAgentId)
  if (!source) return <SubagentGone words="This subagent's chat is not here any more." onBack={props.onBack} />
  const body = <LaneBody {...props} source={source} />
  return source.transport ? (
    <ConversationTransportProvider value={source.transport}>{body}</ConversationTransportProvider>
  ) : (
    body
  )
}

// What the chat's provider can do where the chat holds no session to say: after
// a restart a chat has none until it is sent something, and its finished agents
// can still be reached then.
function useProviderRelays(providerId: string, needed: boolean): boolean | undefined {
  const transport = useConversationTransport()
  const cliRuntimes = useWorkspaceStore((state) => state.appSettings.cliRuntimes)
  const [relays, setRelays] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    if (!needed) return undefined
    let cancelled = false
    void transport.services.providers
      .list({ cliRuntimes: cliRuntimes as ConversationCliRuntimeOverrides })
      .then((list) => {
        if (cancelled || !list.ok) return
        setRelays(list.providers.find((entry) => entry.id === providerId)?.capabilities?.messageSubagent === true)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [needed, providerId, cliRuntimes, transport])
  return relays
}

function LaneBody({
  workspaceId,
  view,
  parentName,
  crumbs,
  onCrumb,
  onBack,
  source,
}: LaneViewProps & { source: ChatSource }): React.JSX.Element {
  const owner = view.ownerAgentId
  const { binding, root } = source
  const rootRef = useRef<HTMLDivElement | null>(null)
  const seen = useChatViewActive(rootRef)
  const session = useConversationSession(root, workspaceId, owner, { active: seen })
  const events = useDeferredValue(useThrottledValue(session.events, LANE_REFRESH_MS, seen, isEmpty))
  const projection = useMemo(() => projectConversation(events), [events])
  const lanes = useMemo(() => collectAgentLanes(projection.entries), [projection.entries])
  const lane = lanes.find((candidate) => candidate.id === view.laneId)
  const name = lane ? laneName(lane) : (view.label ?? 'Subagent')
  const providerId = binding.agent.conversation.providerId
  const cli = cliForConversationProvider(providerId) as AgentCli | null
  const transport = useConversationTransport()
  const facts = [cli ? harnessName(cli) : null, lane ? subagentRunsOn(lane) : null].filter(Boolean).join(' · ')
  const stopEnabled = transport.capabilities.operate && typeof transport.stopSubagent === 'function'

  const ownerSummary = latestSessionOf(useConversationSessions(), workspaceId, owner)
  const ownerSession = binding.session ?? ownerSummary
  const sessionId = ownerSession?.sessionId
  const stop = useMemo(
    () =>
      stopEnabled && sessionId && ownerSession?.capabilities?.stopSubagent === true
        ? async (toolUseId: string) => (await transport.stopSubagent!({ sessionId, toolUseId })).ok
        : null,
    [stopEnabled, sessionId, ownerSession?.capabilities?.stopSubagent, transport],
  )
  const listedRelays = useProviderRelays(providerId, ownerSession === undefined)
  const fileRoot = binding.workspaceRoot ?? ''

  return (
    <ConversationLinkProvider
      workspaceId={workspaceId}
      agentId={owner}
      cwd={fileRoot}
      workspaceRoot={fileRoot}
      providerId={providerId}
    >
      <SubagentTypesProvider value={projection.agentTypes}>
        <SubagentStopProvider value={stop}>
          {/* A chat's ground, as `ChatShell` lays it: what the transcript and the box
              inherit their type and their contrast from. */}
          <div
            ref={rootRef}
            data-chat-pane=""
            className="flex h-full min-h-0 flex-col bg-[color:var(--agent-surface)] text-meta text-[color:var(--text-default)]"
          >
            <SubagentViewHeader
              crumbs={crumbs}
              name={name}
              facts={facts}
              status={lane ? <LaneStatus lane={lane} /> : undefined}
              action={lane?.status === 'running' && stop ? <StopAgentButton laneId={lane.id} stop={stop} /> : null}
              onCrumb={onCrumb}
            />
            {lane ? (
              <LaneConversation
                lane={lane}
                entries={projection.entries}
                lanes={lanes}
                name={name}
                cli={cli}
                workspaceId={workspaceId}
                owner={owner}
                parentName={parentName}
                sessionId={sessionId}
                relays={ownerSession?.capabilities?.messageSubagent ?? listedRelays}
                onBack={onBack}
              />
            ) : (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-meta text-[color:var(--text-muted)]">
                {!session.hydrated && !session.error ? (
                  <span className="flex items-center gap-2" role="status">
                    <Spinner />
                    Reading the chat…
                  </span>
                ) : session.error ? (
                  <InlineNotice tone="error" title="Couldn't read this chat." detail={session.error} />
                ) : session.hasMore ? (
                  <GhostButton
                    size="inline"
                    tone="subtle"
                    disabled={session.loadingEarlier}
                    onClick={() => void session.loadEarlier().catch(() => undefined)}
                  >
                    {session.loadingEarlier ? 'Loading earlier turns…' : 'Load earlier turns to find this subagent'}
                  </GhostButton>
                ) : (
                  <SubagentGone words="This subagent is not in its chat any more." onBack={onBack} />
                )}
              </div>
            )}
          </div>
        </SubagentStopProvider>
      </SubagentTypesProvider>
    </ConversationLinkProvider>
  )
}

function LaneConversation({
  lane,
  entries,
  lanes,
  name,
  cli,
  workspaceId,
  owner,
  parentName,
  sessionId,
  relays,
  onBack,
}: {
  lane: TranscriptToolEntry
  entries: readonly TranscriptEntry[]
  lanes: readonly TranscriptToolEntry[]
  name: string
  cli: AgentCli | null
  workspaceId: string
  owner: string
  parentName: string
  sessionId: string | undefined
  relays: boolean | undefined
  onBack: () => void
}): React.JSX.Element {
  const transport = useConversationTransport()
  const running = lane.status === 'running'
  const rows = useMemo(() => deriveConversationTimelineRows(laneTranscript(lane), running), [lane, running])
  const chrome = useMemo<TimelineChrome>(
    () => ({ assistantName: name, onRetry: noop, retryDisabled: true, cli, conversationRunning: running }),
    [name, cli, running],
  )
  const outcomes = useMemo(() => {
    const parentTools = flattenToolEntries(
      entries.filter((entry): entry is TranscriptToolEntry => entry.kind === 'tool'),
    )
    return laneSentOutcomes(lane, parentTools)
  }, [lane, entries])
  const taskIds = useMemo(() => {
    const ids = new Set<string>()
    for (const candidate of [lane, ...lanes.filter((other) => isInside(other, lane))])
      if (candidate.agent?.taskId) ids.add(candidate.agent.taskId)
    return ids
  }, [lane, lanes])
  const pending = useMemo(
    () =>
      entries.filter(
        (entry): entry is Extract<TranscriptEntry, { kind: 'approval' }> =>
          entry.kind === 'approval' &&
          entry.status === 'pending' &&
          entry.originAgentId !== undefined &&
          taskIds.has(entry.originAgentId),
      ),
    [entries, taskIds],
  )
  const { responding, refusal, respond } = useAnswerSubagentRequest(sessionId)
  const delivery = laneDelivery(lane, {
    operate: transport.capabilities.operate,
    providerRelays: relays,
    transportRelays: transport.capabilities.agentMessages && typeof transport.messageSubagent === 'function',
    harnessName: cli ? harnessName(cli) : 'This harness',
    ...(transport.environment.label ? { machineName: transport.environment.label } : {}),
  })
  const question = pending.some(coversComposer)
  const scroller = useFollowEnd(rows)
  const seen = useRef(new Set<string>())
  return (
    <>
      <div
        ref={scroller.ref}
        onScroll={scroller.onScroll}
        tabIndex={-1}
        role="log"
        aria-label={`${name} conversation`}
        className={`chat-column-gutter min-h-0 flex-1 overflow-y-auto pb-6 pt-[calc(var(--band-clearance,0px)+1rem)] focus:outline-none ${FOCUS_RING_INSET_CLASS}`}
      >
        {rows.map((row) => (
          <React.Fragment key={row.id}>
            <ConversationRowFrame id={row.id} live={false} seen={seen.current} flash={false} onFlashEnd={noop}>
              <TimelineRow row={row} chrome={chrome} />
            </ConversationRowFrame>
            <SentNote row={row} outcomes={outcomes} />
          </React.Fragment>
        ))}
      </div>
      <div className="chat-column-gutter relative pb-4 pt-1">
        <ConversationPendingDock
          placement="tray"
          pendingApprovals={pending}
          onApprove={respond}
          busy={responding || !transport.capabilities.operate}
        />
        {refusal ? (
          <InlineNotice tone="error" title="The answer did not go." detail={refusal} className="mb-2" />
        ) : null}
        {question ? (
          <div className={`relative overflow-hidden ${COMPOSER_SURFACE_CLASS} border-[color:var(--border-default)]`}>
            <ConversationPendingDock
              placement="composer"
              pendingApprovals={pending}
              onApprove={respond}
              busy={responding || !transport.capabilities.operate}
            />
          </div>
        ) : delivery.kind === 'box' ? (
          <LaneComposer lane={lane} name={name} workspaceId={workspaceId} owner={owner} sessionId={sessionId} />
        ) : (
          <SubagentBlockedBar why={delivery.why} parentName={parentName} onGoToParent={onBack} />
        )}
      </div>
    </>
  )
}

// Whether `lane` sits anywhere under `ancestor`.
function isInside(lane: TranscriptToolEntry, ancestor: TranscriptToolEntry): boolean {
  return flattenToolEntries(ancestor.children ?? []).some((tool) => tool.id === lane.id)
}

// Under what the person wrote to the agent: that it went through the main chat,
// and what became of it where the main chat's call said.
function SentNote({
  row,
  outcomes,
}: {
  row: ConversationTimelineRow
  outcomes: ReadonlyMap<number, LaneSentOutcome>
}): React.JSX.Element | null {
  if (row.kind !== 'user' || !row.entry.id.includes(':sent:')) return null
  const outcome = row.entry.createdAt === undefined ? undefined : outcomes.get(row.entry.createdAt)
  if (outcome?.state === 'refused')
    return <InlineNotice tone="error" title="It did not reach the agent." detail={outcome.why} className="mb-4" />
  return (
    <p data-lane-sent-note="" className="-mt-4 mb-4 text-right text-micro text-[color:var(--text-subtle)]">
      Passed on through the main chat. It reads this at its next step.
    </p>
  )
}

// Keep the end of a working agent's thread in view, until the person scrolls up.
function useFollowEnd(rows: readonly ConversationTimelineRow[]) {
  const ref = useRef<HTMLDivElement | null>(null)
  const following = useRef(true)
  useLayoutEffect(() => {
    const element = ref.current
    if (element && following.current) element.scrollTop = element.scrollHeight
  }, [rows])
  const onScroll = useCallback(() => {
    const element = ref.current
    if (element) following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
  }, [])
  return { ref, onScroll }
}

// The chat's box, without what a relayed message cannot carry: it goes through
// the parent's model as words, so no pictures, files or skills. Sent only where
// `laneDelivery` said a message arrives.
function LaneComposer({
  lane,
  name,
  workspaceId,
  owner,
  sessionId,
}: {
  lane: TranscriptToolEntry
  name: string
  workspaceId: string
  owner: string
  sessionId: string | undefined
}): React.JSX.Element {
  const transport = useConversationTransport()
  const key = `${workspaceId}\0${owner}\0${lane.id}`
  const [draft, setDraft] = useState(() => laneDrafts.get(key) ?? '')
  const [sending, setSending] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const fieldRef = useRef<ComposerFieldHandle | null>(null)
  useEffect(() => {
    laneDrafts.set(key, draft)
  }, [key, draft])
  const send = async () => {
    const message = draft.trim()
    if (!message || sending) return
    setSending(true)
    setRefusal(null)
    try {
      // After a restart the chat holds no session until it is sent something,
      // and its hidden view is what starts one. A paired machine wakes its own.
      const session = (await mountedChatViewFor(workspaceId, owner)?.ensureSession?.()) ?? sessionId
      if (!session) {
        setRefusal('The main chat could not be started.')
        return
      }
      const result = await transport.messageSubagent!({ sessionId: session, toolUseId: lane.id, message })
      if (result.ok) setDraft('')
      else setRefusal(result.message)
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : 'The message did not go.')
    } finally {
      setSending(false)
    }
  }
  return (
    <>
      {refusal ? <InlineNotice tone="error" title="The message did not go." detail={refusal} className="mb-2" /> : null}
      <div
        data-chat-composer=""
        data-lane-composer=""
        className={`relative transition-colors ${COMPOSER_SURFACE_CLASS} ${FOCUS_RING_WITHIN_EDITOR_CLASS} border-[color:var(--border-default)]`}
      >
        <div className="px-5 pb-1 pt-4">
          <ComposerField
            ref={fieldRef}
            contentAttributes={{ 'aria-label': `Message ${name}` }}
            value={draft}
            historyScope={key}
            onChange={(value) => setDraft(value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.key !== 'Enter' || event.shiftKey) return
              event.preventDefault()
              void send()
            }}
            placeholder={`Send a message to ${name}`}
            className="max-h-[280px] min-h-[40px] w-full"
          />
        </div>
        <div className="flex items-center justify-end gap-2 px-3 pb-3">
          <SendButton
            size="sm"
            aria-label="Send"
            disabled={!draft.trim() || sending}
            onClick={() => void send()}
            className="w-control-sm shrink-0"
          >
            <SendGlyph className="icon-sm shrink-0" />
          </SendButton>
        </div>
      </div>
    </>
  )
}
