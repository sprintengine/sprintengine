import type { ConversationFileSearchEntry } from '../../packages/conversation-protocol/src/composerReads'
import type { ConversationCommand } from './conversation/commands'
import type {
  ConversationCommand as ConversationContractCommand,
  ConversationHighlightColor,
  ConversationLaneNotCarried,
  ConversationSendRequest,
  ConversationQueuedMessage,
  ConversationScheduledMessage,
  ConversationChangedFileSides,
  ConversationChangesDiff,
  ConversationCheckoutChanges,
  ConversationSubagent,
  ConversationListedThread,
  ConversationUsageLimitNotice,
  ConversationUsageLimitResumeAction,
  ConversationUsageLimitSnapshot,
} from '../../packages/conversation-protocol/src/public'
import { readableConversationPhase } from '../../packages/conversation-protocol/src/public'
import type { ConversationImageAttachment, ConversationSessionFrame } from './conversation-runtime'
import { conversationPhaseWorking, phaseWithBackgroundWork } from './conversation/phase'
import type { RepositoryIdentity } from './repository-identity'
import type { CliPermissionPreset } from './cli-permission-preset'
import type { ScheduledAgentView, ScheduledAgentsPause } from './scheduled-agents'
import type { SettledChatWorktreePlan } from './ipc/settled-chats'
import type { TailnetScope } from './tailnet'
import {
  type MeshConnection,
  type MeshPairRequestView,
  type MeshEvent,
} from '../../packages/studio-protocol/src/tailnet-types'
// The wire shapes, defined once in the protocol package.
export type {
  MeshConnection,
  MeshPairResult,
  MeshPairRequestView,
  MeshPairRequestPhase,
  MeshMachineReachability,
  MeshRequestPairingResult,
  MeshEvent,
  MeshLiveState,
  MeshForgetMachineResult,
  TailnetForgetMachineResult,
} from '../../packages/studio-protocol/src/tailnet-types'

// The Mesh: another machine's Studio, mounted in this one.
//
// `tailnet.ts` is "who may drive this machine"; `tailnet-peers.ts` is "which
// machines exist". This file is the third direction and the one a person
// actually works in: the machines this Studio has PAIRED WITH, what they hold,
// and the conversations it follows on them.
//
// The outbound half lives in the main process (`tailnet/tailnet-mesh-service.ts`),
// not the renderer, for one hard reason: the listener refuses any request
// carrying an `Origin` header, and a renderer's fetch/WebSocket always sends
// one. Main is also where the device token belongs — a credential that reached
// the renderer would be one XSS away from the tailnet.

/** A workspace on the remote machine, as `workspace.list` reports it. */
export type MeshWorkspace = {
  id: string
  name: string
  mode: string | null
  folderPath: string | null
  /**
   * Which repository the folder is a clone of, as the remote read it off its
   * own `git remote` (one-project-across-machines). Null when the remote is
   * an older build, the folder is not a repository, or it has no remote —
   * three different facts with one consequence: no grouping across machines.
   */
  repository: RepositoryIdentity | null
  /**
   * When the workspace was settled there, or null while it is in that
   * machine's list. Null too from a machine built before it said; a resting
   * workspace is one this machine draws no row for.
   */
  settledAt?: number | null
}

/**
 * A workspace's checkout facts on the remote machine, as `workspace.checkout`
 * reports them (checkout-and-branch-on-remote-create). `git: false` is a real
 * answer — the folder is not a repository, so there is no branch to show and
 * no worktree to make — and is distinct from a gap, which is "this pairing
 * may not ask".
 */
export type MeshWorkspaceCheckout = {
  workspaceId: string
  git: boolean
  /** The branch the workspace's own checkout is on; null when detached or not a repo. */
  branch: string | null
  /** The trunk the remote resolves (origin/HEAD, upstream, main/master), or null. */
  defaultBranch: string | null
  branches: Array<{ name: string; current: boolean }>
  worktrees: Array<{ path: string; branch: string | null; isMain: boolean }>
}

export type MeshWorkspaceCheckoutResult =
  { ok: true; checkout: MeshWorkspaceCheckout } | { ok: false; code: string; message: string }

/** A paired machine's `workspace.extensions` answer for one of its projects. */
export type MeshWorkspaceExtensionsResult =
  | { ok: true; extensions: import('./workspace-extensions').WorkspaceExtensions }
  | { ok: false; code: string; message: string }

/** One board on a paired machine. */
export type MeshCanvasBoard = {
  id: string | null
  path: string
  name: string
  /** Its project there; null for a project that machine has removed. */
  project: string | null
  /** That machine's workspace in the board's folder, the one a new chat there starts beside. */
  workspaceId: string | null
  /** Epoch milliseconds. */
  modifiedAt: number
  elementCount: number
  /** It is in the project of the chat that asked. */
  here: boolean
}

/**
 * A paired machine's boards (`canvas.list` there). `allBoards`: the list is the
 * whole machine's, each row with its project; otherwise the asking chat's
 * project's alone.
 */
export type MeshCanvasBoardsResult =
  | { ok: true; boards: MeshCanvasBoard[]; allBoards: boolean; note: string | null }
  | { ok: false; code: string; message: string }

/** A picture of a board on a paired machine (`canvas.picture` there). */
export type MeshCanvasScreenshotResult =
  | { ok: true; mimeType: string; data: string; width: number; height: number }
  | { ok: false; code: string; message: string }

/**
 * A paired machine's answers to its chat's Create PR (`chat-create-pull-request`),
 * one per step, as a Studio answers them over the protocol for a chat it
 * holds (`pullRequests.createState`, `.draft`, `.push`, `.create`). The
 * state carries no path on that machine: its
 * `gitRoot` is null. `text_generation_off` is a machine whose own text
 * generation is off, where the person writes the text themselves.
 */
export type MeshPullRequestStateResult =
  | { ok: true; state: import('./git/pull-request-create').CreatePullRequestState | null }
  | { ok: false; code: string; message: string }
export type MeshPullRequestDraftResult =
  { ok: true; title: string; body: string } | { ok: false; code: string; message: string }
export type MeshPullRequestPushResult = { ok: true; pushed: boolean } | { ok: false; code: string; message: string }
/**
 * A creation's end, as `createPullRequest` answers it, except that a pull
 * request created there was recorded there as the chat's: `recorded` says
 * whether that landed, and why not.
 */
export type MeshPullRequestCreateResult =
  | Exclude<import('./git/pull-request-create').CreatePullRequestOutcome, { ok: false } | { kind: 'created' }>
  | { ok: true; kind: 'created'; url: string; recorded: { ok: true } | { ok: false; message: string } }
  | { ok: false; code: string; message: string }

/**
 * A part of a browse this machine is not allowed to read, named with the reason.
 *
 * A device paired for conversations alone genuinely cannot list workspaces.
 * Showing an empty list would say "this machine has no workspaces", which is a
 * different — and false — statement.
 */
export type MeshGap = {
  part: 'workspaces'
  code: string
  message: string
}

/** One machine's contents, as the window reads them of its Studio (`browsePairedMachine`). */
export type MeshBrowse = {
  connectionId: string
  /** False when the machine did not answer at all; everything below is then empty. */
  reachable: boolean
  /** Why it did not answer, in a sentence. Null when it did. */
  unreachableReason: string | null
  /** True when the remote refused our token — revoked or re-paired at the other end. */
  unauthorized: boolean
  /** Live scopes read from the remote, which may differ from what was stored at pairing. */
  scopes: TailnetScope[]
  workspaces: MeshWorkspace[]
  gaps: MeshGap[]
  /**
   * What of its chats' records the machine's Studio keeps for this one, as its
   * welcome says: `lifecycle` (`chat-lifecycle`) their rest and read state, the
   * row menu's marks, Rename, Auto compact, Delete and a search of them;
   * `unwatchPullRequest` (`pull-request-watch`) Stop watching. Absent from a
   * browse that did not reach its Studio, which offers none of them.
   */
  chatRecord?: { lifecycle: boolean; unwatchPullRequest: boolean }
}

/** The state of one followed remote conversation's link, as the pane badges it. */
export type MeshLinkState =
  /** Opening the socket for the first time. */
  | 'connecting'
  /** Following; frames are flowing. */
  | 'live'
  /** The socket dropped and we are dialling again. The transcript stays on screen. */
  | 'reconnecting'
  /** The peer is not answering. Quiet, not alarming — a sleeping laptop looks like this. */
  | 'offline'
  /** Finished for good: the conversation ended, access was revoked, or the pane stopped following. */
  | 'closed'

/**
 * Where a New chat on a paired machine runs when it is not the project's own
 * folder: a worktree cut for it there (a name, or '' for one made up there),
 * or a worktree the project already has, by the path `workspace.checkout`
 * listed. A machine is asked for one only where it advertises the capability
 * (`new-chat-worktree`, `new-chat-worktree-name`, `new-chat-in-worktree`).
 */
export type MeshNewChatWorktree = { kind: 'new'; name: string } | { kind: 'existing'; path: string }

/**
 * A chat agent started on a paired machine (`conversation.create`). The chat
 * is known there by its workspace and agent ids, which is what a pane follows
 * it by; `title` is the agent's name there. `worktree` is the worktree it runs
 * in there, as that machine answered; null for the project's own folder, or a
 * machine that does not say.
 */
export type MeshCreateConversationResult =
  | {
      ok: true
      workspaceId: string
      agentId: string
      title: string
      providerId: string
      modelId: string
      worktree?: { path: string; branch: string | null } | null
    }
  | { ok: false; code: string; message: string }

/**
 * A chat settled, or brought back, on a paired machine (`conversation.settle`).
 * `settledAt` is the machine's answer: when it was settled, or null when it is
 * in the list. `lifecycle_unsupported` is a machine whose Studio does not serve
 * `chat-lifecycle`.
 */
export type MeshSettleConversationResult =
  { ok: true; workspaceId: string; settledAt: number | null } | { ok: false; code: string; message: string }

/** A visit recorded on a paired machine (`conversation.visit`): the chat's visit clock there now. */
export type MeshVisitConversationResult =
  { ok: true; workspaceId: string; lastVisitedAt: number } | { ok: false; code: string; message: string }

/**
 * A row menu change to a chat on a paired machine, written to that machine's
 * record of it by its Studio (`chat-lifecycle` there): Snooze and Wake now
 * (`until: null`), Star and Highlight color (a member left out stays as it
 * is), Auto-settle, and Mark unread.
 */
export type MeshConversationChange =
  | { kind: 'snooze'; until: number | null }
  | { kind: 'highlight'; starred?: boolean; color?: ConversationHighlightColor | null }
  | { kind: 'auto-settle'; enabled: boolean }
  | { kind: 'mark-unread' }
  | MeshConversationManageChange

/**
 * A chat's management from a paired desktop, beyond its marks, each where
 * the machine takes it (`MeshConversationManage`): Rename, Auto compact and
 * Delete on its Studio (`chat-lifecycle`), and Stop watching
 * (`pull-request-watch`).
 */
export type MeshConversationManageChange =
  | { kind: 'rename'; name: string }
  | { kind: 'auto-compact'; enabled: boolean }
  /** One agent's watch of a pull request, by its address. */
  | { kind: 'unwatch-pull-request'; agentId: string; url: string }
  /** A settled chat deleted there for good (`chat-lifecycle`), after its plan was said. */
  | { kind: 'delete' }

/**
 * Which of a chat's management a paired machine takes from here. `rename`,
 * `autoCompact`, `deleteSettled` and `search` are its Studio's
 * (`chat-lifecycle`): the chat renamed there, so every device lists it by the
 * new name; its Auto compact switched there, the machine that runs it
 * compacting it by itself; a settled chat deleted there for good, its plan
 * read first (`pairedChatDeletePlan`); and what was said in its chats
 * found from here (`searchPairedChats`). `unwatchPullRequest`:
 * `pull-request-watch`, a watch of the chat's pull request ended there
 * (`pullRequests.unwatch`), where its listed pull request says it is watched.
 */
export type MeshConversationManage = {
  rename: boolean
  autoCompact: boolean
  unwatchPullRequest: boolean
  deleteSettled: boolean
  search: boolean
}

/**
 * What was said in a paired machine's chats (`conversation.searchChats`): one entry
 * per chat with a match, by its id there, carrying its matching messages and
 * how many there were. `truncated` is an answer that stopped early.
 * `search_unsupported` is a machine without `chat-lifecycle`.
 */
export type MeshConversationSearchResult =
  | {
      ok: true
      chats: Array<{
        workspaceId: string
        chatTitle: string
        hits: Array<{ agentId: string; seq: number; snippet: string; from?: 'person' | 'agent' | 'studio' }>
        count: number
      }>
      truncated: boolean
    }
  | { ok: false; code: string; message: string }

/**
 * The "always allow" rules a paired machine's chats run with
 * (`conversation.approval_rules`), each project by its folder's name.
 * `approval_rules_unsupported` is a machine without `approval-rules`.
 */
export type MeshApprovalRulesResult =
  | {
      ok: true
      rules: Array<{
        id: string
        label: string
        toolName: string
        toolKind: string
        project: string
        createdAt: number
      }>
    }
  | { ok: false; code: string; message: string }

/** One of them revoked there (`conversation.approval_rule_revoke`). */
export type MeshRevokeApprovalRuleResult = { ok: true; ruleId: string } | { ok: false; code: string; message: string }

/**
 * A paired machine's scheduled agents (`schedule.list`, `workspace:read`),
 * each as that machine's own Scheduled section reads it, and whether every one
 * of them is paused. `canCreate` is whether that machine takes a New chat's
 * schedule from here (`scheduled-agents`); one that does not is still listed
 * and controlled.
 */
export type MeshScheduledAgentsResult =
  | {
      ok: true
      agents: ScheduledAgentView[]
      pausedAll: ScheduledAgentsPause | null
      canCreate: boolean
      /** Whether that machine takes an edit to one of them from here (`scheduled-agents-edit`). */
      canEdit: boolean
    }
  | { ok: false; code: string; message: string }

/** Run now, pause, resume or close one of them there (`workspace:operate`). */
export type MeshScheduledAgentAction = 'run' | 'pause' | 'resume' | 'delete'

export type MeshScheduledAgentActionResult =
  { ok: true; id: string; action: MeshScheduledAgentAction } | { ok: false; code: string; message: string }

/**
 * A scheduled agent made on a paired machine from this New chat
 * (`schedule.create`): the project there by one of its workspaces, and what
 * this door would have scheduled here. `worktreeName` null runs in the
 * project's checkout; empty has a worktree named for it there.
 */
export type MeshCreateScheduledAgentInput = {
  workspaceId: string
  prompt: string
  cron: string
  timezone: string
  /** One run, at this instant (epoch ms), instead of the cron's repeats. */
  once?: number
  cli: string
  model?: string | null
  permissionPreset?: CliPermissionPreset | null
  worktreeName?: string | null
  skills?: string[]
  mcpServers?: string[]
}

export type MeshCreateScheduledAgentResult =
  { ok: true; agent: ScheduledAgentView } | { ok: false; code: string; message: string }

/**
 * One of a paired machine's scheduled agents saved from this machine's editor
 * (`schedule.update`, `scheduled-agents-edit`): what the editor shows, in the
 * shape `schedule.create` takes it. `workspaceId` moves it to another project
 * there; absent, it keeps its own. `once` absent repeats on `cron`.
 */
export type MeshUpdateScheduledAgentInput = {
  id: string
  workspaceId?: string
  prompt: string
  cron: string
  timezone: string
  once?: number
  cli: string
  model?: string | null
  permissionPreset?: CliPermissionPreset | null
  worktreeName?: string | null
  skills?: string[]
  mcpServers?: string[]
}

export type MeshUpdateScheduledAgentResult = MeshCreateScheduledAgentResult

/**
 * What deleting a settled chat on a paired machine would do, as that machine
 * plans it (`conversation.delete_plan`): each worktree it owns by its name and
 * branch, never a path there, and `refused` while it cannot be deleted. `gone`
 * is a chat that machine no longer has. `delete_unsupported` is a machine
 * without `chat-lifecycle`.
 */
export type MeshConversationDeletePlanResult =
  | {
      ok: true
      workspaceId: string
      gone?: true
      refused?: string
      worktrees: Array<Omit<SettledChatWorktreePlan, 'path'>>
    }
  | { ok: false; code: string; message: string }

/** That machine took the change, or why not. `row_menu_unsupported` is a machine without the tool. */
export type MeshChangeConversationResult =
  { ok: true; workspaceId: string } | { ok: false; code: string; message: string }

/**
 * The answer to one poll. `unreachable` is deliberately NOT an outcome here —
 * it comes back as `ok: false` so the panel keeps waiting rather than tearing
 * the request down: a machine that went to sleep mid-wait has not refused.
 */
export type MeshCollectPairingResult =
  | { ok: true; status: 'pending'; request: MeshPairRequestView }
  | { ok: true; status: 'approved'; connection: MeshConnection }
  | { ok: true; status: 'denied' }
  | { ok: true; status: 'expired' }
  | { ok: false; code: string; message: string }

/**
 * Whether an event changes the list of paired desktops as `listConnections`
 * gives it, as far as environments read it: one paired, forgotten, or newly
 * identified.
 */
export function meshListChanged(event: MeshEvent): boolean {
  return event.kind === 'machine-paired' || event.kind === 'machine-forgotten' || event.kind === 'machine-identified'
}

// ── Conversations on a paired machine ───────────────────────────────────────
//
// Main follows a conversation over that machine's conversation socket, keeps
// its transcript tail and cursor on disk, and hands a window the same frames
// the local session API does — `snapshot`, `event`, `synchronized`, `error` —
// plus `link`, the client-side connection state the far end cannot narrate
// while unreachable.

/** What a pairing may do with a machine's conversations: follow them, or also drive them. */
export type MeshConversationAccess = 'read' | 'operate'

/** One conversation on one paired machine. The ids are that machine's own. */
export type MeshConversationKey = { connectionId: string; workspaceId: string; agentId: string }

/** A conversation as that machine lists it, with the members its protocol version keeps. */
export type MeshConversation = ConversationListedThread

export type MeshConversationLink = {
  type: 'link'
  state: MeshLinkState
  detail: string
  /** What the far end lets this pairing do right now; null before it has said. */
  access: MeshConversationAccess | null
  /** Why a closed link will not come back on its own, when it will not. */
  code?: string
}

/**
 * The messages the machine holds for this conversation until its turn ends,
 * whole each time (`conversation-queued-sends`). The last list heard stands
 * while the link is down: that machine still holds them.
 */
export type MeshConversationQueued = { type: 'queued'; messages: MeshQueuedMessage[] }

/** A message a paired machine holds for its chat's turn to end, by that machine's id for it. */
export type MeshQueuedMessage = ConversationQueuedMessage

/**
 * The messages the machine has scheduled into this conversation for a time,
 * soonest first, whole each time (`conversation-scheduled-sends`). The last
 * list heard stands while the link is down: that machine still sends them.
 */
export type MeshConversationScheduled = { type: 'scheduled'; messages: MeshScheduledMessage[] }

/** A message a paired machine has scheduled into its chat, by that machine's id for it. */
export type MeshScheduledMessage = ConversationScheduledMessage

/**
 * What the machine knows of its agents' usage limits, for this conversation,
 * whole each time (`conversation-usage-limits`): the notice a limit left on
 * the chat's turn (null for none), whether it resumes every such chat by
 * itself, and each plan's windows. The last heard stands while the link is
 * down.
 */
export type MeshConversationUsageLimits = {
  type: 'usageLimits'
  notice: MeshUsageLimitNotice | null
  autoResume: boolean
  limits: MeshUsageLimitSnapshot[]
}

/** A paired machine's notice for a chat a usage limit stopped. */
export type MeshUsageLimitNotice = ConversationUsageLimitNotice

/** One plan's windows as a paired machine's agents reported them. */
export type MeshUsageLimitSnapshot = ConversationUsageLimitSnapshot

/** What a paired machine's resume row asks of it. */
export type MeshUsageLimitResumeAction = ConversationUsageLimitResumeAction

/**
 * The sub-agents of this conversation, oldest first, whole each time
 * (`conversation-subagents`). The last list heard stands while the link is
 * down, as the machine's agents work on there.
 */
export type MeshConversationSubagents = { type: 'subagents'; subagents: MeshSubagent[] }

/** A chat of a paired machine that belongs to another: followed by its ids, as any chat is. */
export type MeshSubagent = ConversationSubagent

/**
 * How a chat's checkout stands on its machine, whole each time
 * (`conversation-changes`), while a Diff tab here reads its changes: the
 * branch's commits as steps, and a `revision` that moves whenever what the tab
 * shows may have. `changes` is null where the machine has no repository to read.
 */
export type MeshConversationChanges = {
  type: 'changes'
  changes: ConversationCheckoutChanges | null
  revision: string
}

/** One step of a paired machine's chat's changes: its files, or why they could not be read. */
export type MeshChangesDiffResult =
  ({ ok: true } & ConversationChangesDiff) | { ok: false; code: string; message: string }

/** Both sides of one file of such a step, or why they could not be read. */
export type MeshChangedFileResult =
  ({ ok: true } & ConversationChangedFileSides) | { ok: false; code: string; message: string }

export type MeshConversationFrame =
  | ConversationSessionFrame
  | MeshConversationLink
  | MeshConversationQueued
  | MeshConversationScheduled
  | MeshConversationUsageLimits
  | MeshConversationSubagents
  | MeshConversationChanges

/**
 * `capabilities`: what the machine publishes of itself, as it said it. A chat
 * pane reads what it may offer off them and `access`
 * (`negotiateChatCapabilities`, `@sprintengine/client-runtime`); an empty list
 * is a machine that published none, which offers nothing beyond following.
 *
 * What of a chat's record the machine keeps for this one (its rest and read
 * state, the row menu's marks, Rename, Auto compact, Delete, a search) is not
 * the list's: the window reads it off that machine's Studio welcome
 * (`browsePairedMachine`).
 */
export type MeshConversationListResult =
  | {
      ok: true
      conversations: MeshConversation[]
      access: MeshConversationAccess
    }
  | { ok: false; code: string; message: string }

/**
 * A step's picture from a paired machine, as a data URL a window can draw.
 * `images_unsupported` is a machine that does not serve pictures (it does not
 * advertise `conversation-images`); the picture stays over there.
 */
export type MeshConversationImageResult = { ok: true; dataUrl: string } | { ok: false; code: string; message: string }

/**
 * The commands a remote device may send. A permanent rule ("always") needs
 * `conversation-permanent-approvals` there, and is refused in words for a
 * machine without it. Restarting a chat's agent needs `conversation-restart-session` there.
 * A queued send and taking one back need `conversation-queued-sends` there;
 * scheduling one, and sending or deleting one scheduled, need
 * `conversation-scheduled-sends`; a usage limit's resume
 * `conversation-usage-limits`; a preset switch naming the CLI's own mode,
 * `conversation-cli-permission-modes`; a rewind `conversation-rewind`, and a
 * revert `conversation-checkpoint-revert`.
 */
export type MeshConversationCommand = ConversationContractCommand

/**
 * A send to a chat on a paired machine, as a window hands it to main: the
 * contract's request, its pictures as their bytes, addressed to the chat.
 * Main puts each picture and file in that machine's upload store first and
 * sends the request on the lane, as the lane carries it
 * (`ConversationLaneSend`); a part the lane says another way (the bubble's
 * id, the reasoning effort) is not one a window sends here.
 *
 * `queue` needs `conversation-queued-sends` there, and with pictures, files,
 * skills or mentions `conversation-queued-attachments` too; `steer` needs
 * `conversation-steer-sends`, `mode` `conversation-send-mode`, `skills`
 * `conversation-send-skills`, `mentions` `conversation-send-mentions` and
 * `files` `conversation-message-files`. Main refuses each in words for a
 * machine without it rather than let it be dropped there.
 */
export type MeshConversationSendInput = { key: MeshConversationKey } & Omit<
  ConversationSendRequest<ConversationImageAttachment>,
  ConversationLaneNotCarried
>

/**
 * The files and folders in a paired machine's chat folder that match a
 * mention's query, by their paths relative to that folder
 * (`conversation-file-search`).
 */
export type MeshConversationFileSearchResult =
  | { ok: true; entries: ConversationFileSearchEntry[]; truncated: boolean }
  | { ok: false; code: string; message: string }

/**
 * The slash commands a paired machine's chat CLI runs in the chat's folder
 * there (`conversation-commands`), as that machine's own `/` menu lists them.
 */
export type MeshConversationCommandsResult =
  | { ok: true; cli: string; commands: ConversationCommand[]; fetchedAt: number; error?: string }
  | { ok: false; code: string; message: string }

/**
 * `notice` qualifies an accepted command, e.g. that a model switch applies
 * from the next turn. `data` is what a command that answers more than yes or
 * no said, accepted or refused, as the machine sent it: a `revert`'s
 * `ConversationRevertAnswer`, read with `parseConversationRevertAnswer`.
 */
export type MeshConversationCommandResult =
  | { ok: true; notice?: string; data?: Record<string, unknown> }
  | { ok: false; code: string; message: string; data?: Record<string, unknown> }

/**
 * Whether a machine's listed chat is at work, waiting on a person, or neither.
 * A turn in flight is at work, and so is a chat whose turn is over while its
 * `backgroundWork` goes on, as the machine's own sidebar counts it
 * (`phaseWithBackgroundWork`). A machine from before it listed background work
 * says only the turn's phase, which is read as before.
 */
export function meshConversationPresence(
  phase: MeshConversation['phase'],
  backgroundWork?: MeshConversation['backgroundWork'] | null,
): 'running' | 'needs-input' | 'idle' {
  const counted = phaseWithBackgroundWork(readableConversationPhase(phase), Boolean(backgroundWork))
  if (conversationPhaseWorking(counted)) return 'running'
  if (counted === 'waiting_for_approval' || counted === 'waiting_for_input') return 'needs-input'
  return 'idle'
}

/** The layout component of a chat pane following a conversation on a paired machine. */
export const MESH_CONVERSATION_COMPONENT = 'mesh-conversation'

/**
 * Whether a layout tab's component is a remote conversation pane. Layouts are
 * saved with their tabs, and ones saved before the client side was called the
 * mesh name this pane `fleet-conversation`; it reads as the same pane, so an
 * update reopens every remote chat a person had.
 *
 * A remote terminal pane (`mesh-terminal`, or `fleet-terminal` before that) is
 * not one. Terminals stopped crossing the tailnet on 2026-09-29, and such a tab
 * saved by an earlier build falls through to the layout's unavailable surface,
 * like any other stale tab.
 */
export function isMeshConversationPane(component: unknown): boolean {
  return component === MESH_CONVERSATION_COMPONENT || component === 'fleet-conversation'
}

/** A layout tab's component with a pre-rename remote pane read as its current name; any other unchanged. */
export function canonicalMeshPaneComponent<T>(component: T): T | typeof MESH_CONVERSATION_COMPONENT {
  return isMeshConversationPane(component) ? MESH_CONVERSATION_COMPONENT : component
}

/**
 * The id a remote conversation's row and pane are known by here: one id for
 * "what this pane shows on that machine", so a row finds the window already
 * showing it.
 */
export function meshConversationSessionId(workspaceId: string, agentId: string): string {
  return `conversation:${workspaceId}:${agentId}`
}

/**
 * The chat and agent a `meshConversationSessionId` names, or null for any other
 * string. The agent id is the last segment, so a workspace id with a colon in
 * it reads whole.
 */
export function parseMeshConversationSessionId(sessionId: string): { workspaceId: string; agentId: string } | null {
  const match = /^conversation:(.+):([^:]+)$/.exec(sessionId)
  return match ? { workspaceId: match[1], agentId: match[2] } : null
}

/** The chat a remote conversation pane follows, and what its tab is called until that machine is read. */
export type MeshConversationPaneSpec = {
  connectionId: string
  machineName: string
  remoteWorkspaceId: string
  remoteAgentId: string
  title: string
}

/**
 * A layout tab that is a pane onto a chat on a paired machine: its id names
 * the chat, so a layout never holds two tabs onto one, and its config is what
 * the pane and the sidebar's Remote band read it by.
 */
export function meshConversationTab(
  pane: MeshConversationPaneSpec,
  name: string = pane.title,
): { id: string; name: string; component: typeof MESH_CONVERSATION_COMPONENT; config: Record<string, string> } {
  return {
    id: `mesh-conversation:${pane.connectionId}:${encodeURIComponent(pane.remoteWorkspaceId)}:${encodeURIComponent(pane.remoteAgentId)}`,
    name,
    component: MESH_CONVERSATION_COMPONENT,
    config: {
      connectionId: pane.connectionId,
      machineName: pane.machineName,
      remoteWorkspaceId: pane.remoteWorkspaceId,
      remoteAgentId: pane.remoteAgentId,
      remoteSessionId: meshConversationSessionId(pane.remoteWorkspaceId, pane.remoteAgentId),
      title: pane.title,
    },
  }
}

/** A paired machine's chat folder searched for a mention, and its CLI's `/` list. */
