import {
  STUDIO_METHODS,
  parseStudioMethodParams,
  authorizeStudioMethod,
  studioGrantAllows,
  studioGrantPrincipal,
  projectTerminalSession,
  studioRefusedGrantName,
  type ConversationCommand,
  type StudioChatMethod,
  type StudioCommandAnswer,
  type StudioCommonErrorCode,
  type StudioConversationKey,
  type StudioCreatedConversation,
  type StudioErrorBody,
  type StudioModuleBacklogAnswer,
  type StudioErrorCode,
  type FileWatchEvent,
  type SkillSourceUpdateCheck,
  type StudioGrant,
  type StudioHandlers,
  type StudioMethod,
  type StudioMethodAnswer,
  type StudioMethodParams,
  type StudioMethodResult,
  type StudioRuntimeRefusalCode,
  type StudioServerInfo,
  type StudioUpdateStatus,
  type ThirdPartyModuleListResult,
  studioScopesGrant,
} from '../../../packages/studio-protocol/src/public'
import type { StudioEnvironmentReadiness } from '../../../packages/studio-protocol/src/readiness'
import type { SignIns } from '../machine/machine-sign-in'
import { cliForConversationProvider } from '../../shared/conversation-harness'
import type { EnvironmentAdoption } from '../environment/environment-adoption'
import { createHash, randomBytes } from 'node:crypto'

import { isLooserCliPermissionPreset } from '../../shared/cli-permission-preset'
import { sanitizeEntryMessage } from '../../shared/modules/entry-messages'
import { ceilingAllowsUnaskedTools, clampPresetToCeiling } from '../../shared/permission-ceiling'
import type { ConversationEvent, ConversationImageAttachment, ConversationKey } from '../../shared/conversation-runtime'
import { createStudioUploads, type StudioUploads } from './studio-uploads'
import { BROWSER_NO_TERMINALS, refusedOutsideWindow, refusedToBrowser, WINDOW_ONLY } from './studio-browser-reach'
import { boundConversationPage } from '../conversation-stream-shaping'
import type { ClientToolRegistry } from '../tools/client-tool-registry'
import type { StudioFiles } from './studio-files'
import type { StudioPullRequests } from '../pull-requests/pull-request-domain'
import {
  isChatPullRequestRefusal,
  type ChatPullRequestRefusal,
  type ConversationPullRequests,
} from '../../main/automation/conversation-pull-request-tools'
import type { StudioLocalServers } from '../local-servers/local-server-domain'
import type { StudioTerminalCaller, StudioTerminals } from '../terminals/studio-terminals'
import type { CliRuntimes } from '../../main/cli-runtimes'
import type { StudioAgentSettings } from '../agent-settings/agent-settings-domain'
import { createStudioAgentSettingsHandlers } from './studio-agent-settings'
import type { StudioAgentSetup } from '../agent-setup/agent-setup-domain'
import type { StudioAgentSkills } from '../core/studio-agent-skills'
import { createStudioAgentSkillsHandlers, skillSourceUpdatesShown } from './studio-agent-skills'
import { createStudioAgentSetupHandlers } from './studio-agent-setup'
import type { ModuleHostServices } from '../../main/module-host/main-host'
import type { ModuleLifecycle } from '../../main/modules/module-lifecycle'
import type { StudioFileSystem, StudioFileSystemWatch } from '../files/studio-file-system'
import { createStudioFileSystemHandlers } from './studio-file-system'
import type { StudioGit } from '../git/studio-git-types'
import { createStudioGitHandlers } from './studio-git'
import type { StudioWorktrees } from '../worktrees/studio-worktrees-types'
import { createStudioWorktreesHandlers } from './studio-worktrees'
import type { StudioWorkspaceSync } from '../workspaces/studio-workspace-sync'
import { createStudioWorkspaceSyncHandlers } from './studio-workspace-sync'
import type { StudioExtensions } from '../extensions/extensions-domain'
import { createStudioExtensionsHandlers } from './studio-extensions'
import type { StudioArtifacts } from '../artifacts/artifacts-domain'
import { createStudioArtifactsHandlers } from './studio-artifacts'
import { createStudioAccessHandlers, type StudioAccessDomain } from './studio-access'
import { createStudioWebDevicesHandlers, type StudioWebDevicesDomain } from './studio-web-devices'
import { createStudioTailnetHandlers, type StudioTailnetDomain } from './studio-tailnet'
import type { StudioModuleCallOutcome, StudioModules } from './studio-modules'
import type { StudioChatStores } from '../chat-stores/chat-stores-domain'
import { createStudioChatStoresHandlers } from './studio-chat-stores'
import type { StudioSchedulesDomain } from '../schedules/schedules-domain'
import { createStudioSchedulesHandlers } from './studio-schedules'
import type { StudioPhoneReads } from '../backlog/backlog-domain'
import { createStudioPhoneReadsHandlers } from './studio-phone-reads'
import type { StudioChatLifecycleDomain } from '../chat-lifecycle/chat-lifecycle-domain'
import { createStudioChatLifecycleHandlers } from './studio-chat-lifecycle'
import type { StudioCanvasDomain } from '../canvas/canvas-domain'
import { createStudioCanvasHandlers } from './studio-canvas'
import {
  externalStudioUpdates,
  MANUAL_UPDATE_WORDS,
  studioUpdateStatus,
  type StudioUpdates,
} from '../update/studio-updates'
import type {
  StudioAuditEntry,
  StudioDiscovery,
  StudioDiscoveryAnswer,
  StudioChatBackend,
  StudioComposerRead,
  StudioConversationBackend,
  StudioRequestContext,
  StudioChatExportRead,
  StudioEnvironmentAccess,
} from './studio-rpc-types'

// The Studio RPC's methods, transport-free: given the grant a client holds at
// this moment, a method and its params, an answer. The connection reads the
// grant live and hands it here on every request, so a narrowed grant or a
// revoked client is refused at the next request, not the next connection.
//
// Three rules sit here rather than in the conversation host, because they are
// about who is asking:
//
// - Scope. Every method's scope comes from STUDIO_METHODS, checked first.
//   Its params are read by the validator the same table holds, and it is
//   answered by its handler in `handlers` below: one per method, typed by the
//   method's contract, so a method without a handler, or a handler answering
//   another shape or an undeclared refusal, does not compile.
// - Ceiling. A paired app's chats run no looser than its ceiling, exactly as a
//   module's do (permission-ceiling.ts): a preset it asks for is lowered to the
//   ceiling, none asked for is pinned to it, and naming tools a chat may use
//   unasked needs the loosest ceiling. An app does not drive a chat that
//   already runs looser than its ceiling — it may read it, interrupt or stop
//   it, deny its requests and lower its preset, but not send to it or approve
//   for it — or the ceiling would hold only for chats the app started. A chat
//   running with tools it may use unasked counts as `bypass` for that check,
//   and answering a request for the rest of the conversation (an allow rule
//   for its kind) needs a ceiling of at least `auto`.
// - Command ids. A client's ids are namespaced by the client before they reach
//   the runtime's receipts (`client:<id>:<commandId>`, `owner:<commandId>`), as
//   a module's are (`module:<id>:<commandId>`), so one client can neither
//   collide with nor be answered from another's receipts.
//
// The chat surface (`chat.ts` in the protocol) is served where main hands the
// router a chat backend, to any client its scopes reach. What a client that
// is not an owner names on this disk is held here, by its params: never a
// conversation's or a workspace's folder, never a CLI's own command, and a
// file only inside the folders Studio knows (a search's root, a stat, a
// picture, a file attached to a send). Its session commands reach
// the runtime's durable receipts by the same namespaced ids. Its other
// mutations (starting a session, a revert, a rewind, a fork) address a
// conversation rather than a session, which the runtime keeps no receipts
// for, so this router keeps them: the first answer to an id is the answer to
// every retry of it while this process runs.
//
// What a reply carries is redacted and a failure below is told in stable
// words, except to Studio's own windows (`context.ownWindow`): they are the
// app's own chat view, which reads the same conversations over IPC as they
// are, and a view showing a redacted usage count or a vaguer error than its
// IPC would have is a regression, not a protection.

export type StudioRpcAnswer<M extends StudioMethod = StudioMethod> = StudioMethodAnswer<M>

export type StudioRpcRouter = {
  handle(
    grant: StudioGrant,
    method: StudioMethod,
    params: unknown,
    context?: StudioRequestContext,
  ): Promise<StudioRpcAnswer>
  /** How this Studio is updated and where an update stands: what `update.status` answers. */
  updateStatus(): StudioUpdateStatus
  /** A connection closed: what it staged and did not send waits a little for its reconnect. */
  connectionClosed(connectionId: string, slot?: number): void
  /** Follow a folder for `files.watchPath`, held to what the asker may name. */
  watchPath(
    params: { path: string; includeIgnored?: boolean },
    asking: { grant: StudioGrant; context: StudioRequestContext },
    listener: (event: FileWatchEvent) => void,
  ): Promise<StudioFileSystemWatch | { ok: false; code: 'not_found' | 'unavailable'; message: string }>
  /** Follow a checkout for `git.checkoutChanged`, held to what the asker may name. */
  followCheckout: ReturnType<typeof createStudioGitHandlers>['followCheckout']
  /** A `skillSources.updated` push as this asker is shown it: the local sources it could name, as `checkUpdates` answers. */
  skillSourceUpdatesFor(
    check: SkillSourceUpdateCheck,
    asking: { grant: StudioGrant; context: StudioRequestContext },
  ): Promise<SkillSourceUpdateCheck>
  /** Git's other streams, where this Studio serves git. */
  readonly git: StudioGit | null
  /** The worktree pool's streams, where this Studio serves its worktrees. */
  readonly worktrees: StudioWorktrees | null
  /** The workspace registry's change stream, where this Studio serves its windows' registry. */
  readonly workspaceSync: StudioWorkspaceSync | null
  /** The RPC is stopping: timers stop and staged uploads go. */
  close(): void
}

export type StudioRpcRouterOptions = {
  backend: StudioConversationBackend
  /** What `server.info` answers, without the grant. */
  info: () => Omit<StudioServerInfo, 'grant'>
  audit?: (entry: StudioAuditEntry) => void
  /** Where a refusal's own words go: the client is answered with a stable message instead. */
  log?: (message: string) => void
  /** The chat surface, once main has one to give; null until then, and for a Studio without one. */
  chat?: () => StudioChatBackend | null
  /** Client toolsets; without it, `tools.*` is answered `unavailable`. */
  tools?: ClientToolRegistry
  /** Files under a workspace's roots; without it, `files.*` by root is answered `unavailable`. */
  files?: StudioFiles
  /** The files on this machine by path; without it, `files.*` by path is answered `unavailable`. */
  fileSystem?: StudioFileSystem
  /** Git on this machine; without it, `git.*`, `github.*` and `versionControl.*` are answered `unavailable`. */
  git?: StudioGit
  /** The worktrees its agents run in, and deleting settled chats; without it, `worktrees.*` and `settledChats.*` are answered `unavailable`. */
  worktrees?: StudioWorktrees
  /** The desktop's own windows' workspace registry; without it, `workspaceSync.*` and its neighbours are answered `unavailable`. */
  workspaceSync?: StudioWorkspaceSync
  /** The marketplace, the CLI catalogue, the scaffold and the feeds; without it, `extensions` is answered `unavailable`. */
  extensions?: StudioExtensions
  /** Where the Studio publishes its agents' pages; without it, `artifacts.*` is answered `unavailable`. */
  artifacts?: StudioArtifacts
  /** Who may reach the agents from this machine; without it, `gateway.status`, `mcpHttp.*` and `localApps.*` are answered `unavailable`. */
  access?: StudioAccessDomain
  /** The web listener's paired browsers, once its front door gave them; until then `webDevices.*` is answered `unavailable`. */
  webDevices?: () => StudioWebDevicesDomain | null
  /** The tailnet listener and the machines this one drives; without it, `tailnet.*` and `mesh.*` are answered `unavailable`. */
  tailnet?: StudioTailnetDomain
  /** The pull requests the conversations opened; without it, `pullRequests.*` is answered `unavailable`. */
  pullRequests?: StudioPullRequests
  /** A chat's "Create PR" in its checkout here (`pull-request-create`); absent, its methods are unavailable. */
  pullRequestCreation?: ConversationPullRequests
  /** The local servers the conversations started; without it, `localServers.*` is answered `unavailable`. */
  localServers?: StudioLocalServers
  /** What a client reads before it starts a chat; without it, `workspaces.*` and `cliRuntimes.list` are `unavailable`. */
  discovery?: StudioDiscovery
  /** What this machine has and lacks for its background work; without it, `environment.readiness` is answered `unavailable`. */
  readiness?: () => Promise<StudioEnvironmentReadiness>
  /**
   * A ticket for one connection of a window of the desktop that holds this
   * Studio (`environment.windowTicket`); without it, that method is answered
   * `unavailable`. Asked only by the desktop's own shell connection.
   */
  environmentAccess?: StudioEnvironmentAccess
  /** Records the desktop that holds this Studio hands over (`environment.adopt`); without it, that method is answered `unavailable`. */
  adoption?: EnvironmentAdoption
  /** A CLI's login on this machine with no terminal (`providers.signIn*`); without it, those are answered `unavailable`. */
  signIns?: () => Promise<SignIns>
  /** The terminals on this machine; without it, `terminal.*` is answered `unavailable`. */
  terminals?: StudioTerminals
  /** The CLIs on this machine; without them, `cliRuntimes.*` and `cliVersions.*` are answered `unavailable`. */
  runtimes?: CliRuntimes
  /** The launch settings and the CLIs' texts; without them, `launchSettings.*`, `cliModels.*`, `textGeneration.*` and `commitMessage.*` are. */
  agentSettings?: StudioAgentSettings
  /** What the agents are set up with beyond their CLIs; without it, `memory.*`, `mcp.sync` and the rest are answered `unavailable`. */
  agentSetup?: StudioAgentSetup
  agentSkills?: StudioAgentSkills
  /** The modules beside this Studio; without it, `module.read` and `module.operate` are answered `unavailable`. */
  modules?: StudioModules
  /** What the Studio keeps beside its chats; without it, `usageLimits.*`, `usageLimitResumes.*`, `scheduledMessages.*`, `usage.report` and `conversationImport.*` are answered `unavailable`. */
  chatStores?: StudioChatStores
  /** The scheduled agents this Studio runs; without them, `schedules.*` is answered `unavailable`. */
  schedules?: StudioSchedulesDomain
  /** The projects' backlogs, the machine's shares and the pull request reads; without them, `backlog.*`, `shares.list` and `pullRequests.detail`/`.diff` are answered `unavailable`. */
  phoneReads?: StudioPhoneReads
  /** The chats' records beyond their rest; without them, `chat-lifecycle`'s methods are answered `unavailable`. */
  chatLifecycle?: StudioChatLifecycleDomain
  /** The machine's boards, for another device; without them, `canvas.*` is answered `unavailable`. */
  canvas?: StudioCanvasDomain
  uploads?: StudioUploads
  /** How this Studio is updated; without it, by hand (`update.status` says so, `update.start` is refused). */
  updates?: StudioUpdates
  now?: () => number
}

// How many answers to the chat surface's conversation-level mutations are kept.
const MAX_KEPT_ANSWERS = 256

const OWNER_ONLY = 'This is served to Studio’s own connections only.'
const SHELL_ONLY = 'This is served only to the desktop that holds this Studio.'
const FOLDER_OWNER_ONLY = 'Only Studio’s own connections may name a conversation by its folder.'
const COMMAND_OWNER_ONLY = 'Only Studio’s own connections may name the program a CLI runs.'
const NO_CONTEXT: StudioRequestContext = { connectionId: '', slot: 0, ownWindow: false }

/** The codes a failure below the router is told in: each has one stable sentence. */
type StableCode =
  | Extract<StudioCommonErrorCode, 'unavailable' | 'invalid_params' | 'command_id_conflict' | 'busy'>
  | StudioRuntimeRefusalCode

/** A refusal with the code it names, so a handler's refusals are checked against its method's. */
type Refused<C extends StudioErrorCode> = { ok: false; error: StudioErrorBody & { code: C } }

/** How a request is answered: what its replies show, and in whose words a failure is told. */
type Voice = {
  redact<T>(value: T): T
  /** A failure whose code is known here; one with no stable sentence is told as `unavailable`. */
  failed<C extends StableCode>(code: C, detail: string | undefined, context: string): Refused<C | 'unavailable'>
  /** A failure in a code from below, which may be any: told as the stable code it is, else `unavailable`. */
  failedFrom(
    code: string | undefined,
    detail: string | undefined,
    context: string,
    retryAfterMs?: number,
  ): Refused<StableCode>
}

/**
 * What a client is told when the work below the router refused or failed: one
 * stable sentence per code. The runtime's and the launch's own words can name
 * paths, processes and other internals, so they go to the log and not to the
 * client; a code with no sentence here is answered as `unavailable`.
 */
const STABLE_MESSAGES: Readonly<Record<StableCode, string>> = {
  unavailable: 'Studio could not carry that out.',
  not_found: 'Studio has no such record for this conversation.',
  invalid_params: 'Studio could not read that request.',
  unsupported_model: "That model is not one this chat's agent offers here.",
  unknown_workspace: 'There is no workspace with that id here.',
  workspace_folder_missing: 'That workspace has no project folder.',
  no_cli_selected: 'No agent CLI was named, and none is chosen here.',
  cli_not_conversational: 'That agent CLI does not run as a chat here.',
  unknown_skill: 'A skill the request names is not installed here.',
  conversation_start_failed: 'The conversation could not be started.',
  worktree_unavailable: 'No worktree could be made or found for the chat here, so nothing was started.',
  unsupported_effort: "That effort is not one this chat's agent CLI offers here.",
  command_id_conflict: 'That command id was already used for a different command. Send this one under a new id.',
  // Another send to the chat is being prepared: the client tries again after
  // `retryAfterMs` (the SDK does so by itself), rather than failing for good.
  busy: 'Studio is busy with another message for this chat. Try again shortly.',
}

function stableCode(code: string | undefined): StableCode {
  return code !== undefined && Object.hasOwn(STABLE_MESSAGES, code) ? (code as StableCode) : 'unavailable'
}

/** The delay a `busy` refusal carries, when there is one to carry. */
const retryAfter = (code: string, retryAfterMs: number | undefined): { retryAfterMs?: number } =>
  code === 'busy' && retryAfterMs !== undefined ? { retryAfterMs } : {}

/** JSON with every object's keys in order, so two spellings of one command hash alike. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/**
 * What a command is, for its receipt: its method and its params (but its id),
 * hashed. Kept with the receipt, it tells a retry of the command from another
 * command sent under the same id, which is refused rather than answered with
 * the first one's result.
 */
export function studioCommandFingerprint(method: string, params: unknown): string {
  const { commandId: _id, ...rest } = (params ?? {}) as Record<string, unknown>
  return createHash('sha256')
    .update(`${method}\n${canonicalJson(rest)}`)
    .digest('base64url')
    .slice(0, 32)
}

// How many command ids' fingerprints the router keeps, across every way in.
const MAX_FINGERPRINTS = 4096

/** An opaque id for one refusal, logged beside its real cause. */
export function studioErrorId(): string {
  return randomBytes(6).toString('hex')
}

/** The receipt key a client's command id is held under. */
export function studioRuntimeCommandId(grant: StudioGrant, commandId: string): string {
  return grant.owner ? `owner:${commandId}` : `client:${grant.clientId}:${commandId}`
}

/** The strictest ceiling under which an app may answer a request for the rest of a conversation. */
const CONVERSATION_RULE_FLOOR = 'auto' as const
const MAX_REMEMBERED_STOPS = 1024
/** How long a keyed send's staged uploads are named by its command id: as long as the host keeps an upload. */
const STAGED_SEND_TTL_MS = 60 * 60_000

/**
 * The always-allow rules as a client that is not an owner reads them: each
 * rule's folder named by the project's name, never by its path, wherever the
 * rule spells it (its folder, a file rule's prefix, its label).
 */
function approvalRulesByProject(
  listed: Extract<StudioMethodResult<'conversation.approvalRules'>, { ok: true }>,
): Extract<StudioMethodResult<'conversation.approvalRules'>, { ok: true }> {
  return {
    ...listed,
    rules: listed.rules.map((rule) => {
      const project = rule.workspaceRoot.split(/[\\/]/u).filter(Boolean).at(-1) ?? ''
      const spellings = [rule.workspaceRoot, ...(rule.matcher.type === 'path' ? [rule.matcher.prefix] : [])]
        .filter((spelling) => spelling.length > 0)
        .sort((left, right) => right.length - left.length)
      const label = spellings.reduce((text, spelling) => text.split(spelling).join(project), rule.label)
      return {
        ...rule,
        workspaceRoot: project,
        matcher: rule.matcher.type === 'path' ? { type: 'path' as const, prefix: project } : rule.matcher,
        label,
      }
    }),
  }
}

/** How long a chat's export read for its first page is held for the pages after it, from its last read. */
const EXPORT_HELD_MS = 5 * 60_000
/**
 * How long an export is still held once the connection that last read it
 * closed: a client sends every unanswered request again on the connection it
 * reconnects with, so a dropped export's next page is asked for there. Past
 * this, nobody is coming back for it.
 */
const EXPORT_HELD_AFTER_CLOSE_MS = 60_000
/** The exports one client may have held at once; a newer one lets go of the oldest. */
const EXPORTS_HELD_PER_CLIENT = 2
/** About as much of an export as one page carries, measured as its JSON. */
const EXPORT_PAGE_CHARS = 4 * 1024 * 1024

function refuse<C extends StudioErrorCode>(code: C, message: string): Refused<C> {
  return { ok: false, error: { code, message } }
}

/** A discovery read's answer as the method's: its value, or its refusal in the protocol's words. */
function discovered<T>(
  answer: StudioDiscoveryAnswer<T>,
  voice: { redact<V>(value: V): V },
): { ok: true; result: T } | Refused<'not_found' | 'unavailable'> {
  return answer.ok ? { ok: true, result: voice.redact(answer.value) } : refuse(answer.code, answer.message)
}

/** A refusal from below whose code the protocol already names, carried as it is. */
function refused<C extends StudioErrorCode>(outcome: { code: C; message: string; retryAfterMs?: number }): Refused<C> {
  return {
    ok: false,
    error: {
      code: outcome.code,
      message: outcome.message,
      ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
    },
  }
}

// Commands that move a chat's work forward. The rest — interrupt, a denial, a
// rejected plan, a stricter preset, stop — only ever hold it back, so they are
// never refused for the chat's own preset.
function drivesChat(command: ConversationCommand): boolean {
  switch (command.kind) {
    case 'send':
    case 'answerQuestion':
    case 'setModel':
    // A message scheduled, or sent early, is a send all the same.
    case 'scheduleSend':
    case 'sendScheduledNow':
      return true
    case 'resolveApproval':
      return command.decision !== 'deny'
    case 'resolvePlan':
      return command.decision === 'approve'
    // A resume scheduled, or sent again, is a send of Studio's own.
    case 'usageLimitResume':
      return command.action === 'schedule' || command.action === 'retry'
    default:
      return false
  }
}

/** Who asked, and how they are answered: what every handler is given beside its params. */
type Asking = {
  grant: StudioGrant
  context: StudioRequestContext
  voice: Voice
  /** What a mutation was, kept with its receipt; absent for a read. */
  fingerprint: string | undefined
}

/** A conversation command's members, without the address the method carries them under. */
function members<P extends { key: StudioConversationKey; commandId: string }>(params: P): Omit<P, 'key' | 'commandId'> {
  const { key: _key, commandId: _commandId, ...rest } = params
  return rest
}

export function createStudioRpcRouter(options: StudioRpcRouterOptions): StudioRpcRouter {
  const { backend } = options
  // A refusal from below: logged in its own words under an opaque id, answered
  // in stable ones carrying that id, so a person can quote it and the log
  // still says what really happened.
  const clientFailure = <C extends StableCode>(
    code: C,
    detail: string | undefined,
    context: string,
    retryAfterMs?: number,
  ): Refused<C> => {
    const errorId = studioErrorId()
    options.log?.(`Studio RPC ${context} refused (${code}) [${errorId}]: ${detail || STABLE_MESSAGES[code]}`)
    return {
      ok: false,
      error: { code, message: STABLE_MESSAGES[code], errorId, ...retryAfter(code, retryAfterMs) },
    }
  }
  const clientVoice: Voice = {
    redact: (value) => backend.redact(value),
    failed: (code, detail, context) => clientFailure(code, detail, context),
    failedFrom: (code, detail, context, retryAfterMs) => clientFailure(stableCode(code), detail, context, retryAfterMs),
  }
  // Studio's own window hears what its IPC would have said, in the same words.
  const windowFailure = <C extends StableCode>(
    code: C,
    detail: string | undefined,
    retryAfterMs?: number,
  ): Refused<C> => ({
    ok: false,
    error: { code, message: detail || STABLE_MESSAGES[code], ...retryAfter(code, retryAfterMs) },
  })
  const windowVoice: Voice = {
    redact: (value) => value,
    failed: (code, detail) => windowFailure(code, detail),
    failedFrom: (code, detail, _context, retryAfterMs) => windowFailure(stableCode(code), detail, retryAfterMs),
  }
  const now = options.now ?? Date.now
  const uploads = options.uploads ?? createStudioUploads({ now })
  // Answers to the chat surface's conversation-level mutations, by namespaced
  // id, shared while pending so a retry racing the first attempt waits for it.
  const kept = new Map<string, Promise<{ ok: boolean; error?: StudioErrorBody }>>()
  // What each command id named, while this process runs: the receipts the
  // runtime keeps hold the same fingerprint for a session's commands across a
  // restart, and this covers the rest (a create, a revert, a fork, a stop).
  const fingerprints = new Map<string, string>()
  const stopsDone = new Set<string>()
  // A chat's export, read once for its first page and cut into the rest: by
  // client and export id, each with the time it was last read and the
  // connection that last read it; once that one closes, when it closed.
  const exportsHeld = new Map<
    string,
    { read: Extract<StudioChatExportRead, { ok: true }>; at: number; connectionId: string; closedAt?: number }
  >()
  const letGoOfStaleExports = (clock: number) => {
    for (const [id, kept] of exportsHeld)
      if (
        clock - kept.at > EXPORT_HELD_MS ||
        (kept.closedAt !== undefined && clock - kept.closedAt >= EXPORT_HELD_AFTER_CLOSE_MS)
      )
        exportsHeld.delete(id)
  }
  // The one sweep a close arms, so a dropped export is let go of though no
  // other export is asked for.
  let exportSweep: ReturnType<typeof setTimeout> | null = null
  const exportPage = (
    read: Extract<StudioChatExportRead, { ok: true }>,
    offset: number,
  ): StudioMethodResult<'conversation.exportPage'> => {
    // The events, then the pictures, as one run of items a page is cut from.
    const pictures = Object.entries(read.attachments)
    const total = read.events.length + pictures.length
    const events: ConversationEvent[] = []
    const attachments: Record<string, { mediaType: string; dataBase64: string }> = {}
    let at = offset
    let size = 0
    while (at < total) {
      const item = at < read.events.length ? read.events[at]! : pictures[at - read.events.length]!
      const itemSize = JSON.stringify(item).length
      // Every page carries at least one item, however big.
      if (at > offset && size + itemSize > EXPORT_PAGE_CHARS) break
      if (at < read.events.length) events.push(item as ConversationEvent)
      else {
        const [ref, picture] = item as [string, { mediaType: string; dataBase64: string }]
        attachments[ref] = picture
      }
      size += itemSize
      at++
    }
    return { chat: read.chat, events, attachments, nextOffset: at < total ? at : null }
  }
  // Creates still starting, by namespaced id: a retry that arrives while the
  // first attempt is launching shares it, so one id makes one chat.
  const creating = new Map<
    string,
    Promise<{ ok: true; conversation: StudioCreatedConversation } | { ok: false; code: string; message: string }>
  >()

  // A key's folder is an owner's to name: it is a path on this disk. Anyone
  // else's key is resolved by its workspace, as on the tailnet; `handle`
  // refuses a folder from anyone else before it gets here.
  function resolve(key: StudioConversationKey, grant: StudioGrant): ConversationKey | null {
    if (key.workspaceRoot !== undefined && grant.owner)
      return { workspaceRoot: key.workspaceRoot, workspaceId: key.workspaceId, agentId: key.agentId }
    return backend.resolveKey(key.workspaceId, key.agentId)
  }
  const noChat = (workspaceId: string) => refuse('not_found', `No chat in workspace "${workspaceId}" here.`)
  const notFound = (key: { workspaceId: string; agentId: string }) =>
    refuse('not_found', `No conversation "${key.agentId}" in workspace "${key.workspaceId}" here.`)

  function audit(
    grant: StudioGrant,
    method: StudioMethod,
    started: number,
    params: {
      key?: { workspaceId: string; agentId: string }
      commandId?: string
      workspaceId?: string
      toolset?: string
      moduleId?: string
      moduleMethod?: string
    },
    answer: StudioRpcAnswer,
    created?: { workspaceId: string; agentId: string },
  ): void {
    const target = created ?? params.key
    options.audit?.({
      clientId: grant.clientId,
      clientName: grant.name,
      tool: method,
      ...(target ? { workspaceId: target.workspaceId, agentId: target.agentId } : {}),
      ...(!target && params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      ...(params.commandId ? { commandId: params.commandId } : {}),
      ...(params.toolset ? { toolset: params.toolset } : {}),
      ...(params.moduleId ? { moduleId: params.moduleId } : {}),
      ...(params.moduleMethod ? { moduleMethod: params.moduleMethod } : {}),
      ok: answer.ok,
      ...(answer.ok ? {} : { code: answer.error.code }),
      durationMs: now() - started,
    })
  }

  type CommandRefused = Refused<StableCode | 'ceiling_exceeded'>

  /**
   * Carry out one conversation command, held to the client's ceiling: what it
   * was carried as, and the runtime's notice, or why it was refused.
   */
  async function command(
    asking: Asking,
    params: { key: StudioConversationKey; commandId: string },
    command: ConversationCommand,
  ): Promise<{ ok: true; carried: ConversationCommand; answer: StudioCommandAnswer } | CommandRefused> {
    const { grant, voice, fingerprint } = asking
    const key = resolve(params.key, grant)
    if (!key) return notFound(params.key)
    let carried = command
    if (command.kind === 'setPermissionPreset') {
      // Lowered, never refused: the answer names the preset in force. A mode
      // belongs to the preset it was asked with, so one lowered runs its own.
      const preset = clampPresetToCeiling(command.preset, grant.ceiling) ?? command.preset
      carried = {
        kind: 'setPermissionPreset',
        preset,
        ...(preset === command.preset && command.permissionMode ? { permissionMode: command.permissionMode } : {}),
      }
    } else if (
      command.kind === 'resolveApproval' &&
      (command.decision === 'conversation' || command.decision === 'always') &&
      isLooserCliPermissionPreset(CONVERSATION_RULE_FLOOR, grant.ceiling)
    ) {
      // Allowing a kind of request for the rest of the chat is an allow rule,
      // as loose for that kind as `auto` lets edits be, and one that outlives
      // the chat (`always`) is that and more: an app held below `auto`
      // answers one request at a time.
      return refuse(
        'ceiling_exceeded',
        `Allowing a request for the rest of the conversation needs a ceiling of "${CONVERSATION_RULE_FLOOR}" or looser; this app's is "${grant.ceiling}". Answer it "once" instead.`,
      )
    } else if (drivesChat(command)) {
      const running = backend.permissionOf(key)
      if (isLooserCliPermissionPreset(running, grant.ceiling))
        return refuse(
          'ceiling_exceeded',
          `This conversation runs on "${running}", looser than the "${grant.ceiling}" this app is allowed. Lower its preset first, or pair the app again with a looser ceiling.`,
        )
    }
    const outcome = await backend.command(
      key,
      grant.clientId,
      studioRuntimeCommandId(grant, params.commandId),
      carried,
      fingerprint,
    )
    if (!outcome.ok)
      return voice.failedFrom(outcome.code, outcome.message, `conversation.${carried.kind}`, outcome.retryAfterMs)
    return { ok: true, carried, answer: outcome.notice ? { notice: outcome.notice } : {} }
  }

  /** A command whose answer is the runtime's notice alone. */
  async function plainCommand(
    asking: Asking,
    params: { key: StudioConversationKey; commandId: string },
    carried: ConversationCommand,
  ): Promise<{ ok: true; result: StudioCommandAnswer } | CommandRefused> {
    const done = await command(asking, params, carried)
    return done.ok ? { ok: true, result: done.answer } : done
  }

  async function create(
    params: StudioMethodParams<'conversation.create'>,
    { grant, voice, context }: Asking,
  ): Promise<StudioRpcAnswer<'conversation.create'>> {
    const { commandId, ...request } = params
    if (request.allowedTools?.length && !ceilingAllowsUnaskedTools(grant.ceiling))
      return refuse(
        'ceiling_exceeded',
        'Letting a chat use tools without asking needs a "bypass" ceiling, which this app was not given.',
      )
    const permissionPreset = clampPresetToCeiling(request.permissionPreset, grant.ceiling)
    const capped = {
      ...request,
      permissionPreset,
      // A mode rides only beside the preset it was asked with.
      permissionMode:
        permissionPreset && permissionPreset === request.permissionPreset ? request.permissionMode : undefined,
    }
    if (!capped.permissionPreset) delete capped.permissionPreset
    if (!capped.permissionMode) delete capped.permissionMode
    const launchCommandId = studioRuntimeCommandId(grant, commandId)
    const found = backend.findCreated(launchCommandId)
    if (found) return { ok: true, result: { conversation: found } }
    let pending = creating.get(launchCommandId)
    if (!pending) {
      pending = backend.create(capped, launchCommandId).catch((error: unknown) => ({
        ok: false as const,
        code: 'conversation_start_failed',
        message: error instanceof Error ? error.message : String(error),
      }))
      creating.set(launchCommandId, pending)
      const settled = pending
      void settled.then(() => {
        if (creating.get(launchCommandId) === settled) creating.delete(launchCommandId)
      })
    }
    const created = await pending
    if (created.ok && context.connectionId)
      // The process that started it is where its calls go first (routing, 6.2).
      options.tools?.noteStarted(context.connectionId, created.conversation)
    return created.ok
      ? { ok: true, result: { conversation: created.conversation } }
      : voice.failedFrom(created.code, created.message, 'conversation.create')
  }

  /**
   * The first answer to a namespaced id, for every retry of it; new work
   * otherwise. The id names its method (`keptId`), so what is kept under it
   * is that method's answer.
   */
  function once<A extends { ok: boolean; error?: StudioErrorBody }>(
    id: string,
    work: () => Promise<A>,
    voice: Voice,
    method: string,
    /** Whether a settled answer may be tried again under its id: by default, work that could not be carried out at all. */
    retryable: (settled: A | Refused<'unavailable'>) => boolean = (settled) =>
      !settled.ok && settled.error?.code === 'unavailable',
  ): Promise<A | Refused<'unavailable'>> {
    const known = kept.get(id) as Promise<A | Refused<'unavailable'>> | undefined
    if (known) {
      kept.delete(id)
      kept.set(id, known)
      return known
    }
    const answer = work().catch((error: unknown): Refused<'unavailable'> =>
      voice.failed('unavailable', error instanceof Error ? error.message : String(error), method),
    )
    kept.set(id, answer)
    while (kept.size > MAX_KEPT_ANSWERS) kept.delete(kept.keys().next().value!)
    // Work that could not be carried out at all may be tried again under its id.
    void answer.then((settled) => {
      if (retryable(settled) && kept.get(id) === answer) kept.delete(id)
    })
    return answer
  }

  const updates = options.updates ?? externalStudioUpdates('manual', MANUAL_UPDATE_WORDS)
  const updateStatus = () => {
    const info = options.info()
    return studioUpdateStatus(updates, {
      version: info.server.version,
      protocolVersion: info.protocolVersion,
      minProtocolVersion: info.minProtocolVersion,
    })
  }
  const unserved = (method: StudioMethod) => refuse('unavailable', `This Studio does not serve ${method}.`)
  /** Whether a request may name a folder: any, for an owner's own connection; otherwise one Studio knows. */
  const mayName = async (path: string, asking: PathAsker): Promise<boolean> => {
    if (namesAnyPath(asking)) return true
    const chat = options.chat?.()
    return chat ? folderAllowed(chat, asking, path) : false
  }
  const caller = (context: StudioRequestContext): StudioTerminalCaller => ({
    connectionId: context.connectionId,
    ...(context.windowKey === undefined ? {} : { windowKey: context.windowKey }),
  })
  // A terminal call: answered `unavailable` where this Studio holds no terminal runtime.
  function terminal<M extends StudioMethod, R>(
    method: M,
    work: (terminals: StudioTerminals) => R | Promise<R>,
  ): Promise<{ ok: true; result: R } | Refused<'unavailable'>> | Refused<'unavailable'> {
    const terminals = options.terminals
    if (!terminals) return unserved(method)
    return Promise.resolve(work(terminals)).then((result) => ({ ok: true as const, result }))
  }
  /**
   * A module method's call, as the hub answers it. A refusal before the module
   * heard the call (not running here, no such method, params it refused) is
   * the protocol's; the module's own answer is the result, its refusals included.
   */
  async function moduleCall(
    method: 'module.read' | 'module.operate',
    params: { moduleId: string; method: string; params?: unknown },
    grant: StudioGrant,
    commandId: string | undefined,
  ): Promise<StudioRpcAnswer<'module.read'> | Refused<'unavailable'>> {
    const modules = options.modules
    if (!modules) return unserved(method)
    const outcome: StudioModuleCallOutcome = await modules.call({
      moduleId: params.moduleId,
      method: params.method,
      access: method === 'module.operate' ? 'operate' : 'read',
      params: params.params,
      clientId: grant.clientId,
      ...(commandId === undefined ? {} : { commandId }),
    })
    return outcome.ok ? { ok: true, result: outcome.answer } : refuse(outcome.code, outcome.message)
  }
  // An operate that never reached the module's handler may be tried again under its id.
  const moduleRefusedBefore = (settled: { ok: boolean; error?: StudioErrorBody }) =>
    !settled.ok &&
    ['unavailable', 'module_unavailable', 'module_method_unknown', 'invalid_params'].includes(settled.error?.code ?? '')
  // As `moduleRefusedBefore`, for a module's own method: `unavailable` there is
  // a handler that threw (or answered what no client can read), after it may
  // have sent to a chat, so only a Studio with no modules at all is tried again.
  const operateRefusedBefore = (settled: { ok: boolean; error?: StudioErrorBody }) =>
    moduleRefusedBefore(settled) && (settled.error?.code !== 'unavailable' || !options.modules)
  /**
   * A call into one of the host's services a module's window half reaches,
   * under the calling module's id: `module_unavailable` for a module not
   * running here; the service's own answer otherwise, a service this Studio
   * does not provide answered in its own vocabulary.
   */
  function moduleService<K extends keyof ModuleHostServices, A extends { ok: boolean }>(
    method: StudioMethod,
    moduleId: string,
    service: K,
    missing: A,
    work: (served: NonNullable<ModuleHostServices[K]>) => Promise<A>,
  ): Promise<{ ok: true; result: A } | Refused<'unavailable' | 'module_unavailable'>> | Refused<'unavailable'> {
    const modules = options.modules
    if (!modules) return unserved(method)
    const found = modules.hostServices(moduleId)
    if (!found.ok) return Promise.resolve(refuse(found.code, found.message))
    const served = found.services[service]
    if (!served) return Promise.resolve({ ok: true as const, result: missing })
    return work(served as NonNullable<ModuleHostServices[K]>).then((result) => ({ ok: true as const, result }))
  }
  const BACKLOG_MISSING = {
    ok: false,
    code: 'backlog_unavailable',
    message: 'This Studio has no Backlog service for modules.',
  } as const
  const USAGE_MISSING = {
    ok: false,
    code: 'unavailable',
    message: 'This Studio has no usage service for modules.',
  } as const
  /** A Backlog write, carried out once under its id: a retry is answered with the first answer. */
  function backlogWrite<M extends StudioMethod, T extends object>(
    method: M,
    params: { moduleId: string; commandId: string },
    context: Asking,
    work: (backlog: NonNullable<ModuleHostServices['backlog']>) => Promise<StudioModuleBacklogAnswer<T>>,
  ) {
    return once(
      keptId(method, context.grant, params.commandId),
      () => Promise.resolve(moduleService(method, params.moduleId, 'backlog', BACKLOG_MISSING, work)),
      context.voice,
      method,
      moduleRefusedBefore,
    )
  }
  /** A change to what runs here, carried out once under its id by the modules' lifecycle. */
  function lifecycleCommand<
    M extends
      | 'module.setEnabled'
      | 'module.install'
      | 'module.setTrust'
      | 'module.uninstall'
      | 'module.setAppState'
      | 'module.reportRegistry',
    R,
  >(method: M, context: Asking, commandId: string, work: (lifecycle: ModuleLifecycle) => Promise<R>) {
    const modules = options.modules
    if (!modules) return unserved(method)
    return once(
      keptId(method, context.grant, commandId),
      async (): Promise<{ ok: true; result: R } | Refused<'unavailable'>> => {
        const lifecycle = modules.lifecycle()
        if (!lifecycle) return refuse('unavailable', 'This Studio’s modules have not loaded yet.')
        return { ok: true, result: await work(lifecycle) }
      },
      context.voice,
      method,
    )
  }
  const UNKNOWN_FOLDER = 'That folder is not one Studio knows.'

  /** The chat surface, or why this Studio does not serve one now. */
  function chatOr(method: StudioMethod): StudioChatBackend | Refused<'unavailable'> {
    return options.chat?.() ?? unserved(method)
  }
  const isRefusal = (value: StudioChatBackend | Refused<'unavailable'>): value is Refused<'unavailable'> =>
    'ok' in value && value.ok === false

  /**
   * A chat-surface mutation the runtime keeps no receipt for, carried out
   * once under its id: a repeat is answered with the first answer.
   */
  function sessionOnce<M extends StudioChatMethod, R>(
    method: M,
    grant: StudioGrant,
    commandId: string,
    voice: Voice,
    work: (chat: StudioChatBackend) => Promise<R>,
  ): Promise<{ ok: true; result: R } | Refused<'unavailable'>> | Refused<'unavailable'> {
    const chat = chatOr(method)
    if (isRefusal(chat)) return chat
    return once(
      keptId(method, grant, commandId),
      async () => ({ ok: true as const, result: voice.redact(await work(chat)) }),
      voice,
      method,
    )
  }

  /**
   * The folder of a workspace's history: the one an owner names, else the
   * workspace's own, as this Studio resolves a chat's key by its workspace.
   */
  function historyRoot(workspaceId: string, workspaceRoot: string | undefined, grant: StudioGrant): string | null {
    if (workspaceRoot !== undefined && grant.owner) return workspaceRoot
    return backend.resolveKey(workspaceId, 'history')?.workspaceRoot ?? null
  }

  /** A runtime id under the client's namespace, and the kept-answer id of one method's mutation. */
  const runtimeId = (grant: StudioGrant, id: string) => studioRuntimeCommandId(grant, id)
  // The files on this machine by path, every server's: the router's one rule
  // for them is who may name which path (`studio-file-system.ts`).
  const fileSystem = createStudioFileSystemHandlers({
    ...(options.fileSystem ? { fileSystem: options.fileSystem } : {}),
    once: (id, work, voice, method) => once(id, work, voice as Voice, method),
    runtimeId,
  })
  const gitRouting = createStudioGitHandlers({
    ...(options.git ? { git: options.git } : {}),
    ...(options.fileSystem ? { fileSystem: options.fileSystem } : {}),
    once: (id, work, voice, method) => once(id, work, voice as Voice, method),
    runtimeId,
  })
  const worktreesHandlers = createStudioWorktreesHandlers({
    ...(options.worktrees ? { worktrees: options.worktrees } : {}),
    once: (id, work, voice, method) => once(id, work, voice as Voice, method),
    runtimeId,
  })
  const keptId = (method: StudioMethod, grant: StudioGrant, id: string) => `${method}:${runtimeId(grant, id)}`
  /** A step of a sign-in, answered once per command id: a retried start is the same login, not a second. */
  const signInOnce = <R>(
    method: 'providers.signInStart' | 'providers.signInPaste' | 'providers.signInWait' | 'providers.signInCancel',
    grant: StudioGrant,
    commandId: string,
    voice: Voice,
    step: (table: SignIns) => Promise<R>,
  ) => {
    const signIns = options.signIns
    if (!signIns) return unserved(method)
    return once(
      keptId(method, grant, commandId),
      async () => ({ ok: true as const, result: await step(await signIns()) }),
      voice,
      method,
    )
  }
  const extensionsRouting = createStudioExtensionsHandlers({
    ...(options.extensions ? { extensions: options.extensions } : {}),
    once: (id, work, voice, method) => once(id, work, voice as Voice, method),
    runtimeId,
    mayName,
  })
  const artifactsRouting = createStudioArtifactsHandlers({
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    once: (id, work, voice, method) => once(id, work, voice as Voice, method),
    runtimeId,
  })
  const accessRouting = createStudioAccessHandlers({
    ...(options.access ? { access: options.access } : {}),
    once: (id, work, voice, method) => once(id, work, voice as Voice, method),
    runtimeId,
  })
  const webDevicesRouting = createStudioWebDevicesHandlers({
    webDevices: () => options.webDevices?.() ?? null,
    once: (id, work, voice, method) => once(id, work, voice as Voice, method),
    runtimeId,
  })
  const tailnetRouting = createStudioTailnetHandlers({
    ...(options.tailnet ? { tailnet: options.tailnet } : {}),
    once: (id, work, voice, method) => once(id, work, voice as Voice, method),
    runtimeId,
  })
  // A session command's receipt keeps what it was, across a restart too.
  const stamp = (fingerprint: string | undefined) => (fingerprint ? { commandFingerprint: fingerprint } : {})
  // An upload is the client's; its budget is this connection's. Staging needs
  // no chat: a board too large for one frame is staged the same way.
  const holder = ({ grant, context }: Asking) => ({ client: grant.clientId, connection: context.connectionId })

  // A chat the core does not know is not found; any other refusal (no
  // checkout of it here) is the caller's to say.
  const refusedChat = (refusal: ChatPullRequestRefusal, voice: Voice, method: StudioMethod) =>
    refusal.refused.code === 'unknown_workspace' || refusal.refused.code === 'unknown_conversation'
      ? voice.failed('not_found', refusal.refused.message, method)
      : null

  // ── Every method's handler ──────────────────────────────────────────────

  const followed = backend.followed ?? {}

  /**
   * A key for what reads or runs in the chat's folder, resolved as `resolve`
   * does, and a folder an owner names held to the ones Studio knows on a
   * connection that is (a browser on the tailnet): a search or a command
   * list there must not reach a folder by naming it.
   */
  async function resolveInFolder(wire: StudioConversationKey, asking: Asking): Promise<ConversationKey | null> {
    if (wire.workspaceRoot !== undefined && !namesAnyPath(asking)) {
      const chat = options.chat?.() ?? null
      if (!chat || !(await folderAllowed(chat, asking, wire.workspaceRoot))) return null
    }
    return resolve(wire, asking.grant)
  }
  const ids = (key: ConversationKey) => ({ workspaceId: key.workspaceId, agentId: key.agentId })

  /** A composer read as an answer: the chat gone is `not_found`, anything else `unavailable`. */
  function composerAnswer<T>(
    read: StudioComposerRead<T>,
    wire: StudioConversationKey,
    voice: Voice,
    method: StudioMethod,
  ): { ok: true; result: T } | Refused<'not_found' | 'unavailable'> {
    if (read.ok) return { ok: true, result: voice.redact(read.answer) }
    return read.code === 'unknown_conversation' ? notFound(wire) : voice.failed('unavailable', read.message, method)
  }

  /** A changes read refused: a step or file the chat's changes do not hold is `not_found`, in its own words. */
  function changesRefusal(
    read: { code?: 'not_found'; message: string },
    voice: Voice,
    method: StudioMethod,
  ): Refused<'not_found' | 'unavailable'> {
    return read.code === 'not_found'
      ? refuse('not_found', read.message)
      : voice.failed('unavailable', read.message, method)
  }

  /**
   * A settle refused: no such chat is `not_found`; an agent at work in it is
   * `conflict`, in the record's own words, which name nothing on this disk;
   * anything else `unavailable`.
   */
  function settleRefusal(
    done: { code: string; message: string },
    workspaceId: string,
    voice: Voice,
    method: StudioMethod,
  ): Refused<'not_found' | 'conflict' | 'unavailable'> {
    if (done.code === 'unknown_workspace') return noChat(workspaceId)
    if (done.code === 'working') return refuse('conflict', done.message)
    return voice.failed('unavailable', done.message, method)
  }

  // A keyed send's pictures and files, made the chat's once per command:
  // spent from this client's uploads and handed to the conversation host,
  // whose ids the send then names. A retry of the send under the same id
  // (after a dropped connection, or a `busy` it waited out) names the same
  // ids again, so the host answers it as the same send, and the uploads it
  // spent are not asked for twice. Kept as long as an upload is.
  const stagedSends = new Map<string, { ids: string[]; at: number }>()
  // A retry that arrives while the first is still staging (a phone that sent
  // again after its socket dropped, mid-upload) waits for that staging rather
  // than staging the same uploads a second time under other host ids.
  const stagingSends = new Map<string, Promise<StagedSend>>()
  type StagedSend =
    { ok: true; ids: string[] } | Refused<'not_found' | 'invalid_params' | 'too_large' | 'busy' | 'unavailable'>
  async function stagedFor(
    params: { key: StudioConversationKey; commandId: string },
    uploadIds: string[],
    asking: Asking,
  ): Promise<StagedSend> {
    const stage = followed.stageUploads
    if (!stage) return refuse('unavailable', 'This Studio does not take pictures or files on a send.')
    const { grant } = asking
    const at = now()
    for (const [id, kept] of stagedSends) if (at - kept.at > STAGED_SEND_TTL_MS) stagedSends.delete(id)
    const sendId = `${grant.clientId}\n${params.commandId}`
    const kept = stagedSends.get(sendId)
    if (kept) return { ok: true, ids: kept.ids }
    const staging = stagingSends.get(sendId)
    if (staging) return staging
    const made = stageSend(stage, params, uploadIds, grant, sendId, at)
    stagingSends.set(sendId, made)
    try {
      return await made
    } finally {
      if (stagingSends.get(sendId) === made) stagingSends.delete(sendId)
    }
  }
  async function stageSend(
    stage: NonNullable<typeof followed.stageUploads>,
    params: { key: StudioConversationKey; commandId: string },
    uploadIds: string[],
    grant: StudioGrant,
    sendId: string,
    at: number,
  ): Promise<StagedSend> {
    const key = resolve(params.key, grant)
    if (!key) return notFound(params.key)
    const spent = uploads.spend(grant.clientId, uploadIds, sendId, ['picture', 'attachment'])
    if (!spent.ok) return refused(spent)
    const made = await stage(
      key,
      grant.clientId,
      spent.pictures.map((upload) => ({
        purpose: upload.purpose === 'attachment' ? 'attachment' : 'picture',
        mediaType: upload.mediaType,
        ...(upload.name === undefined ? {} : { name: upload.name }),
        bytes: upload.bytes,
      })),
    ).catch((error: unknown) => ({
      ok: false as const,
      code: 'invalid_params' as const,
      message: error instanceof Error ? error.message : String(error),
    }))
    // The host holds the bytes now, or nothing was made of them and the
    // uploads are this client's to send again.
    uploads.settle(grant.clientId, sendId, made.ok)
    if (!made.ok) return made.code === 'not_found' ? notFound(params.key) : refuse('invalid_params', made.message)
    stagedSends.set(sendId, { ids: made.ids, at })
    return { ok: true, ids: made.ids }
  }

  const handlers: StudioHandlers<Asking> = {
    'server.info': (_params, { grant }) => ({ ok: true, result: { ...options.info(), grant } }),
    'server.ping': () => ({ ok: true, result: { at: now() } }),
    'conversation.list': async () => ({ ok: true, result: { conversations: await backend.list() } }),
    'conversation.create': create,

    // The conversation lane's commands, each carried as its own kind.
    'conversation.send': async (p, asking) => {
      const { uploadIds, ...words } = members(p)
      if (!uploadIds?.length) return plainCommand(asking, p, { kind: 'send', ...words })
      const staged = await stagedFor(p, uploadIds, asking)
      if (!staged.ok) return staged
      return plainCommand(asking, p, { kind: 'send', ...words, uploadIds: staged.ids })
    },
    'conversation.interrupt': (p, asking) => plainCommand(asking, p, { kind: 'interrupt' }),
    'conversation.resolveApproval': (p, asking) => plainCommand(asking, p, { kind: 'resolveApproval', ...members(p) }),
    'conversation.answerQuestion': (p, asking) => plainCommand(asking, p, { kind: 'answerQuestion', ...members(p) }),
    'conversation.resolvePlan': (p, asking) => plainCommand(asking, p, { kind: 'resolvePlan', ...members(p) }),
    'conversation.setPermissionPreset': async (p, asking) => {
      const { voice } = asking
      const done = await command(asking, p, { kind: 'setPermissionPreset', ...members(p) })
      if (!done.ok) return done
      const carried = done.carried
      // Carried as the preset it was lowered to, never as another kind.
      if (carried.kind !== 'setPermissionPreset')
        return voice.failed(
          'unavailable',
          'A preset change was carried as another command.',
          'conversation.setPermissionPreset',
        )
      return {
        ok: true,
        result: {
          permissionPreset: carried.preset,
          ...(carried.permissionMode ? { permissionMode: carried.permissionMode } : {}),
          ...done.answer,
        },
      }
    },
    'conversation.setModel': async (p, asking) => {
      const done = await command(asking, p, { kind: 'setModel', ...members(p) })
      return done.ok ? { ok: true, result: { modelId: p.modelId, ...done.answer } } : done
    },
    'conversation.cancelQueued': (p, asking) => plainCommand(asking, p, { kind: 'cancelQueued', ...members(p) }),
    'conversation.stopSubagent': (p, asking) => plainCommand(asking, p, { kind: 'stopSubagent', ...members(p) }),
    'conversation.messageSubagent': (p, asking) => plainCommand(asking, p, { kind: 'messageSubagent', ...members(p) }),
    'conversation.setReasoningEffort': (p, asking) =>
      plainCommand(asking, p, { kind: 'setReasoningEffort', ...members(p) }),
    'conversation.mcpServerAction': (p, asking) => plainCommand(asking, p, { kind: 'mcpServerAction', ...members(p) }),
    'conversation.restartSession': (p, asking) => plainCommand(asking, p, { kind: 'restartSession' }),
    'conversation.scheduleSend': (p, asking) => plainCommand(asking, p, { kind: 'scheduleSend', ...members(p) }),
    'conversation.sendScheduledNow': (p, asking) =>
      plainCommand(asking, p, { kind: 'sendScheduledNow', ...members(p) }),
    'conversation.cancelScheduled': (p, asking) => plainCommand(asking, p, { kind: 'cancelScheduled', ...members(p) }),
    'conversation.usageLimitResume': (p, asking) =>
      plainCommand(asking, p, { kind: 'usageLimitResume', ...members(p) }),

    'conversation.stop': async ({ key: wire, commandId }, { grant, voice, fingerprint }) => {
      const key = resolve(wire, grant)
      if (!key) return notFound(wire)
      const id = runtimeId(grant, commandId)
      // A stop with no session to stop leaves no receipt in the runtime, so
      // it is remembered here: a resend of it never stops a later session.
      if (stopsDone.has(id)) return { ok: true, result: {} }
      const stopped = await backend.stop(key, id, fingerprint)
      if (stopped.ok) {
        stopsDone.add(id)
        while (stopsDone.size > MAX_REMEMBERED_STOPS) stopsDone.delete(stopsDone.values().next().value!)
        return { ok: true, result: {} }
      }
      return voice.failed(
        stopped.code === 'command_id_conflict' ? 'command_id_conflict' : 'unavailable',
        stopped.message,
        'conversation.stop',
      )
    },
    'conversation.loadEarlier': async ({ key: wire, beforeCursor, turnLimit }, { grant, voice }) => {
      const key = resolve(wire, grant)
      if (!key) return notFound(wire)
      const read = await backend.loadEarlier(key, beforeCursor, turnLimit)
      if (!read.ok) return voice.failed('unavailable', read.message, 'conversation.loadEarlier')
      const { page } = boundConversationPage(read.page)
      return { ok: true, result: { page: { ...page, events: page.events.map((event) => voice.redact(event)) } } }
    },
    'conversation.toolDetail': async ({ key: wire, toolUseId }, { grant, voice }) => {
      const key = resolve(wire, grant)
      if (!key) return notFound(wire)
      const read = await backend.toolDetail(key, toolUseId)
      if (read.ok) return { ok: true, result: { detail: voice.redact(read.detail) } }
      return voice.failed(
        read.code === 'not_found' ? 'not_found' : read.code === 'invalid_input' ? 'invalid_params' : 'unavailable',
        read.message,
        'conversation.toolDetail',
      )
    },
    'conversation.event': async ({ key: wire, seq, id }, { grant, voice }) => {
      const key = resolve(wire, grant)
      if (!key) return notFound(wire)
      const read = await backend.event(key, seq, id)
      if (read.ok) return { ok: true, result: { event: voice.redact(read.event) } }
      return voice.failed(
        read.code === 'not_found' ? 'not_found' : read.code === 'invalid_input' ? 'invalid_params' : 'unavailable',
        read.message,
        'conversation.event',
      )
    },
    'conversation.turnDiff': async ({ key: wire, turnSeq, path }, { grant, voice }) => {
      const key = resolve(wire, grant)
      if (!key) return notFound(wire)
      const read = await backend.turnDiff(key, turnSeq, path)
      if (!read.ok) return voice.failed('unavailable', read.message, 'conversation.turnDiff')
      const { ok: _ok, ...diff } = read
      return { ok: true, result: voice.redact(diff) }
    },

    // ── Beside a followed chat, by its key (`followed.ts`) ─────────────────
    // The conversation host's own, as the tailnet lane serves them.

    'conversation.askSideQuestion': async ({ key: wire, commandId, questionId, question, history }, asking) => {
      const { grant, voice } = asking
      const ask = followed.askSideQuestion
      if (!ask) return unserved('conversation.askSideQuestion')
      const key = await resolveInFolder(wire, asking)
      if (!key) return notFound(wire)
      return once(
        keptId('conversation.askSideQuestion', grant, commandId),
        async () => ({
          ok: true as const,
          result: voice.redact(await ask(key, grant.clientId, questionId, question, history ?? [])),
        }),
        voice,
        'conversation.askSideQuestion',
      )
    },
    'conversation.cancelSideQuestion': async ({ questionId }, { grant, voice }) => {
      const cancel = followed.cancelSideQuestion
      if (!cancel) return unserved('conversation.cancelSideQuestion')
      // Under this client's own id: another client's question is passed over.
      return { ok: true, result: voice.redact(await cancel(grant.clientId, questionId)) }
    },
    'conversation.picture': async ({ key: wire, ...which }, asking) => {
      const read = followed.picture
      if (!read) return unserved('conversation.picture')
      const key = resolve(wire, asking.grant)
      if (!key) return notFound(wire)
      const picture = await read(
        key,
        which.toolUseId !== undefined ? { toolUseId: which.toolUseId } : { attachment: which.attachment! },
      )
      if (!picture.ok) return refuse(picture.code, picture.message)
      return { ok: true, result: { mediaType: picture.mediaType, dataBase64: picture.bytes.toString('base64') } }
    },
    'conversation.contextBreakdown': async ({ key: wire }, asking) => {
      const read = followed.contextBreakdown
      if (!read) return unserved('conversation.contextBreakdown')
      const key = await resolveInFolder(wire, asking)
      if (!key) return notFound(wire)
      return { ok: true, result: asking.voice.redact(await read(key)) }
    },
    'conversation.searchFiles': async ({ key: wire, query, limit }, asking) => {
      const { grant, voice } = asking
      const search = followed.searchFiles
      if (!search) return unserved('conversation.searchFiles')
      const key = await resolveInFolder(wire, asking)
      if (!key) return notFound(wire)
      // An empty query matches nothing, as the composer's own picker asks none.
      if (!query) return { ok: true, result: { entries: [], truncated: false } }
      return composerAnswer(await search(key, grant.clientId, query, limit), wire, voice, 'conversation.searchFiles')
    },
    'conversation.listCommands': async ({ key: wire, refresh }, asking) => {
      const { grant, voice } = asking
      const list = followed.listCommands
      if (!list) return unserved('conversation.listCommands')
      // Asking the CLI again starts it: for a client that may operate the
      // chat, as the lane's refresh was.
      if (refresh && !studioGrantPrincipal(grant).permissions.has('conversation:operate'))
        return refuse('scope_required', 'This app\'s grant does not include "conversation:operate".')
      const key = await resolveInFolder(wire, asking)
      if (!key) return notFound(wire)
      return composerAnswer(await list(key, refresh === true), wire, voice, 'conversation.listCommands')
    },
    'conversation.settle': async ({ workspaceId, commandId, settled }, { grant, voice }) => {
      const settle = followed.settle
      if (!settle) return unserved('conversation.settle')
      // A retry under its command id is answered with the first answer, not
      // written again over an un-settle that came in between.
      return once(
        keptId('conversation.settle', grant, commandId),
        async () => {
          const done = settle(workspaceId, settled !== false, grant.owner)
          if (done.ok) return { ok: true as const, result: { settledAt: done.settledAt } }
          return settleRefusal(done, workspaceId, voice, 'conversation.settle')
        },
        voice,
        'conversation.settle',
      )
    },
    'conversation.visit': async ({ workspaceId, visitedAt }, { grant, voice }) => {
      const visit = followed.visit
      if (!visit) return unserved('conversation.visit')
      const done = visit(workspaceId, visitedAt, grant.owner)
      if (done.ok) return { ok: true, result: { lastVisitedAt: done.lastVisitedAt } }
      return done.code === 'unknown_workspace'
        ? noChat(workspaceId)
        : voice.failed('unavailable', done.message, 'conversation.visit')
    },
    'conversation.changesDiff': async ({ key: wire, selection }, { grant, voice }) => {
      const read = followed.changesDiff
      if (!read) return unserved('conversation.changesDiff')
      const key = resolve(wire, grant)
      if (!key) return notFound(wire)
      const answer = await read(ids(key), selection)
      if (!answer.ok) return changesRefusal(answer, voice, 'conversation.changesDiff')
      const { ok: _ok, ...diff } = answer
      return { ok: true, result: voice.redact(diff) }
    },
    'conversation.changedFile': async ({ key: wire, selection, path }, { grant, voice }) => {
      const read = followed.changedFile
      if (!read) return unserved('conversation.changedFile')
      const key = resolve(wire, grant)
      if (!key) return notFound(wire)
      const answer = await read(ids(key), selection, path)
      if (!answer.ok) return changesRefusal(answer, voice, 'conversation.changedFile')
      const { ok: _ok, ...sides } = answer
      return { ok: true, result: voice.redact(sides) }
    },

    // ── The chat surface ───────────────────────────────────────────────────

    'session.start': (params, { grant, voice }) => {
      const chat = chatOr('session.start')
      if (isRefusal(chat)) return chat
      const { commandId, ...input } = params
      // What a CLI override names is checked where the backend checks the
      // rest of the start, by the rules its IPC applies.
      return once(
        keptId('session.start', grant, commandId),
        async () => ({ ok: true as const, result: voice.redact(await chat.startSession(input)) }),
        voice,
        'session.start',
      )
    },
    'session.send': async (params, asking) => {
      const chat = chatOr('session.send')
      if (isRefusal(chat)) return chat
      const { grant, voice, fingerprint } = asking
      const { commandId, attachments, ...input } = params
      // A file attached or mentioned by path is read by the agent: a client
      // that is not an owner names only what is inside the folders Studio
      // knows (a mention relative to the chat's folder stays inside it).
      for (const path of [
        ...(input.files ?? []).map((file) => file.path),
        ...(input.mentions ?? []).map((mention) => mention.path),
      ])
        if (!(await pathAllowed(chat, asking, path))) return refuse('not_found', UNKNOWN_FOLDER)
      const id = runtimeId(grant, commandId)
      let pictures: ConversationImageAttachment[] | undefined
      // A repeat of a send the runtime holds a receipt for is answered from
      // it, so it needs none of the pictures the first attempt carried,
      // which may be long gone: it must not be refused for them, or the
      // client sends the message again under a new id.
      const answered = attachments?.length && (await chat.hasReceipt({ sessionId: input.sessionId, commandId: id }))
      if (attachments?.length && !answered) {
        const spent = uploads.spend(
          grant.clientId,
          attachments.map((attachment) => attachment.uploadId),
          id,
        )
        if (!spent.ok) return refused(spent)
        pictures = attachments.map((attachment, index) => {
          const picture = spent.pictures[index]
          const name = attachment.name ?? picture.name
          return {
            id: attachment.id,
            mediaType: picture.mediaType,
            dataBase64: picture.bytes.toString('base64'),
            byteLength: picture.bytes.length,
            ...(name === undefined ? {} : { name }),
          }
        })
      }
      const sent = await chat
        .sendTurn({
          ...input,
          // What each mention names is checked by the backend, by the rules its IPC applies.
          ...(pictures ? { attachments: pictures } : {}),
          commandId: id,
          ...stamp(fingerprint),
        })
        .finally(async () => {
          // Recorded, its receipt answers every repeat and the bytes can go;
          // not recorded, nothing ran, and a retry may carry them again.
          if (!pictures) return
          const recorded = await chat.hasReceipt({ sessionId: input.sessionId, commandId: id }).catch(() => false)
          uploads.settle(grant.clientId, id, recorded)
        })
      return { ok: true, result: voice.redact(sent) }
    },
    'session.interrupt': async ({ commandId, ...input }, { grant, voice, fingerprint }) => {
      const chat = chatOr('session.interrupt')
      if (isRefusal(chat)) return chat
      const sent = await chat.interrupt({ ...input, commandId: runtimeId(grant, commandId), ...stamp(fingerprint) })
      return { ok: true, result: voice.redact(sent) }
    },
    'session.respond': async ({ commandId, ...input }, { grant, voice, fingerprint }) => {
      const chat = chatOr('session.respond')
      if (isRefusal(chat)) return chat
      const sent = await chat.respond({ ...input, commandId: runtimeId(grant, commandId), ...stamp(fingerprint) })
      return { ok: true, result: voice.redact(sent) }
    },
    'session.setPermission': async ({ commandId, ...input }, { grant, voice, fingerprint }) => {
      const chat = chatOr('session.setPermission')
      if (isRefusal(chat)) return chat
      const sent = await chat.setPermission({ ...input, commandId: runtimeId(grant, commandId), ...stamp(fingerprint) })
      return { ok: true, result: voice.redact(sent) }
    },
    'session.setModel': async ({ commandId, ...input }, { grant, voice, fingerprint }) => {
      const chat = chatOr('session.setModel')
      if (isRefusal(chat)) return chat
      const sent = await chat.setModel({ ...input, commandId: runtimeId(grant, commandId), ...stamp(fingerprint) })
      return { ok: true, result: voice.redact(sent) }
    },
    'uploads.begin': (input, asking) => {
      // A file's bytes are only ever spent by `files.write`: staged only by a
      // client that may write one.
      if (input.purpose === 'file' && !studioGrantAllows(asking.grant, 'files.write'))
        return refuse('scope_required', 'This app’s grant does not include "files:write".')
      const begun = uploads.begin(holder(asking), input)
      return begun.ok
        ? { ok: true, result: { uploadId: begun.uploadId, chunkBytes: begun.chunkBytes } }
        : refused(begun)
    },
    'uploads.append': (input, asking) => {
      const appended = uploads.append(holder(asking), input)
      return appended.ok ? { ok: true, result: { received: appended.received } } : refused(appended)
    },
    'uploads.discard': ({ uploadIds }, { grant }) => ({ ok: true, result: uploads.discard(grant.clientId, uploadIds) }),
    'conversation.revert': ({ commandId, key: wire, ...input }, { grant, voice }) => {
      const chat = chatOr('conversation.revert')
      if (isRefusal(chat)) return chat
      const key = resolve(wire, grant)
      if (!key) return notFound(wire)
      return once(
        keptId('conversation.revert', grant, commandId),
        async () => ({ ok: true as const, result: voice.redact(await chat.revert({ ...input, key })) }),
        voice,
        'conversation.revert',
      )
    },
    'conversation.rewind': ({ commandId, key: wire, turnSeq }, { grant, voice }) => {
      const chat = chatOr('conversation.rewind')
      if (isRefusal(chat)) return chat
      const key = resolve(wire, grant)
      if (!key) return notFound(wire)
      return once(
        keptId('conversation.rewind', grant, commandId),
        async () => ({ ok: true as const, result: voice.redact(await chat.rewind({ key, turnSeq })) }),
        voice,
        'conversation.rewind',
      )
    },
    'conversation.handoff': ({ commandId, key: wire }, { grant, voice }) => {
      const chat = chatOr('conversation.handoff')
      if (isRefusal(chat)) return chat
      const key = resolve(wire, grant)
      if (!key) return notFound(wire)
      return once(
        keptId('conversation.handoff', grant, commandId),
        async () => ({ ok: true as const, result: voice.redact(await chat.handoff({ key })) }),
        voice,
        'conversation.handoff',
      )
    },
    // The fork is the conversation host's, as the tailnet lane's is: written
    // beside the chat, joined to its workspace's records under the name the
    // host gives it, and held under the client's command id. The answer is
    // where it is, so any client opens it as it opens any chat.
    'conversation.fork': async ({ commandId, key: wire, ...point }, { grant, voice, fingerprint }) => {
      const key = resolve(wire, grant)
      if (!key) return notFound(wire)
      const done = await backend.command(
        key,
        grant.clientId,
        studioRuntimeCommandId(grant, commandId),
        { kind: 'fork', ...point },
        fingerprint,
      )
      if (!done.ok) return voice.failedFrom(done.code, done.message, 'conversation.fork', done.retryAfterMs)
      const name = done.data?.name
      if (typeof name !== 'string' || !name)
        return voice.failed('unavailable', 'The fork was made but not named.', 'conversation.fork')
      return {
        ok: true,
        result: {
          ok: true,
          address: { environmentId: options.info().environment.id, chatId: key.workspaceId, agentId: point.newAgentId },
          name,
        },
      }
    },
    'conversation.attachment': async ({ ref }, { voice }) => {
      const chat = chatOr('conversation.attachment')
      if (isRefusal(chat)) return chat
      return { ok: true, result: voice.redact(await chat.attachment(ref)) }
    },
    'conversation.planDocument': async ({ key: wire, planFilePath, ...input }, { context, grant, voice }) => {
      const chat = chatOr('conversation.planDocument')
      if (isRefusal(chat)) return chat
      const key = resolve(wire, grant)
      if (!key) return notFound(wire)
      // The agent's own plan file is read to see whether it still holds the
      // plan: for a client that is not an owner, only inside the folders
      // Studio knows. Elsewhere, Studio keeps a copy of its own instead.
      const own =
        planFilePath !== undefined && (await folderAllowed(chat, { context, grant }, planFilePath))
          ? { planFilePath }
          : {}
      return { ok: true, result: voice.redact(await chat.planDocument({ ...key, ...input, ...own })) }
    },
    'conversation.exportPage': async ({ key: wire, exportId, offset }, { grant, voice, context }) => {
      const chat = chatOr('conversation.exportPage')
      if (isRefusal(chat)) return chat
      if (!chat.exportSource) return unserved('conversation.exportPage')
      const key = resolve(wire, grant)
      if (!key) return notFound(wire)
      // Held for this client and this chat: an export id names nothing of another's.
      const held = [grant.clientId, key.workspaceId, key.agentId, exportId].join('\u0000')
      const clock = now()
      letGoOfStaleExports(clock)
      let kept = exportsHeld.get(held)
      if (offset === 0) {
        const read = await chat.exportSource({ workspaceId: key.workspaceId, agentId: key.agentId })
        if (!read.ok)
          return read.code === 'not_found'
            ? notFound(wire)
            : voice.failed('unavailable', read.message, 'conversation.exportPage')
        kept = { read: voice.redact(read), at: clock, connectionId: context.connectionId }
        exportsHeld.delete(held)
        exportsHeld.set(held, kept)
        const own = [...exportsHeld.keys()].filter((id) => id.startsWith(`${grant.clientId}\u0000`))
        for (const id of own.slice(0, Math.max(0, own.length - EXPORTS_HELD_PER_CLIENT))) exportsHeld.delete(id)
      }
      if (!kept) return refuse('not_found', 'That export is no longer held. Start it again.')
      kept.at = clock
      kept.connectionId = context.connectionId
      delete kept.closedAt
      const page = exportPage(kept.read, offset)
      if (page.nextOffset === null) exportsHeld.delete(held)
      return { ok: true, result: page }
    },
    'conversation.commands': async (input, { context, grant, voice }) => {
      const chat = chatOr('conversation.commands')
      if (isRefusal(chat)) return chat
      // Asking for a folder's list may run its CLI there (a probe): a client
      // that is not an owner names only a folder Studio knows.
      if (!(await folderAllowed(chat, { context, grant }, input.cwd))) return refuse('not_found', UNKNOWN_FOLDER)
      return { ok: true, result: { catalog: voice.redact(await chat.commands(input)) } }
    },
    'providers.list': async (input, { voice }) => {
      const chat = chatOr('providers.list')
      if (isRefusal(chat)) return chat
      return { ok: true, result: voice.redact(await chat.providers(input)) }
    },
    'providers.models': async (input, { voice }) => {
      const chat = chatOr('providers.models')
      if (isRefusal(chat)) return chat
      return { ok: true, result: voice.redact(await chat.providerModels(input)) }
    },
    'providers.secretStatus': async (input, { voice }) => {
      const chat = chatOr('providers.secretStatus')
      if (isRefusal(chat)) return chat
      return { ok: true, result: voice.redact(await chat.secretStatus(input)) }
    },
    'files.search': (search, asking) => fileSystem.byPath.search(search, asking),
    'files.cancelSearch': ({ channel }, { context }) => fileSystem.byPath.cancelSearch(channel, context),
    'files.stat': async ({ path, root }, asking) => {
      // By root it is the board files' family, served with or without a chat surface.
      if (root !== undefined) {
        if (!options.files) return refuse('unavailable', 'This Studio does not serve files by root.')
        const found = await options.files.stat(root, path)
        return found.ok ? { ok: true, result: { stat: found.stat } } : refused(found)
      }
      const read = await fileSystem.byPath.stat(path, asking)
      return read.ok ? { ok: true, result: { stat: read.result } } : read
    },
    'files.readImage': async ({ path }, asking) => {
      const read = await fileSystem.byPath.readImage(path, asking)
      return read.ok ? { ok: true, result: { dataUrl: read.result } } : read
    },
    'files.repoRoot': async ({ folderPath, hostId }, asking) => {
      const read = await fileSystem.byPath.repoRoot(folderPath, hostId, asking)
      return read.ok ? { ok: true, result: { repoRoot: read.result } } : read
    },
    'session.list': async (input, { voice }) => {
      const chat = chatOr('session.list')
      if (isRefusal(chat)) return chat
      return { ok: true, result: voice.redact(await chat.listSessions(input)) }
    },
    'session.stop': async ({ commandId, ...input }, { grant, voice, fingerprint }) => {
      const chat = chatOr('session.stop')
      if (isRefusal(chat)) return chat
      const sent = await chat.stopSession({ ...input, commandId: runtimeId(grant, commandId), ...stamp(fingerprint) })
      return { ok: true, result: voice.redact(sent) }
    },
    // The runtime keeps no receipt for these, so a repeat under the same id
    // is answered here with the first answer, as a checkpoint's is.
    'session.suspend': ({ commandId, ...input }, { grant, voice }) =>
      sessionOnce('session.suspend', grant, commandId, voice, (chat) => chat.suspendSession(input)),
    'session.mcpServerAction': ({ commandId, ...input }, { grant, voice }) =>
      sessionOnce('session.mcpServerAction', grant, commandId, voice, (chat) => chat.mcpServerAction(input)),
    'session.stopSubagent': ({ commandId, ...input }, { grant, voice }) =>
      sessionOnce('session.stopSubagent', grant, commandId, voice, (chat) => chat.stopSubagent(input)),
    'session.messageSubagent': ({ commandId, ...input }, { grant, voice }) =>
      sessionOnce('session.messageSubagent', grant, commandId, voice, (chat) => chat.messageSubagent(input)),
    'session.askSideQuestion': ({ commandId, ...input }, { grant, voice }) =>
      sessionOnce('session.askSideQuestion', grant, commandId, voice, (chat) => chat.askSideQuestion(input)),
    'session.cancelSideQuestion': async (input, { voice }) => {
      const chat = chatOr('session.cancelSideQuestion')
      if (isRefusal(chat)) return chat
      return { ok: true, result: voice.redact(await chat.cancelSideQuestion(input)) }
    },
    'session.contextBreakdown': async (input, { voice }) => {
      const chat = chatOr('session.contextBreakdown')
      if (isRefusal(chat)) return chat
      return { ok: true, result: voice.redact(await chat.contextBreakdown(input)) }
    },
    'session.terminalHandoff': ({ commandId, ...input }, { grant, voice }) => {
      const chat = chatOr('session.terminalHandoff')
      if (isRefusal(chat)) return chat
      const handoff = chat.terminalHandoff
      if (!handoff) return unserved('session.terminalHandoff')
      return sessionOnce('session.terminalHandoff', grant, commandId, voice, () => handoff(input))
    },
    'conversation.threads': async ({ workspaceId, workspaceRoot }, { grant, voice }) => {
      const chat = chatOr('conversation.threads')
      if (isRefusal(chat)) return chat
      const root = historyRoot(workspaceId, workspaceRoot, grant)
      if (!root) return refuse('not_found', `No workspace "${workspaceId}" here.`)
      return { ok: true, result: voice.redact(await chat.threads({ workspaceId, workspaceRoot: root })) }
    },
    'conversation.search': async ({ workspaceId, workspaceRoot, ...search }, { grant, context, voice }) => {
      const chat = chatOr('conversation.search')
      if (isRefusal(chat)) return chat
      const root = historyRoot(workspaceId, workspaceRoot, grant)
      if (!root) return refuse('not_found', `No workspace "${workspaceId}" here.`)
      const found = await chat.searchHistory(context.slot, { ...search, workspaceId, workspaceRoot: root })
      return { ok: true, result: voice.redact(found) }
    },
    'conversation.cancelSearch': ({ requestId }, { context }) => {
      const chat = chatOr('conversation.cancelSearch')
      if (isRefusal(chat)) return chat
      chat.cancelHistorySearch(context.slot, requestId)
      return { ok: true, result: { ok: true } }
    },
    'conversation.approvalRules': async (_params, { grant, voice }) => {
      const chat = chatOr('conversation.approvalRules')
      if (isRefusal(chat)) return chat
      const listed = voice.redact(await chat.approvalRules())
      return { ok: true, result: grant.owner || !listed.ok ? listed : approvalRulesByProject(listed) }
    },
    'conversation.revokeApprovalRule': ({ commandId, ruleId }, { grant, voice }) =>
      sessionOnce('conversation.revokeApprovalRule', grant, commandId, voice, (chat) =>
        chat.revokeApprovalRule(ruleId),
      ),
    'providers.signIn': async (input, { voice }) => {
      const chat = chatOr('providers.signIn')
      if (isRefusal(chat)) return chat
      return { ok: true, result: voice.redact(await chat.signIn(input)) }
    },
    'providers.setSecret': ({ commandId, ...input }, { grant, voice }) =>
      sessionOnce('providers.setSecret', grant, commandId, voice, (chat) => chat.setSecret(input)),
    'providers.clearSecret': ({ commandId, ...input }, { grant, voice }) =>
      sessionOnce('providers.clearSecret', grant, commandId, voice, (chat) => chat.clearSecret(input)),

    // ── Client tools ───────────────────────────────────────────────────────

    'tools.offer': ({ toolset, reach }, { context }) => {
      if (!options.tools) return unserved('tools.offer')
      const offered = options.tools.offer(context.connectionId, toolset, reach)
      return offered.ok
        ? { ok: true, result: { toolset: offered.toolset, wireNames: offered.wireNames, reach: offered.reach } }
        : refused(offered)
    },
    'tools.withdraw': ({ toolset }, { context }) => {
      if (!options.tools) return unserved('tools.withdraw')
      const withdrawn = options.tools.withdraw(context.connectionId, toolset)
      return withdrawn.ok ? { ok: true, result: { withdrawn: withdrawn.withdrawn } } : refused(withdrawn)
    },
    'tools.focus': (focus, { context }) => {
      if (!options.tools) return unserved('tools.focus')
      options.tools.focus(context.connectionId, focus)
      return { ok: true, result: {} }
    },
    'tools.catalog': (_params, { grant }) => {
      if (!options.tools) return unserved('tools.catalog')
      return { ok: true, result: { toolsets: options.tools.catalog({ clientId: grant.clientId, owner: grant.owner }) } }
    },
    'tools.grants': ({ key: wire }, { grant }) => {
      if (!options.tools) return unserved('tools.grants')
      const key = resolve(wire, grant)
      if (!key) return notFound(wire)
      return {
        ok: true,
        result: { grants: options.tools.grantsOf({ workspaceId: key.workspaceId, agentId: key.agentId }) },
      }
    },
    'tools.grant': ({ key: wire, toolset, granted }, { grant }) => {
      if (!options.tools) return unserved('tools.grant')
      const key = resolve(wire, grant)
      if (!key) return notFound(wire)
      const answer = options.tools.grant({ workspaceId: key.workspaceId, agentId: key.agentId }, toolset, granted)
      return answer.ok ? { ok: true, result: { grants: answer.grants } } : refused(answer)
    },

    // ── Files under a workspace's roots ────────────────────────────────────

    'files.roots': ({ workspaceId }) =>
      options.files ? { ok: true, result: options.files.roots(workspaceId) } : unserved('files.roots'),
    'files.list': async ({ root, path }) => {
      if (!options.files) return unserved('files.list')
      const listed = await options.files.list(root, path)
      return listed.ok ? { ok: true, result: { entries: listed.entries } } : refused(listed)
    },
    'files.read': async ({ root, path }) => {
      if (!options.files) return unserved('files.read')
      const read = await options.files.read(root, path)
      if (!read.ok) return refused(read)
      const { ok: _ok, ...result } = read
      return { ok: true, result }
    },
    'files.write': ({ root, path, text, uploadId, ifMatch, commandId }, { grant, voice }) => {
      const files = options.files
      if (!files) return unserved('files.write')
      const id = runtimeId(grant, commandId)
      // A retry of a write is answered with the first one's outcome: carried
      // out again, its own write would read as another writer's conflict.
      return once(
        `files.write:${id}`,
        async (): Promise<StudioRpcAnswer<'files.write'>> => {
          let bytes: Buffer
          if (text !== undefined) bytes = Buffer.from(text, 'utf8')
          else {
            const spent = uploads.spend(grant.clientId, [uploadId!], id, 'file')
            if (!spent.ok) return refused(spent)
            bytes = spent.pictures[0].bytes
          }
          // A conflict is an answer, kept for every repeat of this command,
          // so its bytes go as a write's do; a write that could not be
          // carried out leaves them unsent, for a retry or a discard.
          let written: Awaited<ReturnType<typeof files.write>>
          try {
            written = await files.write(root, path, bytes, ifMatch)
          } catch (error) {
            if (uploadId !== undefined) uploads.settle(grant.clientId, id, false)
            throw error
          }
          if (uploadId !== undefined) uploads.settle(grant.clientId, id, written.ok || written.code === 'conflict')
          return written.ok || written.code === 'conflict' ? { ok: true, result: written } : refused(written)
        },
        voice,
        'files.write',
      )
    },
    'files.remove': ({ root, path, ifMatch, commandId }, { grant, voice }) => {
      const files = options.files
      if (!files) return unserved('files.remove')
      return once(
        `files.remove:${runtimeId(grant, commandId)}`,
        async (): Promise<StudioRpcAnswer<'files.remove'>> => {
          const removed = await files.remove(root, path, ifMatch)
          return removed.ok || removed.code === 'conflict' ? { ok: true, result: removed } : refused(removed)
        },
        voice,
        'files.remove',
      )
    },

    // ── Pull requests ──────────────────────────────────────────────────────

    'pullRequests.list': async (target) =>
      options.pullRequests
        ? { ok: true, result: await options.pullRequests.list(target) }
        : unserved('pullRequests.list'),
    'pullRequests.refresh': async (target) =>
      options.pullRequests
        ? { ok: true, result: await options.pullRequests.refresh(target) }
        : unserved('pullRequests.refresh'),
    'pullRequests.noteWork': (note) => {
      if (!options.pullRequests) return unserved('pullRequests.noteWork')
      // Answered at once: what it changes reports through
      // `pullRequests.changed`, and a turn end must not wait on GitHub.
      void options.pullRequests.noteWork(note).catch((error: unknown) => {
        options.log?.(`A pull request note failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      return { ok: true, result: {} }
    },
    'pullRequests.link': async (link) => {
      if (!options.pullRequests) return unserved('pullRequests.link')
      const linked = await options.pullRequests.link(link)
      if (!linked.ok) return refuse(linked.code === 'not_a_pull_request' ? 'invalid_params' : 'claimed', linked.message)
      return { ok: true, result: { recorded: linked.recorded, pullRequest: linked.pullRequest } }
    },
    'pullRequests.unwatch': async (unwatch) => {
      if (!options.pullRequests?.unwatch) return unserved('pullRequests.unwatch')
      return { ok: true, result: await options.pullRequests.unwatch(unwatch) }
    },
    // A chat's "Create PR", every step in its checkout here (an owner's, by
    // the table). A chat with no checkout here has no state to show; a step
    // asked of one anyway is refused in the core's words.
    'pullRequests.createState': async ({ conversation }, { voice }) => {
      const creation = options.pullRequestCreation
      if (!creation) return unserved('pullRequests.createState')
      const read = await creation.state(conversation)
      if (!isChatPullRequestRefusal(read)) return { ok: true, result: { state: read.state } }
      return refusedChat(read, voice, 'pullRequests.createState') ?? { ok: true, result: { state: null } }
    },
    'pullRequests.draft': async ({ conversation, draftId }, { grant, voice }) => {
      const creation = options.pullRequestCreation
      if (!creation) return unserved('pullRequests.draft')
      const drafted = await creation.draft(conversation, `client:${grant.clientId}`, draftId)
      if (!isChatPullRequestRefusal(drafted)) return { ok: true, result: drafted }
      return (
        refusedChat(drafted, voice, 'pullRequests.draft') ??
        voice.failed('unavailable', drafted.refused.message, 'pullRequests.draft')
      )
    },
    'pullRequests.draftCancel': ({ conversation, draftId }, { grant }) => {
      if (!options.pullRequestCreation) return unserved('pullRequests.draftCancel')
      options.pullRequestCreation.cancelDraft(conversation, `client:${grant.clientId}`, draftId)
      return { ok: true, result: {} }
    },
    'pullRequests.push': ({ conversation, commandId, pin }, { grant, voice }) => {
      const creation = options.pullRequestCreation
      if (!creation) return unserved('pullRequests.push')
      return once(
        keptId('pullRequests.push', grant, commandId),
        async () => {
          const pushed = await creation.push(conversation, pin)
          if (!isChatPullRequestRefusal(pushed)) return { ok: true as const, result: pushed }
          return (
            refusedChat(pushed, voice, 'pullRequests.push') ??
            voice.failed('unavailable', pushed.refused.message, 'pullRequests.push')
          )
        },
        voice,
        'pullRequests.push',
      )
    },
    'pullRequests.create': ({ conversation, commandId, title, body, pin }, { grant, voice }) => {
      const creation = options.pullRequestCreation
      if (!creation) return unserved('pullRequests.create')
      return once(
        keptId('pullRequests.create', grant, commandId),
        async () => {
          const created = await creation.create(conversation, { title, body }, pin)
          if (!isChatPullRequestRefusal(created)) return { ok: true as const, result: created }
          return (
            refusedChat(created, voice, 'pullRequests.create') ??
            voice.failed('unavailable', created.refused.message, 'pullRequests.create')
          )
        },
        voice,
        'pullRequests.create',
      )
    },
    'pullRequests.noteToolCall': (call) => {
      if (!options.pullRequests) return unserved('pullRequests.noteToolCall')
      // Answered at once, like a note: what it records reports through
      // `pullRequests.changed`.
      void options.pullRequests.noteToolCall(call).catch((error: unknown) => {
        options.log?.(
          `A tool call could not be read for a pull request: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
      return { ok: true, result: {} }
    },

    // ── Local servers ──────────────────────────────────────────────────────

    'workspaces.list': async (_params, { voice }) =>
      options.discovery
        ? { ok: true, result: { workspaces: voice.redact(await options.discovery.workspaces()) } }
        : unserved('workspaces.list'),
    'cliRuntimes.list': async ({ cli }, { voice }) =>
      options.discovery ? discovered(await options.discovery.runtimes(cli), voice) : unserved('cliRuntimes.list'),
    'workspaces.checkout': async ({ workspaceId }, { voice }) =>
      options.discovery
        ? discovered(await options.discovery.checkout(workspaceId), voice)
        : unserved('workspaces.checkout'),
    'workspaces.extensions': async ({ workspaceId, cli }, { voice }) =>
      options.discovery
        ? discovered(await options.discovery.extensions(workspaceId, cli), voice)
        : unserved('workspaces.extensions'),
    'localServers.list': async (target) =>
      options.localServers
        ? { ok: true, result: await options.localServers.list(target) }
        : unserved('localServers.list'),
    'localServers.run': async (server) => {
      if (!options.localServers) return unserved('localServers.run')
      // Answered once the run has started; its port opening reports through
      // `localServers.changed`.
      const started = await options.localServers.run(server)
      return started.ok ? { ok: true, result: { started: true } } : refused(started)
    },
    'localServers.stop': async (server) => {
      if (!options.localServers) return unserved('localServers.stop')
      const stopped = await options.localServers.stop(server)
      return stopped.ok ? { ok: true, result: { stopped: stopped.stopped } } : refused(stopped)
    },
    'localServers.remove': async (server) =>
      options.localServers
        ? { ok: true, result: await options.localServers.remove(server) }
        : unserved('localServers.remove'),

    // ── Terminals ──────────────────────────────────────────────────────────
    // An owner's only, and never a browser's. An owner's connection other
    // than the app's own window is sent sessions projected: never a prompt a
    // person typed or a launch's MCP secrets.

    'terminal.list': (_params, { context }) =>
      terminal('terminal.list', (terminals) => ({
        sessions: context.ownWindow
          ? terminals.list()
          : terminals.list().map((session) => projectTerminalSession(session)),
      })),
    'terminal.status': ({ sessionId }, { context }) =>
      terminal('terminal.status', (terminals) => terminals.status(sessionId, caller(context))),
    'terminal.open': ({ commandId: _id, ...params }, { context }) =>
      terminal('terminal.open', (terminals) => terminals.open(params, caller(context))),
    'terminal.resume': ({ commandId: _id, ...params }, { context }) =>
      terminal('terminal.resume', (terminals) => terminals.resume(params, caller(context))),
    'terminal.write': (params, { grant }) =>
      terminal('terminal.write', (terminals) => ({ written: terminals.write(params, grant.clientId) })),
    'terminal.ack': ({ sessionId, units }, { context }) =>
      terminal('terminal.ack', (terminals) => {
        terminals.ack(sessionId, units, caller(context))
        return {}
      }),
    'terminal.resize': ({ sessionId, cols, rows }) =>
      terminal('terminal.resize', (terminals) => {
        terminals.resize(sessionId, cols, rows)
        return {}
      }),
    'terminal.setVisible': ({ sessionId, visible, freshPane }, { context }) =>
      terminal('terminal.setVisible', (terminals) => {
        terminals.setVisible(sessionId, visible, freshPane === true, caller(context))
        return {}
      }),
    'terminal.suspend': ({ sessionId }) =>
      terminal('terminal.suspend', (terminals) => {
        terminals.suspend(sessionId)
        return {}
      }),
    'terminal.close': ({ sessionId }) =>
      terminal('terminal.close', (terminals) => {
        terminals.close(sessionId)
        return {}
      }),
    'terminal.setReapExempt': ({ sessionId, exempt }) =>
      terminal('terminal.setReapExempt', (terminals) => {
        terminals.setReapExempt(sessionId, exempt)
        return {}
      }),
    'terminal.takeUndeliveredPrompts': () =>
      terminal('terminal.takeUndeliveredPrompts', (terminals) => ({ prompts: terminals.takeUndeliveredPrompts() })),
    'terminal.configure': (policy) =>
      terminal('terminal.configure', (terminals) => {
        terminals.configure(policy)
        return {}
      }),

    // ── Agent CLIs and launch settings ─────────────────────────────────────

    ...createStudioAgentSettingsHandlers({
      ...(options.runtimes ? { runtimes: options.runtimes } : {}),
      ...(options.agentSettings ? { settings: options.agentSettings } : {}),
      mayName,
    }),
    ...createStudioAgentSetupHandlers({ ...(options.agentSetup ? { setup: options.agentSetup } : {}), mayName }),

    // ── Files on this machine, by path ─────────────────────────────────────

    ...fileSystem.handlers,

    // ── Git on this machine ────────────────────────────────────────────────

    ...gitRouting.handlers,

    // ── The worktrees its agents run in, and settled chats ─────────────────

    ...worktreesHandlers,

    // ── The desktop's own windows' workspace registry ──────────────────────

    ...createStudioWorkspaceSyncHandlers({
      ...(options.workspaceSync ? { sync: options.workspaceSync } : {}),
      kept: (method, { grant, voice }, commandId, work) => once(keptId(method, grant, commandId), work, voice, method),
      mayName: (folder, asking) => mayName(folder, asking),
    }),

    // ── What the Studio is extended with ───────────────────────────────────

    ...extensionsRouting,

    // ── Where the Studio publishes its agents' pages ───────────────────────

    ...artifactsRouting,

    // ── Who may reach the agents from this machine ─────────────────────────

    ...accessRouting,
    // ── The browsers paired with the web listener ──────────────────────────

    ...webDevicesRouting,

    // ── Who reaches this machine over the tailnet, and the machines it drives ──

    ...tailnetRouting,
    // ── Readiness ──────────────────────────────────────────────────────────

    // What the machine has is a providers read; what waits names schedules
    // (from their prompts) and watched pull requests, which are the chats'
    // business, so a grant that cannot read chats is told none of it.
    'environment.readiness': async (_params, { grant, voice }) => {
      if (!options.readiness) return unserved('environment.readiness')
      const read = await options.readiness()
      const waiting = grant.owner || studioScopesGrant(grant.scopes, 'conversation:read') ? read.waiting : []
      return { ok: true, result: voice.redact({ ...read, waiting }) }
    },

    // ── For the desktop that holds this Studio ─────────────────────────────

    // Only the shell's own connection reaches here (the dispatch refuses
    // every other with `shell` in the table).
    'environment.windowTicket': async (params) => {
      if (!options.environmentAccess) return unserved('environment.windowTicket')
      try {
        return { ok: true, result: await options.environmentAccess.windowTicket(params) }
      } catch (error) {
        return refuse('unavailable', error instanceof Error ? error.message : String(error))
      }
    },
    'environment.revokeWindow': async ({ windowKey }) => {
      if (!options.environmentAccess) return unserved('environment.revokeWindow')
      options.environmentAccess.revokeWindow(windowKey)
      return { ok: true, result: { revoked: true } }
    },
    // The validator held the scopes to the relayed ceiling; the grant is never an owner's.
    'environment.deviceTicket': async (params) => {
      if (!options.environmentAccess) return unserved('environment.deviceTicket')
      try {
        return { ok: true, result: await options.environmentAccess.deviceTicket(params) }
      } catch (error) {
        return refuse('unavailable', error instanceof Error ? error.message : String(error))
      }
    },
    // Answered once per command id: a hand-over sent again is the same one.
    'environment.adopt': ({ commandId, migrationId, records, files }, { grant, voice }) => {
      const adoption = options.adoption
      if (!adoption) return unserved('environment.adopt')
      const id = keptId('environment.adopt', grant, commandId)
      return once(
        id,
        async () => {
          // The pictures and files the held messages carry, staged by this
          // connection, by the digest each record names them by.
          const staged = new Map<string, { bytes: Buffer; mediaType: string; name?: string }>()
          if (files?.length) {
            const spent = uploads.spend(
              grant.clientId,
              files.map((file) => file.uploadId),
              id,
              ['picture', 'attachment'],
            )
            // A file that did not arrive is the hand-over's to send again.
            if (!spent.ok) return refuse('invalid_params', spent.message)
            files.forEach((file, index) => {
              const upload = spent.pictures[index]
              staged.set(file.digest, {
                bytes: upload.bytes,
                mediaType: upload.mediaType,
                ...(upload.name === undefined ? {} : { name: upload.name }),
              })
            })
          }
          try {
            return { ok: true as const, result: await adoption.adopt({ migrationId, records, files: staged }) }
          } finally {
            // Kept or not, their bytes are the held messages' copies now, or
            // sent again with the next attempt.
            if (files?.length) uploads.settle(grant.clientId, id, true)
          }
        },
        voice,
        'environment.adopt',
      )
    },
    // A CLI's login here: the provider names a flow this server knows, never a command line.
    'providers.signInStart': ({ commandId, providerId }, { grant, voice }) =>
      signInOnce('providers.signInStart', grant, commandId, voice, async (table) => {
        const cli = cliForConversationProvider(providerId)
        return cli ? table.start(cli) : { ok: false as const, message: 'This chat has no CLI to sign in.' }
      }),
    'providers.signInPaste': ({ commandId, id, code }, { grant, voice }) =>
      signInOnce('providers.signInPaste', grant, commandId, voice, async (table) => table.paste(id, code)),
    'providers.signInWait': ({ commandId, id }, { grant, voice }) =>
      signInOnce('providers.signInWait', grant, commandId, voice, (table) => table.wait(id)),
    'providers.signInCancel': ({ commandId, id }, { grant, voice }) =>
      signInOnce('providers.signInCancel', grant, commandId, voice, async (table) => {
        table.cancel(id)
        return { ok: true }
      }),
    ...createStudioAgentSkillsHandlers({ ...(options.agentSkills ? { skills: options.agentSkills } : {}), mayName }),

    // ── Modules ────────────────────────────────────────────────────────────
    // A module's declared methods. A read is answered each time; an operate
    // once per command id, its handler told the id under the client's
    // namespace, so a handler that sends to a chat is answered from the
    // chat's receipt on a retry rather than sending twice.

    'module.read': (params, { grant }) => moduleCall('module.read', params, grant, undefined),
    'module.operate': ({ commandId, ...params }, { grant, voice }) =>
      once(
        keptId('module.operate', grant, commandId),
        () => moduleCall('module.operate', params, grant, runtimeId(grant, commandId)),
        voice,
        'module.operate',
        operateRefusedBefore,
      ),

    // ── What the Studio keeps beside its chats ───────────────────────────────

    ...createStudioChatStoresHandlers({
      ...(options.chatStores ? { stores: options.chatStores } : {}),
      commandIdOf: runtimeId,
      kept: (method, { grant, voice }, commandId, work) =>
        once(
          keptId(method, grant, commandId),
          async () => ({ ok: true as const, result: await work() }),
          voice,
          method,
        ),
    }),

    // What runs here: listed to any client with modules:read, changed only by
    // an owner, each change once per command id.
    'module.list': () => {
      const modules = options.modules
      if (!modules) return unserved('module.list')
      return { ok: true, result: { modules: modules.lifecycle()?.list() ?? [] } }
    },
    'module.setEnabled': ({ moduleId, enabled, commandId }, context) =>
      lifecycleCommand('module.setEnabled', context, commandId, (lifecycle) => lifecycle.setEnabled(moduleId, enabled)),
    'module.install': ({ path, commandId }, context) =>
      lifecycleCommand('module.install', context, commandId, (lifecycle) => lifecycle.install(path)),
    'module.setTrust': ({ moduleId, trusted, commandId }, context) =>
      lifecycleCommand('module.setTrust', context, commandId, (lifecycle) => lifecycle.setTrust(moduleId, trusted)),
    'module.uninstall': ({ moduleId, commandId }, context) =>
      lifecycleCommand('module.uninstall', context, commandId, (lifecycle) => lifecycle.uninstall(moduleId)),
    // The installed extensions and their window halves, read now; what a
    // window sets for them and the registry it resolved, kept here.
    'module.installed': async (_params, asking) => {
      const lifecycle = options.modules?.lifecycle()
      if (!lifecycle) return unserved('module.installed')
      const installed = await lifecycle.installed()
      // Where a folder is on this disk is told only to a connection that may
      // name any path; anyone else is told the folder by its name.
      return { ok: true, result: namesAnyPath(asking) ? installed : withFolderNamesOnly(installed) }
    },
    'module.rendererEntries': async () => {
      const lifecycle = options.modules?.lifecycle()
      return lifecycle ? { ok: true, result: await lifecycle.rendererEntries() } : unserved('module.rendererEntries')
    },
    'module.setAppState': ({ state, commandId }, context) =>
      lifecycleCommand('module.setAppState', context, commandId, async (lifecycle) => {
        lifecycle.setAppState(state)
        return {}
      }),
    'module.reportRegistry': ({ snapshot, commandId }, context) =>
      lifecycleCommand('module.reportRegistry', context, commandId, async (lifecycle) =>
        lifecycle.reportRegistry(snapshot),
      ),

    // The host's services a module's window half calls, under its own id;
    // the service checks the module's permission. A write is carried out
    // once per command id.
    'moduleBacklog.location': ({ moduleId, workspaceId }) =>
      moduleService('moduleBacklog.location', moduleId, 'backlog', BACKLOG_MISSING, (backlog) =>
        backlog.getLocation(moduleId, workspaceId),
      ),
    'moduleBacklog.create': (params, context) =>
      backlogWrite('moduleBacklog.create', params, context, (backlog) =>
        backlog.create(params.moduleId, params.workspaceId, params.input),
      ),
    'moduleBacklog.updateStatus': (params, context) =>
      backlogWrite('moduleBacklog.updateStatus', params, context, (backlog) =>
        backlog.updateStatus(params.moduleId, params.workspaceId, params.itemId, params.status),
      ),
    'moduleBacklog.updateTriage': (params, context) =>
      backlogWrite('moduleBacklog.updateTriage', params, context, (backlog) =>
        backlog.updateTriage(params.moduleId, params.workspaceId, params.itemId, params.triage),
      ),
    'moduleBacklog.addLink': (params, context) =>
      backlogWrite('moduleBacklog.addLink', params, context, (backlog) =>
        backlog.addLink(params.moduleId, params.workspaceId, params.itemId, params.link),
      ),
    'moduleBacklog.updateModuleMetadata': (params, context) =>
      backlogWrite('moduleBacklog.updateModuleMetadata', params, context, (backlog) =>
        backlog.updateModuleMetadata(params.moduleId, params.workspaceId, params.itemId, params.value),
      ),
    'moduleUsage.query': ({ moduleId, query }) =>
      moduleService('moduleUsage.query', moduleId, 'usage', USAGE_MISSING, (usage) => usage.query(moduleId, query)),
    // ── Scheduled agents ───────────────────────────────────────────────────

    ...createStudioSchedulesHandlers({
      ...(options.schedules ? { schedules: options.schedules } : {}),
      kept: (method, { grant, voice }, commandId, work) => once(keptId(method, grant, commandId), work, voice, method),
      mayName: (folder, asking) => mayName(folder, asking),
    }),

    // ── Backlogs, shares, pull request reads ───────────────────────────────

    ...createStudioPhoneReadsHandlers({
      ...(options.phoneReads ? { reads: options.phoneReads } : {}),
      kept: (method, { grant, voice }, commandId, work) => once(keptId(method, grant, commandId), work, voice, method),
      mayName: (folder, asking) => mayName(folder, asking),
    }),

    // ── A chat's record beyond its rest ────────────────────────────────────
    // By its workspace, as a settle; each change once per command id.

    ...createStudioChatLifecycleHandlers({
      ...(options.chatLifecycle ? { lifecycle: options.chatLifecycle } : {}),
      kept: (method, { grant, voice }, commandId, work) => once(keptId(method, grant, commandId), work, voice, method),
    }),

    // ── Canvas boards ──────────────────────────────────────────────────────

    ...createStudioCanvasHandlers({
      ...(options.canvas ? { canvas: options.canvas } : {}),
      kept: (method, { grant, voice }, commandId, work) => once(keptId(method, grant, commandId), work, voice, method),
    }),

    // ── Updates ────────────────────────────────────────────────────────────
    // Served on every connection, and on one kept open only for them (an
    // incompatible client's), so their shapes never change.

    'update.status': () => ({ ok: true, result: updateStatus() }),
    'update.start': async (params) => {
      const status = updates.status()
      if (status.method !== 'self') return refuse('update_unavailable', status.manual ?? MANUAL_UPDATE_WORDS)
      const started = await updates.start({
        commandId: params.commandId,
        ...(params.targetVersion === undefined ? {} : { targetVersion: params.targetVersion }),
      })
      return started.ok
        ? { ok: true, result: { accepted: true, method: 'self', targetVersion: started.targetVersion } }
        : refuse('update_unavailable', started.message)
    },
  }

  /** One method's handler, called with that method's params: the table pairs them, so no cast is needed. */
  async function run<M extends StudioMethod>(
    method: M,
    params: StudioMethodParams<M>,
    asking: Asking,
  ): Promise<StudioRpcAnswer<M>> {
    const handler: StudioHandlers<Asking>[M] = handlers[method]
    return handler(params, asking)
  }

  return {
    updateStatus,
    connectionClosed: (connectionId, slot) => {
      uploads.release(connectionId)
      // An export is read page by page on one connection. With it gone, its
      // pages wait only for the reconnect that asks for the next one again.
      let orphaned = false
      for (const held of exportsHeld.values())
        if (held.connectionId === connectionId && held.closedAt === undefined) {
          held.closedAt = now()
          orphaned = true
        }
      if (orphaned) {
        if (exportSweep) clearTimeout(exportSweep)
        exportSweep = setTimeout(() => {
          exportSweep = null
          letGoOfStaleExports(now())
        }, EXPORT_HELD_AFTER_CLOSE_MS)
        exportSweep.unref?.()
      }
      if (slot !== undefined) options.fileSystem?.releaseSlot(slot)
      options.canvas?.connectionClosed(connectionId)
    },
    watchPath: (params, asking, listener) => fileSystem.watch(params, asking, listener),
    followCheckout: (checkoutPath, asking, listener) => gitRouting.followCheckout(checkoutPath, asking, listener),
    skillSourceUpdatesFor: (check, asking) => skillSourceUpdatesShown(check, (folder) => mayName(folder, asking)),
    git: options.git ?? null,
    worktrees: options.worktrees ?? null,
    workspaceSync: options.workspaceSync ?? null,
    close: () => {
      if (exportSweep) clearTimeout(exportSweep)
      exportSweep = null
      exportsHeld.clear()
      uploads.close()
      options.canvas?.close()
    },
    async handle(grant, method, params, context = NO_CONTEXT) {
      const spec = STUDIO_METHODS[method]
      const voice = context.ownWindow ? windowVoice : clientVoice
      const started = now()
      let answer: StudioRpcAnswer
      let read: unknown = params
      // The one decision, from the method's declared permissions and the
      // grant as it stands; the refusals keep the codes and words they had.
      const decision = authorizeStudioMethod(grant, method)
      // A name the table does not hold has no spec to audit by: refused here,
      // as the connection refuses it before it ever reaches this router.
      if (!decision.ok && decision.reason === 'unknown_method')
        return refuse('unknown_method', `No method "${method}".`)
      if (decision.ok && refusedToBrowser(spec, context.browser))
        answer = refuse('owner_required', BROWSER_NO_TERMINALS)
      // The shell's own: an owner's other clients are refused too.
      else if (decision.ok && spec.shell && context.shell !== true) answer = refuse('owner_required', SHELL_ONLY)
      // Studio's own desktop windows': an owner's web tab and app are refused too.
      else if (decision.ok && refusedOutsideWindow(spec, context)) answer = refuse('owner_required', WINDOW_ONLY)
      else if (!decision.ok) {
        answer =
          decision.reason === 'permission_required'
            ? refuse(
                'scope_required',
                `This app's grant does not include "${studioRefusedGrantName(spec, decision.permission)}".`,
              )
            : refuse('owner_required', OWNER_ONLY)
      } else {
        const parsed = parseStudioMethodParams(method, params)
        // A mutation's id names one command: the same id for another one is refused.
        const fingerprint = spec.mutation
          ? studioCommandFingerprint(method, parsed.ok ? parsed.params : null)
          : undefined
        const commandId = spec.mutation && parsed.ok ? (parsed.params as { commandId?: unknown }).commandId : undefined
        const id = typeof commandId === 'string' ? runtimeId(grant, commandId) : undefined
        const known = id === undefined ? undefined : fingerprints.get(id)
        if (!parsed.ok) answer = refuse(parsed.code, parsed.message)
        else if (!grant.owner && namesFolder(parsed.params)) answer = refuse('owner_required', FOLDER_OWNER_ONLY)
        else if (!grant.owner && namesCliCommand(parsed.params)) answer = refuse('owner_required', COMMAND_OWNER_ONLY)
        else if (known !== undefined && known !== fingerprint)
          answer = refuse('command_id_conflict', STABLE_MESSAGES.command_id_conflict)
        else {
          read = parsed.params
          if (id !== undefined && fingerprint !== undefined) {
            fingerprints.delete(id)
            fingerprints.set(id, fingerprint)
            while (fingerprints.size > MAX_FINGERPRINTS) fingerprints.delete(fingerprints.keys().next().value!)
          }
          answer = await run(method, parsed.params, { grant, context, voice, fingerprint }).catch(
            (error: unknown): StudioRpcAnswer =>
              voice.failedFrom('unavailable', error instanceof Error ? error.message : String(error), method),
          )
        }
      }
      // Every mutation is audited, a refused one included: a refusal at the
      // scope or the ceiling is what this log exists to show. Studio's own
      // windows are the app rather than a client of it, and are left out.
      if (spec.mutation && (context.audited ?? !context.ownWindow)) {
        const created =
          answer.ok && method === 'conversation.create'
            ? (answer as StudioRpcAnswer<'conversation.create'> & { ok: true }).result.conversation
            : undefined
        audit(grant, method, started, auditTargets(read), answer, created)
      }
      return answer
    },
  }
}

type PathAsker = { context: StudioRequestContext; grant: { owner: boolean } }

/**
 * The installed extensions with each unreadable folder named, not placed: its
 * `path` (the folder, or the `manifest.json` in it) becomes the folder's name,
 * and an issue's words that still name a place on this disk (a read error's
 * `open '/…/manifest.json'`) say the folder's name in its stead, or a plain
 * sentence when some other path remains.
 */
function withFolderNamesOnly(installed: ThirdPartyModuleListResult): ThirdPartyModuleListResult {
  return {
    ...installed,
    rejected: installed.rejected.map((entry) => {
      const segments = entry.path.split(/[\\/]/u).filter(Boolean)
      if (segments.length > 1 && segments.at(-1) === 'manifest.json') segments.pop()
      const name = segments.at(-1) ?? ''
      const folder = name ? entry.path.slice(0, entry.path.lastIndexOf(name) + name.length) : ''
      return {
        path: name,
        issues: entry.issues.map((issue) => ({
          ...issue,
          message: sanitizeEntryMessage(
            folder ? issue.message.replaceAll(folder, name) : issue.message,
            'Studio could not read this folder.',
          ),
        })),
      }
    }),
  }
}

/** Whether a connection names any path on this disk: an owner's, unless it is held to the folders Studio knows. */
function namesAnyPath(asking: PathAsker): boolean {
  return asking.grant.owner && !asking.context.knownFoldersOnly
}

/** Whether a connection may name this path: any, if `namesAnyPath`; otherwise only inside the folders Studio knows. */
async function folderAllowed(chat: StudioChatBackend, asking: PathAsker, path: string): Promise<boolean> {
  if (namesAnyPath(asking)) return true
  return chat.isKnownFolder ? chat.isKnownFolder(path).catch(() => false) : false
}

/** As `folderAllowed`, for a path a send names: a relative one is the chat's own, unless it climbs out. */
async function pathAllowed(chat: StudioChatBackend, asking: PathAsker, path: string): Promise<boolean> {
  const absolute = path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(path)
  if (absolute) return folderAllowed(chat, asking, path)
  return namesAnyPath(asking) || !path.split(/[\\/]/u).includes('..')
}

/**
 * Whether parsed params name a CLI's own program (`cliRuntimes[cli].command`,
 * or a detection's or an install's `runtime.command`), which only an owner may.
 */
function namesCliCommand(params: unknown): boolean {
  const runtime = (params as { runtime?: unknown } | null)?.runtime
  if (runtime !== null && typeof runtime === 'object' && 'command' in runtime) return true
  const runtimes = (params as { cliRuntimes?: unknown } | null)?.cliRuntimes
  if (runtimes === null || typeof runtimes !== 'object') return false
  return Object.values(runtimes as Record<string, unknown>).some(
    (override) => override !== null && typeof override === 'object' && 'command' in override,
  )
}

/** Whether parsed params name a conversation or a workspace by its folder, which only an owner may. */
function namesFolder(params: unknown): boolean {
  const named = params as { key?: { workspaceRoot?: unknown }; workspaceRoot?: unknown } | null
  return named?.key?.workspaceRoot !== undefined || named?.workspaceRoot !== undefined
}

// What a request names, for the audit: its conversation and command id when
// they are where the protocol puts them, and a module call's module and
// method. Never anything else it carries.
function auditTargets(value: unknown): {
  key?: { workspaceId: string; agentId: string }
  commandId?: string
  workspaceId?: string
  toolset?: string
  moduleId?: string
  moduleMethod?: string
} {
  if (value === null || typeof value !== 'object') return {}
  const params = value as Record<string, unknown>
  const text = (field: unknown) => (typeof field === 'string' && field ? field.slice(0, 200) : undefined)
  const key = params.key as Record<string, unknown> | undefined
  const workspaceId = text(key?.workspaceId)
  const agentId = text(key?.agentId)
  const commandId = text(params.commandId)
  const created = text(params.workspaceId)
  const toolset = text(params.toolset)
  const moduleId = text(params.moduleId)
  const moduleMethod = moduleId ? text(params.method) : undefined
  return {
    ...(workspaceId && agentId ? { key: { workspaceId, agentId } } : {}),
    ...(commandId ? { commandId } : {}),
    ...(created ? { workspaceId: created } : {}),
    ...(toolset ? { toolset } : {}),
    ...(moduleId ? { moduleId } : {}),
    ...(moduleMethod ? { moduleMethod } : {}),
  }
}
