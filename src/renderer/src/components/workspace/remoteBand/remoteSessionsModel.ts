import type { RepositoryIdentity } from '../../../../../shared/repository-identity'
import type { StudioLocalServer } from '../../../../../../packages/studio-protocol/src/public'
import { cliForConversationProvider } from '../../../../../shared/conversation-harness'
import {
  meshConversationPresence,
  meshConversationSessionId,
  parseMeshConversationSessionId,
  type MeshBrowse,
  type MeshConversation,
  type MeshConversationAccess,
  type MeshConversationManage,
  type MeshConversationPaneSpec,
  type MeshWorkspace,
} from '../../../../../shared/tailnet-mesh'
import type {
  ConversationWireChanges,
  ConversationWirePullRequest,
} from '../../../../../../packages/conversation-protocol/src/public'
import { classifyPullRequestUrl } from '../../../../../shared/git/pr-url'
import { pullRequestRepository, type BranchPullRequest } from '../../../../../shared/git/pull-request'
import type { Workspace, WorkspaceHighlight, WorkspaceRemoteOrigin } from '../../../../../shared/workspace'
import { workspaceLastUserMessageAt } from '../../../utils/workspaceRecency'
import { finishedUnseen } from '../../../../../shared/workspace-lifecycle'
import type { Tone } from '../../ui'
import { environmentOfRoute, type EnvironmentEntry } from '../../../../../shared/environments'
import {
  formatChatAddress,
  isEnvironmentId,
  parseEnvironmentRoute,
} from '../../../../../../packages/studio-protocol/src/environment'
import { workspaceProjectRootOf } from '../../../utils/workspaceWorktree'
import { environmentTargetOf } from '../../panels/agentChat/environmentChat'
import { pairedRoute } from '../../../studio/environmentStudio'
import {
  environmentStatus,
  type EnvironmentStatusKind,
} from '../../../../../../packages/client-runtime/src/environments/environmentStatus'
import { copy as appCopy } from '../../../../../shared/copy'
import { remoteLastKnownOf, type RemoteLastKnown } from './remoteListFreshness'
import type { EnvironmentListFailure } from '../../../studio/environmentChatsFreshness'

// The sidebar's rows of every other environment's chats (design-environments
// PR 3): each followed environment's (a paired desktop, an SSH machine, a WSL
// distribution) chats, by their address, as its own Studio lists them
// (`environmentChats.ts`). DOM-free, so the rules (which chats are rows, what
// each row wears, which record here opening one focuses) are tested without
// mounting the tree. Nothing here asks what kind of machine a chat is on.
//
// A record this window keeps of one of those chats (an SSH or WSL copy, a
// paired chat attached here) is never a row of its own: the chat's address
// row is, and opening it focuses that record (`chatRecordsByAddress`). That
// bridge goes once windows arrange chats by address.

/** One machine's last read, as the hook holds it. */
export type RemoteBrowseEntry = {
  /** The newest browse that answered. Kept across a machine going quiet, so its rows stay on screen dimmed. */
  browse: MeshBrowse | null
  loading: boolean
  /** Why the newest read did not answer; null when it did. */
  error: string | null
  /** Epoch ms of the newest read that settled, or null before the first. */
  at: number | null
  /**
   * The chat conversations the machine listed on the newest read that could
   * list them; absent before one has. A pairing without conversation access,
   * or a machine that does not serve them, simply has none.
   */
  conversations?: MeshConversation[]
  /**
   * The machine's Studio keeps its chats' records for this one
   * (`chat-lifecycle`): their rest and read state, and the row menu's marks.
   * Absent before a browse has reached its Studio.
   */
  lifecycle?: boolean
  /** What the pairing may do with the machine's chats, as its newest list said. Absent before a list. */
  access?: MeshConversationAccess
  /** What of its chats' management the machine takes from here, as its Studio's welcome said. Absent before a browse. */
  manage?: MeshConversationManage
  /** Epoch ms of the newest read that listed its chats (or got a refusal that is the answer); absent before one. */
  listedAt?: number
  /**
   * Why the newest read of its chats did not replace them, or null when it
   * did: the rows are then a last-known list (`remoteLastKnownOf`).
   */
  listFailure?: EnvironmentListFailure | null
}

/** No chat management from here: a machine before it, or a pairing that may only follow. */
export const NO_CHAT_MANAGE: MeshConversationManage = {
  rename: false,
  autoCompact: false,
  unwatchPullRequest: false,
  deleteSettled: false,
  search: false,
}

/** What of its chats' management a machine's Studio takes from here, from what its welcome serves. */
export function chatManageOf(record: { lifecycle: boolean; unwatchPullRequest: boolean }): MeshConversationManage {
  return {
    rename: record.lifecycle,
    autoCompact: record.lifecycle,
    unwatchPullRequest: record.unwatchPullRequest,
    deleteSettled: record.lifecycle,
    search: record.lifecycle,
  }
}

/** What of a machine's chats' management this pairing may ask for: what it takes, where the pairing may drive. */
export function remoteManageWritable(entry: RemoteBrowseEntry | undefined): MeshConversationManage {
  if (!entry?.manage || entry.access !== 'operate') return NO_CHAT_MANAGE
  return { ...NO_CHAT_MANAGE, ...entry.manage }
}

/** What a machine's row menu may do from here, for each of its chats. */
type RemoteRowWrites = { lifecycle: boolean; rowMenu: boolean; markUnread: boolean; manage: MeshConversationManage }

/**
 * Whether this pairing may write a machine's chats' rest and read state:
 * the machine keeps them, and the pairing may drive its chats. Settling one
 * and saying one is on screen need `conversation:operate` there; a pairing
 * that may only follow them would be refused every time, and a visit is
 * stamped every few seconds.
 */
export function remoteLifecycleWritable(entry: RemoteBrowseEntry | undefined): boolean {
  return entry?.lifecycle === true && entry.access === 'operate'
}

/**
 * What a remote conversation is doing, in the local rows' vocabulary (owner
 * ruling 2026-09-05: the band reuses the marks local rows already have — the
 * working mark and elapsed, the gold surface for needs-input, a quiet time
 * for idle — and invents no dot of its own).
 */
type RemoteRowActivity = 'working' | 'needs-input' | 'idle'

/** A chat on a paired machine — one AGENT, a line on its conversation's row. */
export type RemoteSessionRow = {
  key: string
  /** The environment's route the row was read over (`formatEnvironmentRoute`). */
  route: string
  machineName: string
  sessionId: string
  /** The conversation's agent id over there. */
  remoteAgentId: string
  /**
   * The agent's own name ("Gael Corry"), or the kind when the remote has not
   * named it. This is a LINE's name, not a row's: it used to be the row title,
   * which is why the sidebar's remote rows read as a list of strangers instead
   * of a list of conversations (owner, 2026-09-11).
   */
  title: string
  /**
   * The CHAT's title, the one its own machine's sidebar shows: the list's
   * `chatTitle`, else the browse's name for its workspace, else the agent's
   * name when the machine gives neither.
   */
  chatTitle: string
  cli: string | null
  /** The remote workspace: its id, name, and folder there, and which repository that is. */
  workspaceId: string
  workspaceName: string | null
  workspaceRoot: string | null
  repository: RepositoryIdentity | null
  status: { label: string; tone: Tone }
  activity: RemoteRowActivity
  /** The phase the machine listed, which words the line: a wait for approval and a question are two waits. */
  phase: MeshConversation['phase']
  /** The opening of the agent's last reply, as its machine listed it; null from a machine that does not say. */
  replyPreview: string | null
  /** The branch the chat's folder is on over there; null from a machine that does not say, or off a branch. */
  branch: string | null
  /** The pull requests the chat opened, as its machine's record holds them, newest first. */
  pullRequests: BranchPullRequest[]
  /** The model the chat runs on over there; absent or null from a machine that does not say. */
  modelId?: string | null
  /** The local servers its agents linked over there, as that machine last checked them. */
  localServers?: StudioLocalServer[]
  /** Background agents the chat still has out over there; absent or 0 for none. */
  backgroundAgents?: number
  /** The files the chat's checkout carries over there; null from a machine that does not say, or a chat at rest. */
  changes: ConversationWireChanges | null
  /** The chat works in a worktree of its project over there. */
  worktree: boolean
  /** Epoch ms the activity began — how long it has worked, or sat idle. Null when the remote did not say. */
  since: number | null
  /**
   * Where the row sits: where its machine's own sidebar sits it
   * (`recencyAt`), which is when the person last wrote to the chat, else when
   * it was made or typed into there. A machine from before it said so gives
   * `lastUserMessageAt ?? updatedAt`. The same rule as a local row's, so a
   * remote row stays put until someone speaks.
   */
  recencyAt: number
  /** When a person last wrote to the chat, from any device, as its machine records it; null if never. */
  lastUserMessageAt: number | null
  /** When the chat's agent last finished a turn, and a person last had it on screen, on any device. */
  lastTurnEndedAt: number | null
  lastVisitedAt: number | null
  /** The schedule whose run started the chat over there, which its row marks; null for any other chat. */
  scheduledAgentId: string | null
  /** When the chat wakes, while it is snoozed over there; null from a machine that does not say, or awake. */
  snoozedUntil: number | null
  /**
   * The machine keeps this chat's rest and read state, and this pairing may
   * write them (`remoteLifecycleWritable`), so Settle may be offered for it
   * and a visit said.
   */
  lifecycle: boolean
  /** The chat's star and highlight colour, as its machine records them; null for neither. */
  highlight: WorkspaceHighlight | null
  /** Auto-settle is on for the chat over there. */
  autoSettle: boolean
  /**
   * Its machine takes the row menu's Star, Highlight color, Snooze and
   * Auto-settle from here (`remoteLifecycleWritable`).
   */
  rowMenu: boolean
  /** Its machine takes Mark unread from here (`remoteLifecycleWritable`). */
  markUnread: boolean
  /** What of the chat's management its machine takes from here (`remoteManageWritable`). */
  manage: MeshConversationManage
  /**
   * Whether its machine compacts the chat by itself before its cache
   * expires, by its own switch or that machine's default; null from a
   * machine that does not say.
   */
  autoCompact: boolean | null
  /** The chat is Claude's, the only one Auto compact works on yet. */
  claude: boolean
}

/**
 * A chat on another environment, as its row: the chat, by its address, and
 * the agents its environment lists in it.
 *
 * This is the unit the sidebar draws (owner, 2026-09-11): titled with its own
 * name, filed under its project like every other chat, and drawn with a line
 * per agent exactly as a local row is.
 */
export type RemoteConversation = {
  /** Its address (`<environmentId>:<chatId>`), or `<route>:<chatId>` while its environment has not said its id. */
  key: string
  /** Its address, once its environment has said its id. */
  address: string | null
  /** The route its environment is followed by. */
  route: string
  environmentId: string | null
  /**
   * The pairing a paired desktop's chat is reached over, which a pane opened
   * on it here still names; null on every other kind of machine.
   */
  connectionId: string | null
  machineName: string
  /** The chat's name over there. */
  title: string
  /** The chat's id there. */
  workspaceId: string
  /** The folder it stands in, on that machine's disk. */
  workspaceRoot: string | null
  /** The project it is in there: a worktree's checkout, else its folder. */
  projectFolder: string | null
  repository: RepositoryIdentity | null
  /** Its listed agents, a line each; none for a chat whose agents its environment does not list (or not yet). */
  agents: RemoteSessionRow[]
  /** What its agents are doing — what the row's marks report. */
  activity: RemoteRowActivity
  /** An agent's last turn there failed. */
  failed: boolean
  /** When that began, for the row's clock; null when the remote did not say. */
  since: number | null
  /** The record here that opening it focuses (`chatRecordsByAddress`), when there is one. */
  attachedWorkspaceId: string | null
  /** Read from an earlier read of an environment that is not answering now. */
  stale: boolean
  /** Its environment's list is a last-known one, and why. */
  lastKnown: RemoteLastKnown | null
  /** Its row's place in the list; see `RemoteSessionRow.recencyAt`. */
  recencyAt: number
  /** When a person last wrote to it, its agent last finished a turn, and a person last had it on screen. */
  lastUserMessageAt: number | null
  lastTurnEndedAt: number | null
  lastVisitedAt: number | null
  /** The schedule whose run started the chat over there; null for any other chat. */
  scheduledAgentId: string | null
  /** The chat's star and highlight colour over there; null for neither. */
  highlight: WorkspaceHighlight | null
  /** When the chat wakes, while it is snoozed over there. */
  snoozedUntil: number | null
  /** Auto-settle is on for the chat over there. */
  autoSettle: boolean
  /** Its environment keeps its rest and read state, and this device may write them: Settle and visits are asked of it. */
  lifecycle: boolean
  /** Its environment takes the row menu's marks from here (`RemoteSessionRow.rowMenu`). */
  rowMenu: boolean
  /** Its environment takes Mark unread from here. */
  markUnread: boolean
  /** What of the chat's management its environment takes from here (`RemoteSessionRow.manage`). */
  manage: MeshConversationManage
  /**
   * The Auto compact switch as its machine reads it, as a local chat's menu
   * draws it (`autoCompactSwitchOf`); null from a machine that does not say.
   */
  autoCompact: { on: boolean; claude: boolean } | null
}

/**
 * A listed chat's pull requests as a local line wears them. The list carries
 * a pull request's number, state, address and title; which repository it is
 * in is read off its address, as the local record reads it, and one whose
 * address names no pull request is left out rather than drawn wrong.
 */
export function branchPullRequestsOfWire(listed: readonly ConversationWirePullRequest[]): BranchPullRequest[] {
  return listed.flatMap((entry) => {
    const repository = pullRequestRepository(entry.url)
    const forge = classifyPullRequestUrl(entry.url)?.forge
    if (!repository || !forge) return []
    return [
      {
        url: entry.url,
        ...repository,
        number: entry.number,
        title: entry.title,
        state: entry.state,
        isDraft: false,
        openedAt: 0,
        stateAt: 0,
        ...(forge === 'github' ? {} : { forge }),
        // Watched there: the strip and the row say so, and offer Stop watching
        // where the machine takes it from here.
        ...(entry.watch ? { watch: { ...entry.watch } } : {}),
      },
    ]
  })
}

/**
 * The agent finished a turn nobody has had on screen since, on any device:
 * the green "finished while you were away" row a local chat wears, by the
 * rule a local row is marked by (`finishedUnseen`). Only a machine that keeps
 * its chats' read state can say so, and a chat with no visit recorded reads
 * as seen, as the list's contract has it. A chat snoozed over there is not
 * marked until it wakes, as its machine's own row is not.
 */
export function remoteFinishUnseen(
  row: Pick<RemoteSessionRow, 'activity' | 'lastTurnEndedAt' | 'lastVisitedAt'> &
    Partial<Pick<RemoteSessionRow, 'snoozedUntil'>>,
  now: number = Date.now(),
): boolean {
  if (typeof row.snoozedUntil === 'number' && row.snoozedUntil > now) return false
  return finishedUnseen({
    idle: row.activity === 'idle',
    finishedAt: row.lastTurnEndedAt,
    visitedAt: row.lastVisitedAt,
  })
}

/**
 * What opening a row asks the app to do: focus the record here that holds the
 * chat, or, until windows arrange chats by address, open one onto it.
 */
export type RemoteSessionOpenSpec = {
  route: string
  machineName: string
  /** A paired desktop's pairing, which a pane opened here onto the chat names; null on every other kind. */
  connectionId: string | null
  /** The chat's id there. */
  chatId: string
  /** The agent the pane follows first: the one asked for, else the chat's first listed; null when none is listed. */
  agent: { agentId: string; sessionId: string; title: string; cli: string | null } | null
  title: string
  workspaceName: string | null
  workspaceRoot: string | null
  repository: RepositoryIdentity | null
  attachedWorkspaceId: string | null
}

/**
 * A chat conversation on a paired machine, as a row: the same marks a local
 * row wears — working while a turn runs, the needs-input surface while it
 * waits on an approval or a question — titled with the chat's own name.
 */
function remoteChatRowOf(
  source: Pick<EnvironmentChatSourceView, 'route' | 'machineName'>,
  conversation: MeshConversation,
  browse: MeshBrowse | null,
  writes: RemoteRowWrites,
  lastKnown = false,
): RemoteSessionRow {
  const remoteWorkspace = browse?.workspaces.find((workspace) => workspace.id === conversation.workspaceId) ?? null
  const sessionId = meshConversationSessionId(conversation.workspaceId, conversation.agentId)
  // Its background work counts, as the machine's own sidebar counts it: a
  // chat whose turn is over while its agents or a monitor go on is working.
  // A row from a last-known list claims no live work: a turn that was running
  // when the machine stopped answering would otherwise wear the working mark
  // and its clock for as long as the machine stays away.
  const presence = lastKnown ? 'idle' : meshConversationPresence(conversation.phase, conversation.backgroundWork)
  const title = conversation.title || 'Conversation'
  // The chat's own title over there is its workspace's name there; the list
  // says it fresher than the browse does, and a machine from before the list
  // carried it leaves the browse's.
  const workspaceName = conversation.chatTitle?.trim() || remoteWorkspace?.name || null
  return {
    key: `${source.route}:${sessionId}`,
    route: source.route,
    machineName: source.machineName,
    sessionId,
    remoteAgentId: conversation.agentId,
    title,
    chatTitle: workspaceName ?? title,
    cli: cliForConversationProvider(conversation.providerId),
    workspaceId: conversation.workspaceId,
    workspaceName,
    workspaceRoot: remoteWorkspace?.folderPath ?? null,
    repository: remoteWorkspace?.repository ?? null,
    status:
      presence === 'running'
        ? { label: appCopy.workspace.remoteBand.remoteSessionsModel.running, tone: 'accent' }
        : presence === 'needs-input'
          ? { label: appCopy.workspace.remoteBand.remoteSessionsModel.needsApproval, tone: 'warn' }
          : conversation.phase === 'failed'
            ? { label: appCopy.workspace.remoteBand.remoteSessionsModel.failed, tone: 'error' }
            : { label: appCopy.workspace.remoteBand.remoteSessionsModel.done, tone: 'neutral' },
    activity: presence === 'running' ? 'working' : presence === 'needs-input' ? 'needs-input' : 'idle',
    phase: conversation.phase,
    replyPreview: conversation.lastAssistantText ?? null,
    branch: conversation.branch ?? null,
    pullRequests: branchPullRequestsOfWire(conversation.pullRequests ?? []),
    modelId: conversation.modelId?.trim() || null,
    // In the shape this computer's own record hands a list, under the chat's
    // agent there; what a server needs to run again is that machine's.
    localServers: (conversation.localServers ?? []).map((server) => ({
      ...server,
      agentId: conversation.agentId,
      linkedAt: 0,
      stateAt: 0,
    })),
    backgroundAgents: conversation.backgroundWork?.agents ?? 0,
    changes: conversation.changes ?? null,
    worktree: conversation.worktree === true,
    // A working chat counts from when its stretch of work began, the number
    // its machine's own sidebar counts from: a turn the chat opened by itself
    // does not restart it. A machine from before it said so gives the turn's
    // start; `updatedAt` also moves when an approval resolves or the model
    // changes.
    since:
      presence === 'running'
        ? (conversation.workingSince ?? conversation.turnStartedAt ?? conversation.updatedAt)
        : conversation.updatedAt,
    recencyAt: conversation.recencyAt ?? conversation.lastUserMessageAt ?? conversation.updatedAt,
    lastUserMessageAt: conversation.lastUserMessageAt ?? null,
    lastTurnEndedAt: conversation.lastTurnEndedAt ?? null,
    lastVisitedAt: conversation.lastVisitedAt ?? null,
    scheduledAgentId: conversation.scheduledAgentId ?? null,
    snoozedUntil: conversation.snoozedUntil ?? null,
    lifecycle: writes.lifecycle,
    highlight: conversation.highlight
      ? { starred: conversation.highlight.starred, color: conversation.highlight.color ?? null }
      : null,
    autoSettle: conversation.autoSettle === true,
    rowMenu: writes.rowMenu,
    markUnread: writes.markUnread,
    manage: writes.manage,
    autoCompact: typeof conversation.autoCompact === 'boolean' ? conversation.autoCompact : null,
    claude: cliForConversationProvider(conversation.providerId) === 'claude-code',
  }
}

/**
 * Most recently written to first, as the local rows are (owner ruling
 * 2026-09-09: rows stay put, ordered by when I last messaged them). These
 * used to sort working first, then waiting, then idle, then by name, so a
 * remote row jumped whenever its agent started or stopped. The marks say what
 * an agent is doing; the order never does. Ties keep the order the machine
 * listed them in.
 */
function compareByRecency(a: { recencyAt: number }, b: { recencyAt: number }): number {
  return b.recencyAt - a.recencyAt
}

/**
 * Several machines' rows as one list, most recently written to first, with
 * each machine's own rows kept in the order it gave them. A machine that
 * keeps its chats' rest lists them in its sidebar's order, by a key of its
 * own (a chat never written to counts from its creation there, not from when
 * it last moved), and re-sorting them here by `recencyAt` drew them in an
 * order that machine's own sidebar does not.
 */
function mergeByRecency<T extends { recencyAt: number }>(lists: ReadonlyArray<readonly T[]>): T[] {
  const queues = lists.map((list) => ({ list, next: 0 }))
  const merged: T[] = []
  for (;;) {
    let pick: { list: readonly T[]; next: number } | null = null
    for (const queue of queues) {
      const head = queue.list[queue.next]
      // The first machine wins a tie, as a stable sort of the groups in order would.
      if (head !== undefined && (pick === null || head.recencyAt > pick.list[pick.next]!.recencyAt)) pick = queue
    }
    if (!pick) return merged
    merged.push(pick.list[pick.next]!)
    pick.next += 1
  }
}

/** One followed environment's rows, as the sidebar reads them. */
export type EnvironmentChatSourceView = {
  /** The route it is followed by (`formatEnvironmentRoute`). */
  route: string
  /** What the person calls it. */
  machineName: string
  /** Its id, once its Studio or the environment list has said it. */
  environmentId: string | null
  /** The pairing a paired desktop is reached over; null for every other kind of machine. */
  connectionId: string | null
  /** Its source reads it; false while it rests (`FollowedEnvironment.resting`), drawn from its last-known rows. */
  live: boolean
  entry: RemoteBrowseEntry
}

/** A chat's key: its address, or its route and id while its environment has not said its id. */
export function environmentChatKey(environmentId: string | null, route: string, chatId: string): string {
  if (environmentId && isEnvironmentId(environmentId)) {
    try {
      return formatChatAddress({ environmentId, chatId })
    } catch {
      // An id its address cannot carry: keyed by its route instead.
    }
  }
  return `${route}:${chatId}`
}

/**
 * A record this window keeps of another environment's chat (an SSH or WSL
 * copy, a paired chat attached here). It is never drawn as a row of its own:
 * the chat's address row is (design-environments PR 3).
 */
export function isEnvironmentRecord(workspace: Pick<Workspace, 'environment' | 'remoteOrigin'>): boolean {
  return Boolean(workspace.environment || workspace.remoteOrigin)
}

/**
 * The records this window keeps of other environments' chats, by the chat's
 * key (`environmentChatKey`): what opening its row focuses. The first in list
 * order wins. This is the one bridge from an address to a record, and it goes
 * when windows arrange chats by address.
 */
export function chatRecordsByAddress(
  workspaces: readonly Pick<Workspace, 'id' | 'environment' | 'remoteOrigin'>[],
  idOfRoute: (route: string) => string | null,
): ReadonlyMap<string, string> {
  const records = new Map<string, string>()
  for (const workspace of workspaces) {
    const copy = environmentTargetOf(workspace.environment)
    const origin = workspace.remoteOrigin
    const route = copy?.route ?? (origin ? pairedRoute(origin.connectionId) : null)
    if (!route) continue
    const chatId = copy ? workspace.id : remoteOriginChatWorkspaceId(origin!)
    const key = environmentChatKey(idOfRoute(route), route, chatId)
    if (!records.has(key)) records.set(key, workspace.id)
  }
  return records
}

/** How an environment's rows stand: a last-known list, and why, or null while its newest read stands. */
function lastKnownOfSource(
  source: EnvironmentChatSourceView,
  status: EnvironmentStatusKind | null,
): RemoteLastKnown | null {
  // A resting environment is not asked: its rows are its last-known list.
  if (!source.live) return { reason: 'not-connected', since: source.entry.listedAt ?? null }
  return remoteLastKnownOf(source.entry, status)
}

const latestOf = (values: Array<number | null | undefined>): number | null => {
  const known = values.filter((value): value is number => typeof value === 'number' && value > 0)
  return known.length > 0 ? Math.max(...known) : null
}

/**
 * One chat's row: its workspace's facts (`chat-rows`, what its machine's own
 * row draws), and the agents its environment lists in it. From a Studio
 * before `chat-rows`, the agents carry those facts, as paired rows did.
 */
function chatOf(
  source: EnvironmentChatSourceView,
  workspace: MeshWorkspace | null,
  agents: RemoteSessionRow[],
  rest: {
    writes: RemoteRowWrites
    lastKnown: RemoteLastKnown | null
    records: ReadonlyMap<string, string>
  },
): RemoteConversation {
  const lead = agents[0] ?? null
  const row = workspace?.row
  const chatId = workspace?.id ?? lead!.workspaceId
  const key = environmentChatKey(source.environmentId, source.route, chatId)
  const workspaceRoot = workspace?.folderPath ?? lead?.workspaceRoot ?? null
  const activity: RemoteRowActivity = agents.some((agent) => agent.activity === 'needs-input')
    ? 'needs-input'
    : agents.some((agent) => agent.activity === 'working')
      ? 'working'
      : 'idle'
  const highlight = row ? (row.highlight ?? null) : (lead?.highlight ?? null)
  return {
    key,
    address: key.startsWith(`${source.route}:`) ? null : key,
    route: source.route,
    environmentId: source.environmentId,
    connectionId: source.connectionId,
    machineName: source.machineName,
    // The list says the chat's title fresher than the browse does.
    title: lead?.chatTitle ?? workspace?.name ?? appCopy.workspace.remoteBand.remoteSessionsModel.conversation,
    workspaceId: chatId,
    workspaceRoot,
    projectFolder: row?.worktree?.projectFolder ?? workspaceProjectRootOf({ folderPath: workspaceRoot }),
    repository: workspace?.repository ?? lead?.repository ?? null,
    agents,
    activity,
    failed: activity === 'idle' && agents.some((agent) => agent.phase === 'failed'),
    since: lead?.since ?? row?.lastTurnEndedAt ?? null,
    attachedWorkspaceId: rest.records.get(key) ?? null,
    stale: rest.lastKnown !== null,
    lastKnown: rest.lastKnown,
    recencyAt:
      row?.recencyAt ??
      latestOf(agents.map((agent) => agent.recencyAt)) ??
      row?.lastUserMessageAt ??
      row?.createdAt ??
      0,
    lastUserMessageAt: row ? (row.lastUserMessageAt ?? null) : latestOf(agents.map((a) => a.lastUserMessageAt)),
    lastTurnEndedAt: row ? (row.lastTurnEndedAt ?? null) : latestOf(agents.map((a) => a.lastTurnEndedAt)),
    lastVisitedAt: row ? (row.lastVisitedAt ?? null) : (lead?.lastVisitedAt ?? null),
    scheduledAgentId: row
      ? (row.scheduledAgentId ?? null)
      : (agents.find((agent) => agent.scheduledAgentId)?.scheduledAgentId ?? null),
    highlight: highlight ? { starred: highlight.starred === true, color: highlight.color ?? null } : null,
    snoozedUntil: row ? (row.snoozedUntil ?? null) : (lead?.snoozedUntil ?? null),
    autoSettle: row ? row.autoSettle === true : lead?.autoSettle === true,
    lifecycle: rest.writes.lifecycle,
    rowMenu: rest.writes.rowMenu,
    markUnread: rest.writes.markUnread,
    manage: rest.writes.manage,
    // The switch is the chat's, kept on its record there; it works on a chat
    // any of whose agents is Claude's, as a local chat's does.
    autoCompact:
      lead === null || lead.autoCompact === null
        ? null
        : { on: lead.autoCompact, claude: agents.some((agent) => agent.claude) },
  }
}

/**
 * Every followed environment's chats as rows, by address, most recently
 * written to first whichever environment each is on (owner, 2026-10-09).
 *
 * A chat is a row when its environment lists it in what it holds
 * (`workspaces.list`) and has not settled it, whether or not an agent of it is
 * listed: a chat whose agents run in terminals there is a chat too. A Studio
 * from before `chat-rows` says nothing of a chat but its listed agents, so only
 * a chat with one is a row of it, as before. A chat its environment lists by
 * its agents before what it holds has been read is a row too.
 *
 * Off the tailnet (`onTailnet` false), nothing a paired desktop lists is
 * drawn (owner, 2026-09-13): it cannot be reached, opened or typed into from
 * here, and its rows come back with the link. Its environment says whether it
 * is reached over the tailnet (`reachedOverTailnet`).
 */
export function environmentChatRows(input: {
  sources: readonly EnvironmentChatSourceView[]
  environments: readonly EnvironmentEntry[]
  /** The records here of other environments' chats, by chat key (`chatRecordsByAddress`). */
  records: ReadonlyMap<string, string>
  /** A workspace kind whose workspaces are kept off the sidebar (`isHiddenFromRail`). */
  hiddenMode?: (mode: string | null) => boolean
  onTailnet?: boolean
  reachedOverTailnet?: (route: string) => boolean
}): RemoteConversation[] {
  const { environments, records, hiddenMode, onTailnet = true, reachedOverTailnet } = input
  const lists: RemoteConversation[][] = []
  for (const followed of input.sources) {
    if (!onTailnet && reachedOverTailnet?.(followed.route)) continue
    const route = parseEnvironmentRoute(followed.route)
    const environment = route ? environmentOfRoute(environments, route) : null
    // Its id as the list says it, until its own Studio has: its rows are keyed by address either way.
    const source = followed.environmentId
      ? followed
      : { ...followed, environmentId: environment?.environmentId ?? null }
    const { entry } = source
    const browse = entry.browse
    const status = environment ? environmentStatus(environment).kind : null
    const lastKnown = lastKnownOfSource(source, status)
    const writes: RemoteRowWrites = {
      lifecycle: remoteLifecycleWritable(entry),
      rowMenu: remoteLifecycleWritable(entry),
      markUnread: remoteLifecycleWritable(entry),
      manage: remoteManageWritable(entry),
    }
    // A chat its environment has settled has no row, as it has none in that
    // machine's own sidebar.
    const resting = new Set(
      (browse?.workspaces ?? [])
        .filter((workspace) => typeof workspace.settledAt === 'number')
        .map((workspace) => workspace.id),
    )
    const agentsByChat = new Map<string, RemoteSessionRow[]>()
    for (const conversation of entry.conversations ?? []) {
      if (resting.has(conversation.workspaceId)) continue
      const row = remoteChatRowOf(source, conversation, browse, writes, lastKnown !== null)
      const agents = agentsByChat.get(conversation.workspaceId)
      if (agents) agents.push(row)
      else agentsByChat.set(conversation.workspaceId, [row])
    }
    const rest = { writes, lastKnown, records }
    const chats: RemoteConversation[] = []
    const drawn = new Set<string>()
    for (const workspace of browse?.workspaces ?? []) {
      if (resting.has(workspace.id) || hiddenMode?.(workspace.mode)) continue
      const agents = agentsByChat.get(workspace.id) ?? []
      if (!workspace.row && agents.length === 0) continue
      drawn.add(workspace.id)
      chats.push(chatOf(source, workspace, agents, rest))
    }
    for (const [chatId, agents] of agentsByChat) if (!drawn.has(chatId)) chats.push(chatOf(source, null, agents, rest))
    lists.push(chats.sort(compareByRecency))
  }
  return mergeByRecency(lists)
}

/** One row of a list that holds both this desktop's chats and a paired machine's. */
export type ChatListEntry =
  | { kind: 'local'; workspace: Workspace; recencyAt: number }
  | { kind: 'remote'; conversation: RemoteConversation; recencyAt: number }

/**
 * Its agent finished a turn nobody has had on screen since, on any device:
 * the green "finished while you were away" row a local chat wears, by the
 * rule a local row is marked by (`finishedUnseen`). Only an environment that
 * keeps its chats' read state can say so, and a chat with no visit recorded
 * reads as seen. A chat snoozed over there is not marked until it wakes.
 */
export function remoteRowFinishUnseen(
  conversation: Pick<RemoteConversation, 'activity' | 'lastTurnEndedAt' | 'lastVisitedAt' | 'snoozedUntil'>,
  now: number = Date.now(),
): boolean {
  if (remoteConversationAsleep(conversation, now)) return false
  return finishedUnseen({
    idle: conversation.activity === 'idle',
    finishedAt: conversation.lastTurnEndedAt,
    visitedAt: conversation.lastVisitedAt,
  })
}

/**
 * What another environment's chat's row says its agents are doing, in the
 * local rows' words: a chat stopped by a failed turn reads as failed, or By
 * status files it with the chats at rest while a local one leads the list.
 */
export function remoteRowActivity(
  conversation: Pick<RemoteConversation, 'activity' | 'failed'>,
): RemoteRowActivity | 'failed' {
  return conversation.failed ? 'failed' : conversation.activity
}

/** Rows here, most recently written to first by `recencyOf`; ties keep the order they came in. */
export function sortChatsByRecency(
  workspaces: readonly Workspace[],
  recencyOf: (workspace: Workspace) => number = workspaceLastUserMessageAt,
): Workspace[] {
  return [...workspaces].sort((a, b) => recencyOf(b) - recencyOf(a))
}

/**
 * This desktop's rows and the paired machines' as one list, most recently
 * written to first, whichever machine each runs on (owner, 2026-10-09: a chat
 * I just wrote to on the Mini sat under a local one two days quiet). Each
 * machine's rows keep the order it gave them, and a tie goes to the local row.
 * They used to follow every local row, for fear a machine's clock a few
 * minutes off would shuffle them; it sank the chats the person was working in
 * instead.
 */
export function interleaveChats(
  local: readonly Workspace[],
  remote: readonly RemoteConversation[],
  recencyOf: (workspace: Workspace) => number = workspaceLastUserMessageAt,
): ChatListEntry[] {
  return mergeByRecency<ChatListEntry>([
    sortChatsByRecency(local, recencyOf).map((workspace) => ({
      kind: 'local',
      workspace,
      recencyAt: recencyOf(workspace),
    })),
    remote.map((conversation) => ({ kind: 'remote', conversation, recencyAt: conversation.recencyAt })),
  ])
}

/** What opening a chat asks: its record here, or a pane onto it following the agent asked for, else its first. */
export function openSpecOfConversation(
  conversation: RemoteConversation,
  agentId?: string | null,
): RemoteSessionOpenSpec {
  const agent =
    (agentId ? conversation.agents.find((row) => row.remoteAgentId === agentId) : undefined) ??
    conversation.agents[0] ??
    null
  return {
    route: conversation.route,
    machineName: conversation.machineName,
    connectionId: conversation.connectionId,
    chatId: conversation.workspaceId,
    agent: agent
      ? { agentId: agent.remoteAgentId, sessionId: agent.sessionId, title: agent.title, cli: agent.cli }
      : null,
    title: conversation.title,
    workspaceName: conversation.title,
    workspaceRoot: conversation.workspaceRoot,
    repository: conversation.repository,
    attachedWorkspaceId: conversation.attachedWorkspaceId,
  }
}

/**
 * What a chat opened from — or started on — a paired machine is CALLED here.
 *
 * The remote chat's own name, and the lone agent's only when the remote had no
 * name to give (owner, 2026-09-13: "we shouldn't show 'Tara Boyle · xxx' — the
 * agent name shouldn't be there, it is not relevant"). It used to be
 * `${agentName} · ${chatName}`, which put a stranger's name in front of every
 * remote row and made a list of chats read as a list of people — the same
 * mistake the band's own rows made until `conversationsOf` stopped titling a
 * conversation with its loudest agent. One rule, both paths.
 */
export function remoteWorkspaceName(agentTitle: string, remoteChatName: string | null | undefined): string {
  return remoteChatName?.trim() || agentTitle
}

/**
 * The id of the chat a remote-born row is, on its machine. Read off the
 * session id the row was stamped with, which names the chat itself: rows
 * started from New chat were stored with the PROJECT's workspace there in
 * `workspaceId` (the chat the project picker was seated on), so a settle, a
 * visit or a bring-back asked about that chat instead, and the row followed
 * that chat's settle off the sidebar while its own chat ran on.
 */
export function remoteOriginChatWorkspaceId(origin: Pick<WorkspaceRemoteOrigin, 'workspaceId' | 'sessionId'>): string {
  return (origin.sessionId ? parseMeshConversationSessionId(origin.sessionId)?.workspaceId : null) ?? origin.workspaceId
}

/**
 * The pane a remote-born row exists to show: the chat its session id names, on
 * the machine it came from. Null for a row born before the session id was
 * stamped, which says no more than the project it was opened from.
 */
export function remoteOriginPaneSpec(
  workspace: Pick<Workspace, 'name' | 'remoteOrigin'>,
): MeshConversationPaneSpec | null {
  const origin = workspace.remoteOrigin
  const chat = origin?.sessionId ? parseMeshConversationSessionId(origin.sessionId) : null
  if (!origin || !chat) return null
  return {
    connectionId: origin.connectionId,
    machineName: origin.machineName,
    remoteWorkspaceId: chat.workspaceId,
    remoteAgentId: chat.agentId,
    title: remoteConversationTitle(workspace),
  }
}

/**
 * The name a remote pane's tab shows: its agent's, and nothing else (owner,
 * 2026-10-08, REVERSING the machine-in-the-name rule: "all we need to show here
 * is in the tab the name of the agent, and then the computer icon to show that
 * it is a remote"). The tab's machine mark, in that machine's colour and named
 * on hover, is what says where it runs.
 *
 * A pane opened under the old rule was saved as `${title} · ${machineName}`,
 * and its tab drops the machine when it is drawn, so the fix reaches the tabs
 * people already have rather than only the next one opened.
 */
export function remotePaneTabLabel(name: string, machineName: string | null | undefined): string {
  const suffix = machineName ? ` · ${machineName}` : null
  return suffix && name.endsWith(suffix) && name.length > suffix.length ? name.slice(0, -suffix.length) : name
}

/**
 * A remote-born row's title, for rows that already exist.
 *
 * `workspace.name` is the answer, except for the rows minted under the old
 * `${agentName} · ${chatName}` rule: those are already in people's stores and
 * would keep reading as strangers forever. A name that ends in exactly its own
 * provenance's chat name, with something in front of it, IS one of those, and
 * the chat name is what it should have been called. A person who renamed the
 * row themselves keeps their name — unless they happened to type that exact
 * shape, in which case they get the chat's name, which is not a bad one.
 */
export function remoteConversationTitle(
  workspace: Pick<Workspace, 'name' | 'remoteOrigin'>,
  listedTitle?: string | null,
): string {
  const chatName = workspace.remoteOrigin?.workspaceName?.trim()
  // A row still named what it was born as follows the chat's title over
  // there, as a local chat's row follows its own: the machine names a new
  // chat once its first turn has been read, and a rename there reaches here.
  // A row renamed here keeps the person's name.
  const listed = listedTitle?.trim()
  if (listed && workspace.name.trim() === (chatName ?? '')) return listed
  if (!chatName) return workspace.name
  const suffix = ` · ${chatName}`
  if (workspace.name.length > suffix.length && workspace.name.endsWith(suffix)) return chatName
  return workspace.name
}

/**
 * Whether THIS device is on the tailnet, as the sidebar must answer it.
 *
 * Three answers rather than two, because "we have not been told" is a real
 * state and must not read as "disconnected": a host without the tailnet bridge
 * (a narrower preload, a partial test harness) and the moment before the first
 * status read both have `status === null`, and hiding every remote row on
 * those would empty the sidebar of chats that are perfectly fine.
 *
 * `tailnetAddress` is the signal rather than `running`, which is the INBOUND
 * listener's state: a person can drive paired machines with Remote turned off
 * here — the listener is what lets other machines drive THIS one — so a
 * listener that is down says nothing about whether the mesh can be reached.
 * The address is read off Tailscale's own interface (`resolveTailnetInterface`,
 * which tells it apart from a WARP or other VPN tunnel in the same 100.64/10
 * range), and that interface holds one only while Tailscale is up, which is
 * exactly the question.
 */
export type RemoteLinkState = 'unknown' | 'up' | 'down'

export function remoteLinkStateOf(status: { tailnetAddress: string | null } | null | undefined): RemoteLinkState {
  if (!status) return 'unknown'
  return status.tailnetAddress === null ? 'down' : 'up'
}

// ── Another environment's chat's row menu marks ──────────────────────────
//
// Its star, colour, sleep and Auto-settle are kept by the environment it runs
// on (`chat-lifecycle`), and read back off its list. A change asked from here
// is drawn at once, as a local Star flips at once, and held until a list read
// after the environment took it says the same thing for itself.

/** The marks a chat's row wears from its environment's list. */
export type RemoteChatMarks = Pick<RemoteConversation, 'highlight' | 'snoozedUntil' | 'autoSettle'>

/** What a change asked of an environment draws at once: its marks, its name, or its Auto compact switch. */
export type RemoteChatPending = Partial<RemoteChatMarks & { title: string; autoCompactOn: boolean }>

/** A change asked of an environment and not yet read back off its list, held by the chat's key. */
export type PendingRemoteMarks = {
  /** The route the environment is followed by, whose next list says it. */
  route: string
  marks: RemoteChatPending
  /** When the environment said it took them; null while it has not answered. */
  takenAt: number | null
}

/** Each row, wearing the marks asked of its environment that its list does not say yet. */
export function withPendingRemoteMarks(
  conversations: readonly RemoteConversation[],
  pending: ReadonlyMap<string, PendingRemoteMarks>,
): readonly RemoteConversation[] {
  if (pending.size === 0) return conversations
  return conversations.map((conversation) => {
    const asked = pending.get(conversation.key)?.marks
    if (!asked) return conversation
    const { autoCompactOn, ...marks } = asked
    return {
      ...conversation,
      ...marks,
      ...(autoCompactOn !== undefined && conversation.autoCompact
        ? { autoCompact: { ...conversation.autoCompact, on: autoCompactOn } }
        : {}),
    }
  })
}

/** Whether a list read since the environment took the change has come in, so the list says it now. */
export function pendingRemoteMarksRead(pending: PendingRemoteMarks, readAt: (route: string) => number | null): boolean {
  if (pending.takenAt === null) return false
  const at = readAt(pending.route)
  return at !== null && at > pending.takenAt
}

/** The highlight a chat would have after a Star or colour change: none when neither is left. */
export function remoteHighlightAfter(
  current: WorkspaceHighlight | null,
  change: { starred?: boolean; color?: WorkspaceHighlight['color'] },
): WorkspaceHighlight | null {
  const starred = change.starred ?? current?.starred === true
  const color = change.color === undefined ? (current?.color ?? null) : change.color
  return starred || color ? { starred, color } : null
}

/** Whether a sleeping chat over there is asleep still, as its machine's own row reads one. */
export function remoteConversationAsleep(conversation: Pick<RemoteConversation, 'snoozedUntil'>, now: number): boolean {
  return typeof conversation.snoozedUntil === 'number' && conversation.snoozedUntil > now
}

/**
 * The pull request a paired machine watches for one of the chat's agents, and
 * that agent, where the machine takes Stop watching from here
 * (`pull-request-watch`); null for none. An open one on GitHub, as a
 * local chat's watch is.
 */
export function remoteWatchedPullRequest(
  conversation: Pick<RemoteConversation, 'manage' | 'agents'>,
): { agentId: string; url: string; number: number } | null {
  if (!conversation.manage?.unwatchPullRequest) return null
  for (const row of conversation.agents) {
    const pr = row.pullRequests.find((candidate) => candidate.watch && candidate.state === 'open' && !candidate.forge)
    if (pr) return { agentId: row.remoteAgentId, url: pr.url, number: pr.number }
  }
  return null
}

/**
 * Whether another environment's chat has something for Mark unread to mark:
 * its environment takes it from here, its agent has finished a turn, and the
 * row is not already marked finished-unseen.
 */
export function canMarkRemoteConversationUnread(
  conversation: Pick<
    RemoteConversation,
    'markUnread' | 'activity' | 'lastTurnEndedAt' | 'lastVisitedAt' | 'snoozedUntil'
  >,
  now: number = Date.now(),
): boolean {
  if (!conversation.markUnread || remoteRowFinishUnseen(conversation, now)) return false
  return conversation.lastTurnEndedAt !== null
}

/** Where a paired machine's chat opens when its menu moves it: a window of its own, or the main one. */
export type RemoteWindowPlace = 'new-window' | 'main-window'
