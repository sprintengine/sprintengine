import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ConversationSessionSummary } from '../../../../../shared/conversation-runtime'
import { meshConversationSessionId } from '../../../../../shared/tailnet-mesh'
import type { BranchPullRequest } from '../../../../../shared/git/pull-request'
import {
  CONVERSATION_AGENT_MESSAGE_CAPABILITY,
  CONVERSATION_CLI_PERMISSION_MODES_CAPABILITY,
  CONVERSATION_CONTEXT_BREAKDOWN_CAPABILITY,
  CONVERSATION_FORK_CAPABILITY,
  CONVERSATION_HANDOFF_CAPABILITY,
  CONVERSATION_MCP_SERVER_ACTIONS_CAPABILITY,
  CONVERSATION_REASONING_EFFORT_CAPABILITY,
  CONVERSATION_REWIND_CAPABILITY,
  CONVERSATION_SEND_MODE_CAPABILITY,
  CONVERSATION_SEND_SKILLS_CAPABILITY,
  CONVERSATION_SIDE_QUESTIONS_CAPABILITY,
  CONVERSATION_STOP_SUBAGENT_CAPABILITY,
  type StudioLocalServer,
} from '../../../../../../packages/studio-protocol/src/public'
import { negotiateChatCapabilities } from '../../../../../../packages/client-runtime/src/public'
import type {
  MeshConversation,
  MeshConversationAccess,
  MeshConversationKey,
  MeshConversationLink,
  MeshQueuedMessage,
  MeshScheduledMessage,
  MeshConversationUsageLimits,
  MeshSubagent,
} from '../../../../../shared/tailnet-mesh'
import type { CliRuntimeOption } from '../../ui/CliModelPicker'
import {
  publishRemoteConversationList,
  useRemoteConversationFactsOf,
} from '../../workspace/remoteBand/remoteConversationFacts'
import { ConversationChatBody } from '../AgentChatView'
import { remoteFileCountsOf } from '../../workspace/terminalLines'
import { ChatViewErrorBoundary } from './ChatViewErrorBoundary'
import { hostUsageLimitsOf } from './hostUsageLimits'
import { publishRemoteChat } from './remoteChatRegistry'
import { cliForConversationProvider } from '../../../../../shared/conversation-harness'
import { studioSubagentsOf, SubagentStatusWords } from './chatSubagents'
import {
  SubagentChatHost,
  SubagentEndNotice,
  subagentFacts,
  SubagentGone,
  SubagentViewHeader,
} from './SubagentChatHost'
import type { ChatBinding, ChatAgentFields } from './chatBinding'
import type { ChatReadiness } from './chatStates'
import {
  ConversationTransportProvider,
  createRemoteConversationTransport,
  type ConversationTransport,
} from './conversationTransport'

// A conversation on a paired machine, in the regular chat view.
//
// The transcript, pending requests and composer are the chat view's own; what
// this pane adds is the transport (main follows the conversation over the
// tailnet and keeps its tail, so a reconnect or a restart resumes rather than
// replays) and the agent fields a local chat keeps in its record. The machine
// is named above the transcript and on the tab, so a keystroke here is never
// mistaken for one on this machine.
//
// Readiness is the link's: live and allowed to operate is ready; live and
// read-only shows the conversation with the composer closed and says why; a
// link that is reconnecting keeps the transcript on screen and says so.

const NO_PULL_REQUESTS: readonly BranchPullRequest[] = []
const NO_LOCAL_SERVERS: readonly StudioLocalServer[] = []

type Props = {
  /** The workspace here that holds this pane. */
  workspaceId: string
  connectionId: string
  machineName: string
  /** The conversation's ids on that machine. */
  remoteWorkspaceId: string
  remoteAgentId: string
  /** What the row it was opened from called it, until the machine is read. */
  title?: string
  /**
   * Set for a sub-agent drawn in its parent's place: no list names one, so its
   * parent's `subagents` row stands in for its listed thread, and it is a layer
   * of its parent's stack rather than the chat at the bottom of one.
   */
  subagent?: {
    row: MeshSubagent
    parentAgentId: string
    parentName: string
    onGoToParent: () => void
  }
}

/** A sub-agent's row as the chat its pane reads: it names what a list would. */
function threadOfSubagent(row: MeshSubagent): MeshConversation {
  const { readOnly: _readOnly, status: _status, task: _task, startedAt, endedAt, error: _error, ...listed } = row
  return { ...listed, createdAt: startedAt, updatedAt: endedAt ?? startedAt } as MeshConversation
}

function remoteConversationReadiness(
  link: MeshConversationLink | null,
  access: MeshConversationAccess | null,
  machineName: string,
): ChatReadiness {
  if (!link) return { kind: 'error', message: `Connecting to ${machineName}.` }
  if (link.state !== 'live') return { kind: 'error', message: link.detail }
  if (access !== 'operate')
    return {
      kind: 'error',
      message: `This pairing may follow this conversation on ${machineName} but not drive it.`,
    }
  return { kind: 'ready' }
}

/**
 * The chat's CLI row as the machine running it lists it: its name and the
 * models its own picker offers, which are the only ones it will switch to.
 * Null for a machine that does not offer model switching, or a chat whose
 * provider is not a CLI; the chip then shows the model it is on, locked.
 */
function remoteConversationEngine(thread: MeshConversation | null, modelSwitch: boolean): CliRuntimeOption | null {
  const models = modelSwitch ? thread?.models : undefined
  if (!models) return null
  return {
    value: models.cli,
    label: models.cliLabel,
    modelSelection: { options: models.options, allowCustomId: false },
  }
}

/** What the machine says it does for its chats beyond the turn: forks, side questions, the window's breakdown. */
type RemoteAgentReads = { fork: boolean; sideQuestions: boolean; contextBreakdown: boolean }

const NO_CAPABILITIES: readonly string[] = []

const sameNames = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((name, index) => name === b[index])

/** What the machine a chat runs on said it takes, each read from its list. */
type RemoteSessionFeatures = {
  modelSwitch: boolean
  stopSubagents: boolean
  messageSubagents: boolean
  handoff: boolean
  sendSkills: boolean
  rewind: boolean
  agentReads: RemoteAgentReads
  cliPermissionModes: boolean
  sendMode: boolean
  reasoningEffort: boolean
  mcpServerActions: boolean
}

/**
 * What the machine takes for its chats' sessions, from the capabilities it
 * publishes: each still needs the chat's provider to be able, which its row says.
 */
function remoteSessionFeatures(capabilities: readonly string[]): Omit<RemoteSessionFeatures, 'modelSwitch'> {
  const has = (name: string) => capabilities.includes(name)
  return {
    stopSubagents: has(CONVERSATION_STOP_SUBAGENT_CAPABILITY),
    messageSubagents: has(CONVERSATION_AGENT_MESSAGE_CAPABILITY),
    handoff: has(CONVERSATION_HANDOFF_CAPABILITY),
    // Its skills are listed by its extensions, and a send carries them.
    sendSkills: has(CONVERSATION_SEND_SKILLS_CAPABILITY) && has('workspace-extensions'),
    rewind: has(CONVERSATION_REWIND_CAPABILITY),
    agentReads: {
      fork: has(CONVERSATION_FORK_CAPABILITY),
      sideQuestions: has(CONVERSATION_SIDE_QUESTIONS_CAPABILITY),
      contextBreakdown: has(CONVERSATION_CONTEXT_BREAKDOWN_CAPABILITY),
    },
    cliPermissionModes: has(CONVERSATION_CLI_PERMISSION_MODES_CAPABILITY),
    sendMode: has(CONVERSATION_SEND_MODE_CAPABILITY),
    reasoningEffort: has(CONVERSATION_REASONING_EFFORT_CAPABILITY),
    mcpServerActions: has(CONVERSATION_MCP_SERVER_ACTIONS_CAPABILITY),
  }
}

/** The session a remote row stands for, as the chat view reads one: what that machine said it can do. */
function remoteConversationSession(
  thread: MeshConversation | null,
  key: MeshConversationKey,
  features: RemoteSessionFeatures,
): ConversationSessionSummary {
  const {
    modelSwitch,
    stopSubagents,
    messageSubagents,
    handoff,
    sendSkills,
    rewind,
    agentReads,
    cliPermissionModes,
    sendMode,
    reasoningEffort,
    mcpServerActions,
  } = features
  const capabilities = thread?.capabilities
  return {
    // A session id, even for a conversation with none live over there: a
    // remote send resumes one, so the view never starts one here.
    sessionId: thread?.sessionId ?? `remote:${key.agentId}`,
    workspaceId: key.workspaceId,
    agentId: key.agentId,
    providerId: thread?.providerId ?? '',
    modelId: thread?.modelId ?? '',
    status: 'ready',
    // The preset the machine says the conversation is on. With it the chat
    // shows the same switcher a local chat does; without it (a desktop built
    // before the list named it) the switcher stays hidden.
    ...(thread?.permissionPreset ? { permissionPreset: thread.permissionPreset } : {}),
    // And the CLI's own mode at it (Claude Code's Accept edits), from a
    // machine that runs them; elsewhere the preset runs its own.
    ...(cliPermissionModes && thread?.permissionPreset && thread.permissionMode
      ? { permissionMode: thread.permissionMode }
      : {}),
    createdAt: thread?.createdAt ?? 0,
    updatedAt: thread?.updatedAt ?? 0,
    capabilities: {
      tools: true,
      approvals: capabilities?.approvals ?? true,
      questions: capabilities?.questions ?? true,
      // Whether its provider plans, where the machine takes the mode a turn
      // runs in; one that does not runs every turn in the default mode.
      planMode: sendMode && capabilities?.planMode === true,
      // The remote send carries images where the machine lists the chat as
      // taking them: main puts each in that machine's upload store, as the
      // phone does, and the send names them.
      images: capabilities?.images === true,
      // That machine's skills, where it takes them with a message: its runtime
      // resolves each against its own folder and delivers it, which is what
      // `context` stands for here. The "+" lists them, and that machine's MCP
      // servers beside them.
      skills: sendSkills ? 'context' : 'none',
      // The levels its provider runs, where the machine takes a change of
      // them: the effort control and `/effort` are offered as a local chat's
      // are, and a change is that machine's to keep.
      reasoningEfforts:
        reasoningEffort && capabilities?.reasoningEfforts?.length ? capabilities.reasoningEfforts : null,
      interrupt: capabilities?.interrupt ?? true,
      resume: false,
      subagents: true,
      cost: false,
      contextMeter: false,
      // Whether the machine will take a new model mid-conversation, as its
      // list says; a machine that does not offer model switching never will.
      liveModelSwitch: modelSwitch && thread?.models?.liveModelSwitch === true,
      checkpoints: capabilities?.checkpoints ?? false,
      // Whether its provider takes a message mid-turn, where the list says;
      // the transport offers it only for a machine that takes a steer.
      steer: capabilities?.steer === true,
      // Whether one agent the chat spawned can be stopped by itself: the
      // machine takes the command and lists the chat's provider as able.
      // The machine's turn Stop spares such a chat's agents, so this is the
      // only Stop an agent has from here.
      stopSubagent: stopSubagents && capabilities?.stopSubagent === true,
      // Whether the person's words can be passed to one agent the chat spawned:
      // the machine takes the command and lists the chat's provider as able.
      messageSubagent: messageSubagents && capabilities?.messageSubagent === true,
      // Whether the chat can be handed off to a fresh session over there: the
      // machine takes the command and lists the chat's provider as able.
      handoff: handoff && capabilities?.handoff === true,
      // Whether the chat can go back to before one of its messages over there
      // (Edit from here): the machine takes the command and lists the chat's
      // provider as able.
      rewind: rewind && capabilities?.rewind === true,
      // Fork from here, a side question, and what fills the window: each
      // where the machine takes it and lists the chat's provider as able. A
      // fork is made over there and opens here as a pane of its own.
      fork: agentReads.fork && capabilities?.fork === true,
      sideQuestion: agentReads.sideQuestions && capabilities?.sideQuestion === true,
      contextBreakdown: agentReads.contextBreakdown && capabilities?.contextBreakdown === true,
      // The presets the chat's provider over there can run, where its list names them.
      ...(capabilities?.permissionPresets ? { permissionPresets: capabilities.permissionPresets } : {}),
      // What the "+" menu's server rows may do to the chat's servers over
      // there while it runs, where the machine takes the command.
      ...(mcpServerActions && capabilities?.mcpServerActions?.length
        ? { mcpServerActions: capabilities.mcpServerActions }
        : {}),
      // The CLI's own modes it runs beside them, offered in the same picker a
      // local chat's are, where the machine takes a switch to one.
      ...(cliPermissionModes && capabilities?.permissionModes ? { permissionModes: capabilities.permissionModes } : {}),
    },
  }
}

export default function RemoteConversationPanel({
  workspaceId,
  connectionId,
  machineName,
  remoteWorkspaceId,
  remoteAgentId,
  title,
  subagent,
}: Props) {
  const key = useMemo<MeshConversationKey>(
    () => ({ connectionId, workspaceId: remoteWorkspaceId, agentId: remoteAgentId }),
    [connectionId, remoteWorkspaceId, remoteAgentId],
  )
  const [link, setLink] = useState<MeshConversationLink | null>(null)
  const seedThread = useMemo(() => (subagent ? threadOfSubagent(subagent.row) : null), [subagent])
  const [listedThread, setThread] = useState<MeshConversation | null>(null)
  const thread = listedThread ?? seedThread
  // What the machine last said of itself in its list: the capabilities it
  // publishes, and what this pairing may do there.
  const [said, setSaid] = useState<{ access: MeshConversationAccess; capabilities: readonly string[] } | null>(null)
  const [hostQueued, setHostQueued] = useState<MeshQueuedMessage[]>([])
  const [hostScheduled, setHostScheduled] = useState<MeshScheduledMessage[]>([])
  const [hostUsage, setHostUsage] = useState<MeshConversationUsageLimits | null>(null)
  // The chat's sub-agents, as the machine last said. It says only where it
  // advertises `conversation-subagents`; the panel reads them from here.
  const [hostSubagents, setHostSubagents] = useState<MeshSubagent[]>([])
  // Bumped after an accepted model switch, so the list is read again and the
  // chip names what the machine says the chat is now on.
  const [listVersion, setListVersion] = useState(0)
  // The link's word on access is the latest (a refused command narrows it);
  // the list's is what was granted when this pane last read the machine.
  const access = link?.access ?? said?.access ?? null
  // What every transport of this pane reads its capabilities off
  // (`negotiateChatCapabilities`), as a window reads its Studio's welcome.
  const offer = useMemo(
    () => ({
      via: 'paired-lane' as const,
      capabilities: said?.capabilities ?? NO_CAPABILITIES,
      access,
      modelCatalog: Boolean(thread?.models),
    }),
    [said, access, thread?.models],
  )
  const capabilities = useMemo(() => negotiateChatCapabilities(offer), [offer])
  const features = useMemo(() => remoteSessionFeatures(said?.capabilities ?? NO_CAPABILITIES), [said])
  const modelSwitch = capabilities.modelSwitch

  // One transport per conversation, never rebuilt on a grant change: a new
  // transport is a new subscription, and the follow in main would be dropped
  // and dialled again. Its capabilities read the offer as it is now.
  const offerRef = useRef(offer)
  offerRef.current = offer
  const threadRef = useRef(thread)
  threadRef.current = thread
  const transport = useMemo(() => {
    const base = createRemoteConversationTransport({
      key,
      machineName,
      offer: () => offerRef.current,
      onLink: setLink,
      onQueued: setHostQueued,
      onScheduled: setHostScheduled,
      onUsageLimits: setHostUsage,
      onSubagents: setHostSubagents,
      // A pull request Create PR opened there is in the machine's list now:
      // read it again, so the strip says "Open PR #N" without waiting for the
      // sidebar's next read.
      onPullRequestRecorded: () => setListVersion((version) => version + 1),
    })
    const setModel = base.setModel
    const setEffort = base.setReasoningEffort
    const send = base.send
    const unwatchPullRequest = base.unwatchPullRequest
    // Spread with its own getter kept: `...base` would copy the capabilities
    // as they are now.
    return Object.defineProperties(
      {
        ...base,
        // A chat at rest over there is listed without a session, and so without
        // what it can do: its first message wakes one, and the list is read
        // again once that message is answered, so the composer learns whether
        // the chat takes images without waiting for the link to drop.
        send: async (turn: Parameters<typeof send>[0]) => {
          const result = await send(turn)
          if (result.ok && !threadRef.current?.capabilities) setListVersion((version) => version + 1)
          return result
        },
        // A watch ended there is off its list: read it again, so the strip
        // stops saying it is watched without waiting for the sidebar's read.
        ...(unwatchPullRequest
          ? {
              unwatchPullRequest: async (input: Parameters<typeof unwatchPullRequest>[0]) => {
                const result = await unwatchPullRequest(input)
                if (result.ok) setListVersion((version) => version + 1)
                return result
              },
            }
          : {}),
        ...(setModel
          ? {
              setModel: async (change: Parameters<typeof setModel>[0]) => {
                const result = await setModel(change)
                if (result.ok) setListVersion((version) => version + 1)
                return result
              },
            }
          : {}),
        // Read again once accepted, as a model switch is, so the control names
        // the level the machine says the chat now runs at.
        ...(setEffort
          ? {
              setReasoningEffort: async (change: Parameters<typeof setEffort>[0]) => {
                const result = await setEffort(change)
                if (result.ok) setListVersion((version) => version + 1)
                return result
              },
            }
          : {}),
      },
      { capabilities: Object.getOwnPropertyDescriptor(base, 'capabilities')! },
    ) as ConversationTransport
  }, [key, machineName])

  // A sub-agent is a chat of its own over there, followed by its own ids: what
  // the panel reads of one, and the answer to what it asks, go through
  // this. Made once for each, as the pane's own is, and reading the pane's
  // offer: the same machine, the same pairing.
  const subagentTransport = useMemo(() => {
    const made = new Map<string, ConversationTransport>()
    return (agentId: string): ConversationTransport => {
      const existing = made.get(agentId)
      if (existing) return existing
      const transport = createRemoteConversationTransport({
        key: { ...key, agentId },
        machineName,
        offer: () => offerRef.current,
      })
      made.set(agentId, transport)
      return transport
    }
  }, [key, machineName])

  // The machine's list names the conversation's title, model and what its
  // provider can do. Read on open and whenever the link comes back live.
  // Not when the link drops: a machine the follow cannot reach will not
  // answer a list either, and the read would only wait out its timeout.
  // Main shares one list per machine across the panes and the band that ask
  // at once, and the protocol has no read for a single conversation, so the
  // whole list is still what is asked for.
  const live = link?.state === 'live'
  const linkRef = useRef(link)
  linkRef.current = link
  useEffect(() => {
    if (!live && linkRef.current !== null) return
    let cancelled = false
    void window.api
      .meshConversationList(connectionId)
      .then((result) => {
        if (cancelled || !result.ok) return
        // The pane's tab reads its mark, model and clock off this list too.
        publishRemoteConversationList(connectionId, result.conversations)
        setSaid((current) =>
          current?.access === result.access && sameNames(current.capabilities, result.capabilities)
            ? current
            : { access: result.access, capabilities: result.capabilities },
        )
        setThread(
          result.conversations.find(
            (entry) => entry.workspaceId === remoteWorkspaceId && entry.agentId === remoteAgentId,
          ) ?? null,
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [connectionId, remoteWorkspaceId, remoteAgentId, live, listVersion])

  const [fields, setFields] = useState<Omit<ChatAgentFields, 'conversation' | 'name'>>({})
  const update = useCallback((patch: Partial<ChatAgentFields>) => {
    const { conversation, name: _name, conversationReasoningEffort: _effort, ...rest } = patch
    setFields((current) => ({ ...current, ...rest }))
    // The chat view records a model only once the machine accepted the
    // switch; the chip moves now, and the list read that follows confirms it.
    // The CLI is the machine's to say, never this pane's.
    if (conversation?.modelId)
      setThread((current) => (current ? { ...current, modelId: conversation.modelId } : current))
    // The effort likewise: the machine keeps it, and the control reads it off
    // the list, moved now to the level it accepted.
    if ('conversationReasoningEffort' in patch)
      setThread((current) => {
        if (!current) return current
        const { reasoningEffort: _was, ...rest } = current
        return patch.conversationReasoningEffort
          ? { ...rest, reasoningEffort: patch.conversationReasoningEffort }
          : rest
      })
  }, [])
  // The branch, changed files, pull requests and local servers the strip under the composer draws, from
  // the newest list either this pane or the sidebar read: the sidebar reads
  // the machine again whenever it says its chats changed, so a pull request
  // the agent opens mid-conversation reaches the strip without a reopen.
  const facts = useRemoteConversationFactsOf(connectionId, meshConversationSessionId(remoteWorkspaceId, remoteAgentId))
  const listed = useMemo(() => {
    const pullRequests = facts?.pullRequests ?? NO_PULL_REQUESTS
    return {
      branch: facts?.branch ?? null,
      worktree: facts?.worktree ?? false,
      files: remoteFileCountsOf(facts?.changes ?? null, pullRequests)?.files ?? null,
      pullRequests,
      localServers: facts?.localServers ?? NO_LOCAL_SERVERS,
    }
  }, [facts])
  const hostUsageLimits = useMemo(
    () => (capabilities.hostUsageLimits && hostUsage ? hostUsageLimitsOf(machineName, hostUsage) : null),
    [capabilities.hostUsageLimits, hostUsage, machineName],
  )
  const displayTitle = thread?.title || title || 'Conversation'
  const session = useMemo(
    () => remoteConversationSession(thread, key, { ...features, modelSwitch }),
    [thread, key, features, modelSwitch],
  )
  const engine = useMemo(() => remoteConversationEngine(thread, modelSwitch), [thread, modelSwitch])
  const readiness = useMemo(() => remoteConversationReadiness(link, access, machineName), [link, access, machineName])
  const binding = useMemo<ChatBinding>(
    () => ({
      agent: {
        ...fields,
        name: displayTitle,
        conversation: { providerId: thread?.providerId ?? '', modelId: thread?.modelId ?? '' },
        // The effort the machine says the chat runs at, which each turn there runs at.
        ...(thread?.reasoningEffort ? { conversationReasoningEffort: thread.reasoningEffort } : {}),
      },
      update,
      workspace: null,
      workspaceRoot: null,
      sessionRoot: `mesh:${connectionId}`,
      readiness,
      session,
      // No header of its own (owner, 2026-10-08): the tab names the agent and
      // wears the machine's mark, and the strip under the composer marks the
      // machine again; a third line saying both was the same fact once more.
      ...(engine ? { engine } : {}),
      hostQueue: { machineName, messages: hostQueued },
      ...(capabilities.hostSchedule ? { hostSchedule: { machineName, messages: hostScheduled } } : {}),
      ...(hostUsageLimits ? { hostUsageLimits } : {}),
      listed,
      ...(subagent
        ? {
            subagent: {
              parentAgentId: subagent.parentAgentId,
              parentName: subagent.parentName,
              onGoToParent: subagent.onGoToParent,
              ...(access !== null && access !== 'operate'
                ? { blocked: `This pairing may follow this chat on ${machineName} but not drive it.` }
                : {}),
            },
          }
        : {}),
    }),
    [
      subagent,
      access,
      fields,
      displayTitle,
      thread,
      update,
      connectionId,
      readiness,
      session,
      engine,
      machineName,
      hostQueued,
      capabilities.hostSchedule,
      hostScheduled,
      hostUsageLimits,
      listed,
    ],
  )

  // The panel beside it reads the chat through this transport, as it reads a
  // local chat through its record.
  const subagentOf = subagent?.parentAgentId
  useEffect(
    () =>
      publishRemoteChat(workspaceId, {
        agentId: remoteAgentId,
        ...(subagentOf ? { subagentOf } : {}),
        key,
        machineName,
        hostChanges: capabilities.hostChanges,
        transport,
        binding,
        subagents: hostSubagents,
        subagentTransport,
      }),
    [
      workspaceId,
      remoteAgentId,
      subagentOf,
      key,
      machineName,
      capabilities.hostChanges,
      transport,
      binding,
      hostSubagents,
      subagentTransport,
    ],
  )

  const chat = (
    <ConversationTransportProvider value={transport}>
      <ChatViewErrorBoundary chatKey={`${connectionId}:${remoteWorkspaceId}:${remoteAgentId}`}>
        <ConversationChatBody
          key={`${connectionId}:${remoteWorkspaceId}:${remoteAgentId}`}
          workspaceId={workspaceId}
          agentId={remoteAgentId}
          binding={binding}
        />
      </ChatViewErrorBoundary>
    </ConversationTransportProvider>
  )
  if (subagent) return chat
  return (
    <SubagentChatHost
      workspaceId={workspaceId}
      rootAgentId={remoteAgentId}
      rootName={displayTitle}
      chatName={(id) => hostSubagents.find((row) => row.agentId === id)?.title}
      renderChat={({ agentId, parentAgentId, parentName, crumbs, onCrumb, onBack }) => {
        const row = hostSubagents.find((candidate) => candidate.agentId === agentId)
        if (!row) return <SubagentGone words={`${machineName} no longer lists this subagent.`} onBack={onBack} />
        const [shown] = studioSubagentsOf([row])
        return (
          <>
            <SubagentViewHeader
              crumbs={crumbs}
              name={row.title}
              facts={subagentFacts(cliForConversationProvider(row.providerId), row.modelId)}
              status={shown ? <SubagentStatusWords subagent={shown} /> : undefined}
              onCrumb={onCrumb}
            />
            <SubagentEndNotice error={row.error ?? null} />
            <div className="min-h-0 flex-1">
              <RemoteConversationPanel
                workspaceId={workspaceId}
                connectionId={connectionId}
                machineName={machineName}
                remoteWorkspaceId={remoteWorkspaceId}
                remoteAgentId={agentId}
                title={row.title}
                subagent={{ row, parentAgentId, parentName, onGoToParent: onBack }}
              />
            </div>
          </>
        )
      }}
    >
      {chat}
    </SubagentChatHost>
  )
}
