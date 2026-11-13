import {
  studioNoParams,
  studioParams,
  studioParamsRefused as refuse,
  type StudioMethodDefinition,
  type StudioMethodTable,
  type StudioTopicTable,
} from './contract.js'
import {
  CONVERSATION_MAX_MESSAGE_CHARS,
  isConversationWirePermissionPreset,
  isConversationApprovalDecision,
  parseConversationMentions,
  type ConversationApprovalRuleRevokeResult,
  type ConversationApprovalRulesResult,
  type ConversationAttachmentResult,
  type ConversationCommandCatalog,
  type ConversationContextBreakdownResult,
  type ConversationEvent,
  type ConversationListSessionsResult,
  type ConversationMcpServerAction,
  type ConversationMcpServerActionResult,
  type ConversationProviderSignInResult,
  type ConversationSearchResult,
  type ConversationSessionActionResult,
  type ConversationSideQuestionExchange,
  type ConversationSideQuestionResult,
  type ConversationTerminalHandoffResult,
  type ConversationThreadsResult,
  type ConversationForkResult,
  type ConversationHandoffResult,
  type ConversationApprovalDecision,
  type ConversationSendRequest,
  type ConversationSendUpload,
  type ConversationPlanDocumentResult,
  type ConversationRevertResult,
  type ConversationRewindResult,
  type ConversationStartSessionResult,
  type ConversationWirePermissionPreset,
} from './conversation.js'
import {
  STUDIO_APPROVAL_RULES_CAPABILITY,
  STUDIO_CHECKPOINTS_CAPABILITY,
  STUDIO_COMMANDS_CAPABILITY,
  STUDIO_CONVERSATION_FILES_CAPABILITY,
  STUDIO_FILES_CAPABILITY,
  STUDIO_HANDOFF_CAPABILITY,
  STUDIO_HISTORY_CAPABILITY,
  STUDIO_PROVIDER_SETTINGS_CAPABILITY,
  STUDIO_PROVIDERS_CAPABILITY,
  STUDIO_SESSION_CONTROLS_CAPABILITY,
  STUDIO_SESSIONS_CAPABILITY,
  STUDIO_TERMINAL_HANDOFF_CAPABILITY,
  type StudioCapability,
} from './handshake.js'
import { isStudioPath, parseStudioConversationKey, type StudioConversationKey } from './key.js'
import {
  STUDIO_MAX_FILE_BYTES,
  isStudioRelativePath,
  parseStudioFileRoot,
  type StudioFileRoot,
  type StudioFileStat,
} from './files.js'
import type { StudioProviderListResult, StudioProviderModelsResult, StudioSecretStatusResult } from './providers.js'
import type { StudioParsed } from './contract.js'
import type { StudioScope } from './scopes.js'

// What a chat view needs beside the conversation lane: the methods Studio's
// own chat view calls, so a window, a browser tab or any other client can
// show and drive a chat exactly as the desktop does.
//
// - `session.*` drives a chat's live session by its id, with everything the
//   composer sends (mentions, skills, effort, mode, a steer, pictures). The
//   conversation lane's commands (`conversation.send`, …) stay as they are for
//   a client that drives a chat by its key and never starts a session itself.
// - `uploads.*` carries a picture in pieces small enough for a frame, ahead of
//   the send that names it.
// - `conversation.*` gains a turn's revert, rewind and fork, a sent picture, a
//   plan as a file, and the `/` command list.
// - `providers.*`, `files.*` and `workspaces.*` are the reads around a chat:
//   which providers and models it can run, @-mention search and the file facts
//   its links and pictures need, and the workspace list.
//
// Each reaches a client by the scope it names. Two are an owner's by
// declaration, each with its reason (`owner`): handing a chat to a terminal
// and a CLI's sign-in line, which run on the screen of Studio's own machine.
// What takes a path or a CLI's executable is held by a rule on its params
// instead, at the router: a client that is not an owner names files only in
// the folders Studio knows, never a key's folder, and never a CLI's
// `command`. A provider's key and an approval rule are Settings, written
// under `settings:write`.
//
// A session method answers with the runtime's own outcome, a refusal by the
// runtime included: `{ ok: true, session } | { ok: false, message, event? }`
// inside a successful response, exactly what Studio's own windows read. The
// response's error is for the request itself (its scope, its params, Studio
// being unable to carry it). The same holds for the other methods whose
// outcome has an `ok` of its own.

/** The largest picture a send may carry, decoded. */
export const STUDIO_MAX_UPLOAD_BYTES = 5 * 1024 * 1024
/** The most pictures one send may carry. */
export const STUDIO_MAX_UPLOADS_PER_SEND = 16
/** The most bytes one `uploads.append` may carry, decoded: its base64 stays well under a client frame. */
export const STUDIO_UPLOAD_CHUNK_BYTES = 512 * 1024
/** The picture types a send may carry. */
export const STUDIO_UPLOAD_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

// ── Shapes ──────────────────────────────────────────────────────────────────

// A session method answers with the runtime's own outcome
// (`ConversationSessionActionResult`, `ConversationStartSessionResult`, from
// the conversation contract), a refusal by the runtime included.

/** A CLI's runtime override: the command to run it with, the machine it runs on, the models it offers. */
export type StudioCliRuntimeOverride = { command?: string; hostId?: string; models?: string[] }

/** The most files one send may attach. */
export const STUDIO_MAX_FILES_PER_SEND = 50

export type StudioSessionStartParams = {
  commandId: string
  workspaceRoot: string
  workspaceId: string
  agentId: string
  providerId: string
  modelId: string
  cliRuntimes?: Record<string, StudioCliRuntimeOverride | undefined>
  permissionPreset?: ConversationWirePermissionPreset
  permissionMode?: string
  allowedTools?: string[]
}

/**
 * A send to a chat this Studio runs: the conversation contract's request, its
 * pictures by the uploads that hold them, addressed to the session. Its
 * `files` go only to a Studio that advertises `session-files`; one that does
 * not would drop them without a word. Never `queue`: Studio runs the chat,
 * and a message queued behind its turn waits in the view that wrote it.
 */
export type StudioSessionSendParams = { commandId: string; sessionId: string } & Omit<ConversationSendRequest, 'queue'>

export type StudioSessionRespondParams = {
  commandId: string
  sessionId: string
  requestId: string
  approved: boolean
  decision?: ConversationApprovalDecision
  answers?: Record<string, string>
  /** The kind of request the client believes it answers; an answer to another kind is refused. */
  requestKind?: string
}

export type StudioForkParams = {
  commandId: string
  key: StudioConversationKey
  newAgentId: string
  title?: string
} & ({ side: 'assistant'; turnId: string } | { side: 'user'; turnSeq: number })

/** A path on Studio's disk, as `files.stat` answers by an absolute path. */
export type StudioPathStat = {
  isFile: boolean
  isDirectory: boolean
  sizeBytes: number
  modifiedAt: string
  modifiedAtMs: number
}

export type StudioFileSearchEntry = {
  name: string
  path: string
  parentPath: string
  isDir: boolean
}

/**
 * What listed the files: ripgrep, or — when the install's ripgrep cannot be
 * found or will not start — a plain directory walk that skips hidden entries
 * and the built-in excludes but reads no ignore files.
 */
export type StudioFileSearchEngine = 'ripgrep' | 'walker'

export type StudioFileSearchResult =
  | {
      ok: true
      results: StudioFileSearchEntry[]
      truncated: boolean
      engine: StudioFileSearchEngine
      elapsedMs: number
      resultCount: number
    }
  | {
      ok: false
      message: string
      engine: 'ripgrep' | null
    }

/** A workspace as the chat surface lists it. */
/** Which upload a send's refusal names: one not staged, not this client's, too large, or too many waiting. */
type UploadRefusal = 'not_found'

export type StudioChatMethodMap = {
  'session.start': { params: StudioSessionStartParams; result: ConversationStartSessionResult }
  'session.send': {
    params: StudioSessionSendParams
    result: ConversationSessionActionResult
    errors: UploadRefusal
  }
  'session.interrupt': { params: { commandId: string; sessionId: string }; result: ConversationSessionActionResult }
  'session.respond': { params: StudioSessionRespondParams; result: ConversationSessionActionResult }
  'session.setPermission': {
    params: {
      commandId: string
      sessionId: string
      permissionPreset: ConversationWirePermissionPreset
      permissionMode?: string
    }
    result: ConversationSessionActionResult
  }
  'session.setModel': {
    params: { commandId: string; sessionId: string; modelId: string }
    result: ConversationSessionActionResult
  }
  'uploads.begin': {
    /** A picture for a send, or (`purpose: 'file'`, owners) a file's bytes for `files.write`, of any type. */
    params: { mediaType: string; byteLength: number; name?: string; purpose?: 'picture' | 'file' }
    result: { uploadId: string; chunkBytes: number }
  }
  'uploads.append': {
    params: { uploadId: string; offset: number; dataBase64: string }
    result: { received: number }
    errors: UploadRefusal
  }
  /** Give back staged pictures that will not be sent; one already sent, or not this client's, is passed over. */
  'uploads.discard': { params: { uploadIds: string[] }; result: { discarded: number } }
  'conversation.revert': {
    params: {
      commandId: string
      key: StudioConversationKey
      turnSeq: number
      confirmed?: boolean
      undo?: boolean
      files?: string[]
    }
    result: ConversationRevertResult
    errors: 'not_found'
  }
  'conversation.rewind': {
    params: { commandId: string; key: StudioConversationKey; turnSeq: number }
    result: ConversationRewindResult
    errors: 'not_found'
  }
  'conversation.fork': { params: StudioForkParams; result: ConversationForkResult; errors: 'not_found' }
  /** Hand a chat off to a fresh session pointed at a file of its messages; answers that file's path. */
  'conversation.handoff': {
    params: { commandId: string; key: StudioConversationKey }
    result: ConversationHandoffResult
    errors: 'not_found'
  }
  'conversation.attachment': { params: { ref: string }; result: ConversationAttachmentResult }
  'conversation.planDocument': {
    params: { key: StudioConversationKey; plan: string; title?: string; planFilePath?: string }
    result: ConversationPlanDocumentResult
    errors: 'not_found'
  }
  'conversation.commands': {
    params: { cli: string; cwd: string; refresh?: boolean; probe?: false }
    result: { catalog: ConversationCommandCatalog }
    /** A client that is not an owner, or is held to the folders Studio knows, named another. */
    errors: 'not_found'
  }
  'providers.list': {
    params: { cliRuntimes?: Record<string, StudioCliRuntimeOverride | undefined> }
    result: StudioProviderListResult
  }
  'providers.models': { params: { providerId: string }; result: StudioProviderModelsResult }
  'providers.secretStatus': { params: { providerId: string }; result: StudioSecretStatusResult }
  'files.search': {
    params: {
      rootPath: string
      query: string
      limit?: number
      purpose?: 'mention'
      /** Names this search, so a newer one or `files.cancelSearch` can end it. */
      channel?: string
      recentAt?: Record<string, number>
    }
    result: StudioFileSearchResult
    /** A connection held to the folders Studio knows named another. */
    errors: 'not_found'
  }
  'files.cancelSearch': { params: { channel?: string }; result: Record<string, never> }
  /**
   * By an absolute path, answered as `StudioPathStat`; or, with `root` (the
   * `files-write` capability), by a path relative to it, answered as
   * `StudioFileStat`.
   */
  'files.stat': {
    params: { path: string; root?: StudioFileRoot }
    result: { stat: StudioPathStat | StudioFileStat }
    errors: 'not_found'
  }
  'files.readImage': { params: { path: string }; result: { dataUrl: string }; errors: 'not_found' }
  'files.repoRoot': {
    params: { folderPath: string; hostId?: string }
    result: { repoRoot: string | null }
    errors: 'not_found'
  }
  /** The live sessions of a workspace's chats, or of one chat, or of every chat. */
  'session.list': { params: { workspaceId?: string; agentId?: string }; result: ConversationListSessionsResult }
  /** End a session's process; the chat keeps its record and starts again on the next send. */
  'session.stop': { params: SessionCommandParams; result: ConversationSessionActionResult }
  /** End a session's process and keep its place, so the next send resumes the same provider session. */
  'session.suspend': { params: SessionCommandParams; result: ConversationSessionActionResult }
  /** Reconnect one of a live session's MCP servers, switch it on or off, or begin its sign-in. */
  'session.mcpServerAction': {
    params: SessionCommandParams & { serverId: string; action: ConversationMcpServerAction }
    result: ConversationMcpServerActionResult
  }
  /** Stop one agent the session spawned, by the call that spawned it. */
  'session.stopSubagent': {
    params: SessionCommandParams & { toolUseId: string }
    result: ConversationSessionActionResult
  }
  /** Pass the person's words to one agent the session spawned. */
  'session.messageSubagent': {
    params: SessionCommandParams & { toolUseId: string; message: string }
    result: ConversationSessionActionResult
  }
  /**
   * A side question about the chat, asked of its agent under the client's
   * `requestId`; the answer is kept in the chat as a side question.
   */
  'session.askSideQuestion': {
    params: SessionCommandParams & {
      requestId: string
      question: string
      history?: ConversationSideQuestionExchange[]
    }
    result: ConversationSideQuestionResult
  }
  /** Call off a side question still being answered. */
  'session.cancelSideQuestion': {
    params: { sessionId: string; requestId: string }
    result: { ok: true } | { ok: false; message: string }
  }
  /** What fills the session's context window, as its agent measures it. */
  'session.contextBreakdown': { params: { sessionId: string }; result: ConversationContextBreakdownResult }
  /**
   * Hand a chat to a terminal agent on the Studio's machine running its CLI's
   * own resume; by its live session, or by the chat for one with none.
   */
  'session.terminalHandoff': {
    params: { commandId: string } & ({ sessionId: string } | { workspaceId: string; agentId: string })
    result: ConversationTerminalHandoffResult
  }
  /** A workspace's history, every chat its transcripts hold; `workspaceRoot` as the workspace list gives it. */
  'conversation.threads': {
    params: { workspaceId: string; workspaceRoot?: string }
    result: ConversationThreadsResult
    errors: 'not_found'
  }
  /**
   * Search a workspace's history; answered with every hit at once. A newer
   * search under the same `requestId`, or `conversation.cancelSearch`, ends it.
   */
  'conversation.search': {
    params: { workspaceId: string; workspaceRoot?: string; query: string; requestId?: string }
    result: ConversationSearchResult
    errors: 'not_found'
  }
  'conversation.cancelSearch': { params: { requestId: string }; result: { ok: boolean } }
  /** The rules that answer an approval by themselves, everywhere in a folder. */
  'conversation.approvalRules': { params: Record<string, never>; result: ConversationApprovalRulesResult }
  'conversation.revokeApprovalRule': {
    params: { commandId: string; ruleId: string }
    result: ConversationApprovalRuleRevokeResult
  }
  /** The line a terminal runs to sign a provider's CLI back in, and where. */
  'providers.signIn': {
    params: { providerId: string; cliRuntimes?: Record<string, StudioCliRuntimeOverride | undefined> }
    result: ConversationProviderSignInResult
  }
  /** Keep a provider's key in the Studio's credential store; answered with its status, never the key. */
  'providers.setSecret': {
    params: { commandId: string; providerId: string; value: string }
    result: StudioSecretStatusResult
  }
  'providers.clearSecret': { params: { commandId: string; providerId: string }; result: StudioSecretStatusResult }
}

/** A session command: the session by its id, under the client's command id. */
type SessionCommandParams = { commandId: string; sessionId: string }

export type StudioChatMethod = keyof StudioChatMethodMap

// ── Params ──────────────────────────────────────────────────────────────────
//
// Shapes are checked here, at the edge, and unknown members dropped. What a
// value means (a mention that resolves inside its folder, a skill that
// exists) is checked by the Studio against the same rules its own windows'
// requests meet.

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}
function optional<T>(value: unknown, check: (value: unknown) => value is T): boolean {
  return value === undefined || check(value)
}
function boolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}
function strings(value: unknown, max: number, each: (value: unknown) => boolean): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(each)
}
const COMMAND_ID = '"commandId" must be a string of 1 to 200 characters.'
const SESSION_ID = '"sessionId" names the session.'
const KEY = '"key" names the conversation: { workspaceId, agentId, workspaceRoot? }.'

function cliRuntimes(value: unknown): Record<string, StudioCliRuntimeOverride | undefined> | null {
  if (!record(value)) return null
  const out: Record<string, StudioCliRuntimeOverride | undefined> = {}
  for (const [cli, entry] of Object.entries(value)) {
    if (!id(cli)) return null
    if (entry === undefined || entry === null) continue
    if (!record(entry)) return null
    if (!optional(entry.command, (v): v is string => text(v, 4096))) return null
    if (!optional(entry.hostId, id)) return null
    if (entry.models !== undefined && !strings(entry.models, 500, id)) return null
    out[cli] = {
      ...(entry.command === undefined ? {} : { command: entry.command as string }),
      ...(entry.hostId === undefined ? {} : { hostId: entry.hostId as string }),
      ...(entry.models === undefined ? {} : { models: [...(entry.models as string[])] }),
    }
  }
  return out
}

type SessionCommand = { commandId: string; sessionId: string }

function sessionCommand(value: Record<string, unknown>): StudioParsed<SessionCommand> {
  if (!id(value.commandId)) return refuse(COMMAND_ID)
  if (!id(value.sessionId)) return refuse(SESSION_ID)
  return studioParams({ commandId: value.commandId, sessionId: value.sessionId })
}

function attachments(value: unknown): ConversationSendUpload[] | null {
  if (!Array.isArray(value) || value.length > STUDIO_MAX_UPLOADS_PER_SEND) return null
  const out: ConversationSendUpload[] = []
  for (const entry of value) {
    if (
      !record(entry) ||
      !id(entry.id) ||
      !id(entry.uploadId) ||
      !optional(entry.name, (v): v is string => text(v, 500))
    )
      return null
    out.push({
      id: entry.id,
      uploadId: entry.uploadId,
      ...(entry.name === undefined ? {} : { name: entry.name as string }),
    })
  }
  return out
}

/** A conversation by its key and a command id: what every conversation-level mutation starts with. */
function addressed(value: Record<string, unknown>): StudioParsed<{ commandId: string; key: StudioConversationKey }> {
  if (!id(value.commandId)) return refuse(COMMAND_ID)
  const key = parseStudioConversationKey(value.key)
  if (!key) return refuse(KEY)
  return studioParams({ commandId: value.commandId, key })
}

// Each reaches a client by its scope; the few that are an owner's say why (the header).
type Held = Pick<StudioMethodDefinition<never>, 'scope' | 'mutation' | 'capability' | 'owner'>
const held = (scope: StudioScope, capability: StudioCapability, mutation: boolean): Held => ({
  scope,
  mutation,
  capability,
})
const sessions = held('conversation:operate', STUDIO_SESSIONS_CAPABILITY, true)
// Staging bytes changes nothing anyone sees until a send names them, and an
// append is idempotent by its offset, so neither carries a command id;
// discarding unsent bytes is as safe to repeat as staging them.
const staging = held('conversation:operate', STUDIO_SESSIONS_CAPABILITY, false)
const checkpoints = held('conversation:operate', STUDIO_CHECKPOINTS_CAPABILITY, true)
const conversationFiles = held('conversation:read', STUDIO_CONVERSATION_FILES_CAPABILITY, false)
const providers = held('providers:read', STUDIO_PROVIDERS_CAPABILITY, false)
const files = held('files:read', STUDIO_FILES_CAPABILITY, false)

// Reading a session changes nothing; acting on one carries a command id.
const sessionReads = held('conversation:read', STUDIO_SESSION_CONTROLS_CAPABILITY, false)
const sessionControls = held('conversation:operate', STUDIO_SESSION_CONTROLS_CAPABILITY, true)
const history = held('conversation:read', STUDIO_HISTORY_CAPABILITY, false)

const MCP_SERVER_ACTIONS: readonly ConversationMcpServerAction[] = ['reconnect', 'enable', 'disable', 'sign-in']
const TOOL_USE_ID = '"toolUseId" names the call that spawned the agent.'
const REQUEST_ID = '"requestId" must be a string of 1 to 200 characters.'
/** A side question is a message's worth of words; its aside holds a handful, each with its answer. */
const SIDE_QUESTION_MAX_CHARS = 20_000
const SIDE_ANSWER_MAX_CHARS = 100_000
const SIDE_QUESTION_HISTORY_MAX = 20
/** Longer than any provider's key. */
const SECRET_MAX_CHARS = 16_384

function sideQuestionHistory(value: unknown): ConversationSideQuestionExchange[] | null {
  if (!Array.isArray(value) || value.length > SIDE_QUESTION_HISTORY_MAX) return null
  const out: ConversationSideQuestionExchange[] = []
  for (const entry of value) {
    if (!record(entry) || !text(entry.question, SIDE_QUESTION_MAX_CHARS) || !text(entry.answer, SIDE_ANSWER_MAX_CHARS))
      return null
    out.push({ question: entry.question, answer: entry.answer })
  }
  return out
}

/** A workspace by its id, and its folder as the workspace list gives it, when the client knows it. */
function workspaceHistory(
  value: Record<string, unknown>,
): StudioParsed<{ workspaceId: string; workspaceRoot?: string }> {
  if (!id(value.workspaceId)) return refuse('"workspaceId" names the workspace.')
  if (!optional(value.workspaceRoot, isStudioPath)) return refuse('"workspaceRoot" is the workspace’s folder.')
  return studioParams({
    workspaceId: value.workspaceId,
    ...(value.workspaceRoot === undefined ? {} : { workspaceRoot: value.workspaceRoot as string }),
  })
}

const providerId = (value: Record<string, unknown>): StudioParsed<{ providerId: string }> =>
  id(value.providerId) ? studioParams({ providerId: value.providerId }) : refuse('"providerId" names the provider.')

export const STUDIO_CHAT_METHODS: StudioMethodTable<StudioChatMethodMap> = {
  'session.start': {
    ...sessions,
    params: (value) => {
      if (!id(value.commandId)) return refuse(COMMAND_ID)
      if (!isStudioPath(value.workspaceRoot)) return refuse('"workspaceRoot" is the folder the chat runs in.')
      if (!id(value.workspaceId) || !id(value.agentId)) return refuse('"workspaceId" and "agentId" name the chat.')
      if (!id(value.providerId) || !text(value.modelId, 400)) return refuse('"providerId" and "modelId" are required.')
      const runtimes = value.cliRuntimes === undefined ? undefined : cliRuntimes(value.cliRuntimes)
      if (runtimes === null) return refuse('"cliRuntimes" maps a CLI to { command?, hostId?, models? }.')
      if (!optional(value.permissionPreset, isConversationWirePermissionPreset))
        return refuse('"permissionPreset" is none, manual, auto or bypass.')
      if (!optional(value.permissionMode, id)) return refuse('"permissionMode" names a mode of the CLI.')
      if (value.allowedTools !== undefined && !strings(value.allowedTools, 200, id))
        return refuse('"allowedTools" is a list of tool names.')
      return studioParams({
        commandId: value.commandId,
        workspaceRoot: value.workspaceRoot,
        workspaceId: value.workspaceId,
        agentId: value.agentId,
        providerId: value.providerId,
        modelId: value.modelId,
        ...(runtimes ? { cliRuntimes: runtimes } : {}),
        ...(value.permissionPreset === undefined
          ? {}
          : { permissionPreset: value.permissionPreset as ConversationWirePermissionPreset }),
        ...(value.permissionMode === undefined ? {} : { permissionMode: value.permissionMode as string }),
        ...(value.allowedTools === undefined ? {} : { allowedTools: [...(value.allowedTools as string[])] }),
      })
    },
  },
  'session.send': {
    ...sessions,
    params: (value) => {
      const session = sessionCommand(value)
      if (!session.ok) return session
      if (typeof value.message !== 'string') return refuse('"message" is required.')
      if (value.message.length > CONVERSATION_MAX_MESSAGE_CHARS)
        return refuse(`A message may hold at most ${CONVERSATION_MAX_MESSAGE_CHARS} characters.`, 'too_large')
      if (!optional(value.localTurnId, id)) return refuse('"localTurnId" must be a string of 1 to 200 characters.')
      const mentions = value.mentions === undefined ? undefined : parseConversationMentions(value.mentions)
      if (mentions === null) return refuse('"mentions" is a list of at most 50 { path, kind, line?, endLine? }.')
      if (
        value.files !== undefined &&
        !(
          Array.isArray(value.files) &&
          value.files.length <= STUDIO_MAX_FILES_PER_SEND &&
          value.files.every((file) => record(file) && isStudioPath(file.path))
        )
      )
        return refuse(`"files" is a list of at most ${STUDIO_MAX_FILES_PER_SEND} { path }.`)
      if (
        value.skills !== undefined &&
        !(
          Array.isArray(value.skills) &&
          value.skills.length <= 32 &&
          value.skills.every(
            (skill) => record(skill) && id(skill.id) && optional(skill.sourcePath, (v): v is string => isStudioPath(v)),
          )
        )
      )
        return refuse('"skills" is a list of at most 32 { id, sourcePath? }.')
      if (!optional(value.reasoningEffort, (v): v is string => typeof v === 'string' && /^[a-z0-9_-]{1,40}$/i.test(v)))
        return refuse('"reasoningEffort" names an effort level.')
      if (value.mode !== undefined && value.mode !== 'default' && value.mode !== 'plan' && value.mode !== 'ask')
        return refuse('"mode" is default, plan or ask.')
      if (!optional(value.steer, boolean)) return refuse('"steer" is a boolean.')
      if (value.queue !== undefined)
        return refuse('"queue" is not taken here: a message queued behind the turn waits in the view that wrote it.')
      if (!optional(value.composedAt, integer))
        return refuse('"composedAt" is when the message was written, in epoch ms.')
      if (!optional(value.confirmedStale, boolean)) return refuse('"confirmedStale" is a boolean.')
      const sent = value.attachments === undefined ? undefined : attachments(value.attachments)
      if (sent === null)
        return refuse(`"attachments" is a list of at most ${STUDIO_MAX_UPLOADS_PER_SEND} { id, uploadId, name? }.`)
      return studioParams({
        ...session.params,
        message: value.message,
        ...(value.localTurnId === undefined ? {} : { localTurnId: value.localTurnId as string }),
        ...(mentions === undefined ? {} : { mentions }),
        ...(value.files === undefined
          ? {}
          : { files: (value.files as { path: string }[]).map((file) => ({ path: file.path })) }),
        ...(value.skills === undefined
          ? {}
          : {
              skills: (value.skills as { id: string; sourcePath?: string }[]).map((skill) => ({
                id: skill.id,
                ...(skill.sourcePath === undefined ? {} : { sourcePath: skill.sourcePath }),
              })),
            }),
        ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort as string }),
        ...(value.mode === undefined ? {} : { mode: value.mode }),
        ...(value.steer === true ? { steer: true } : {}),
        ...(value.composedAt === undefined ? {} : { composedAt: value.composedAt as number }),
        ...(value.confirmedStale === true ? { confirmedStale: true } : {}),
        ...(sent?.length ? { attachments: sent } : {}),
      })
    },
  },
  'session.interrupt': { ...sessions, params: sessionCommand },
  'session.respond': {
    ...sessions,
    params: (value) => {
      const session = sessionCommand(value)
      if (!session.ok) return session
      if (!id(value.requestId)) return refuse('"requestId" names the request.')
      if (!boolean(value.approved)) return refuse('"approved" is a boolean.')
      const decision = value.decision
      if (decision !== undefined && !isConversationApprovalDecision(decision))
        return refuse('"decision" is once, conversation, always or deny.')
      if (
        value.answers !== undefined &&
        !(
          record(value.answers) &&
          Object.keys(value.answers).length <= 64 &&
          Object.values(value.answers).every((answer) => text(answer, CONVERSATION_MAX_MESSAGE_CHARS))
        )
      )
        return refuse('"answers" maps question text to answer strings.')
      if (!optional(value.requestKind, id)) return refuse('"requestKind" names a kind of request.')
      return studioParams({
        ...session.params,
        requestId: value.requestId,
        approved: value.approved,
        ...(decision === undefined ? {} : { decision }),
        ...(value.answers === undefined ? {} : { answers: { ...(value.answers as Record<string, string>) } }),
        ...(value.requestKind === undefined ? {} : { requestKind: value.requestKind as string }),
      })
    },
  },
  'session.setPermission': {
    ...sessions,
    params: (value) => {
      const session = sessionCommand(value)
      if (!session.ok) return session
      if (!isConversationWirePermissionPreset(value.permissionPreset))
        return refuse('"permissionPreset" is none, manual, auto or bypass.')
      if (!optional(value.permissionMode, id)) return refuse('"permissionMode" names a mode of the CLI.')
      return studioParams({
        ...session.params,
        permissionPreset: value.permissionPreset,
        ...(value.permissionMode === undefined ? {} : { permissionMode: value.permissionMode as string }),
      })
    },
  },
  'session.setModel': {
    ...sessions,
    params: (value) => {
      const session = sessionCommand(value)
      if (!session.ok) return session
      if (!(typeof value.modelId === 'string' && value.modelId.trim() && value.modelId.length <= 200))
        return refuse('"modelId" names the model.')
      return studioParams({ ...session.params, modelId: value.modelId.trim() })
    },
  },
  'uploads.begin': {
    ...staging,
    params: (value) => {
      if (value.purpose === 'file') {
        if (!(typeof value.mediaType === 'string' && /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/.test(value.mediaType)))
          return refuse('"mediaType" is the file’s media type.')
        if (!(integer(value.byteLength) && value.byteLength > 0))
          return refuse('"byteLength" is the file’s size in bytes.')
        if (value.byteLength > STUDIO_MAX_FILE_BYTES)
          return refuse(`A file may be at most ${STUDIO_MAX_FILE_BYTES / (1024 * 1024)} MB.`, 'too_large')
        return studioParams({ mediaType: value.mediaType, byteLength: value.byteLength, purpose: 'file' as const })
      }
      if (value.purpose !== undefined && value.purpose !== 'picture') return refuse('"purpose" is picture or file.')
      if (!(
        typeof value.mediaType === 'string' &&
        (STUDIO_UPLOAD_MEDIA_TYPES as readonly string[]).includes(value.mediaType)
      ))
        return refuse('A picture is PNG, JPEG, WebP or GIF.')
      if (!(integer(value.byteLength) && value.byteLength > 0))
        return refuse('"byteLength" is the picture’s size in bytes.')
      if (value.byteLength > STUDIO_MAX_UPLOAD_BYTES)
        return refuse(`A picture may be at most ${STUDIO_MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`, 'too_large')
      if (!optional(value.name, (v): v is string => text(v, 500))) return refuse('"name" is the picture’s file name.')
      return studioParams({
        mediaType: value.mediaType,
        byteLength: value.byteLength,
        ...(value.name === undefined ? {} : { name: value.name as string }),
      })
    },
  },
  'uploads.append': {
    ...staging,
    params: (value) => {
      if (!id(value.uploadId)) return refuse('"uploadId" names the upload.')
      if (!integer(value.offset)) return refuse('"offset" is where these bytes start.')
      if (typeof value.dataBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.dataBase64))
        return refuse('"dataBase64" is the bytes, base64-encoded.')
      if (value.dataBase64.length > Math.ceil(STUDIO_UPLOAD_CHUNK_BYTES / 3) * 4)
        return refuse(`One append carries at most ${STUDIO_UPLOAD_CHUNK_BYTES} bytes.`, 'too_large')
      return studioParams({ uploadId: value.uploadId, offset: value.offset, dataBase64: value.dataBase64 })
    },
  },
  'uploads.discard': {
    ...staging,
    params: (value) => {
      const ids = value.uploadIds
      if (!(Array.isArray(ids) && ids.length <= STUDIO_MAX_UPLOADS_PER_SEND * 2 && ids.every(id)))
        return refuse(`"uploadIds" lists at most ${STUDIO_MAX_UPLOADS_PER_SEND * 2} uploads.`)
      return studioParams({ uploadIds: [...(ids as string[])] })
    },
  },
  'conversation.revert': {
    ...checkpoints,
    params: (value) => {
      const at = addressed(value)
      if (!at.ok) return at
      if (!(integer(value.turnSeq) && value.turnSeq >= 1)) return refuse('"turnSeq" is the turn to revert.')
      if (!optional(value.confirmed, boolean) || !optional(value.undo, boolean))
        return refuse('"confirmed" and "undo" are booleans.')
      if (value.files !== undefined && !strings(value.files, 10_000, isStudioPath))
        return refuse('"files" lists the paths the preview showed.')
      return studioParams({
        ...at.params,
        turnSeq: value.turnSeq,
        ...(value.confirmed === true ? { confirmed: true } : {}),
        ...(value.undo === true ? { undo: true } : {}),
        ...(value.files === undefined ? {} : { files: [...(value.files as string[])] }),
      })
    },
  },
  'conversation.rewind': {
    ...checkpoints,
    params: (value) => {
      const at = addressed(value)
      if (!at.ok) return at
      if (!(integer(value.turnSeq) && value.turnSeq >= 1)) return refuse('"turnSeq" is the message to go back to.')
      return studioParams({ ...at.params, turnSeq: value.turnSeq })
    },
  },
  'conversation.fork': {
    ...held('conversation:create', STUDIO_CHECKPOINTS_CAPABILITY, true),
    params: (value) => {
      const at = addressed(value)
      if (!at.ok) return at
      if (!(id(value.newAgentId) && value.newAgentId.trim())) return refuse('"newAgentId" names the new chat.')
      if (!optional(value.title, (v): v is string => text(v, 500))) return refuse('"title" is the new chat’s name.')
      const common = {
        ...at.params,
        newAgentId: value.newAgentId,
        ...(value.title === undefined ? {} : { title: value.title as string }),
      }
      if (value.side === 'user') {
        if (!(integer(value.turnSeq) && value.turnSeq >= 1)) return refuse('"turnSeq" is the message to fork before.')
        return studioParams({ ...common, side: 'user' as const, turnSeq: value.turnSeq })
      }
      if (value.side === 'assistant' && id(value.turnId))
        return studioParams({ ...common, side: 'assistant' as const, turnId: value.turnId })
      return refuse('A fork is { side: "assistant", turnId } or { side: "user", turnSeq }.')
    },
  },
  'conversation.handoff': { ...held('conversation:operate', STUDIO_HANDOFF_CAPABILITY, true), params: addressed },
  'conversation.attachment': {
    ...conversationFiles,
    params: (value) =>
      typeof value.ref === 'string' && value.ref.length > 0 && value.ref.length <= 1000
        ? studioParams({ ref: value.ref })
        : refuse('"ref" is the reference the user_message recorded.'),
  },
  // Writes the plan into Studio's data when the agent kept no copy of its
  // own, the same text to the same file however often it is asked.
  'conversation.planDocument': {
    ...conversationFiles,
    params: (value) => {
      const key = parseStudioConversationKey(value.key)
      if (!key) return refuse(KEY)
      if (!text(value.plan, CONVERSATION_MAX_MESSAGE_CHARS * 5)) return refuse('"plan" is the plan’s text.')
      if (!optional(value.title, (v): v is string => text(v, 500))) return refuse('"title" is the plan’s title.')
      if (!optional(value.planFilePath, isStudioPath)) return refuse('"planFilePath" is the agent’s own copy.')
      return studioParams({
        key,
        plan: value.plan,
        ...(value.title === undefined ? {} : { title: value.title as string }),
        ...(value.planFilePath === undefined ? {} : { planFilePath: value.planFilePath as string }),
      })
    },
  },
  'conversation.commands': {
    ...held('conversation:read', STUDIO_COMMANDS_CAPABILITY, false),
    params: (value) => {
      if (!id(value.cli)) return refuse('"cli" names the chat’s CLI.')
      if (!isStudioPath(value.cwd)) return refuse('"cwd" is the folder the list is for.')
      if (!optional(value.refresh, boolean)) return refuse('"refresh" is a boolean.')
      if (value.probe !== undefined && value.probe !== false) return refuse('"probe" is false or absent.')
      return studioParams({
        cli: value.cli,
        cwd: value.cwd,
        ...(value.refresh === true ? { refresh: true } : {}),
        ...(value.probe === false ? { probe: false as const } : {}),
      })
    },
  },
  'providers.list': {
    ...providers,
    params: (value) => {
      const runtimes = value.cliRuntimes === undefined ? undefined : cliRuntimes(value.cliRuntimes)
      if (runtimes === null) return refuse('"cliRuntimes" maps a CLI to { command?, hostId?, models? }.')
      return studioParams(runtimes ? { cliRuntimes: runtimes } : {})
    },
  },
  'providers.models': { ...providers, params: providerId },
  'providers.secretStatus': { ...providers, params: providerId },
  'files.search': {
    ...files,
    params: (value) => {
      if (!isStudioPath(value.rootPath)) return refuse('"rootPath" is the folder to search.')
      if (!text(value.query, 1000)) return refuse('"query" is at most 1000 characters.')
      if (!optional(value.limit, (v): v is number => integer(v) && v >= 1 && v <= 500))
        return refuse('"limit" is between 1 and 500.')
      if (value.purpose !== undefined && value.purpose !== 'mention') return refuse('"purpose" is mention or absent.')
      if (!optional(value.channel, id)) return refuse('"channel" names the search.')
      let recentAt: Record<string, number> | undefined
      if (value.recentAt !== undefined) {
        if (!record(value.recentAt) || Object.keys(value.recentAt).length > 1000)
          return refuse('"recentAt" maps at most 1000 paths to when each was opened.')
        recentAt = {}
        for (const [path, at] of Object.entries(value.recentAt))
          if (isStudioPath(path) && typeof at === 'number' && Number.isFinite(at)) recentAt[path] = at
      }
      return studioParams({
        rootPath: value.rootPath,
        query: value.query,
        ...(value.limit === undefined ? {} : { limit: value.limit as number }),
        ...(value.purpose === undefined ? {} : { purpose: 'mention' as const }),
        ...(value.channel === undefined ? {} : { channel: value.channel as string }),
        ...(recentAt ? { recentAt } : {}),
      })
    },
  },
  'files.cancelSearch': {
    ...files,
    params: (value) =>
      optional(value.channel, id)
        ? studioParams(value.channel === undefined ? {} : { channel: value.channel as string })
        : refuse('"channel" names the search.'),
  },
  'files.stat': {
    ...files,
    params: (value) => {
      if (value.root === undefined)
        return isStudioPath(value.path)
          ? studioParams({ path: value.path })
          : refuse('"path" is a path on Studio’s disk.')
      const root = parseStudioFileRoot(value.root)
      if (!root) return refuse('"root" is { kind: "boards" | "workspace" | "store", workspaceId }.')
      if (!isStudioRelativePath(value.path)) return refuse('"path" is relative to its root, with "/" between parts.')
      return studioParams({ path: value.path, root })
    },
  },
  'files.readImage': {
    ...files,
    params: (value) =>
      isStudioPath(value.path) ? studioParams({ path: value.path }) : refuse('"path" is a path on Studio’s disk.'),
  },
  'files.repoRoot': {
    ...files,
    params: (value) => {
      if (!isStudioPath(value.folderPath)) return refuse('"folderPath" is a folder on Studio’s disk.')
      if (!optional(value.hostId, id)) return refuse('"hostId" names the machine.')
      return studioParams({
        folderPath: value.folderPath,
        ...(value.hostId === undefined ? {} : { hostId: value.hostId as string }),
      })
    },
  },
  'session.list': {
    ...sessionReads,
    params: (value) => {
      if (!optional(value.workspaceId, id) || !optional(value.agentId, id))
        return refuse('"workspaceId" and "agentId", when given, name the chats.')
      return studioParams({
        ...(value.workspaceId === undefined ? {} : { workspaceId: value.workspaceId as string }),
        ...(value.agentId === undefined ? {} : { agentId: value.agentId as string }),
      })
    },
  },
  'session.stop': { ...sessionControls, params: sessionCommand },
  'session.suspend': { ...sessionControls, params: sessionCommand },
  'session.mcpServerAction': {
    ...sessionControls,
    params: (value) => {
      const session = sessionCommand(value)
      if (!session.ok) return session
      if (!id(value.serverId)) return refuse('"serverId" names the MCP server.')
      if (!MCP_SERVER_ACTIONS.includes(value.action as ConversationMcpServerAction))
        return refuse('"action" is reconnect, enable, disable or sign-in.')
      return studioParams({
        ...session.params,
        serverId: value.serverId,
        action: value.action as ConversationMcpServerAction,
      })
    },
  },
  'session.stopSubagent': {
    ...sessionControls,
    params: (value) => {
      const session = sessionCommand(value)
      if (!session.ok) return session
      if (!id(value.toolUseId)) return refuse(TOOL_USE_ID)
      return studioParams({ ...session.params, toolUseId: value.toolUseId })
    },
  },
  'session.messageSubagent': {
    ...sessionControls,
    params: (value) => {
      const session = sessionCommand(value)
      if (!session.ok) return session
      if (!id(value.toolUseId)) return refuse(TOOL_USE_ID)
      if (typeof value.message !== 'string' || !value.message.trim()) return refuse('"message" is required.')
      if (value.message.length > CONVERSATION_MAX_MESSAGE_CHARS)
        return refuse(`A message may hold at most ${CONVERSATION_MAX_MESSAGE_CHARS} characters.`, 'too_large')
      return studioParams({ ...session.params, toolUseId: value.toolUseId, message: value.message })
    },
  },
  'session.askSideQuestion': {
    ...sessionControls,
    params: (value) => {
      const session = sessionCommand(value)
      if (!session.ok) return session
      if (!id(value.requestId)) return refuse(REQUEST_ID)
      if (typeof value.question !== 'string' || !value.question.trim()) return refuse('"question" is required.')
      if (value.question.length > SIDE_QUESTION_MAX_CHARS)
        return refuse(`A side question may hold at most ${SIDE_QUESTION_MAX_CHARS} characters.`, 'too_large')
      const history = value.history === undefined ? undefined : sideQuestionHistory(value.history)
      if (history === null)
        return refuse(`"history" is a list of at most ${SIDE_QUESTION_HISTORY_MAX} { question, answer }.`)
      return studioParams({
        ...session.params,
        requestId: value.requestId,
        question: value.question,
        ...(history ? { history } : {}),
      })
    },
  },
  'session.cancelSideQuestion': {
    ...sessionReads,
    params: (value) => {
      if (!id(value.sessionId)) return refuse(SESSION_ID)
      if (!id(value.requestId)) return refuse(REQUEST_ID)
      return studioParams({ sessionId: value.sessionId, requestId: value.requestId })
    },
  },
  'session.contextBreakdown': {
    ...sessionReads,
    params: (value) => (id(value.sessionId) ? studioParams({ sessionId: value.sessionId }) : refuse(SESSION_ID)),
  },
  'session.terminalHandoff': {
    ...held('conversation:operate', STUDIO_TERMINAL_HANDOFF_CAPABILITY, true),
    owner: 'It opens a terminal on the screen of the machine Studio runs on.',
    params: (value) => {
      if (!id(value.commandId)) return refuse(COMMAND_ID)
      if (value.sessionId !== undefined) {
        if (!id(value.sessionId)) return refuse(SESSION_ID)
        return studioParams({ commandId: value.commandId, sessionId: value.sessionId })
      }
      if (!id(value.workspaceId) || !id(value.agentId))
        return refuse('"sessionId", or "workspaceId" and "agentId", name the chat.')
      return studioParams({ commandId: value.commandId, workspaceId: value.workspaceId, agentId: value.agentId })
    },
  },
  'conversation.threads': { ...history, params: (value) => workspaceHistory(value) },
  'conversation.search': {
    ...history,
    params: (value) => {
      const at = workspaceHistory(value)
      if (!at.ok) return at
      if (typeof value.query !== 'string' || !value.query.trim() || value.query.length > 1_000)
        return refuse('"query" is the words to search for, at most 1000 characters.')
      if (!optional(value.requestId, id)) return refuse(REQUEST_ID)
      return studioParams({
        ...at.params,
        query: value.query,
        ...(value.requestId === undefined ? {} : { requestId: value.requestId as string }),
      })
    },
  },
  'conversation.cancelSearch': {
    ...history,
    params: (value) => (id(value.requestId) ? studioParams({ requestId: value.requestId }) : refuse(REQUEST_ID)),
  },
  'conversation.approvalRules': {
    ...held('conversation:read', STUDIO_APPROVAL_RULES_CAPABILITY, false),
    params: studioNoParams,
  },
  // Revoking a rule only makes the chats ask again: whoever may drive them may.
  'conversation.revokeApprovalRule': {
    ...held('conversation:operate', STUDIO_APPROVAL_RULES_CAPABILITY, true),
    params: (value) => {
      if (!id(value.commandId)) return refuse(COMMAND_ID)
      if (!id(value.ruleId)) return refuse('"ruleId" names the rule.')
      return studioParams({ commandId: value.commandId, ruleId: value.ruleId })
    },
  },
  'providers.signIn': {
    ...held('providers:read', STUDIO_PROVIDER_SETTINGS_CAPABILITY, false),
    owner: 'It answers a command line to run in a terminal on the machine Studio runs on.',
    params: (value) => {
      const provider = providerId(value)
      if (!provider.ok) return provider
      const runtimes = value.cliRuntimes === undefined ? undefined : cliRuntimes(value.cliRuntimes)
      if (runtimes === null) return refuse('"cliRuntimes" maps a CLI to { command?, hostId?, models? }.')
      return studioParams({ ...provider.params, ...(runtimes ? { cliRuntimes: runtimes } : {}) })
    },
  },
  'providers.setSecret': {
    ...held('settings:write', STUDIO_PROVIDER_SETTINGS_CAPABILITY, true),
    params: (value) => {
      if (!id(value.commandId)) return refuse(COMMAND_ID)
      const provider = providerId(value)
      if (!provider.ok) return provider
      if (typeof value.value !== 'string' || !value.value || value.value.length > SECRET_MAX_CHARS)
        return refuse(`"value" is the key, 1 to ${SECRET_MAX_CHARS} characters.`)
      return studioParams({ commandId: value.commandId, providerId: provider.params.providerId, value: value.value })
    },
  },
  'providers.clearSecret': {
    ...held('settings:write', STUDIO_PROVIDER_SETTINGS_CAPABILITY, true),
    params: (value) => {
      if (!id(value.commandId)) return refuse(COMMAND_ID)
      const provider = providerId(value)
      if (!provider.ok) return provider
      return studioParams({ commandId: value.commandId, providerId: provider.params.providerId })
    },
  },
}

// ── Topics ──────────────────────────────────────────────────────────────────

export type StudioChatTopicMap = {
  /**
   * Every `/` command list a CLI reports for a folder, as it reports it: a
   * live session's, an ACP update's, a probe's. Each push is a whole catalog
   * that replaces the last one for its (CLI, folder). Nothing is replayed on
   * subscribing; ask `conversation.commands` for the list held now.
   */
  'conversation.commands': { params: Record<string, never>; payload: ConversationCommandCatalog; stream: 'push' }
  /**
   * Every chat's lifecycle, as it happens: a session started, a turn began or
   * ended, an approval was asked, an agent changed. Each push is one event
   * without its payload or parts (whose chat, what kind, when): a reader asks
   * for what it shows (`session.list`, the chat's own topic). Never a chat's
   * per-token stream, and nothing is replayed on subscribing.
   */
  'conversation.events': { params: Record<string, never>; payload: ConversationEvent; stream: 'push' }
}

export const STUDIO_CHAT_TOPICS: StudioTopicTable<StudioChatTopicMap> = {
  'conversation.commands': {
    scope: 'conversation:read',
    capability: STUDIO_COMMANDS_CAPABILITY,
    push: true,
    params: studioNoParams,
  },
  'conversation.events': {
    scope: 'conversation:read',
    capability: STUDIO_SESSION_CONTROLS_CAPABILITY,
    push: true,
    params: studioNoParams,
  },
}
