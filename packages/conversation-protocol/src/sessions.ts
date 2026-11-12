import type { ConversationWirePermissionPreset } from './index.js'
import type { ConversationBackgroundTask, ConversationEvent, ConversationSessionStatus } from './events.js'
import type { ConversationJsonValue, ConversationToolStatus } from './tool-types.js'

// A live session as Studio's runtime summarises it, and what its session
// methods answer: the shapes every client of a chat reads, whichever way it
// reaches it (the desktop's own window, the Studio protocol's `session.*`
// methods, an SDK). They are defined here once; the desktop's runtime
// re-exports them under the names its code has always used.

/** One display phase for a conversation, ordered by the action it needs. */
export type ConversationPhase =
  'idle' | 'starting' | 'running' | 'waiting_for_approval' | 'waiting_for_input' | 'failed' | 'completed'

/** The lifetime of a cached prompt prefix. */
export type PromptCacheTtl = '5m' | '1h'

/**
 * A session's prompt cache, as the agent CLI last reported it: when the
 * cached prefix goes cold and what a cold resume writes to the cache again.
 * How it is read and folded lives in `@sprintengine/conversation-timeline`.
 */
export type PromptCacheReading = {
  // The lifetime of the cached prefix. Null when the source has not said.
  ttl: PromptCacheTtl | null
  // When the cached prefix goes cold, in epoch ms. Null when the last request
  // reported no cache tokens at all: nothing is cached, so it is already cold.
  expiresAt: number | null
  // How many tokens the next request writes to the cache again if the cache
  // has gone cold by then — the size of the conversation. Null when unknown,
  // which the CLI reports right after a compaction until the next request.
  recacheTokens: number | null
}

/**
 * A file one of a conversation's tool calls is reading or editing, or did a
 * moment ago: what the Files tree marks while the agent works. One entry per
 * path, so a patch across three files is three.
 */
export type ConversationFileActivity = {
  /** Absolute and `/`-separated, a relative path placed against the root the agent runs in. */
  path: string
  verb: 'reading' | 'editing'
  /** The tool call. */
  toolUseId: string
  /** The call that spawned the agent doing it, for a spawned agent's step; absent for the conversation's own. */
  laneId?: string
  startedAt: number
  /** Absent while the call runs. */
  endedAt?: number
}

export type ConversationSessionSummary = {
  sessionId: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  status: ConversationSessionStatus
  createdAt: number
  updatedAt: number
  displayName?: string
  capabilities?: ConversationCapabilities
  phase?: ConversationPhase
  currentToolTitle?: string
  firstUserText?: string
  lastUserText?: string
  // The opening of the agent's last reply (the sidebar's preview)…
  lastAssistantText?: string
  // …and its end, where an agent puts its conclusion: what a launch notice
  // quotes to the agent that started this one.
  lastAssistantTail?: string
  // Background subagents still running. They keep the conversation working
  // after its turn has ended, so the sidebar and tab still show activity.
  backgroundAgents?: number
  // Shells and monitors the chat's process still runs after its turn ended.
  // They keep that process alive, and a monitor keeps the chat working too,
  // since it wakes the agent when it has something to say. Absent when none.
  backgroundTasks?: ConversationBackgroundTask[]
  // When the most recent turn completed or failed (the event's own time, so it
  // survives a resume). Absent until a turn has ended. The sidebar and the tab
  // count "finished" from this rather than `updatedAt`, which also moves on a
  // model or permission change.
  lastTurnEndedAt?: number
  // When the turn now running began: its message was sent, or the agent
  // carried on by itself. A message steered into a running turn does not move
  // it. Absent between turns, so a "working for" count needs no event stream.
  turnStartedAt?: number
  // When the chat's current stretch of work began (conversation/
  // workingStretch.ts): the person's message that began it, carried through
  // the turns the chat opens by itself while a background agent or a monitor
  // still works, where `turnStartedAt` restarts with each. The sidebar's
  // "working for" count, here and on a paired machine. Present only while the
  // summary reads as working (`conversationSummaryPhase` running or
  // starting), and absent from a server built before it, where the sidebar
  // keeps its own reading.
  workingSince?: number
  // When the chat began waiting on the person: the request (an approval or a
  // question) that stopped it, by the event's own time, so a resume restores
  // it from the transcript. A second card while one is up does not move it.
  // Absent while nothing is asked. `updatedAt` cannot stand in: it also moves
  // on a model or permission change.
  waitingSince?: number
  // When the person last sent the chat a message (the event's own time, so it
  // survives a resume). `updatedAt` also moves on a model or permission
  // change, which is not the person saying anything. Absent until one is sent.
  lastUserMessageAt?: number
  // Settle, Snooze or the idle sweep ended the chat's child process and
  // nothing has started it again; the next message does. The session and its
  // resume cursor stay, so its status still reads `ready`, but it holds no
  // process and is not warm to switch into. Absent while a child may be live.
  resting?: true
  // The main conversation's prompt cache, as its provider's last request left
  // it: when it goes cold and what a cold resume re-caches
  // (shared/prompt-cache.ts). Absent for a provider that reports no cache.
  promptCache?: PromptCacheReading
  // The files the conversation's tool calls are reading and editing, and the
  // ones they finished with in the last minute (shared/conversation/
  // fileActivity.ts): what the Files tree marks. Absent when there are none,
  // and from a server built before it existed, which the tree reads as an
  // agent touching nothing.
  fileActivity?: ConversationFileActivity[]
  // The preset currently in force, when the session carries one. Absent means
  // the session never set one and the provider passes no permission override,
  // as `none` does. Changing it mid-conversation goes through
  // `conversation:sessions:set-permission`.
  permissionPreset?: ConversationWirePermissionPreset
  // The CLI's own mode at that preset (Claude Code's Accept edits), when one
  // other than the preset's own is in force (cli-permission-mode.ts). Absent,
  // the preset's own mode.
  permissionMode?: string
  // The session was started with tools it may use without asking
  // (`allowedTools`). For those tools that is as loose as `bypass`, so anything
  // holding a caller to a ceiling counts it as bypass. The tools themselves
  // are not listed here.
  allowsUnaskedTools?: true
}

export type ConversationAttachmentResult =
  { ok: true; mediaType: string; dataBase64: string } | { ok: false; message: string }

export type ConversationPlanDocumentResult = { ok: true; path: string } | { ok: false; message: string }

/** What can be done to one of a live chat's MCP servers from its composer. */
export type ConversationMcpServerAction = 'reconnect' | 'enable' | 'disable' | 'sign-in'

export type ConversationStartSessionResult =
  { ok: true; session: ConversationSessionSummary } | { ok: false; message: string; event?: ConversationEvent }

export type ConversationSessionActionResult =
  // `notice` is a plain sentence for the user about a change that was accepted
  // but does not apply yet (switching to Bypass while a turn is still
  // streaming). The action succeeded; this is not an error.
  | { ok: true; session: ConversationSessionSummary; notice?: string }
  // `code` names a refusal a caller acts on by itself. The runtime gives three:
  // `command_id_conflict`, a command id already used for a different command,
  // `session_not_found` (CONVERSATION_SESSION_NOT_FOUND), and `busy`, a send
  // that arrived while a turn runs, to send again after `retryAfterMs`.
  | { ok: false; message: string; event?: ConversationEvent; code?: string; retryAfterMs?: number }

/**
 * The refusal of a call about a session the runtime does not hold: the
 * server that held it restarted (a WSL distribution's, an SSH machine's, the
 * desktop's own out of process), or the chat started another. Whoever holds
 * the id starts the chat's session again, which resumes it from its
 * transcript, and sends again on that one.
 */
export const CONVERSATION_SESSION_NOT_FOUND = 'session_not_found'

export type ConversationToolDetail = {
  input: ConversationJsonValue
  output: ConversationJsonValue
  status: ConversationToolStatus
  exitCode?: number
  mime?: string
  totalBytes?: number
  clipped: boolean
}

export type ConversationToolDetailResult =
  | { ok: true; detail: ConversationToolDetail }
  | { ok: false; code: 'not_found' | 'invalid_input' | 'unavailable'; message: string }
export type ConversationCapabilities = {
  permissionPresets?: ConversationWirePermissionPreset[]
  // The CLI's own modes this chat can run beside the presets' own, by the ids
  // its CLI's manifest keys them under (`conversationPermissionModes`).
  permissionModes?: string[]
  tools: boolean
  approvals: boolean
  questions: boolean
  planMode: boolean
  // Runs `ask` turns read-only without planning: a provider with `planMode`
  // has that already, on the same read-only channel.
  askMode?: boolean
  images: boolean
  // `native`: the provider loads attached skills itself. `context`: the
  // runtime delivers them, as the CLI's own invocation by name when a CLI
  // stands behind the chat (conversation-skills.ts), else as instructions.
  skills: 'native' | 'context' | 'none'
  reasoningEfforts: string[] | null
  interrupt: boolean
  resume: boolean
  subagents: boolean
  cost: boolean
  contextMeter: boolean
  liveModelSwitch: boolean
  // What the composer may do to the chat's MCP servers while it runs.
  mcpServerActions?: ConversationMcpServerAction[]
  checkpoints?: boolean
  // The provider reads `@path` in a prompt as a reference to that workspace
  // file and opens it itself, so a mention can be passed as `@path`.
  atMentions?: boolean
  // The provider takes a user message into a turn it is already running
  // (`steer` on a send). Without it, sending now means stopping the turn first.
  steer?: boolean
  // The provider can take the conversation back to before one of its user
  // messages, dropping that message and everything after it from its own
  // context ("Edit from here"). Without it the action is not offered.
  rewind?: boolean
  // A new chat can be made holding this one up to an earlier message, and
  // carry on from there on its own ("Fork from here"). Without it the action
  // is not offered.
  fork?: boolean
  // A fork at the newest reply branches the session the chat is running
  // (an ACP agent's `session/fork`), so the chat's session is started first.
  forkFromLiveSession?: boolean
  // The chat can be handed off to a fresh provider session that is pointed
  // at a file of its messages ("Handoff", `ConversationHandoffInput`).
  // Without it the action is not offered.
  handoff?: boolean
  // One agent the chat spawned can be stopped by itself, leaving the chat,
  // its turn and its other agents running. Without it a lane offers no Stop.
  stopSubagent?: boolean
  // The chat's model can be asked to pass a message to one agent it spawned.
  // Without it an agent's chat draws no box, only a way to the parent.
  messageSubagent?: boolean
  // A side question can be asked about the chat and answered from its
  // context without entering it, even while a turn runs. Without it the
  // action is not offered.
  sideQuestion?: boolean
  // The agent says what fills its context window, row by row and item by
  // item (`readContextBreakdown`). Without it the ring opens on the total.
  contextBreakdown?: boolean
}
export type ConversationCheckpointFile = {
  path: string
  status: 'added' | 'modified' | 'deleted'
  addedLines: number
  removedLines: number
  binary: boolean
}
export type ConversationCheckpointDiff = { files: ConversationCheckpointFile[]; submodulesExcluded: true }
export type ConversationTurnDiffResult =
  | { ok: true; diff: ConversationCheckpointDiff; patch?: string; original?: string; modified?: string }
  | { ok: false; message: string }

export type ConversationRevertResult =
  | {
      ok: true
      files: ConversationCheckpointFile[]
      reverted: boolean
      undoRef?: string
      /** Listed as added but left in place: the checkpoint's ignore rules ignore them. */
      kept?: string[]
    }
  | { ok: false; message: string; changed?: true }

export type ConversationRewindResult = { ok: true } | { ok: false; message: string }

export type ConversationHandoffResult = { ok: true; path: string } | { ok: false; message: string }

export type ConversationForkResult = { ok: true } | { ok: false; message: string }
