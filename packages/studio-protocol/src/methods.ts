import {
  explainRejectedConversationMessage,
  parseConversationClientMessage,
  parseConversationCreateRequest,
  type ConversationCheckpointDiff,
  type ConversationCommand,
  type ConversationCreateRequest,
  type ConversationHelloAnswer,
  type ConversationServerFrame,
  type ConversationThread,
  type ConversationToolDetail,
  type ConversationWireEvent,
  type ConversationWirePage,
  type ConversationWirePermissionPreset,
} from './conversation.js'
import {
  studioParams,
  studioParamsRefused,
  type StudioAnswerOf,
  type StudioErrorCodeOf,
  type StudioHandlersOf,
  type StudioMethodDefinition,
  type StudioMethodSpec,
  type StudioMethodTable,
  type StudioParamsRefusal,
  type StudioParamsRefusalCode,
  type StudioParsed,
  type StudioRequestOf,
  type StudioRpcClientOf,
  type StudioTopicDefinition,
  type StudioTopicTable,
} from './contract.js'
import { STUDIO_CONVERSATION_CREATE_CAPABILITY, STUDIO_CONVERSATIONS_CAPABILITY } from './handshake.js'
import type { StudioEnvironment, StudioGrant, StudioServerIdentity } from './envelope.js'
import {
  authorizeStudioAccess,
  studioGrantPrincipal,
  studioScopeRequires,
  type StudioAccess,
  type StudioAuthorization,
  type StudioPermission,
} from './permissions.js'
import { STUDIO_CHAT_METHODS, STUDIO_CHAT_TOPICS, type StudioChatMethodMap, type StudioChatTopicMap } from './chat.js'
import {
  STUDIO_FOLLOWED_METHODS,
  STUDIO_FOLLOWED_TOPICS,
  type StudioFollowedMethodMap,
  type StudioFollowedTopicMap,
} from './followed.js'
import { parseStudioConversationKey, type StudioConversationKey } from './key.js'
import {
  STUDIO_FILES_METHODS,
  STUDIO_FILES_TOPICS,
  type StudioFilesMethodMap,
  type StudioFilesTopicMap,
} from './files.js'
import {
  STUDIO_PULL_REQUESTS_METHODS,
  STUDIO_PULL_REQUESTS_TOPICS,
  type StudioPullRequestsMethodMap,
  type StudioPullRequestsTopicMap,
} from './pull-requests.js'
import {
  STUDIO_LOCAL_SERVERS_METHODS,
  STUDIO_LOCAL_SERVERS_TOPICS,
  type StudioLocalServersMethodMap,
  type StudioLocalServersTopicMap,
} from './local-servers.js'
import {
  STUDIO_MODULES_METHODS,
  STUDIO_MODULES_TOPICS,
  type StudioModulesMethodMap,
  type StudioModulesTopicMap,
} from './modules.js'
import { STUDIO_MODULE_SERVICES_METHODS, type StudioModuleServicesMethodMap } from './module-services.js'
import { STUDIO_WORKSPACES_METHODS, type StudioWorkspacesMethodMap } from './workspaces.js'
import {
  STUDIO_TERMINALS_METHODS,
  STUDIO_TERMINALS_TOPICS,
  type StudioTerminalsMethodMap,
  type StudioTerminalsTopicMap,
} from './terminals.js'
import {
  STUDIO_TOOLS_METHODS,
  STUDIO_TOOLS_TOPICS,
  type StudioToolsMethodMap,
  type StudioToolsTopicMap,
} from './tools.js'
import { STUDIO_UPDATE_METHODS, type StudioUpdateMethodMap } from './update.js'
import {
  STUDIO_AGENT_SETTINGS_METHODS,
  STUDIO_AGENT_SETTINGS_TOPICS,
  type StudioAgentSettingsMethodMap,
  type StudioAgentSettingsTopicMap,
} from './agent-settings.js'
import {
  STUDIO_AGENT_SETUP_METHODS,
  STUDIO_AGENT_SETUP_TOPICS,
  type StudioAgentSetupMethodMap,
  type StudioAgentSetupTopicMap,
} from './agent-setup.js'
import { STUDIO_READINESS_METHODS, type StudioReadinessMethodMap } from './readiness.js'
import {
  STUDIO_CHAT_STORES_METHODS,
  STUDIO_CHAT_STORES_TOPICS,
  type StudioChatStoresMethodMap,
  type StudioChatStoresTopicMap,
} from './chat-stores.js'
import {
  STUDIO_BACKLOG_METHODS,
  STUDIO_BACKLOG_TOPICS,
  STUDIO_SHARES_METHODS,
  type StudioBacklogMethodMap,
  type StudioBacklogTopicMap,
  type StudioSharesMethodMap,
} from './backlog.js'
import { STUDIO_PULL_REQUEST_READS_METHODS, type StudioPullRequestReadsMethodMap } from './pull-request-reads.js'
import {
  STUDIO_AGENT_SKILLS_METHODS,
  STUDIO_AGENT_SKILLS_TOPICS,
  type StudioAgentSkillsMethodMap,
  type StudioAgentSkillsTopicMap,
} from './agent-skills.js'
import {
  STUDIO_SCHEDULES_METHODS,
  STUDIO_SCHEDULES_TOPICS,
  type StudioSchedulesMethodMap,
  type StudioSchedulesTopicMap,
} from './schedules.js'
import {
  STUDIO_FILE_SYSTEM_METHODS,
  STUDIO_FILE_SYSTEM_TOPICS,
  type StudioFileSystemMethodMap,
  type StudioFileSystemTopicMap,
} from './file-system.js'
import { STUDIO_GIT_METHODS, STUDIO_GIT_TOPICS, type StudioGitMethodMap, type StudioGitTopicMap } from './git.js'
import {
  STUDIO_WORKTREES_METHODS,
  STUDIO_WORKTREES_TOPICS,
  type StudioWorktreesMethodMap,
  type StudioWorktreesTopicMap,
} from './worktrees.js'
import { STUDIO_CHAT_LIFECYCLE_METHODS, type StudioChatLifecycleMethodMap } from './chat-lifecycle.js'

export { parseStudioConversationKey, isStudioPath, STUDIO_MAX_PATH_CHARS, type StudioConversationKey } from './key.js'

// Every method and stream topic, with the scope it needs and the validator its
// params are read by, in one table (`contract.ts` says how a table builds both
// ends).
//
// `StudioMethodMap` is the source of truth for what a method takes, answers
// and may refuse with; `STUDIO_METHODS` is typed over its keys, so a method
// added to the map without a scope or a validator does not compile, and the
// server's `StudioHandlers` must answer every one of them in its own shape.
// What a method needs is the
// permission its scope names and any it adds (`studioSpecPermissions`), so it
// can never need less than its scope. A Studio checks those on every request,
// against the grant as it stands at that moment (`authorizeStudioMethod`,
// `permissions.ts`).
//
// A conversation command is the conversation lane's own command, addressed:
// its params are the command's members plus the conversation `key` and the
// client's `commandId`, and they are read by the lane's own validator
// (`parseConversationClientMessage`), so the socket and the tailnet accept
// exactly the same commands. Every mutation carries a `commandId`; a retry
// with the same id is answered with the first attempt's result and is never
// carried out twice, across a reconnect and an app restart alike.

/** Every command answers with this, plus what its own method adds. */
export type StudioCommandAnswer = {
  /** Qualifies an accepted command: a model switched mid-turn applies from the next turn. */
  notice?: string
}

type Addressed<T> = { key: StudioConversationKey; commandId: string } & T

/**
 * A command method's params: the conversation lane's command of that kind,
 * its `kind` given by the method, addressed. Pictures (`uploadIds`) are not
 * carried by this connection (`parseStudioCommand`). A rule that outlives the
 * conversation (`always`) is taken, as the lane takes it
 * (`conversation-permanent-approvals`), from a client the router lets allow a
 * kind of request for the rest of the conversation.
 */
type CommandParams<K extends ConversationCommand['kind']> = Addressed<
  Omit<Extract<ConversationCommand, { kind: K }>, 'kind' | 'uploadIds'>
>

/**
 * What the runtime and the launch may refuse a command or a create with, in
 * the stable words Studio tells a client (the router's `STABLE_MESSAGES`).
 */
export type StudioRuntimeRefusalCode =
  | 'not_found'
  | 'unsupported_model'
  | 'unknown_workspace'
  | 'workspace_folder_missing'
  | 'no_cli_selected'
  | 'cli_not_conversational'
  | 'unknown_skill'
  | 'conversation_start_failed'
  // New chat's own: no worktree could be cut or found for it, or its CLI has no such effort.
  | 'worktree_unavailable'
  | 'unsupported_effort'

/** A command's own refusals: the runtime's, a ceiling it would exceed, and a decision no remote client makes. */
type CommandRefusal = StudioRuntimeRefusalCode | 'ceiling_exceeded' | 'unsafe_remote_decision'

type Command<K extends ConversationCommand['kind'], R = StudioCommandAnswer> = {
  params: CommandParams<K>
  result: R
  errors: CommandRefusal
}

/** A conversation `conversation.create` started. */
export type StudioCreatedConversation = {
  workspaceId: string
  agentId: string
  sessionId: string | null
  name: string
  cli: string
  providerId: string
  modelId: string
  /** The preset the chat runs on: the one asked for, lowered to the client's ceiling. */
  permissionPreset?: ConversationWirePermissionPreset
  permissionMode?: string
}

/** What `server.info` answers: the welcome without the per-connection parts. */
export type StudioServerInfo = {
  protocolVersion: number
  minProtocolVersion: number
  server: StudioServerIdentity
  environment: StudioEnvironment
  capabilities: string[]
  conversation: ConversationHelloAnswer
  grant: StudioGrant
}

export type StudioMethodMap = StudioConversationMethodMap &
  StudioFollowedMethodMap &
  StudioChatMethodMap &
  StudioToolsMethodMap &
  StudioFilesMethodMap &
  StudioPullRequestsMethodMap &
  StudioLocalServersMethodMap &
  StudioModulesMethodMap &
  StudioModuleServicesMethodMap &
  StudioTerminalsMethodMap &
  StudioUpdateMethodMap &
  StudioAgentSettingsMethodMap &
  StudioAgentSetupMethodMap &
  StudioWorkspacesMethodMap &
  StudioReadinessMethodMap &
  StudioChatStoresMethodMap &
  StudioAgentSkillsMethodMap &
  StudioSchedulesMethodMap &
  StudioFileSystemMethodMap &
  StudioBacklogMethodMap &
  StudioSharesMethodMap &
  StudioPullRequestReadsMethodMap &
  StudioGitMethodMap &
  StudioWorktreesMethodMap &
  StudioChatLifecycleMethodMap

/** The `server` and `conversation` methods phase 2 shipped; the chat surface's are in `chat.ts`. */
type StudioConversationMethodMap = {
  'server.info': { params: Record<string, never>; result: StudioServerInfo }
  /**
   * Answered at once, by any authenticated client: proof the connection is
   * alive end to end. A client asks after a quiet spell, since a socket left
   * half-open by a machine that slept never closes by itself.
   */
  'server.ping': { params: Record<string, never>; result: { at: number } }
  'conversation.list': { params: Record<string, never>; result: { conversations: ConversationThread[] } }
  'conversation.create': {
    params: StudioConversationCreateParams
    result: { conversation: StudioCreatedConversation }
    errors: StudioRuntimeRefusalCode | 'ceiling_exceeded'
  }
  'conversation.send': Command<'send'>
  'conversation.interrupt': Command<'interrupt'>
  'conversation.resolveApproval': Command<'resolveApproval'>
  'conversation.answerQuestion': Command<'answerQuestion'>
  'conversation.resolvePlan': Command<'resolvePlan'>
  /** Lowered to the client's ceiling, never refused for it: the answer names the preset in force. */
  'conversation.setPermissionPreset': Command<
    'setPermissionPreset',
    StudioCommandAnswer & { permissionPreset: ConversationWirePermissionPreset; permissionMode?: string }
  >
  'conversation.setModel': Command<'setModel', StudioCommandAnswer & { modelId: string }>
  /**
   * Takes back a message the desktop holds for the chat's turn to end, by its
   * `id` (the conversation lane's `cancelQueued`).
   */
  'conversation.cancelQueued': Command<'cancelQueued'>
  /**
   * Stops one agent the chat spawned, by the call that spawned it (its lane's
   * `toolUseId`; the conversation lane's `stopSubagent`), and leaves the chat,
   * its turn and its other agents running. Refused for an agent that is not
   * running, and for a chat whose provider cannot stop one by itself.
   */
  'conversation.stopSubagent': Command<'stopSubagent'>
  /**
   * Passes the person's words to one agent the chat spawned, by the call that
   * spawned it (the conversation lane's `messageSubagent`): the chat's model is
   * asked to deliver them. Refused for a chat whose provider cannot.
   */
  'conversation.messageSubagent': Command<'messageSubagent'>
  /**
   * Sets the reasoning effort the chat runs at from its next turn (the
   * conversation lane's `setReasoningEffort`): one of the levels its listed
   * `capabilities.reasoningEfforts` names, or none for the provider's own
   * default, kept on the chat.
   */
  'conversation.setReasoningEffort': Command<'setReasoningEffort'>
  /**
   * Reconnects one of a live chat's MCP servers, or switches it on or off (the
   * conversation lane's `mcpServerAction`), where its listed
   * `capabilities.mcpServerActions` names the action. Never a sign-in, whose
   * callback the chat's CLI waits for on the desktop.
   */
  'conversation.mcpServerAction': Command<'mcpServerAction'>
  /**
   * Restarts the chat's agent (the conversation lane's `restartSession`): its
   * process ends, the session keeps its place, and the next message starts it
   * again. Refused while the agent works; `notice` says when there was none
   * running.
   */
  'conversation.restartSession': Command<'restartSession'>
  /**
   * Has the desktop keep a message and send it into the chat at `sendAt`
   * (the conversation lane's `scheduleSend`), answered once it is kept; and
   * sends one it keeps now, or deletes it, by its `id`
   * (`sendScheduledNow`, `cancelScheduled`).
   */
  'conversation.scheduleSend': Command<'scheduleSend'>
  'conversation.sendScheduledNow': Command<'sendScheduledNow'>
  'conversation.cancelScheduled': Command<'cancelScheduled'>
  /**
   * Acts on the notice a usage limit left on the chat's turn (the
   * conversation lane's `usageLimitResume`): schedules the resume the desktop
   * sends once the limit resets (`always`: for every chat a limit stops),
   * cancels, dismisses or retries it.
   */
  'conversation.usageLimitResume': Command<'usageLimitResume'>
  /** Ends the chat's live session. Idempotent by nature: stopping a stopped chat answers ok. */
  'conversation.stop': { params: Addressed<object>; result: StudioCommandAnswer; errors: 'not_found' }
  'conversation.loadEarlier': {
    params: { key: StudioConversationKey; beforeCursor: number; turnLimit?: number }
    result: { page: ConversationWirePage }
    errors: 'not_found'
  }
  'conversation.toolDetail': {
    params: { key: StudioConversationKey; toolUseId: string }
    result: { detail: ConversationToolDetail }
    errors: 'not_found'
  }
  /**
   * One event as the chat's log stores it, by the `seq` and `id` it was sent
   * under: the whole of an event that crossed cut to fit (`wireClipped`).
   */
  'conversation.event': {
    params: { key: StudioConversationKey; seq: number; id: string }
    result: { event: ConversationWireEvent }
    errors: 'not_found'
  }
  'conversation.turnDiff': {
    params: { key: StudioConversationKey; turnSeq: number; path?: string }
    result: { diff: ConversationCheckpointDiff; patch?: string; original?: string; modified?: string }
    errors: 'not_found'
  }
}

export type StudioMethod = keyof StudioMethodMap
export type StudioMethodParams<M extends StudioMethod> = StudioMethodMap[M]['params']
export type StudioMethodResult<M extends StudioMethod> = StudioMethodMap[M]['result']
/** Every code a method may answer with: the common ones and its own. */
export type StudioMethodErrorCode<M extends StudioMethod> = StudioErrorCodeOf<StudioMethodMap[M]>
/** A method's answer, as the server's handler gives it. */
export type StudioMethodAnswer<M extends StudioMethod> = StudioAnswerOf<StudioMethodMap[M]>
/** A handler for every method, each answering its own method's result: the server's half of the table. */
export type StudioHandlers<Context> = StudioHandlersOf<StudioMethodMap, Context>
/** A client's one way to call, typed by the table: the client's half. */
export type StudioRequest = StudioRequestOf<StudioMethodMap>
/** A call per method, built from the table by `createStudioRpcClient`. */
export type StudioRpcClient = StudioRpcClientOf<StudioMethodMap>

// ── The conversation methods' table ─────────────────────────────────────────

/** The conversation command kind each command method carries. */
export const STUDIO_COMMAND_METHODS = {
  'conversation.send': 'send',
  'conversation.interrupt': 'interrupt',
  'conversation.resolveApproval': 'resolveApproval',
  'conversation.answerQuestion': 'answerQuestion',
  'conversation.resolvePlan': 'resolvePlan',
  'conversation.setPermissionPreset': 'setPermissionPreset',
  'conversation.setModel': 'setModel',
  'conversation.cancelQueued': 'cancelQueued',
  'conversation.stopSubagent': 'stopSubagent',
  'conversation.messageSubagent': 'messageSubagent',
  'conversation.setReasoningEffort': 'setReasoningEffort',
  'conversation.mcpServerAction': 'mcpServerAction',
  'conversation.restartSession': 'restartSession',
  'conversation.scheduleSend': 'scheduleSend',
  'conversation.sendScheduledNow': 'sendScheduledNow',
  'conversation.cancelScheduled': 'cancelScheduled',
  'conversation.usageLimitResume': 'usageLimitResume',
} as const satisfies Partial<Record<StudioMethod, ConversationCommand['kind']>>

export type StudioCommandMethod = keyof typeof STUDIO_COMMAND_METHODS

/** A command's params as the conversation command they carry, with its conversation and id. */
export type StudioParsedCommand = { key: StudioConversationKey; commandId: string; command: ConversationCommand }

function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
const refuse = (code: StudioParamsRefusalCode, message: string): StudioParamsRefusal =>
  studioParamsRefused(message, code)

const KEY_REQUIRED = '"key" names the conversation: { workspaceId, agentId, workspaceRoot? }.'
const COMMAND_ID = '"commandId" must be a string of 1 to 200 characters.'

/**
 * A command method's params as the conversation command they carry, read by
 * the conversation lane's own validator. The refusal is the lane's own
 * (`explainRejectedConversationMessage`), so an over-long message is refused
 * as too large, exactly as on the tailnet.
 */
export function parseStudioCommand(
  method: StudioCommandMethod,
  params: Record<string, unknown>,
): StudioParsedCommand | StudioParamsRefusal {
  const key = parseStudioConversationKey(params.key)
  if (!key) return refuse('invalid_params', KEY_REQUIRED)
  if (!id(params.commandId)) return refuse('invalid_params', COMMAND_ID)
  // Pictures travel beside the socket, not in it, and this version has no
  // upload route: refused rather than dropped, so a send never silently loses one.
  if (params.uploadIds !== undefined) return refuse('invalid_params', 'This connection does not carry pictures yet.')
  const { key: _key, commandId, ...members } = params
  const frame = { type: 'command', commandId, command: { ...members, kind: STUDIO_COMMAND_METHODS[method] } }
  const parsed = parseConversationClientMessage(frame)
  if (!parsed || parsed.type !== 'command') {
    const rejection = explainRejectedConversationMessage(frame)
    return refuse(
      rejection.code === 'too_large' || rejection.code === 'unsafe_remote_decision' ? rejection.code : 'invalid_params',
      rejection.code === 'invalid_frame' || rejection.code === 'unsupported_command'
        ? `The params of ${method} are not in the documented shape.`
        : rejection.message,
    )
  }
  return { key, commandId: parsed.commandId, command: parsed.command }
}

/**
 * The validator of one command method: the lane's validator, then the
 * command's members under their conversation and id. The lane's command of
 * that kind is the method's params by construction (`CommandParams`), which
 * the narrowing by `kind` proves.
 */
function commandParams<K extends ConversationCommand['kind']>(
  method: StudioCommandMethod,
  kind: K,
): (value: Record<string, unknown>) => StudioParsed<CommandParams<K>> {
  return (value) => {
    const parsed = parseStudioCommand(method, value)
    if (!('command' in parsed)) return parsed
    if (parsed.command.kind !== kind)
      return refuse('invalid_params', `The params of ${method} are not in the documented shape.`)
    const { kind: _kind, ...members } = parsed.command as Extract<ConversationCommand, { kind: K }>
    return studioParams({ key: parsed.key, commandId: parsed.commandId, ...members } as CommandParams<K>)
  }
}

function keyed(value: Record<string, unknown>): StudioParsed<{ key: StudioConversationKey }> {
  const key = parseStudioConversationKey(value.key)
  return key ? studioParams({ key }) : refuse('invalid_params', KEY_REQUIRED)
}

function turnLimit(value: unknown): StudioParsed<{ turnLimit?: number }> {
  if (value === undefined) return studioParams({})
  return integer(value) && value >= 1 && value <= 100
    ? studioParams({ turnLimit: value })
    : refuse('invalid_params', '"turnLimit" must be between 1 and 100.')
}

const read = (scope: StudioMethodSpec['scope'] = 'conversation:read'): StudioMethodSpec => ({
  scope,
  mutation: false,
  capability: scope ? STUDIO_CONVERSATIONS_CAPABILITY : null,
})
const operate: StudioMethodSpec = {
  scope: 'conversation:operate',
  mutation: true,
  capability: STUDIO_CONVERSATIONS_CAPABILITY,
}

function command<K extends ConversationCommand['kind'], M extends StudioCommandMethod>(
  method: M,
  kind: K,
): StudioMethodDefinition<{ params: CommandParams<K>; result: unknown }> {
  return { ...operate, params: commandParams(method, kind) }
}

const noParams = (): StudioParsed<Record<string, never>> => studioParams({})

/**
 * How New chat starts one, beyond the contract's create: as a chat of its own
 * in the project's folder (`newChat`) rather than one more agent in a
 * workspace, in a worktree cut for it (`worktree`, named from `worktreeName`)
 * or one the project already has (`inWorktree`, a path `workspaces.checkout`
 * lists), under no project at all (`noProject`, in place of `workspaceId`),
 * and at a reasoning effort (`effort`, one of the CLI's `reasoningLevels`).
 * The gateway's `conversation.create` tool takes the same, for agents.
 */
export type StudioNewChatOptions = {
  newChat?: boolean
  worktree?: boolean
  worktreeName?: string
  inWorktree?: string
  effort?: string
}

/** A create as the protocol takes it: in a workspace, or (`noProject`) in a folder of its own. */
export type StudioConversationCreate = StudioNewChatOptions &
  (
    | (ConversationCreateRequest & { noProject?: undefined })
    | (Omit<ConversationCreateRequest, 'workspaceId'> & { workspaceId?: undefined; noProject: true })
  )

export type StudioConversationCreateParams = StudioConversationCreate & { commandId: string }

const EFFORT_ID = /^[a-z][a-z0-9_-]{0,31}$/iu

/** A create's members, read and held to New chat's rules; `commandId` is the caller's to read. */
export function parseStudioConversationCreate(
  value: Record<string, unknown>,
): { ok: true; create: StudioConversationCreate } | { ok: false; message: string } {
  const { commandId: _commandId, noProject, newChat, worktree, worktreeName, inWorktree, effort, ...request } = value
  if (noProject !== undefined && noProject !== true) return { ok: false, message: '"noProject", when given, is true.' }
  for (const [name, flag] of [
    ['newChat', newChat],
    ['worktree', worktree],
  ] as const)
    if (flag !== undefined && typeof flag !== 'boolean') return { ok: false, message: `"${name}" is a boolean.` }
  for (const [name, text, max] of [
    ['worktreeName', worktreeName, 200],
    ['inWorktree', inWorktree, 4096],
  ] as const)
    if (text !== undefined && (typeof text !== 'string' || !text.trim() || text.length > max))
      return { ok: false, message: `"${name}" is a string of 1 to ${max} characters.` }
  if (effort !== undefined && (typeof effort !== 'string' || !EFFORT_ID.test(effort.trim())))
    return { ok: false, message: '"effort" is an effort level id, such as "high".' }
  if (noProject) {
    if (request.workspaceId !== undefined)
      return { ok: false, message: '"noProject" takes the place of "workspaceId".' }
    if (worktree || worktreeName !== undefined || inWorktree !== undefined)
      return { ok: false, message: 'A chat with no project has no checkout to take a worktree from.' }
  }
  if (worktree && newChat !== true)
    return { ok: false, message: '"worktree" starts a new chat: set "newChat" with it.' }
  if (worktreeName !== undefined && worktree !== true)
    return { ok: false, message: '"worktreeName" names a new worktree: set "worktree" with it.' }
  if (inWorktree !== undefined && newChat !== true)
    return { ok: false, message: '"inWorktree" starts a new chat: set "newChat" with it.' }
  if (inWorktree !== undefined && worktree)
    return { ok: false, message: 'Ask for a new worktree or name one, not both.' }
  // The contract's own members, read by its own validator; a chat under no
  // project names no workspace, so it is read with a stand-in and given none.
  const parsed = parseConversationCreateRequest(noProject ? { ...request, workspaceId: 'no-project' } : request)
  if (!parsed.ok) return { ok: false, message: parsed.message }
  const options: StudioNewChatOptions = {
    ...(newChat === true ? { newChat: true } : {}),
    ...(worktree === true ? { worktree: true } : {}),
    ...(typeof worktreeName === 'string' ? { worktreeName: worktreeName.trim() } : {}),
    ...(typeof inWorktree === 'string' ? { inWorktree: inWorktree.trim() } : {}),
    ...(typeof effort === 'string' ? { effort: effort.trim() } : {}),
  }
  if (noProject) {
    const { workspaceId: _standIn, ...rest } = parsed.request
    return { ok: true, create: { ...rest, ...options, noProject: true } }
  }
  return { ok: true, create: { ...parsed.request, ...options } }
}

const STUDIO_CONVERSATION_METHODS: StudioMethodTable<StudioConversationMethodMap> = {
  'server.info': { ...read(null), params: noParams },
  'server.ping': { ...read(null), params: noParams },
  'conversation.list': { ...read(), params: noParams },
  'conversation.create': {
    scope: 'conversation:create',
    mutation: true,
    capability: STUDIO_CONVERSATION_CREATE_CAPABILITY,
    params: (value) => {
      if (!id(value.commandId)) return refuse('invalid_params', COMMAND_ID)
      const parsed = parseStudioConversationCreate(value)
      return parsed.ok
        ? studioParams({ ...parsed.create, commandId: value.commandId })
        : refuse('invalid_params', parsed.message)
    },
  },
  'conversation.send': command('conversation.send', 'send'),
  'conversation.interrupt': command('conversation.interrupt', 'interrupt'),
  'conversation.resolveApproval': command('conversation.resolveApproval', 'resolveApproval'),
  'conversation.answerQuestion': command('conversation.answerQuestion', 'answerQuestion'),
  'conversation.resolvePlan': command('conversation.resolvePlan', 'resolvePlan'),
  'conversation.setPermissionPreset': command('conversation.setPermissionPreset', 'setPermissionPreset'),
  'conversation.setModel': command('conversation.setModel', 'setModel'),
  'conversation.cancelQueued': command('conversation.cancelQueued', 'cancelQueued'),
  'conversation.stopSubagent': command('conversation.stopSubagent', 'stopSubagent'),
  'conversation.messageSubagent': command('conversation.messageSubagent', 'messageSubagent'),
  'conversation.setReasoningEffort': command('conversation.setReasoningEffort', 'setReasoningEffort'),
  'conversation.mcpServerAction': command('conversation.mcpServerAction', 'mcpServerAction'),
  'conversation.restartSession': command('conversation.restartSession', 'restartSession'),
  'conversation.scheduleSend': command('conversation.scheduleSend', 'scheduleSend'),
  'conversation.sendScheduledNow': command('conversation.sendScheduledNow', 'sendScheduledNow'),
  'conversation.cancelScheduled': command('conversation.cancelScheduled', 'cancelScheduled'),
  'conversation.usageLimitResume': command('conversation.usageLimitResume', 'usageLimitResume'),
  'conversation.stop': {
    ...operate,
    params: (value) => {
      const at = keyed(value)
      if (!at.ok) return at
      if (!id(value.commandId)) return refuse('invalid_params', COMMAND_ID)
      return studioParams({ key: at.params.key, commandId: value.commandId })
    },
  },
  'conversation.loadEarlier': {
    ...read(),
    params: (value) => {
      const at = keyed(value)
      if (!at.ok) return at
      if (!integer(value.beforeCursor)) return refuse('invalid_params', '"beforeCursor" must be a sequence number.')
      const limit = turnLimit(value.turnLimit)
      if (!limit.ok) return limit
      return studioParams({ key: at.params.key, beforeCursor: value.beforeCursor, ...limit.params })
    },
  },
  'conversation.toolDetail': {
    ...read(),
    params: (value) => {
      const at = keyed(value)
      if (!at.ok) return at
      if (!id(value.toolUseId)) return refuse('invalid_params', '"toolUseId" names the tool call.')
      return studioParams({ key: at.params.key, toolUseId: value.toolUseId })
    },
  },
  'conversation.event': {
    ...read(),
    params: (value) => {
      const at = keyed(value)
      if (!at.ok) return at
      if (!integer(value.seq) || value.seq < 1) return refuse('invalid_params', '"seq" must be a sequence number.')
      if (!id(value.id)) return refuse('invalid_params', '"id" names the event.')
      return studioParams({ key: at.params.key, seq: value.seq, id: value.id })
    },
  },
  'conversation.turnDiff': {
    ...read(),
    params: (value) => {
      const at = keyed(value)
      if (!at.ok) return at
      if (!integer(value.turnSeq)) return refuse('invalid_params', '"turnSeq" must be a sequence number.')
      if (value.path !== undefined && !(typeof value.path === 'string' && value.path.length <= 4096))
        return refuse('invalid_params', '"path" must be a path of at most 4096 characters.')
      return studioParams({
        key: at.params.key,
        turnSeq: value.turnSeq,
        ...(value.path === undefined ? {} : { path: value.path as string }),
      })
    },
  },
}

/** Every method: how it is held and how its params are read. A method of the map without one does not compile. */
export const STUDIO_METHODS: StudioMethodTable<StudioMethodMap> = {
  ...STUDIO_CONVERSATION_METHODS,
  ...STUDIO_FOLLOWED_METHODS,
  ...STUDIO_CHAT_METHODS,
  ...STUDIO_TOOLS_METHODS,
  ...STUDIO_FILES_METHODS,
  ...STUDIO_PULL_REQUESTS_METHODS,
  ...STUDIO_LOCAL_SERVERS_METHODS,
  ...STUDIO_MODULES_METHODS,
  ...STUDIO_MODULE_SERVICES_METHODS,
  ...STUDIO_TERMINALS_METHODS,
  ...STUDIO_UPDATE_METHODS,
  ...STUDIO_AGENT_SETTINGS_METHODS,
  ...STUDIO_AGENT_SETUP_METHODS,
  ...STUDIO_AGENT_SKILLS_METHODS,
  ...STUDIO_WORKSPACES_METHODS,
  ...STUDIO_READINESS_METHODS,
  ...STUDIO_CHAT_STORES_METHODS,
  ...STUDIO_SCHEDULES_METHODS,
  ...STUDIO_FILE_SYSTEM_METHODS,
  ...STUDIO_BACKLOG_METHODS,
  ...STUDIO_SHARES_METHODS,
  ...STUDIO_PULL_REQUEST_READS_METHODS,
  ...STUDIO_GIT_METHODS,
  ...STUDIO_WORKTREES_METHODS,
  ...STUDIO_CHAT_LIFECYCLE_METHODS,
}

/** Whether a string names a method this version of the protocol defines. */
export function isStudioMethod(value: unknown): value is StudioMethod {
  return typeof value === 'string' && Object.hasOwn(STUDIO_METHODS, value)
}

/**
 * The client, built from the table: a call per method, each taking that
 * method's params and promising its result, made through one `request`.
 */
export function createStudioRpcClient(request: StudioRequest): StudioRpcClient {
  const client: Record<string, (params: object) => Promise<unknown>> = {}
  for (const method of Object.keys(STUDIO_METHODS) as StudioMethod[])
    client[method] = (params) => request(method, params as never)
  return Object.freeze(client) as StudioRpcClient
}

// ── Topics ──────────────────────────────────────────────────────────────────

export type StudioTopicMap = {
  /**
   * One conversation, followed as every follower of the contract follows it:
   * a `snapshot` (or, for a cursor the log can vouch for, only the events
   * after it), one `synchronized` fence, then live `event`s.
   */
  'conversation.session': {
    params: { key: StudioConversationKey; turnLimit?: number }
    payload: ConversationServerFrame
    stream: 'frames'
  }
} & StudioFollowedTopicMap &
  StudioChatTopicMap &
  StudioToolsTopicMap &
  StudioFilesTopicMap &
  StudioPullRequestsTopicMap &
  StudioLocalServersTopicMap &
  StudioModulesTopicMap &
  StudioTerminalsTopicMap &
  StudioAgentSettingsTopicMap &
  StudioAgentSetupTopicMap &
  StudioChatStoresTopicMap &
  StudioAgentSkillsTopicMap &
  StudioSchedulesTopicMap &
  StudioFileSystemTopicMap &
  StudioBacklogTopicMap &
  StudioGitTopicMap &
  StudioWorktreesTopicMap

export type StudioTopic = keyof StudioTopicMap
export type StudioTopicParams<T extends StudioTopic> = StudioTopicMap[T]['params']
/** What one message of a topic carries: a push's payload, or a conversation frame. */
export type StudioTopicPayload<T extends StudioTopic> = StudioTopicMap[T]['payload']
/** The topics whose messages are whole pushes, with no cursor. */
export type StudioPushTopic = {
  [T in StudioTopic]: StudioTopicMap[T]['stream'] extends 'push' ? T : never
}[StudioTopic]

/** How a topic is held: its scope, capability and owner rule, as a method's. */
export type StudioTopicSpec = {
  [T in StudioTopic]: Omit<StudioTopicDefinition<StudioTopicMap[T]>, 'params'>
}[StudioTopic]

export const STUDIO_TOPICS: StudioTopicTable<StudioTopicMap> = {
  'conversation.session': {
    scope: 'conversation:read',
    capability: STUDIO_CONVERSATIONS_CAPABILITY,
    params: (value) => {
      const at = keyed(value)
      if (!at.ok) return at
      const limit = turnLimit(value.turnLimit)
      if (!limit.ok) return limit
      return studioParams({ key: at.params.key, ...limit.params })
    },
  },
  ...STUDIO_FOLLOWED_TOPICS,
  ...STUDIO_CHAT_TOPICS,
  ...STUDIO_TOOLS_TOPICS,
  ...STUDIO_FILES_TOPICS,
  ...STUDIO_PULL_REQUESTS_TOPICS,
  ...STUDIO_LOCAL_SERVERS_TOPICS,
  ...STUDIO_MODULES_TOPICS,
  ...STUDIO_TERMINALS_TOPICS,
  ...STUDIO_AGENT_SETTINGS_TOPICS,
  ...STUDIO_AGENT_SETUP_TOPICS,
  ...STUDIO_CHAT_STORES_TOPICS,
  ...STUDIO_BACKLOG_TOPICS,
  ...STUDIO_AGENT_SKILLS_TOPICS,
  ...STUDIO_SCHEDULES_TOPICS,
  ...STUDIO_FILE_SYSTEM_TOPICS,
  ...STUDIO_GIT_TOPICS,
  ...STUDIO_WORKTREES_TOPICS,
}

/** Whether a string names a topic this version of the protocol defines. */
export function isStudioTopic(value: unknown): value is StudioTopic {
  return typeof value === 'string' && Object.hasOwn(STUDIO_TOPICS, value)
}

// ── Access ──────────────────────────────────────────────────────────────────

type StudioSpec = { scope: StudioMethodSpec['scope']; extraPermissions?: readonly StudioPermission[]; owner?: string }

/** What a method or topic needs: the permission its scope names, first, then any it adds. */
export function studioSpecPermissions(spec: StudioSpec): readonly StudioPermission[] {
  const needed = [...(spec.scope ? studioScopeRequires(spec.scope) : []), ...(spec.extraPermissions ?? [])]
  return [...new Set(needed)]
}

function studioSpecAccess(table: object, name: string): StudioAccess | undefined {
  // Own keys only: `constructor` is not a method.
  if (!Object.hasOwn(table, name)) return undefined
  const spec = (table as Record<string, StudioSpec>)[name]
  return { permissions: studioSpecPermissions(spec), ...(spec.owner ? { owner: spec.owner } : {}) }
}

/** A grant as it stands, the method it asks for, and the answer: unknown methods are refused. */
export function authorizeStudioMethod(
  grant: { owner: boolean; scopes: readonly string[] },
  method: string,
): StudioAuthorization {
  return authorizeStudioAccess(studioGrantPrincipal(grant), studioSpecAccess(STUDIO_METHODS, method))
}

/** The same for a topic, on subscribing and again before each frame goes out. */
export function authorizeStudioTopic(
  grant: { owner: boolean; scopes: readonly string[] },
  topic: string,
): StudioAuthorization {
  return authorizeStudioAccess(studioGrantPrincipal(grant), studioSpecAccess(STUDIO_TOPICS, topic))
}

/**
 * What each method asks of its caller, derived from the table: the permissions
 * it needs and whether it is an owner's only. A client reads what a grant
 * reaches here (`studioGrantAllows`), never off `grant.owner`.
 */
export const STUDIO_METHOD_ACCESS = Object.freeze(
  Object.fromEntries(
    (Object.keys(STUDIO_METHODS) as StudioMethod[]).map((method) => [
      method,
      studioSpecAccess(STUDIO_METHODS, method) as StudioAccess,
    ]),
  ),
) as { readonly [M in StudioMethod]: StudioAccess }

/** The same for each topic. */
export const STUDIO_TOPIC_ACCESS = Object.freeze(
  Object.fromEntries(
    (Object.keys(STUDIO_TOPICS) as StudioTopic[]).map((topic) => [
      topic,
      studioSpecAccess(STUDIO_TOPICS, topic) as StudioAccess,
    ]),
  ),
) as { readonly [T in StudioTopic]: StudioAccess }

/**
 * Whether a grant as it stands reaches a method: the server's grant check
 * (`authorizeStudioMethod`), for a client deciding whether to offer a control.
 * Unknown methods are not reached. A request it allows can still be refused
 * by a rule on its params (a folder only an owner may name, a file's bytes
 * staged for `files.write`) or for a capability the Studio does not advertise.
 */
export function studioGrantAllows(grant: { owner: boolean; scopes: readonly string[] }, method: string): boolean {
  return authorizeStudioMethod(grant, method).ok
}

/** The same for subscribing to a topic. */
export function studioGrantAllowsTopic(grant: { owner: boolean; scopes: readonly string[] }, topic: string): boolean {
  return authorizeStudioTopic(grant, topic).ok
}

/**
 * What a `scope_required` refusal names: the method's scope when that is what
 * is missing, as a client asks to be granted it, else the permission itself.
 */
export function studioRefusedGrantName(spec: StudioSpec, permission: StudioPermission): string {
  return spec.scope && studioScopeRequires(spec.scope).includes(permission) ? spec.scope : permission
}

// ── Params ──────────────────────────────────────────────────────────────────

export type { StudioParamsRefusal } from './contract.js'
export type StudioParsedParams<M extends StudioMethod> = StudioParsed<StudioMethodParams<M>>

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Validate a request's params by its method's own validator, keeping only the members the method defines. */
export function parseStudioMethodParams<M extends StudioMethod>(method: M, params: unknown): StudioParsedParams<M> {
  const value = params === undefined ? {} : params
  if (!record(value)) return refuse('invalid_params', `${method} takes an object of params.`)
  return (STUDIO_METHODS[method] as StudioMethodDefinition<StudioMethodMap[M]>).params(value)
}

/** A subscription's params for its topic, or why they are not. */
export function parseStudioTopicParams<T extends StudioTopic>(
  topic: T,
  params: unknown,
): StudioParsed<StudioTopicParams<T>> {
  const definition = STUDIO_TOPICS[topic] as StudioTopicDefinition<StudioTopicMap[T]>
  const notObject = refuse(
    'invalid_params',
    topic === 'files.watch' ? 'files.watch takes { root, path }.' : `${topic} takes an object of params.`,
  )
  // A topic that follows everything takes nothing; one that names what it
  // follows (its validator refuses `{}`) needs its params.
  if (params === undefined) {
    const empty = definition.params({})
    return empty.ok ? empty : notObject
  }
  return record(params) ? definition.params(params) : notObject
}
