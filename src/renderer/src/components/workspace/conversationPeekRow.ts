import { isSessionWorking } from '../../hooks/useTerminalSessions'
import { formatRelativeMs } from '../../utils/relativeTime'
import type { TerminalSessionSnapshot } from '../../../../shared/electron-api'
import type { ConversationSessionSummary } from '../../../../shared/conversation-runtime'
import { conversationSummaryPhase } from '../../../../shared/conversation/phase'
import type { AgentCli, AgentState, Workspace } from '../../../../shared/workspace'
import type {
  ConversationPeekIdentity,
  ConversationPeekMachine,
  ConversationPeekPlace,
  ConversationPeekServer,
  ConversationPeekStatus,
} from './ConversationPeekCard'
import type { BranchPullRequest } from '../../../../shared/git/pull-request'
import { executionHostLabel, isWslHostId, LOCAL_HOST_ID } from '../../../../shared/execution-host'
import { cliForConversationProvider } from '../../../../shared/conversation-harness'
import type { RemoteSessionRow } from './remoteBand/remoteSessionsModel'
import { copy } from '../../../../shared/copy'

// What a SIDEBAR ROW knows about the conversations behind it.
//
// ONE CARD PER AGENT (owner, 2026-09-09). A row is a CHAT and may hold several
// terminals, so this resolves ONE IDENTITY PER TERMINAL rather than a roster
// the card selects from: the sidebar already lists a chat's agents as its own
// sub-lines, and the person points at the one they mean. The shell picks the
// identity whose session the pointer is on (`data-peek-session`) and falls back
// to the first — which is the whole of a single-agent row, where the row and
// the agent are the same thing.
//
// Nothing is merged. Three terminals are three conversations that happen to
// share a folder, and a single thread stitched from all three reads as one
// conversation that never happened.
//
// Pure: props in, a value out. The row renders it; the tests read it.

/** A row's live state, in the peek header's terse voice. */
export type ConversationPeekRowActivity = 'needs-input' | 'working' | 'failed' | 'idle'

/**
 * How recently a session did anything. The same three timestamps the row's own
 * terminal lines rank on, folded to one number: a session that has never
 * spoken still sorts by when it started, so the ordering is total.
 */
export function activityAt(session: TerminalSessionSnapshot): number {
  return Math.max(session.lastInputAt ?? 0, session.lastOutputAt ?? 0, session.startedAt)
}

/**
 * ONE terminal's own state, for a row that holds more than one.
 *
 * Idle says how long, from the same three timestamps the ordering uses, because
 * a bare "Idle" on a card opened from a chat you last touched in March says
 * nothing. The row's own status (see `peekStatusOf`) is better than this
 * wherever there is only one terminal — it knows about needs-input, which a
 * session snapshot alone does not — so that is what a single-agent row uses.
 */
function agentStatusOf(session: TerminalSessionSnapshot | null, now: number): ConversationPeekStatus {
  if (!session) return { kind: 'attention', label: copy.workspace.conversationPeekRow.parked }
  // Working needs a process to do it in (`isSessionWorking`). A session paused
  // mid-turn keeps its working stamp, and unguarded that stamp outranked the
  // `Paused` branch below — the card said "Working" about a dead pty.
  if (isSessionWorking(session)) return { kind: 'working', label: copy.workspace.conversationPeekRow.working }
  if (session.activity?.kind === 'failed')
    return { kind: 'attention', label: copy.workspace.conversationPeekRow.failed }
  if (session.exitedAt !== null) return { kind: 'idle', label: copy.workspace.conversationPeekRow.exited }
  if (session.suspended) return { kind: 'attention', label: copy.workspace.conversationPeekRow.paused }
  const idleFor = formatRelativeMs(activityAt(session), now)
  return {
    kind: 'idle',
    label: idleFor ? copy.workspace.conversationPeekRow.idle(idleFor) : copy.workspace.conversationPeekRow.idle2,
  }
}

/**
 * The header's status cluster for the ROW as a whole. Deliberately terser than
 * the tab's — a row is read in a list of forty, and "Workspace agents working"
 * is a sentence where the tab card has room for one. Idle says how long only
 * when the row already knows; a bare "Idle" beside a chat you last touched in
 * March says nothing.
 */
export function peekStatusOf(activity: ConversationPeekRowActivity, idleFor: string): ConversationPeekStatus {
  if (activity === 'needs-input') return { kind: 'attention', label: copy.workspace.conversationPeekRow.waiting }
  if (activity === 'working') return { kind: 'working', label: copy.workspace.conversationPeekRow.working }
  if (activity === 'failed') return { kind: 'attention', label: copy.workspace.conversationPeekRow.failed }
  if (idleFor) return { kind: 'idle', label: copy.workspace.conversationPeekRow.idle(idleFor) }
  return { kind: 'idle', label: copy.workspace.conversationPeekRow.idle2 }
}

type PlaceWorkspace = Partial<Pick<Workspace, 'hostId' | 'environment' | 'worktree' | 'remoteOrigin'>>

/**
 * The machine a chat runs on, by the one rule the workspace records: a chat
 * born on a paired machine is that machine's, one on an SSH machine is that
 * one's, and everything else runs in one of this computer's WSL hosts or on
 * this computer itself — which is null, because local is the unmarked default.
 */
export function peekMachineOf(workspace: PlaceWorkspace, platform: string): ConversationPeekMachine | null {
  if (workspace.remoteOrigin) return { label: workspace.remoteOrigin.machineName, kind: 'remote' }
  if (workspace.environment) return { label: workspace.environment.label, kind: 'remote' }
  const hostId = workspace.hostId ?? LOCAL_HOST_ID
  return isWslHostId(hostId) ? { label: executionHostLabel(hostId, platform), kind: 'wsl' } : null
}

/**
 * Where one agent of the chat runs. The branch is the one its own hooks last
 * SAW it on when there is such a reading — an agent that switched branch is on
 * the new one — and otherwise the branch the chat was made on.
 */
export function peekPlaceOf(
  workspace: PlaceWorkspace,
  session: Pick<TerminalSessionSnapshot, 'observedCheckout'> | null,
  platform: string,
): ConversationPeekPlace {
  const observed = session?.observedCheckout?.resolved ? session.observedCheckout.branch : null
  return {
    machine: peekMachineOf(workspace, platform),
    branch:
      observed?.trim() ||
      workspace.worktree?.branch?.trim() ||
      workspace.remoteOrigin?.checkout?.branch?.trim() ||
      null,
  }
}

/**
 * One card per terminal this row can peek at, live first and then most recently
 * active — which is also why the FIRST entry is the one a row with no hovered
 * agent line opens on. Not the first by name or by id: an arbitrary answer
 * dressed up as a considered one.
 *
 * Built from the two sources the peek already resolves — the sessions main
 * knows about and the row's own parked agent records — deduplicated by session
 * id, so an agent that is both a tracked session and a persisted record appears
 * once.
 *
 * Shells are not in it: a plain terminal has no conversation. Neither is an
 * agent record that has never launched — no prompts and no sidecar by
 * construction, so main would answer `none` and the card would call a Claude
 * Code chat a runtime that cannot report.
 *
 * The `live` arm is load-bearing now that the caller hands over every session
 * main knows about rather than only the running ones: a chat with a finished
 * agent and a running one opens on the running one.
 *
 * `status` is the ROW's own answer and is used only where the row holds one
 * terminal, because there the row and the agent are the same thing and the row
 * knows more (needs-input, and its own idle clock). Where there are several,
 * each card says its own agent's state — the point of the ruling.
 *
 * `sessions` is every session main knows about for this row, NOT only the ones
 * with a living process — a peek is asked for most about the chat that is not
 * running.
 *
 * Empty when the row has no conversation to peek at, which is the caller's
 * signal to draw no card at all.
 */
export function rowConversationPeekIdentities(input: {
  workspace: Pick<Workspace, 'name'> & PlaceWorkspace & { agents?: Record<string, AgentState> }
  sessions: ReadonlyArray<TerminalSessionSnapshot>
  conversations?: ReadonlyArray<ConversationSessionSummary>
  status: ConversationPeekStatus
  now: number
  /** The OS the Studio server runs on, which names this computer ("This Mac"). */
  platform: string
  /**
   * The pull requests the Studio's record files under each of the row's
   * conversations (`pullRequests.list` by conversation), by agent id. A chat's
   * card lists its own; a terminal agent's snapshot already carries its own.
   */
  pullRequestsByAgent?: Readonly<Record<string, readonly BranchPullRequest[]>>
  /** The row's pull requests by workspace, for a row with one agent whose own list is empty. */
  rowPullRequests?: readonly BranchPullRequest[]
  /** The local servers the chat's agents started (`localServers.list` by workspace). */
  servers?: readonly ConversationPeekServer[]
  /** Goes to one agent's own view. */
  openAgent?: (agentId: string, name: string) => void
  /** Opens one of the chat's servers. */
  openServer?: (server: ConversationPeekServer) => void
}): ConversationPeekIdentity[] {
  const openOf = (agentId: string | null | undefined, name: string) =>
    agentId && input.openAgent ? () => input.openAgent?.(agentId, name) : null
  const pullRequestsOf = (agentId: string | null | undefined): BranchPullRequest[] => [
    ...((agentId && input.pullRequestsByAgent?.[agentId]) || []),
  ]
  const held = {
    ...(input.servers && input.servers.length > 0 ? { servers: input.servers } : {}),
    ...(input.openServer ? { openServer: input.openServer } : {}),
  }
  const agents = input.workspace.agents
  const byId = new Map<string, { identity: ConversationPeekIdentity; live: boolean; at: number }>()
  // Which agents already have a session on the list. Deduplicating by session
  // id alone is not enough: an agent record's `cliSessionId` is the id it was
  // LAST launched under, and a relaunch mints a new one — so a stale record
  // would put the same person on the list twice, live and parked, under one
  // name. The agent is the unit; the session is how we ask about it.
  const seenAgents = new Set<string>()

  for (const session of input.sessions) {
    if (session.kind !== 'agent') continue
    if (session.agentId) seenAgents.add(session.agentId)
    const record = session.agentId ? agents?.[session.agentId] : undefined
    const agentName = record?.name ?? null
    byId.set(session.sessionId, {
      identity: {
        // The ROW's title, not the agent's: the card opens out of the row and
        // has to be recognisable as that row's card (mockup frame 3, where the
        // card opened from an agent line still names the chat).
        name: input.workspace.name,
        place: peekPlaceOf(input.workspace, session, input.platform),
        status: agentStatusOf(session, input.now),
        open: openOf(session.agentId ?? record?.id, agentName ?? input.workspace.name),
        ...held,
        agent: {
          sessionId: session.sessionId,
          name: agentName,
          agentId: session.agentId ?? record?.id ?? null,
          cli: record?.cli ?? session.cli ?? null,
          model: record?.cliModel ?? null,
          // What this conversation produced (epic pull-request-marks): main's
          // own union of the branch's pull requests and the ones this session
          // opened itself in any repository. Absent on an older snapshot, and
          // an absent answer draws exactly what an empty one draws.
          pullRequests: session.pullRequests?.length ? session.pullRequests : pullRequestsOf(session.agentId),
          activeSubagents: session.activeSubagents ?? 0,
          contextUsage: session.contextUsage ?? null,
        },
      },
      live: session.exitedAt === null,
      at: activityAt(session),
    })
  }

  for (const session of input.conversations ?? []) {
    const phase = conversationSummaryPhase(session)
    const agentName = agents?.[session.agentId]?.name ?? session.displayName ?? null
    byId.set(session.sessionId, {
      identity: {
        name: input.workspace.name,
        place: peekPlaceOf(input.workspace, null, input.platform),
        open: openOf(session.agentId, agentName ?? input.workspace.name),
        ...held,
        status:
          phase === 'running' || phase === 'starting'
            ? { kind: 'working', label: copy.workspace.conversationPeekRow.working }
            : phase === 'waiting_for_approval'
              ? { kind: 'attention', label: copy.workspace.conversationPeekRow.needsApproval }
              : phase === 'waiting_for_input'
                ? { kind: 'attention', label: copy.workspace.conversationPeekRow.askedAQuestion }
                : phase === 'failed'
                  ? { kind: 'attention', label: copy.workspace.conversationPeekRow.failed }
                  : { kind: 'idle', label: copy.workspace.conversationPeekRow.idle2 },
        agent: {
          sessionId: session.sessionId,
          name: agentName,
          agentId: session.agentId,
          cli: cliForConversationProvider(session.providerId) as AgentCli | null,
          model: session.modelId,
          // The ones the record files under this conversation: what its own
          // line in the sidebar wears.
          pullRequests: pullRequestsOf(session.agentId),
          activeSubagents: session.backgroundAgents ?? 0,
          contextUsage: null,
        },
      },
      live: phase !== 'completed',
      at: session.updatedAt,
    })
    seenAgents.add(session.agentId)
  }

  // Parked records, for the chats main's session list has never heard of. Never
  // for a chat that belongs to a paired machine: its ids are that machine's, and
  // this main has neither a session nor a sidecar under any of them.
  if (!input.workspace.remoteOrigin) {
    for (const record of Object.values(agents ?? {})) {
      const sessionId = record.cliSessionId
      if (!sessionId || record.cliHasLaunched !== true) continue
      if (byId.has(sessionId) || seenAgents.has(record.id)) continue
      byId.set(sessionId, {
        identity: {
          name: input.workspace.name,
          place: peekPlaceOf(input.workspace, null, input.platform),
          status: agentStatusOf(null, input.now),
          open: openOf(record.id, record.name || input.workspace.name),
          ...held,
          agent: {
            sessionId,
            name: record.name || null,
            agentId: record.id,
            cli: record.cli ?? null,
            model: record.cliModel ?? null,
            // A parked record is not a session: main holds no ledger for it.
            // Its pull requests are the conversation's in the Studio's record,
            // which files them by agent whether or not anything is running.
            pullRequests: pullRequestsOf(record.id),
            activeSubagents: 0,
            contextUsage: null,
          },
        },
        live: false,
        at: record.cliLastExitedAt ?? 0,
      })
    }
  }

  const ordered = [...byId.values()]
    .sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1
      if (a.at !== b.at) return b.at - a.at
      return a.identity.agent.sessionId.localeCompare(b.identity.agent.sessionId)
    })
    .map((entry) => entry.identity)

  // One terminal: the row IS the agent, so the row's own status wins — it knows
  // about needs-input, and its idle clock is the one the row is already showing.
  // Its pull requests are the row's too where its own list is empty: the
  // record files a pull request under the workspace when it cannot tell which
  // of its agents opened it, and the row's mark already wears those.
  const only = ordered[0]
  if (ordered.length === 1 && only) {
    const rowPullRequests = input.rowPullRequests ?? []
    return [
      {
        ...only,
        status: input.status,
        agent:
          only.agent.pullRequests.length === 0 && rowPullRequests.length > 0
            ? { ...only.agent, pullRequests: [...rowPullRequests] }
            : only.agent,
      },
    ]
  }
  return ordered
}

/** What a paired machine lists of one agent of its chat: the fields of a band row the card reads. */
export type RemotePeekAgent = Pick<
  RemoteSessionRow,
  'sessionId' | 'title' | 'cli' | 'phase' | 'activity' | 'since' | 'branch' | 'pullRequests' | 'lastTurnEndedAt'
> &
  Partial<Pick<RemoteSessionRow, 'modelId' | 'localServers' | 'backgroundAgents'>>

/** A listed agent's state, in the corner's words: the phase its machine listed, as a local chat's card says it. */
function remoteStatusOf(row: RemotePeekAgent): ConversationPeekStatus {
  if (row.activity === 'working') return { kind: 'working', label: copy.workspace.conversationPeekRow.working }
  if (row.activity === 'needs-input')
    return {
      kind: 'attention',
      label:
        row.phase === 'waiting_for_input'
          ? copy.workspace.conversationPeekRow.askedAQuestion
          : copy.workspace.conversationPeekRow.needsApproval,
    }
  if (row.phase === 'failed') return { kind: 'attention', label: copy.workspace.conversationPeekRow.failed }
  const since = row.lastTurnEndedAt ?? row.since
  return since !== null
    ? {
        kind: 'idle',
        label: copy.workspace.conversationPeekRow.idle2,
        aged: { label: copy.workspace.conversationPeekRow.idle2, since },
      }
    : { kind: 'idle', label: copy.workspace.conversationPeekRow.idle2 }
}

/**
 * One card per agent of a chat on a paired machine, built from what that
 * machine's list carries and nothing of this computer's: its agents, their
 * branch and model, the pull requests the chat opened and the local servers
 * its agents started there, as the machine last recorded them, and how many
 * sub-agents are out. The same card a local chat's row opens, so a chat reads
 * the same whichever machine it runs on.
 *
 * Its servers are listed and not opened: an address an agent gave there
 * (`localhost:5173`) is that machine's own, and opens only there. A row goes
 * to its agent through `openAgent`, which follows it in a pane here.
 */
export function remoteConversationPeekIdentities<Row extends RemotePeekAgent>(input: {
  /** The chat's title, as its machine's sidebar shows it. */
  name: string
  machineName: string
  agents: readonly Row[]
  openAgent?: (row: Row) => void
}): ConversationPeekIdentity[] {
  return input.agents.map((row) => ({
    name: input.name,
    place: { machine: { label: input.machineName, kind: 'remote' }, branch: row.branch?.trim() || null },
    status: remoteStatusOf(row),
    open: input.openAgent ? () => input.openAgent?.(row) : null,
    ...(row.localServers && row.localServers.length > 0 ? { servers: row.localServers } : {}),
    agent: {
      sessionId: row.sessionId,
      name: row.title,
      cli: row.cli as AgentCli | null,
      model: row.modelId ?? null,
      pullRequests: row.pullRequests,
      activeSubagents: row.backgroundAgents ?? 0,
      // The list carries no context reading; a line at 0% would claim one.
      contextUsage: null,
    },
  }))
}
