import { randomUUID } from 'node:crypto'

import { StudioError } from '../../../packages/client-runtime/src/public'
import { STUDIO_COMMAND_METHODS, type StudioCommandMethod } from '../../../packages/studio-protocol/src/public'
import type { ConversationCommand } from '../../../packages/conversation-protocol/src/public'
import type { ConversationEvent, ConversationKey } from '../../shared/conversation-runtime'
import { environmentRouteOfRecord, type EnvironmentClients } from '../../shared/environment-clients'
import type { ConversationGatewayCommandResult } from '../../main/automation/tailnet/tailnet-conversation-host'
import type { ConversationLaunchRequest, ConversationLaunchResult } from '../../main/conversation-launch-service'

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

/**
 * Launch a chat as this core does, or, when the workspace it joins is another
 * environment's (an SSH machine's copy here), there: `conversation.create` on
 * that environment's Studio, answered as this core's launch answers.
 */
export function launchWhereItLives(
  clients: EnvironmentClients | null,
  recordOf: (workspaceId: string) => Parameters<typeof environmentRouteOfRecord>[0] | null,
  launchHere: (request: ConversationLaunchRequest) => Promise<ConversationLaunchResult>,
): (request: ConversationLaunchRequest) => Promise<ConversationLaunchResult> {
  return async (request) => {
    const route = request.workspaceId ? environmentRouteOfRecord(recordOf(request.workspaceId)) : null
    if (!route || !request.workspaceId) return launchHere(request)
    // What only this desktop's own launch carries has no place in a create there.
    if (request.subagentOf || request.attachments?.length || request.scheduledAgentId || request.ownerModuleId)
      return {
        ok: false,
        code: 'invalid_arguments',
        message: 'That chat runs on another machine: start this kind of chat in one of this computer’s projects.',
      }
    const reached = await clients?.clientFor(route)
    if (!reached)
      return { ok: false, code: 'unavailable', message: 'That machine cannot be reached from this computer.' }
    if (!reached.ok) return { ok: false, code: 'unavailable', message: reached.message }
    try {
      const created = await reached.client.request('conversation.create', {
        commandId: request.launchCommandId ?? randomUUID(),
        workspaceId: request.workspaceId,
        ...(request.newChat ? { newChat: true } : {}),
        ...(request.newWorktree ? { worktree: true } : {}),
        ...(request.worktreeName ? { worktreeName: request.worktreeName } : {}),
        ...(request.existingWorktreePath ? { inWorktree: request.existingWorktreePath } : {}),
        ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
        ...(request.cli ? { cli: request.cli } : {}),
        ...(request.cliModel ? { model: request.cliModel } : {}),
        ...(request.prompt ? { prompt: request.prompt } : {}),
        ...(request.name ? { name: request.name } : {}),
        ...(request.skills?.length ? { skills: request.skills } : {}),
        ...(request.permissionPreset ? { permissionPreset: request.permissionPreset } : {}),
        ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}),
        ...(request.allowedTools?.length ? { allowedTools: request.allowedTools } : {}),
      })
      const chat = created.conversation
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
    } catch (error) {
      return {
        ok: false,
        code: error instanceof StudioError ? error.code : 'launch_failed',
        message: `${reached.name}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
}
