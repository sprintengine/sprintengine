// The conversation contract — events, their payloads, pages and stream
// frames — is @sprintengine/conversation-protocol's, which every transport
// speaks (the chat view's IPC, the tailnet lane, the module SDK). It is
// re-exported here under the names app code has always imported; what stays
// below is the runtime's own: session inputs, results and summaries.
import type {
  ConversationApprovalKind,
  ConversationEvent,
  ConversationJsonValue,
  ConversationMessageOrigin,
  ConversationSubagentMessage,
  ConversationPage,
  ConversationToolKind,
  ConversationToolOutputPayload,
  ConversationToolStartedPayload,
  ConversationToolStatus,
} from '../../packages/conversation-protocol/src/public'
export type {
  ConversationApprovalKind,
  ConversationApprovalRequestedPayload,
  ConversationBackgroundTask,
  ConversationBackgroundTaskKind,
  ConversationApprovalResolvedPayload,
  ConversationCursor,
  ConversationEvent,
  ConversationEventType,
  ConversationGoal,
  ConversationGoalStatus,
  ConversationHandoffPayload,
  ConversationJsonValue,
  ConversationMessageOrigin,
  ConversationSubagentMessage,
  ConversationPage,
  ConversationQuestion,
  ConversationQuestionOption,
  ConversationSessionStatus,
  ConversationStreamFrame as ConversationSessionFrame,
  ConversationSubagentMessagePayload,
  ConversationSubagentState,
  ConversationSubagentStatusPayload,
  ConversationToolKind,
  ConversationToolOutputPayload,
  ConversationToolStartedPayload,
  ConversationToolStatus,
  ConversationTurnCompletedPayload,
  ConversationTurnRetryingPayload,
  ConversationTurnUsage,
} from '../../packages/conversation-protocol/src/public'
// Who a `user_message` came from when it was not the person (`origin`).
export { readConversationMessageOrigin } from '../../packages/conversation-protocol/src/public'
import type {
  ConversationSessionSummary,
  ConversationMcpServerAction,
  ConversationCapabilities,
} from '../../packages/conversation-protocol/src/public'
// A live session's summary and its methods' results are the contract's too.
export type {
  ConversationFileActivity,
  ConversationSessionSummary,
  ConversationAttachmentResult,
  ConversationPlanDocumentResult,
  ConversationMcpServerAction,
  ConversationStartSessionResult,
  ConversationSessionActionResult,
  ConversationToolDetail,
  ConversationToolDetailResult,
  ConversationCapabilities,
  ConversationCheckpointFile,
  ConversationCheckpointDiff,
  ConversationTurnDiffResult,
  ConversationRevertResult,
  ConversationRewindResult,
  ConversationHandoffResult,
  ConversationForkResult,
} from '../../packages/conversation-protocol/src/public'
export { CONVERSATION_SESSION_NOT_FOUND } from '../../packages/conversation-protocol/src/public'

// Loose mirror of the CLI runtime override map (`appSettings.cliRuntimes`)
// so stateful CLI-backed providers can honor a custom binary path. Kept
// structural (not the electron-api types) to avoid a shared-type cycle.
export type ConversationCliRuntimeOverrides = Record<
  string,
  { command?: string; hostId?: import('./execution-host').ExecutionHostId; models?: string[] } | undefined
>

// Mirrors the terminal-side `cliPermissionPreset` vocabulary
// (CliPermissionPreset, shared/cli-permission-preset.ts, where each mode's
// meaning is written down) without importing electron-api types. The value
// tuple is exported so the IPC boundary validates against one list.
export const CONVERSATION_PERMISSION_PRESETS = ['none', 'manual', 'auto', 'bypass'] as const

export type ConversationPermissionPreset = (typeof CONVERSATION_PERMISSION_PRESETS)[number]

/**
 * An MCP server a chat's session is started with, on top of whatever the
 * person's own CLI configuration loads: a connector automation's server, or
 * the app's own gateway. The fields an installed server (`McpServerConfig`)
 * carries for the CLI; `envVarNames` names variables the CLI hands the server
 * from its own environment (an HTTP server's bearer token is the first).
 */
export type ConversationMcpServer = {
  id: string
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  envVarNames?: string[]
}

export type ConversationStartSessionInput = {
  workspaceRoot: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  cliRuntimes?: ConversationCliRuntimeOverrides
  // How tool permissions behave for CLI-backed stateful providers: 'bypass'
  // skips the CLI's permission prompts (the default for every agent), 'auto'
  // lets workspace edits through and asks before anything riskier, 'manual'
  // asks before every edit, command and outside call, and 'none' passes no
  // override and lets the CLI's own configuration decide — which can still
  // ask, as approval cards.
  permissionPreset?: ConversationPermissionPreset
  // The CLI's own mode at that preset, read only beside it; one the provider
  // does not run (`capabilities.permissionModes`) starts the preset's own.
  permissionMode?: string
  // Tools auto-allowed without an approval card. Lets unattended flows (the
  // long-running authoring sessions) run file writes without stalling while interactive tools
  // (AskUserQuestion) still surface as cards — unlike bypass, which would
  // silence them entirely.
  allowedTools?: string[]
  // MCP servers this session alone runs with. Main-only: a start that comes
  // over IPC never carries them. A provider that cannot take servers per
  // session refuses a start that names any, rather than running without them.
  mcpServers?: ConversationMcpServer[]
}

export type ConversationProvidersListInput = {
  cliRuntimes?: ConversationCliRuntimeOverrides
}

// Signing a chat's CLI back in after its login lapsed: the line a plain
// terminal on this machine runs, resolved to the executable the provider runs.
export type ConversationProviderSignInInput = {
  providerId: string
  cliRuntimes?: ConversationCliRuntimeOverrides
}

export type ConversationProviderSignInResult =
  | {
      ok: true
      commandLine: string
      cwd: string
      platform: string
      /** The machine the sign-in terminal opens on; absent is this one. */
      hostId?: import('./execution-host').ExecutionHostId
    }
  | { ok: false; message: string }

export type ConversationTranscriptInput = {
  workspaceRoot: string
  workspaceId: string
  agentId: string
}

export type ConversationTranscriptResult = { ok: true; events: ConversationEvent[] } | { ok: false; message: string }

// The images a turn carries, as the timeline package defines them.
import type {
  ConversationImageAttachment,
  ConversationStoredImageAttachment,
} from '../../packages/conversation-timeline/src/attachments'
export type { ConversationImageAttachment, ConversationStoredImageAttachment }

export type ConversationAttachmentInput = { ref: string }

// A plan the agent proposed, as a file the workspace pane can open. `plan` is
// the text the transcript recorded; `planFilePath` is the agent's own copy
// when it keeps one on this machine (Claude Code's plan file). The result is
// that file when it still holds this plan, otherwise a copy in app data.
export type ConversationPlanDocumentInput = ConversationKey & {
  plan: string
  title?: string
  planFilePath?: string
}

export type ConversationSendTurnInput = {
  // What the person wrote to one of the chat's agents, for a message asking the
  // chat to pass it on: recorded on the `user_message`, for the agent's lane.
  subagentMessage?: ConversationSubagentMessage
  // What the command was, hashed by whoever named its id: a receipt keeps it,
  // and the same id coming back for a different command is refused rather
  // than answered with the first one's result. Never sent by a window's IPC.
  commandFingerprint?: string
  mentions?: import('./conversation/mentions').ConversationMentionRef[]
  // Files attached by path from this computer: the agent is told where each
  // is, after the words, and the `user_message` keeps them beside the text
  // so the bubble draws them as cards. The text stays the person's words.
  files?: import('./conversation/attachedFiles').ConversationAttachedFile[]
  reasoningEffort?: string
  mode?: 'default' | 'plan' | 'ask'
  commandId?: string
  skills?: ConversationSkillRef[]
  sessionId: string
  message: string
  // Renderer-generated id of the optimistic user bubble for this send; echoed
  // back on the persisted `user_message` event so the projection can replace
  // the optimistic entry with the authoritative one deterministically.
  localTurnId?: string
  // Images attached to this turn. Honored only by vision-capable providers
  // (currently the claude-agent provider); other providers ignore them, so no
  // image block is ever sent to them. Main keeps a copy in the attachment store
  // so the replayed bubble can show them; the model sees them on this turn only.
  attachments?: ConversationImageAttachment[]
  // Deliver into the turn that is running instead of waiting for it to end.
  // Honored where the provider declares `capabilities.steer`; the running
  // turn closes where the message lands, and the reply carries on as this
  // one's.
  steer?: boolean
  // Studio sent this message itself (a launched agent's notice, a resume after
  // a usage limit), not the person: recorded on the `user_message` so the chat
  // draws it as Studio's and nothing counts it as the person writing. Set only
  // by Studio's own senders in main; neither a window's IPC nor the Studio
  // protocol's `session.send` passes one through.
  origin?: ConversationMessageOrigin
  // When the person wrote the message, on the sending device's clock (epoch
  // ms): a paired device's `send` says so. Recorded on the `user_message`,
  // and a send under a command id written longer ago than the lane's limit is
  // refused `stale` unless `confirmedStale` says the person asked for it to go
  // now (`isStaleConversationSend`). A message held on a device while it slept
  // is not one the person still means hours later.
  composedAt?: number
  confirmedStale?: boolean
}

export type ConversationInterruptInput = {
  // What the command was, hashed by whoever named its id: a receipt keeps it,
  // and the same id coming back for a different command is refused rather
  // than answered with the first one's result. Never sent by a window's IPC.
  commandFingerprint?: string
  commandId?: string
  sessionId: string
}

export type ConversationRespondToRequestInput = {
  // What the command was, hashed by whoever named its id: a receipt keeps it,
  // and the same id coming back for a different command is refused rather
  // than answered with the first one's result. Never sent by a window's IPC.
  commandFingerprint?: string
  commandId?: string
  decision?: import('./conversation/approvalRules').ConversationApprovalDecision
  sessionId: string
  requestId: string
  approved: boolean
  // Structured answers for question-kind requests (AskUserQuestion): question
  // text → chosen answer (multi-select answers comma-separated, free-text
  // "other" answers verbatim). Ignored for plain tool approvals.
  answers?: Record<string, string>
  // The kind of request the caller believes it is answering. Given, an answer
  // to a request of another kind is refused rather than read as that kind's:
  // a plan approved by a client that meant to answer a tool permission is not
  // the same decision. Absent, any kind is answered, as before.
  requestKind?: ConversationApprovalKind
}

// Change how tool permissions behave on a session that is already running. The
// interactive path only: the change reaches the live provider session and takes
// effect on its next tool call, without recreating the session or losing
// history.
export type ConversationSetPermissionInput = {
  // What the command was, hashed by whoever named its id: a receipt keeps it,
  // and the same id coming back for a different command is refused rather
  // than answered with the first one's result. Never sent by a window's IPC.
  commandFingerprint?: string
  commandId?: string
  sessionId: string
  permissionPreset: ConversationPermissionPreset
  // The CLI's own mode at that preset; absent, the preset's own.
  permissionMode?: string
}

// Switch a running conversation to another model of the same provider. The
// CLI's own default row is `default`. Applies from the next turn.
export type ConversationSetModelInput = {
  // What the command was, hashed by whoever named its id: a receipt keeps it,
  // and the same id coming back for a different command is refused rather
  // than answered with the first one's result. Never sent by a window's IPC.
  commandFingerprint?: string
  commandId?: string
  sessionId: string
  modelId: string
}

export type ConversationMcpServerActionInput = {
  sessionId: string
  serverId: string
  action: ConversationMcpServerAction
}

/**
 * `authUrl` is where a sign-in is finished, in the person's browser; the CLI
 * waits on its own callback and reconnects the server once it arrives.
 */
export type ConversationMcpServerActionResult = { ok: true; authUrl?: string } | { ok: false; message: string }

/** One agent a chat spawned, named by the call that spawned it (its lane), to stop on its own. */
export type ConversationStopSubagentInput = {
  sessionId: string
  toolUseId: string
}

/** The person's words for one agent a chat spawned, named as `ConversationStopSubagentInput` names it. */
export type ConversationMessageSubagentInput = {
  sessionId: string
  toolUseId: string
  message: string
  commandId?: string
  commandFingerprint?: string
}

/**
 * A side question about a chat: answered from what the chat's agent knows, and
 * kept out of the conversation. Neither the question nor its answer enters the
 * agent's context, the transcript or the chat's history, and a turn the chat
 * is running goes on undisturbed. `requestId` is the caller's, so the question
 * can be called off while it is answered (`cancelSideQuestion`). `history` is
 * the side questions asked before it in the same aside, oldest first, so a
 * follow-up can lean on them.
 */
export type ConversationSideQuestionInput = {
  sessionId: string
  requestId: string
  question: string
  history?: ConversationSideQuestionExchange[]
}
export type ConversationSideQuestionExchange = { question: string; answer: string }
/** `cancelled`: called off before it was answered, which says nothing to the person. */
export type ConversationSideQuestionResult =
  { ok: true; answer: string } | { ok: false; message: string; cancelled?: true; code?: string }
export type ConversationCancelSideQuestionInput = { sessionId: string; requestId: string }

/**
 * What fills a chat's context window, item by item, as its agent measured it
 * (Claude Code's own `/context` reading). Asked for when a person opens the
 * composer strip's context ring, never on a timer: the agent answers from
 * the conversation it holds, so there is nothing to keep fresh in between.
 */
export type ConversationContextBreakdownInput = { sessionId: string }

/**
 * One row of the window's breakdown. `used` fills the window, `free` is what
 * is left of it, `buffer` is held back for compaction, and `deferred` is
 * listed for awareness but not in the window (tool schemas loaded on demand).
 */
export type ConversationContextCategory = {
  name: string
  tokens: number
  kind: 'used' | 'free' | 'buffer' | 'deferred'
}

/** A skill, memory file or custom agent and what it costs; `detail` is where it comes from. */
export type ConversationContextItem = { name: string; tokens: number; detail?: string }

/** An MCP server, the tokens its loaded tools' schemas take, and each tool. */
export type ConversationContextMcpServer = {
  name: string
  /** Its loaded tools' tokens: a deferred tool is not in the window until it is used. */
  tokens: number
  tools: Array<{ name: string; tokens: number; loaded: boolean }>
}

export type ConversationContextBreakdown = {
  model: string
  usedTokens: number
  /** The window the agent measures against: the model's, or a smaller one it compacts at. */
  windowTokens: number
  categories: ConversationContextCategory[]
  mcpServers: ConversationContextMcpServer[]
  skills: ConversationContextItem[]
  memoryFiles: ConversationContextItem[]
  agents: ConversationContextItem[]
  /** Where the agent compacts on its own; null when it does not. */
  autoCompactAt: number | null
  /** The agent estimated the rows rather than counting each one with the API. */
  estimated: boolean
  measuredAt: number
}

/**
 * `stale`: the agent is not running now, and this is the last reading it gave.
 * `not-running`: nothing to ask and nothing read before. `unsupported`: the
 * chat's agent, or its version, gives no breakdown.
 */
export type ConversationContextBreakdownResult =
  | { ok: true; breakdown: ConversationContextBreakdown; stale?: true }
  | { ok: false; reason: 'unsupported' | 'not-running' | 'failed'; message: string }

export type ConversationStopSessionInput = {
  // What the command was, hashed by whoever named its id: a receipt keeps it,
  // and the same id coming back for a different command is refused rather
  // than answered with the first one's result. Never sent by a window's IPC.
  commandFingerprint?: string
  sessionId: string
  // With one, the stop goes through the conversation's durable receipts like
  // any other command: a retry is answered with the first result, so a resend
  // after a reconnect cannot stop a session started since.
  commandId?: string
}

// Settle and Snooze: end the session's child process but keep the session, so
// the next message respawns it and resumes the same provider session.
export type ConversationSuspendSessionInput = {
  sessionId: string
}

// Resume in terminal: the chat's CLI session is taken over by a terminal agent
// running the CLI's own resume (`claude --resume <id>`, `codex resume <id>`).
export type ConversationTerminalHandoffInput =
  | { sessionId: string }
  // The chat by its identity, for a caller that holds no session of it (a tab's
  // menu): main hands over the session it has running, or starts one from the
  // chat's record to read the CLI session from its transcript, as after an app
  // restart, when nothing has been sent to the chat yet.
  | { workspaceId: string; agentId: string }

export type ConversationTerminalHandoffResult =
  // The terminal agent now carrying the conversation on, in the chat's workspace.
  { ok: true; workspaceId: string; agentId: string } | { ok: false; message: string }

export type ConversationListSessionsInput = {
  workspaceId?: string
  agentId?: string
}

export type ConversationListSessionsResult =
  { ok: true; sessions: ConversationSessionSummary[] } | { ok: false; message: string }

export type ConversationToolDetailInput = ConversationTranscriptInput & { toolUseId: string }
export type ConversationToolEvent =
  | (Omit<ConversationEvent, 'type' | 'payload'> & {
      type: 'tool_started'
      payload: ConversationToolStartedPayload & {
        toolUseId: string
        kind: ConversationToolKind
        name: string
        input: ConversationJsonValue
      }
    })
  | (Omit<ConversationEvent, 'type' | 'payload'> & {
      type: 'tool_output'
      payload: ConversationToolOutputPayload & {
        toolUseId: string
        preview: string
        totalBytes: number
        truncated: boolean
        status: ConversationToolStatus
      }
    })
export type ConversationTurnDiffInput = { key: ConversationKey; turnSeq: number; path?: string }
/** A confirmed revert names the exact paths the preview showed; any drift refuses with `changed`. */
export type ConversationRevertInput = {
  key: ConversationKey
  turnSeq: number
  confirmed?: boolean
  undo?: boolean
  files?: string[]
}
/**
 * Take the conversation back to before the user message at `turnSeq`: that
 * message and every turn after it leave the provider's context and the
 * transcript's view. Files are not touched; a caller that wants them back
 * reverts the turn's checkpoint first.
 */
export type ConversationRewindInput = { key: ConversationKey; turnSeq: number }
/**
 * Hand a chat off to a fresh provider session instead of compacting it: its
 * messages (no tool calls, no tool output) are saved to a file in the
 * project's store, the provider session is let go, and the next message the
 * person sends points the new session at the file. The chat's history stays
 * as it was, with a divider where the handoff happened. Refused while the chat
 * is doing anything: a turn, a question, an agent, a shell or a monitor all
 * live in the process this ends.
 */
export type ConversationHandoffInput = { key: ConversationKey }
/**
 * Start a new chat, `newAgentId`, holding this one up to a point: through the
 * reply of the turn `turnId` names, or up to (not including) the user message
 * at `turnSeq`. The new chat carries on by itself; this one is not touched.
 * `title` names it in the chat history.
 */
export type ConversationForkInput = {
  key: ConversationKey
  newAgentId: string
  title?: string
} & ({ side: 'assistant'; turnId: string } | { side: 'user'; turnSeq: number })
/**
 * Give a new chat the history of a session an agent CLI saved on its own (one
 * a person ran in its terminal), ending in that session's id as the chat's
 * resume cursor, so the chat's next message continues the same session.
 * `events` are the history in this protocol's vocabulary, oldest first.
 */
export type ConversationImportTranscriptInput = {
  key: ConversationKey
  providerId: string
  modelId: string
  providerSessionId: string
  title?: string
  importedFrom: { source: string; sessionId: string }
  events: Array<{ type: ConversationEvent['type']; createdAt: number; payload: Record<string, unknown> }>
}
export type ConversationImportTranscriptResult = { ok: true } | { ok: false; message: string }
export type ConversationSkillRef = { id: string; sourcePath?: string }
export type ConversationApprovalRulesResult =
  | { ok: true; rules: import('./conversation/approvalRules').ConversationApprovalRule[] }
  | { ok: false; message: string }
export type ConversationApprovalRuleRevokeResult = { ok: true } | { ok: false; message: string }

export type ConversationKey = ConversationTranscriptInput
// `afterSeq` with the `generation` from an earlier snapshot or synchronized
// frame asks for only the events after that sequence. A cursor the log cannot
// vouch for (another generation, ahead of the log, or too far behind) gets a
// reset snapshot instead, as does a cursor sent without a generation.
export type ConversationSubscribeInput = {
  key: ConversationKey
  afterSeq?: number
  generation?: string
  turnLimit?: number
}
export type ConversationLoadEarlierInput = { key: ConversationKey; beforeCursor: number; turnLimit?: number }
export type ConversationPageResult = { ok: true; page: ConversationPage } | { ok: false; message: string }

/** Whether a provider can run a turn in `mode`. Any mode but these two is a plain turn. */
export function runsTurnMode(
  capabilities: Pick<ConversationCapabilities, 'planMode' | 'askMode'> | undefined,
  mode: string | undefined,
): boolean {
  if (mode === 'plan') return capabilities?.planMode === true
  if (mode === 'ask') return capabilities?.planMode === true || capabilities?.askMode === true
  return true
}
