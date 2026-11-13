import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'

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
  STUDIO_CONVERSATIONS_CAPABILITY,
  STUDIO_WORKSPACES_CAPABILITY,
  type StudioLocalServer,
  type StudioWelcomeFrame,
} from '../../../../../../packages/studio-protocol/src/public'
import { formatChatAddress, isEnvironmentId } from '../../../../../../packages/studio-protocol/src/environment'
import type {
  MeshConversation,
  MeshConversationAccess,
  MeshConversationKey,
  MeshSubagent,
} from '../../../../../shared/tailnet-mesh'
import type { CliRuntimeOption } from '../../ui/CliModelPicker'
import {
  publishRemoteConversationList,
  useRemoteConversationFactsOf,
} from '../../workspace/remoteBand/remoteConversationFacts'
import { ConversationChatBody } from '../AgentChatView'
import { remoteFileCountsOf } from '../../workspace/terminalLines'
import { environmentChatSourceFor, type EnvironmentChatSource } from '../../../studio/environmentChats'
import { pairedTarget } from '../../../studio/environmentStudio'
import { listPairedChats } from '../../../studio/pairedChats'
import { ChatViewErrorBoundary } from './ChatViewErrorBoundary'
import { useStudioChatHeld } from './chatServerHeld'
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
import { ConversationTransportProvider, type ConversationTransport } from './conversationTransport'
import { createPairedChatTransport, pairedCommandsKey } from './pairedChat'

// A conversation on a paired machine, in the regular chat view.
//
// The transcript, pending requests and composer are the chat view's own; what
// this pane adds is the transport (this window's own client of that
// machine's Studio, `pairedChat.ts`, which follows the conversation by its
// cursor, so a reconnect resumes rather than replays) and the agent fields a
// local chat keeps in its record. The machine is named on the tab and on the
// strip under the composer, so a keystroke here is never mistaken for one on
// this machine.
//
// Readiness is the connection's and the grant's: connected and allowed to
// operate is ready; connected and read-only shows the conversation with the
// composer closed and says why; a machine that is away keeps the transcript
// on screen and says so.

const NO_PULL_REQUESTS: readonly BranchPullRequest[] = []
const NO_LOCAL_SERVERS: readonly StudioLocalServer[] = []
const NO_SUBAGENTS: MeshSubagent[] = []

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

/** Whether the window is reaching that machine now: not yet, yes, or away with what it last said. */
type PairedLink = 'connecting' | 'live' | 'away'

function remoteConversationReadiness(
  link: PairedLink,
  access: MeshConversationAccess | null,
  machineName: string,
): ChatReadiness {
  if (link === 'connecting') return { kind: 'error', message: `Connecting to ${machineName}.` }
  if (link === 'away')
    return { kind: 'error', message: `${machineName} is not answering. This shows what it last said.` }
  if (access !== 'operate')
    return {
      kind: 'error',
      message: `This pairing may follow this conversation on ${machineName} but not drive it.`,
    }
  return { kind: 'ready' }
}

/** The machine's welcome, its chat source's snapshot, and how the window reaches it: read as they change. */
function usePairedSource(source: EnvironmentChatSource): { welcome: StudioWelcomeFrame | null; link: PairedLink } {
  const welcome = useSyncExternalStore(
    (listener) => source.watchOpen(listener),
    () => source.welcome(),
    () => source.welcome(),
  )
  const stale = useSyncExternalStore(
    (listener) => source.subscribe(listener),
    () => source.snapshot().stale,
    () => source.snapshot().stale,
  )
  return { welcome, link: !welcome ? 'connecting' : stale ? 'away' : 'live' }
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

/** What the machine a chat runs on said it takes, each read from its welcome. */
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
 * What the machine takes for its chats' sessions, from what its Studio's
 * welcome serves: each still needs the chat's provider to be able, which its
 * row says.
 */
function remoteSessionFeatures(welcome: StudioWelcomeFrame | null): Omit<RemoteSessionFeatures, 'modelSwitch'> {
  const conversation = welcome?.conversation.capabilities ?? []
  const has = (name: string) => conversation.includes(name)
  return {
    stopSubagents: has(CONVERSATION_STOP_SUBAGENT_CAPABILITY),
    messageSubagents: has(CONVERSATION_AGENT_MESSAGE_CAPABILITY),
    handoff: has(CONVERSATION_HANDOFF_CAPABILITY),
    // Its skills are listed by its workspaces' extensions, and a send carries them.
    sendSkills:
      has(CONVERSATION_SEND_SKILLS_CAPABILITY) &&
      (welcome?.capabilities.includes(STUDIO_WORKSPACES_CAPABILITY) ?? false),
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
  // This window's client of that machine, shared with the list of its chats.
  const source = useMemo(
    () => environmentChatSourceFor(pairedTarget({ id: connectionId, machineName })),
    [connectionId, machineName],
  )
  const { welcome, link } = usePairedSource(source)
  const seedThread = useMemo(() => (subagent ? threadOfSubagent(subagent.row) : null), [subagent])
  const [listedThread, setThread] = useState<MeshConversation | null>(null)
  const thread = listedThread ?? seedThread
  // Bumped after an accepted model switch, so the list is read again and the
  // chip names what the machine says the chat is now on.
  const [listVersion, setListVersion] = useState(0)
  const features = useMemo(() => remoteSessionFeatures(welcome), [welcome])

  // One transport per conversation, never rebuilt on a grant change: a new
  // transport is a new subscription. Its capabilities read the welcome as it is now.
  const transport = useMemo(() => {
    const base = createPairedChatTransport({
      key,
      machineName,
      // A pull request Create PR opened there is in the machine's list now:
      // read it again, so the strip says "Open PR #N" without waiting for the
      // sidebar's next read.
      onPullRequestRecorded: () => setListVersion((version) => version + 1),
    })
    const setModel = base.setModel
    const setEffort = base.setReasoningEffort
    const send = base.send
    const unwatchPullRequest = base.unwatchPullRequest
    // Spread with its own getters kept: `...base` would copy the capabilities
    // and the environment as they are now.
    return Object.defineProperties(
      {
        ...base,
        // A chat at rest over there is listed without a session, and so without
        // what it can do: its first message wakes one, and the list is read
        // again once that message is answered.
        send: async (turn: Parameters<typeof send>[0]) => {
          const result = await send(turn)
          if (result.ok) setListVersion((version) => version + 1)
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
      {
        capabilities: Object.getOwnPropertyDescriptor(base, 'capabilities')!,
        environment: Object.getOwnPropertyDescriptor(base, 'environment')!,
      },
    ) as ConversationTransport
  }, [key, machineName])
  const capabilities = transport.capabilities
  // What this pairing may do there: its grant, as the machine's welcome says it.
  const access: MeshConversationAccess | null = welcome ? (capabilities.operate ? 'operate' : 'read') : null
  const modelSwitch = capabilities.modelSwitch && Boolean(thread?.models)

  // A sub-agent is a chat of its own over there, followed by its own ids: what
  // the panel reads of one, and the answer to what it asks, go through this.
  const subagentTransport = useMemo(() => {
    const made = new Map<string, ConversationTransport>()
    return (agentId: string): ConversationTransport => {
      const existing = made.get(agentId)
      if (existing) return existing
      const transport = createPairedChatTransport({ key: { ...key, agentId }, machineName })
      made.set(agentId, transport)
      return transport
    }
  }, [key, machineName])

  // The machine's list names the conversation's title, model and what its
  // provider can do. Read on open, whenever the window reaches the machine
  // again, and whenever its chats move there (the source's list is read
  // again then too). Not while it is away: it would only wait out its timeout.
  const listedAt = useSyncExternalStore(
    (listener) => source.subscribe(listener),
    () => source.snapshot(),
    () => source.snapshot(),
  )
  useEffect(() => {
    if (link !== 'live') return
    let cancelled = false
    void listPairedChats({ id: connectionId, machineName }).then((result) => {
      if (cancelled || !result.ok) return
      // The pane's tab reads its mark, model and clock off this list too.
      publishRemoteConversationList(connectionId, result.conversations)
      setThread(
        result.conversations.find(
          (entry) => entry.workspaceId === remoteWorkspaceId && entry.agentId === remoteAgentId,
        ) ?? null,
      )
    })
    return () => {
      cancelled = true
    }
  }, [connectionId, machineName, remoteWorkspaceId, remoteAgentId, link, listVersion, listedAt])

  // The chat's live session there, as that machine's sessions list it: what it
  // can do now, from its own Studio. A chat at rest has none listed.
  const liveSession = useMemo(() => {
    const environmentId = listedAt.environmentId
    if (!environmentId || !isEnvironmentId(environmentId)) return null
    const sessions = listedAt.byAddress.get(formatChatAddress({ environmentId, chatId: remoteWorkspaceId })) ?? []
    return sessions.find((candidate) => candidate.agentId === remoteAgentId) ?? null
  }, [listedAt, remoteWorkspaceId, remoteAgentId])

  // What the machine holds for the chat beside its turn, and its sub-agents,
  // on the chat's own push topics there.
  const heldKey = useMemo(
    () => ({ workspaceId: remoteWorkspaceId, agentId: remoteAgentId }),
    [remoteWorkspaceId, remoteAgentId],
  )
  const held = useStudioChatHeld(heldKey, transport.services.followPush, machineName)
  const [hostSubagents, setHostSubagents] = useState<MeshSubagent[]>(NO_SUBAGENTS)
  useEffect(() => {
    setHostSubagents(NO_SUBAGENTS)
    const follow = transport.services.followPush
    if (!follow) return
    return follow({
      topic: 'conversation.subagents',
      params: { key: heldKey },
      capability: STUDIO_CONVERSATIONS_CAPABILITY,
      onPayload: (frame) => setHostSubagents(frame.subagents),
    })
  }, [transport, heldKey])

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
  const displayTitle = thread?.title || title || 'Conversation'
  // Its live session as that machine lists it, where it has one; else what
  // its list row says it can do, as a session a send there wakes.
  const session = useMemo(
    () => liveSession ?? remoteConversationSession(thread, key, { ...features, modelSwitch }),
    [liveSession, thread, key, features, modelSwitch],
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
      // No folder of this disk: the chat itself, which its `/` list is kept under here.
      sessionRoot: pairedCommandsKey(key),
      readiness,
      session,
      // No header of its own (owner, 2026-10-08): the tab names the agent and
      // wears the machine's mark, and the strip under the composer marks the
      // machine again; a third line saying both was the same fact once more.
      ...(engine ? { engine } : {}),
      hostQueue: held.hostQueue,
      ...(capabilities.hostSchedule ? { hostSchedule: held.hostSchedule } : {}),
      ...(capabilities.hostUsageLimits && held.hostUsageLimits ? { hostUsageLimits: held.hostUsageLimits } : {}),
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
      key,
      readiness,
      session,
      engine,
      machineName,
      held,
      capabilities.hostSchedule,
      capabilities.hostUsageLimits,
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
