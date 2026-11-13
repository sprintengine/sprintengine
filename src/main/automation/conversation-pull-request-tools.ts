import { conversationWorkingRoot } from '../../shared/agent-state'
import {
  PULL_REQUEST_BODY_MAX_CHARS,
  PULL_REQUEST_TITLE_MAX_CHARS,
  readPullRequestCheckoutPin,
  type CreatePullRequestOutcome,
  type CreatePullRequestState,
  type PullRequestCheckoutPin,
  type PushForPullRequestOutcome,
} from '../../shared/git/pull-request-create'
import type {
  StudioPullRequestCreated,
  StudioPullRequestDraftOutcome,
} from '../../../packages/studio-protocol/src/public'
import {
  toolError,
  toolSuccess,
  type McpConnectionContext,
  type McpToolRegistration,
  type McpToolResult,
} from '../../shared/modules/mcp-tools'
import type {
  PullRequestTextRequest,
  PullRequestTextResult,
  TextGenerationCliRuntimeOverrides,
  TextGenerationEngine,
} from '../../shared/text-generation/contract'
import type { TextGenerationWritingStyle } from '../../shared/text-generation/writing-style'
import type { WorkspaceRegistryRecord } from '../../shared/workspace-registry'
import { gatewayConversation } from '../../server/tools/client-tool-gateway'
import { createDraftRuns } from '../ipc/text-generation-draft'
import type { DraftInputOutcome } from '../pull-request-create'

// The chat's "Create PR" on the machine that holds the chat (owner ruling
// 2026-10-18: apart from the machine's mark, a remote chat looks and behaves
// as a local one). The checkout, git, the forge's CLI and the agent CLI that
// drafts the text are all here, so every step runs here, in the chat's own
// checkout (`createConversationPullRequests`): for a client of this Studio
// over the protocol (`pullRequests.createState` … `.create`, an owner's), and
// for a paired desktop that follows one of its chats over the lane, through
// the tools below.
//
// A call names the CHAT, never a folder: this machine resolves the folder the
// chat works in from its own record, so a paired device can reach no checkout
// but a chat's, and learns no path on this disk (the state's `gitRoot` is left
// out). The draft is written with this machine's text generation settings,
// as a chat here is titled with them; a machine where it is off says so, and
// the person writes the text themselves. A pull request opened here is
// recorded as the chat's here, where its record lives, and the paired
// device's next read of the list carries it.
//
// Reading whether the button may show is a read, on `conversation:read` like
// the list it sits beside; everything else pushes, opens or spends a CLI
// run, and needs `conversation:operate`, as sending into the chat does.

export const CONVERSATION_PULL_REQUEST_STATE_TOOL = 'conversation.pull_request_state'
export const CONVERSATION_PULL_REQUEST_DRAFT_TOOL = 'conversation.pull_request_draft'
export const CONVERSATION_PULL_REQUEST_DRAFT_CANCEL_TOOL = 'conversation.pull_request_draft_cancel'
export const CONVERSATION_PULL_REQUEST_PUSH_TOOL = 'conversation.pull_request_push'
export const CONVERSATION_PULL_REQUEST_CREATE_TOOL = 'conversation.pull_request_create'

/** Classified as mutations: audited, and `conversation:operate` from a paired device (tailnet-scopes.ts). */
export const CONVERSATION_PULL_REQUEST_MUTATION_TOOL_NAMES: readonly string[] = [
  CONVERSATION_PULL_REQUEST_DRAFT_TOOL,
  CONVERSATION_PULL_REQUEST_DRAFT_CANCEL_TOOL,
  CONVERSATION_PULL_REQUEST_PUSH_TOOL,
  CONVERSATION_PULL_REQUEST_CREATE_TOOL,
]

type ChatKey = { workspaceId: string; agentId: string }

export type ChatCheckout = { ok: true; root: string } | { ok: false; code: string; message: string }

/** What drafts this machine's text: the engine its settings resolve to, the CLI overrides and the writing style. */
export type PullRequestDraftEngine = {
  engine: TextGenerationEngine
  cliRuntimes?: TextGenerationCliRuntimeOverrides
  writingStyle: TextGenerationWritingStyle
}

export type ConversationPullRequestToolsDeps = {
  /** The folder a chat works in on this disk, or why it has none here. */
  checkoutOf(key: ChatKey): ChatCheckout
  creator: {
    state(cwd: string): Promise<CreatePullRequestState>
    draftInput(cwd: string): Promise<DraftInputOutcome>
    push(cwd: string, pin?: PullRequestCheckoutPin): Promise<PushForPullRequestOutcome>
    create(
      cwd: string,
      text: { title: string; body: string },
      pin?: PullRequestCheckoutPin,
    ): Promise<CreatePullRequestOutcome>
  }
  /** The engine this machine's settings draft with; null when text generation is off or no CLI can. */
  draftEngine(): PullRequestDraftEngine | null
  generate(request: PullRequestTextRequest): Promise<PullRequestTextResult>
  /** Record the pull request as the chat's, as the shell's "Create PR" records it (`pullRequests.link`). */
  link(input: {
    conversation: ChatKey
    url: string
    title: string
  }): Promise<{ ok: true } | { ok: false; message: string }>
  /** A draft that could not be written, for the diagnostics log. */
  log?(message: string): void
}

/**
 * The folder a chat works in, read from this machine's registry: its
 * worktree when it runs in one, else its workspace's folder. A workspace on
 * WSL or an SSH machine has its folder on that machine's disk, where this
 * process has no git to run.
 */
export function chatCheckoutFromRegistry(
  getRecord: (workspaceId: string) => WorkspaceRegistryRecord | null,
): (key: ChatKey) => ChatCheckout {
  return (key) => {
    const record = getRecord(key.workspaceId)
    if (!record)
      return { ok: false, code: 'unknown_workspace', message: `Workspace "${key.workspaceId}" is not known here.` }
    const agent = record.agents[key.agentId]
    if (!agent) return { ok: false, code: 'unknown_conversation', message: 'That chat is not known here.' }
    if (record.environment)
      return {
        ok: false,
        code: 'checkout_elsewhere',
        message: "That chat's checkout is on another machine, and Create PR works in this machine's checkouts only.",
      }
    const root = conversationWorkingRoot(agent, record.folderPath)
    if (!root) return { ok: false, code: 'workspace_without_folder', message: 'That chat has no folder here.' }
    return { ok: true, root }
  }
}

const ID_MAX = 200

const CHAT_PROPERTIES = {
  workspaceId: { type: 'string', description: 'The workspace id of the chat, as conversation.create answered it.' },
  agentId: { type: 'string', description: 'The agent id of the chat.' },
}

const PIN_PROPERTY = {
  type: 'object',
  description:
    'The branch and commit conversation.pull_request_state answered (`branch`, `headSha`). Refused once the ' +
    'checkout has moved off it, so nothing is pushed or opened that was not seen.',
  properties: { branch: { type: 'string' }, headSha: { type: 'string' } },
  required: ['branch', 'headSha'],
  additionalProperties: false,
}

function idArg(args: Record<string, unknown>, key: string): string | McpToolResult {
  const value = args[key]
  if (typeof value !== 'string' || !value || value.length > ID_MAX)
    return toolError('invalid_arguments', `"${key}" must be a non-empty string.`)
  return value
}

/** The chat a call names, held to the caller (`refuseAnotherChat`). */
function chatArg(args: Record<string, unknown>, context: McpConnectionContext | undefined): ChatKey | McpToolResult {
  const workspaceId = idArg(args, 'workspaceId')
  if (typeof workspaceId !== 'string') return workspaceId
  const agentId = idArg(args, 'agentId')
  if (typeof agentId !== 'string') return agentId
  const key = { workspaceId, agentId }
  return refuseAnotherChat(context, key) ?? key
}

/**
 * A paired device names a chat on this machine, and its grant is what
 * authorises it (`conversation:operate`, tailnet-scopes.ts). Anything on the
 * local socket acts on its own chat only: the conversation its launch token
 * proved, as `pull_request.link` records under. Without that proof there is no
 * chat it may push or open a pull request for.
 */
function refuseAnotherChat(context: McpConnectionContext | undefined, key: ChatKey): McpToolResult | null {
  if (context?.metadata.kind === 'remote-tailnet') return null
  const own = gatewayConversation(context)
  if (own && own.workspaceId === key.workspaceId && own.agentId === key.agentId) return null
  return toolError(
    'forbidden',
    own
      ? "An agent works on its own chat's pull request only, and this names another chat."
      : 'Only an agent SprintEngine Studio started works on a pull request here, and only on its own chat.',
  )
}

/** The pin a call carries: absent is the checkout as it stands; one that is not a pin is refused, never dropped. */
function pinArg(args: Record<string, unknown>): { pin: PullRequestCheckoutPin | undefined } | McpToolResult {
  if (args.pin === undefined) return { pin: undefined }
  const pin = readPullRequestCheckoutPin(args.pin)
  if (!pin) return toolError('invalid_arguments', '"pin" is the branch and commit the state answered.')
  return { pin }
}

const isResult = (value: object): value is McpToolResult => 'content' in value

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A chat a step cannot run for here: no such chat, or no checkout of it on this machine. */
export type ChatPullRequestRefusal = { ok: false; refused: { code: string; message: string } }

/**
 * The chat's "Create PR" steps, each in the chat's own checkout here: what
 * the gateway's tools answer a paired desktop with, and what the Studio
 * protocol's `pullRequests.createState`, `.draft`, `.draftCancel`, `.push` and
 * `.create` answer a client with. `caller` names who asks, so one caller's
 * cancel reaches only its own draft.
 */
export type ConversationPullRequests = {
  state(key: ChatKey): Promise<{ ok: true; state: CreatePullRequestState | null } | ChatPullRequestRefusal>
  draft(
    key: ChatKey,
    caller: string,
    draftId: string | null,
  ): Promise<StudioPullRequestDraftOutcome | ChatPullRequestRefusal>
  cancelDraft(key: ChatKey, caller: string, draftId: string): void
  push(key: ChatKey, pin?: PullRequestCheckoutPin): Promise<PushForPullRequestOutcome | ChatPullRequestRefusal>
  create(
    key: ChatKey,
    text: { title: string; body: string },
    pin?: PullRequestCheckoutPin,
  ): Promise<StudioPullRequestCreated | ChatPullRequestRefusal>
}

export const isChatPullRequestRefusal = (value: object): value is ChatPullRequestRefusal => 'refused' in value

export function createConversationPullRequests(deps: ConversationPullRequestToolsDeps): ConversationPullRequests {
  // Drafts in flight, by the caller, the chat and the id the caller gave each.
  const drafts = createDraftRuns()
  const draftKey = (caller: string, key: ChatKey, draftId: string) =>
    [caller, key.workspaceId, key.agentId, draftId].join('\0')
  const checkout = (key: ChatKey): { root: string } | ChatPullRequestRefusal => {
    const found = deps.checkoutOf(key)
    return found.ok ? { root: found.root } : { ok: false, refused: { code: found.code, message: found.message } }
  }
  return {
    async state(key) {
      const chat = checkout(key)
      if (isChatPullRequestRefusal(chat)) return chat
      const read = await deps.creator.state(chat.root).catch(() => null)
      // No path on this machine in the answer.
      return { ok: true, state: read ? { ...read, gitRoot: null } : null }
    },
    async draft(key, caller, draftId) {
      const chat = checkout(key)
      if (isChatPullRequestRefusal(chat)) return chat
      const engine = deps.draftEngine()
      if (!engine)
        return {
          ok: false,
          code: 'text_generation_off',
          message:
            'Text generation is off on this machine (Settings → Agents → Text generation), so write the title and description yourself.',
        }
      const result = await drafts.run(
        draftId === null ? null : draftKey(caller, key, draftId),
        async (signal): Promise<PullRequestTextResult> => {
          const gathered = await deps.creator.draftInput(chat.root)
          if (!gathered.ok) return { ok: false, code: 'unsupported', message: gathered.message }
          return deps.generate({
            input: { ...gathered.input, style: engine.writingStyle },
            engine: engine.engine,
            ...(engine.cliRuntimes ? { cliRuntimes: engine.cliRuntimes } : {}),
            signal,
          })
        },
      )
      if (result.ok) return { ok: true, title: result.value.title, body: result.value.body }
      if (result.code !== 'cancelled') deps.log?.(`${engine.engine.cli}: ${result.code} — ${result.message}`)
      return { ok: false, code: result.code === 'cancelled' ? 'cancelled' : 'draft_failed', message: result.message }
    },
    cancelDraft(key, caller, draftId) {
      drafts.cancel(draftKey(caller, key, draftId))
    },
    async push(key, pin) {
      const chat = checkout(key)
      if (isChatPullRequestRefusal(chat)) return chat
      return deps.creator
        .push(chat.root, pin)
        .catch((error: unknown): PushForPullRequestOutcome => ({ ok: false, message: describe(error) }))
    },
    async create(key, input, pin) {
      const chat = checkout(key)
      if (isChatPullRequestRefusal(chat)) return chat
      const text = {
        title: input.title.trim().slice(0, PULL_REQUEST_TITLE_MAX_CHARS),
        body: input.body.slice(0, PULL_REQUEST_BODY_MAX_CHARS),
      }
      const outcome = await deps.creator
        .create(chat.root, text, pin)
        .catch((error: unknown): CreatePullRequestOutcome => ({ ok: false, message: describe(error) }))
      if (!outcome.ok || outcome.kind !== 'created') return outcome
      // Recorded here, where the chat's record is; a failure to record is
      // said with the address, since the pull request exists either way.
      const linked = await deps
        .link({ conversation: key, url: outcome.url, title: text.title })
        .catch((error: unknown) => ({ ok: false as const, message: describe(error) }))
      return {
        ...outcome,
        recorded: linked.ok,
        ...(linked.ok
          ? {}
          : {
              recordMessage: `The pull request is open (${outcome.url}), but it could not be recorded: ${linked.message}`,
            }),
      }
    },
  }
}

export function createConversationPullRequestTools(deps: ConversationPullRequestToolsDeps): McpToolRegistration[] {
  const pullRequests = createConversationPullRequests(deps)
  // One device's cancel reaches only its own draft.
  const callerOf = (context: McpConnectionContext | undefined) =>
    context?.metadata.deviceId ?? context?.metadata.kind ?? 'local'
  const refusal = (refused: ChatPullRequestRefusal) => toolError(refused.refused.code, refused.refused.message)

  const state: McpToolRegistration = {
    name: CONVERSATION_PULL_REQUEST_STATE_TOOL,
    description:
      "Whether a chat's checkout is ready for a pull request, as the chat's Create PR button asks: `state` is null " +
      'when the folder is not a checkout, else `readiness` (`ready`, or the `reason` it is not), the `branch` and ' +
      '`headSha` to pin the push and the creation to, `base`, `forge`, and how many `uncommittedChanges` the pull ' +
      'request would leave out.',
    inputSchema: {
      type: 'object',
      properties: CHAT_PROPERTIES,
      required: ['workspaceId', 'agentId'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const key = chatArg(args, context)
      if (isResult(key)) return key
      const read = await pullRequests.state(key)
      if (isChatPullRequestRefusal(read)) return refusal(read)
      return toolSuccess({ ok: true, ...key, state: read.state })
    },
  }

  const draft: McpToolRegistration = {
    name: CONVERSATION_PULL_REQUEST_DRAFT_TOOL,
    description:
      "Draft a pull request's `title` and `body` from the chat's branch (its commits, diff and the repository's " +
      'template) with this machine\'s text generation settings. Refused with "text_generation_off" where they are ' +
      'off or no CLI here can write one. Name it with `draftId` to stop it with conversation.pull_request_draft_cancel.',
    inputSchema: {
      type: 'object',
      properties: {
        ...CHAT_PROPERTIES,
        draftId: { type: 'string', description: 'A name for this draft, to cancel it by.' },
      },
      required: ['workspaceId', 'agentId'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const key = chatArg(args, context)
      if (isResult(key)) return key
      if (
        args.draftId !== undefined &&
        (typeof args.draftId !== 'string' || !args.draftId || args.draftId.length > ID_MAX)
      )
        return toolError('invalid_arguments', '"draftId" must be a non-empty string when provided.')
      const draftId = typeof args.draftId === 'string' ? args.draftId : null
      const result = await pullRequests.draft(key, callerOf(context), draftId)
      if (isChatPullRequestRefusal(result)) return refusal(result)
      if (!result.ok) return toolError(result.code, result.message)
      return toolSuccess({ ok: true, title: result.title, body: result.body })
    },
  }

  const draftCancel: McpToolRegistration = {
    name: CONVERSATION_PULL_REQUEST_DRAFT_CANCEL_TOOL,
    description: 'Stop a draft conversation.pull_request_draft is writing, by the `draftId` it was given.',
    inputSchema: {
      type: 'object',
      properties: { ...CHAT_PROPERTIES, draftId: { type: 'string', description: 'The draft to stop.' } },
      required: ['workspaceId', 'agentId', 'draftId'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const key = chatArg(args, context)
      if (isResult(key)) return key
      const draftId = idArg(args, 'draftId')
      if (typeof draftId !== 'string') return draftId
      pullRequests.cancelDraft(key, callerOf(context), draftId)
      return toolSuccess({ ok: true })
    },
  }

  const push: McpToolRegistration = {
    name: CONVERSATION_PULL_REQUEST_PUSH_TOOL,
    description:
      "Push the chat's branch to its own name on its push remote when that does not have all of it, as Create PR " +
      'does before it opens the pull request. `pushed` says whether anything went.',
    inputSchema: {
      type: 'object',
      properties: { ...CHAT_PROPERTIES, pin: PIN_PROPERTY },
      required: ['workspaceId', 'agentId'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const key = chatArg(args, context)
      if (isResult(key)) return key
      const pinned = pinArg(args)
      if (isResult(pinned)) return pinned
      const pushed = await pullRequests.push(key, pinned.pin)
      if (isChatPullRequestRefusal(pushed)) return refusal(pushed)
      if (!pushed.ok) return toolError('push_failed', pushed.message)
      return toolSuccess({ ok: true, pushed: pushed.pushed })
    },
  }

  const create: McpToolRegistration = {
    name: CONVERSATION_PULL_REQUEST_CREATE_TOOL,
    description:
      "Open a pull request from the chat's branch with the forge's CLI (gh, glab or tea), as Create PR does. " +
      "`kind` is `created` (recorded as the chat's; `recorded` says whether that landed), `existing` (the branch " +
      "had one, not claimed for the chat), `page` (the forge's own page to finish it on, with `place` and why in " +
      "`reason`) or `list` (probably opened, address unknown: the forge's list to look in).",
    inputSchema: {
      type: 'object',
      properties: {
        ...CHAT_PROPERTIES,
        title: { type: 'string', description: "The pull request's title." },
        body: { type: 'string', description: 'Its description, in Markdown.' },
        pin: PIN_PROPERTY,
      },
      required: ['workspaceId', 'agentId', 'title', 'body'],
      additionalProperties: false,
    },
    handler: async (args, context) => {
      const key = chatArg(args, context)
      if (isResult(key)) return key
      if (typeof args.title !== 'string' || !args.title.trim() || typeof args.body !== 'string')
        return toolError('invalid_arguments', '"title" and "body" are the pull request\'s text.')
      const pinned = pinArg(args)
      if (isResult(pinned)) return pinned
      const outcome = await pullRequests.create(key, { title: args.title, body: args.body }, pinned.pin)
      if (isChatPullRequestRefusal(outcome)) return refusal(outcome)
      if (!outcome.ok) return toolError('create_failed', outcome.message)
      return toolSuccess({ ...outcome })
    },
  }

  return [state, draft, draftCancel, push, create]
}
