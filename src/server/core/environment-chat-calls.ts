import { randomUUID } from 'node:crypto'

import { StudioError } from '../../../packages/client-runtime/src/public'
import {
  parseEnvironmentRoute,
  STUDIO_CHAT_LIFECYCLE_CAPABILITY,
  STUDIO_COMMAND_METHODS,
  STUDIO_CONVERSATION_CREATE_CAPABILITY,
  type StudioCapability,
  type StudioCommandMethod,
  type StudioMethod,
  type StudioMethodParams,
  type StudioMethodResult,
} from '../../../packages/studio-protocol/src/public'
import type { ConversationCommand } from '../../../packages/conversation-protocol/src/public'
import type { ConversationEvent, ConversationKey } from '../../shared/conversation-runtime'
import { environmentRouteOfRecord, type EnvironmentClients } from '../../shared/environment-clients'
import type { ConversationGatewayCommandResult } from './conversation-host'
import type { ConversationLaunchResult } from '../../main/conversation-launch-service'
import type { McpConnectionContext } from '../../shared/modules/mcp-tools'
import type {
  ChatLifecycleCalls,
  ChatPlace,
  ConversationEnvironments,
  EnvironmentLaunchRequest,
} from '../../main/automation/conversation-tools'

type EnvironmentRecord = NonNullable<Parameters<typeof environmentRouteOfRecord>[0]>

// A chat another environment holds, acted on from this desktop's own callers
// (the gateway's conversation tools, modules): the same protocol method a
// window sends, on this desktop's own client of that environment's Studio
// (`EnvironmentClients`), never through this core's runtime (orchestrator
// ruling 1). No server-to-server call, no routing table: the route is the
// chat's record's. A machine that cannot be reached is said so in words.

/** The method a conversation command is on a Studio, by its kind. */
const COMMAND_METHOD_OF = new Map<string, StudioCommandMethod>(
  Object.entries(STUDIO_COMMAND_METHODS).map(([method, kind]): [string, StudioCommandMethod] => [
    kind,
    method as StudioCommandMethod,
  ]),
)

/** One command carried out on the environment that holds the chat, answered as this core's host answers it. */
export async function environmentCommand(
  clients: EnvironmentClients | null,
  route: string,
  key: ConversationKey,
  commandId: string,
  command: ConversationCommand,
): Promise<ConversationGatewayCommandResult> {
  const method = COMMAND_METHOD_OF.get(command.kind)
  if (!method)
    return { ok: false, code: 'invalid_frame', message: `A chat on another machine cannot ${command.kind} from here.` }
  const reached = await clients?.clientFor(route)
  if (!reached) return { ok: false, code: 'unavailable', message: 'That machine cannot be reached from this computer.' }
  if (!reached.ok) return { ok: false, code: 'unavailable', message: reached.message }
  const { kind: _kind, ...members } = command
  try {
    const answer = (await (reached.client.request as (method: string, params: unknown) => Promise<unknown>)(method, {
      key: { workspaceId: key.workspaceId, agentId: key.agentId, workspaceRoot: key.workspaceRoot },
      commandId,
      ...members,
    })) as { notice?: string } | null
    return { ok: true, ...(answer?.notice ? { notice: answer.notice } : {}) }
  } catch (error) {
    return {
      ok: false,
      ...(error instanceof StudioError ? { code: error.code as ConversationGatewayCommandResult['code'] } : {}),
      message: `${reached.name}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** A page of a chat's transcript, read on the environment that holds it. */
export async function environmentPage(
  clients: EnvironmentClients | null,
  route: string,
  key: ConversationKey,
  page: { before?: number; turns: number },
): Promise<
  { ok: true; events: ConversationEvent[]; hasMore: boolean; before: number | null } | { ok: false; message: string }
> {
  const reached = await clients?.clientFor(route)
  if (!reached) return { ok: false, message: 'That machine cannot be reached from this computer.' }
  if (!reached.ok) return { ok: false, message: reached.message }
  const read = await reached.client.conversations
    .loadEarlier(
      { workspaceId: key.workspaceId, agentId: key.agentId, workspaceRoot: key.workspaceRoot },
      page.before ?? Number.MAX_SAFE_INTEGER,
      page.turns,
    )
    .catch((error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : String(error),
    }))
  if (!read.ok) return { ok: false, message: `${reached.name}: ${read.message}` }
  return {
    ok: true,
    events: read.page.events as ConversationEvent[],
    hasMore: read.page.hasMore,
    before: read.page.beforeCursor,
  }
}

const UNREACHABLE = 'That machine cannot be reached from this computer.'
const PAIRED_DESKTOP =
  "That chat is on a paired desktop, which an agent here cannot reach: open it on that desktop, or from this computer's window."
const DEVICE_RELAY =
  'That chat is on another machine this computer connects to, and a paired device cannot reach it through this computer. Ask that machine, or use one of this computer’s own projects.'

/**
 * The other environments this computer reaches, as the agents' conversation
 * tools ask them: where a chat lives (`place`, the one lookup every chat tool
 * goes through), and the calls a chat's lifecycle and a new chat make on the
 * Studio there, with the same protocol methods a window sends.
 *
 * A chat is named by its address: this Studio's own id is this core; another
 * environment's id is routed by the shell's environment registry (`routesOf`).
 * Only an SSH machine's or a WSL distribution's Studio has a client here; a
 * paired desktop's chat is refused in words. Until the copies go
 * (design-environments PR 3c-5), a copy's workspace id is turned into its
 * machine's route by its record, here and nowhere else.
 *
 * Only for this machine's own callers: a call goes out on this desktop's owner
 * connection to that machine, so a paired device asking for it would be
 * driving the SSH machine or the WSL distribution through the desktop, the
 * relay the protocol does not offer devices. A device's call naming another
 * machine is refused before any connection is chosen.
 */
export function chatEnvironments(deps: {
  clients: EnvironmentClients | null
  /** This Studio's own environment id. */
  ownEnvironmentId: () => string
  /** The routes this computer reaches an environment by, best first; none for one it does not know. */
  routesOf: ((environmentId: string) => Promise<readonly string[]>) | null
  /** A workspace's record here, if this core holds one. */
  recordOf: (workspaceId: string) => (EnvironmentRecord & { remoteOrigin?: unknown }) | null
}): ConversationEnvironments {
  const place = async (
    where: { environmentId: string | null; chatId: string | null },
    caller?: McpConnectionContext,
  ): Promise<ChatPlace> => {
    const { environmentId, chatId } = where
    let route: string | null
    if (environmentId === null || environmentId === deps.ownEnvironmentId()) {
      const record = chatId ? deps.recordOf(chatId) : null
      if (record?.remoteOrigin) return { ok: false, code: 'unavailable', message: PAIRED_DESKTOP }
      // A copy of a machine's chat (until 3c-5) is that machine's, under the same id.
      route = environmentRouteOfRecord(record)
    } else {
      const routes = (await deps.routesOf?.(environmentId).catch(() => [])) ?? []
      if (routes.length === 0)
        return {
          ok: false,
          code: 'unknown_environment',
          message: `This computer knows no machine whose environment id is "${environmentId}".`,
        }
      route =
        routes.find((each) => {
          const kind = parseEnvironmentRoute(each)?.kind
          return kind === 'ssh' || kind === 'wsl'
        }) ?? null
      if (!route) return { ok: false, code: 'unavailable', message: PAIRED_DESKTOP }
    }
    if (route && caller?.metadata.kind === 'remote-tailnet')
      return { ok: false, code: 'tailnet_local_only', message: DEVICE_RELAY }
    return { ok: true, route, workspaceId: chatId }
  }

  // One method on the Studio a route reaches, its refusal in that machine's words.
  const ask = async <M extends StudioMethod>(
    route: string,
    capability: StudioCapability | null,
    method: M,
    params: StudioMethodParams<M>,
  ): Promise<{ ok: true; answer: StudioMethodResult<M> } | { ok: false; code: string; message: string }> => {
    const reached = await deps.clients?.clientFor(route, capability)
    if (!reached) return { ok: false, code: 'unavailable', message: UNREACHABLE }
    if (!reached.ok) return { ok: false, code: 'unavailable', message: reached.message }
    try {
      return { ok: true, answer: await reached.client.request(method, params) }
    } catch (error) {
      const code = error instanceof StudioError ? error.code : 'unavailable'
      return {
        ok: false,
        // A chat that machine does not hold is named as one this machine does not.
        code: code === 'not_found' ? 'unknown_workspace' : code,
        message: `${reached.name}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  const lifecycle = (route: string): ChatLifecycleCalls => ({
    settle: async (workspaceId, settled) => {
      const done = await ask(route, null, 'conversation.settle', {
        workspaceId,
        commandId: randomUUID(),
        settled,
      })
      return done.ok ? { ok: true, workspaceId, settledAt: done.answer.settledAt } : done
    },
    visit: async (workspaceId, visitedAt) => {
      const done = await ask(route, null, 'conversation.visit', {
        workspaceId,
        ...(visitedAt === undefined ? {} : { visitedAt }),
      })
      return done.ok ? { ok: true, workspaceId, lastVisitedAt: done.answer.lastVisitedAt } : done
    },
    markUnread: async (workspaceId) => {
      const done = await ask(route, STUDIO_CHAT_LIFECYCLE_CAPABILITY, 'conversation.markUnread', {
        workspaceId,
        commandId: randomUUID(),
      })
      return done.ok ? { ok: true, workspaceId, lastVisitedAt: done.answer.lastVisitedAt } : done
    },
    snooze: async (workspaceId, until) => {
      const done = await ask(route, STUDIO_CHAT_LIFECYCLE_CAPABILITY, 'conversation.snooze', {
        workspaceId,
        commandId: randomUUID(),
        until,
      })
      return done.ok ? { ok: true, workspaceId, snoozedUntil: done.answer.snoozedUntil } : done
    },
    highlight: async (workspaceId, change) => {
      const done = await ask(route, STUDIO_CHAT_LIFECYCLE_CAPABILITY, 'conversation.highlight', {
        workspaceId,
        commandId: randomUUID(),
        ...change,
      })
      return done.ok ? { ok: true, workspaceId, starred: done.answer.starred, color: done.answer.color } : done
    },
    setAutoSettle: async (workspaceId, enabled) => {
      const done = await ask(route, STUDIO_CHAT_LIFECYCLE_CAPABILITY, 'conversation.setAutoSettle', {
        workspaceId,
        commandId: randomUUID(),
        enabled,
      })
      return done.ok ? { ok: true, workspaceId, autoSettle: done.answer.enabled } : done
    },
  })

  const launch = async (route: string, request: EnvironmentLaunchRequest): Promise<ConversationLaunchResult> => {
    const created = await ask(route, STUDIO_CONVERSATION_CREATE_CAPABILITY, 'conversation.create', {
      commandId: request.launchCommandId ?? randomUUID(),
      ...(request.noProject ? { noProject: true as const } : { workspaceId: request.workspaceId }),
      ...(request.newChat ? { newChat: true } : {}),
      ...(request.newWorktree ? { worktree: true } : {}),
      ...(request.worktreeName ? { worktreeName: request.worktreeName } : {}),
      ...(request.existingWorktreePath ? { inWorktree: request.existingWorktreePath } : {}),
      ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
      // Judged there as its own creates are; a Studio there too old to take
      // it is refused by the client before anything is sent (`new-chat-mode`).
      ...(request.mode === 'plan' || request.mode === 'ask' ? { mode: request.mode } : {}),
      ...(request.cli ? { cli: request.cli } : {}),
      ...(request.cliModel ? { model: request.cliModel } : {}),
      ...(request.prompt ? { prompt: request.prompt } : {}),
      ...(request.name ? { name: request.name } : {}),
      ...(request.skills?.length ? { skills: request.skills } : {}),
      ...(request.permissionPreset ? { permissionPreset: request.permissionPreset } : {}),
      ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}),
      ...(request.allowedTools?.length ? { allowedTools: request.allowedTools } : {}),
    })
    if (!created.ok) return created
    const chat = created.answer.conversation
    return {
      ok: true,
      workspaceId: chat.workspaceId,
      agentId: chat.agentId,
      name: chat.name,
      cli: chat.cli,
      providerId: chat.providerId,
      modelId: chat.modelId,
      sessionId: chat.sessionId ?? '',
      ...(chat.worktree ? { worktree: chat.worktree } : {}),
    }
  }

  return { place, lifecycle, launch }
}
