import type {
  ConversationWirePermissionPreset,
  StudioCreatedConversation,
} from '../../../packages/studio-protocol/src/public'
import type { AgentState } from '../../shared/agent-state'
import { cliForConversationProvider } from '../../shared/conversation-harness'
import type {
  ConversationListSessionsInput,
  ConversationListSessionsResult,
  ConversationSessionActionResult,
  ConversationStopSessionInput,
} from '../../shared/conversation-runtime'
import { DEFAULT_AGENT_SPAWN_PERMISSION_PRESET } from '../../shared/launch-settings'
import type { StudioConversationBackend } from '../../server/rpc/studio-rpc-types'
import type { ConversationGatewayHost } from '../automation/tailnet/tailnet-conversation-host'
import { redactConversationValue } from '../conversation-tool-details'
import type { ConversationLaunchRequest, ConversationLaunchResult } from '../conversation-launch-service'
import type { ConversationLifecycle } from '../automation/conversation-lifecycle'

// The conversations the Studio RPC serves, in main: the conversation host the
// tailnet lane wraps (list, follow, reads and commands, with its session
// resume and catalog checks), the launch service a module's and a paired
// machine's New chat go through, and the runtime for stop. One chat behaves
// the same whichever door it is reached by.

export type StudioConversationBackendDeps = {
  host: ConversationGatewayHost
  launch: (request: ConversationLaunchRequest) => Promise<ConversationLaunchResult>
  listSessions: (input?: ConversationListSessionsInput) => ConversationListSessionsResult
  stopSession: (input: ConversationStopSessionInput) => Promise<ConversationSessionActionResult>
  /** Every workspace with its agent records, read fresh on each call. */
  getWorkspaceAgents: () => ReadonlyArray<{ id: string; agents: Record<string, AgentState> }>
  /**
   * A chat's rest and visit clock, written to Studio's own record as the
   * gateway's `conversation.settle` and `conversation.visit` write it: an
   * owner's write as the gateway's, a paired client's as a paired device's.
   */
  lifecycle?: Pick<ConversationLifecycle, 'settle' | 'visit'>
}

/**
 * The client that started a conversation, read off its record: a chat a
 * client starts is launched under its namespaced command id (`owner:<id>`, or
 * `client:<clientId>:<id>` for a paired app), which the record keeps. Null for
 * a chat started in Studio itself.
 */
export function conversationStartedBy(
  workspaces: ReadonlyArray<{ id: string; agents: Record<string, AgentState> }>,
  key: { workspaceId: string; agentId: string },
): string | null {
  const launched = workspaces.find((workspace) => workspace.id === key.workspaceId)?.agents[key.agentId]
    ?.launchCommandId
  if (typeof launched !== 'string') return null
  if (launched.startsWith('owner:')) return 'owner'
  const client = /^client:([^:]+):/.exec(launched)
  return client ? client[1] : null
}

export function createStudioConversationBackend(deps: StudioConversationBackendDeps): StudioConversationBackend {
  const { host } = deps
  const liveSessions = (key: { workspaceId: string; agentId: string }) => {
    const listed = deps.listSessions({ workspaceId: key.workspaceId, agentId: key.agentId })
    return listed.ok ? listed.sessions.filter((session) => session.status !== 'stopped') : []
  }
  return {
    list: () => host.list(),
    resolveKey: (workspaceId, agentId) => host.resolveKey(workspaceId, agentId),
    follow: (key, cursor, listener) => host.subscribe(key, cursor, listener),
    loadEarlier: (key, beforeCursor, turnLimit) => host.loadEarlier(key, beforeCursor, turnLimit),
    toolDetail: (key, toolUseId) => host.getToolDetail(key, toolUseId),
    event: (key, seq, id) => host.getEvent(key, seq, id),
    turnDiff: (key, turnSeq, path) => host.getTurnDiff(key, turnSeq, path),
    command: (key, clientId, commandId, command, fingerprint) =>
      host.command(key, clientId, commandId, command, fingerprint),
    // The newest live session, as a send reaches it, through the receipts.
    async stop(key, commandId, fingerprint) {
      const live = liveSessions(key).sort((a, b) => b.createdAt - a.createdAt)[0]
      if (!live) return { ok: true }
      const stopped = await deps.stopSession({
        sessionId: live.sessionId,
        commandId,
        ...(fingerprint ? { commandFingerprint: fingerprint } : {}),
      })
      return stopped.ok
        ? { ok: true }
        : { ok: false, message: stopped.message, ...(stopped.code ? { code: stopped.code } : {}) }
    },
    // How loose the chat runs, for a ceiling: its preset, except that a
    // session started with tools it may use unasked runs those tools as
    // `bypass` would, and so counts as `bypass`.
    permissionOf: (key) =>
      liveSessions(key).some((session) => session.allowsUnaskedTools)
        ? 'bypass'
        : ((host.permissionOf?.(key) ?? DEFAULT_AGENT_SPAWN_PERMISSION_PRESET) as ConversationWirePermissionPreset),
    findCreated(launchCommandId) {
      for (const workspace of deps.getWorkspaceAgents()) {
        for (const agent of Object.values(workspace.agents)) {
          if (agent?.launchCommandId !== launchCommandId || agent.runtimeKind !== 'conversation') continue
          const live = liveSessions({ workspaceId: workspace.id, agentId: agent.id }).sort(
            (a, b) => b.createdAt - a.createdAt,
          )[0]
          const providerId = live?.providerId ?? agent.conversation?.providerId ?? ''
          const preset = live?.permissionPreset ?? agent.cliPermissionPreset
          return {
            workspaceId: workspace.id,
            agentId: agent.id,
            sessionId: live?.sessionId ?? null,
            name: agent.name,
            cli: cliForConversationProvider(providerId) ?? providerId,
            providerId,
            modelId: live?.modelId ?? agent.conversation?.modelId ?? '',
            ...(preset ? { permissionPreset: preset } : {}),
          } satisfies StudioCreatedConversation
        }
      }
      return null
    },
    async create(request, launchCommandId) {
      const launched = await deps.launch({
        workspaceId: request.workspaceId,
        ...(request.cli ? { cli: request.cli } : {}),
        ...(request.model ? { cliModel: request.model } : {}),
        ...(request.prompt ? { prompt: request.prompt } : {}),
        ...(request.name ? { name: request.name } : {}),
        ...(request.skills?.length ? { skills: request.skills } : {}),
        ...(request.permissionPreset ? { permissionPreset: request.permissionPreset } : {}),
        ...(request.permissionPreset && request.permissionMode ? { permissionMode: request.permissionMode } : {}),
        ...(request.allowedTools?.length ? { allowedTools: request.allowedTools } : {}),
        launchCommandId,
      })
      if (!launched.ok) return { ok: false, code: launched.code, message: launched.message }
      const record = deps.getWorkspaceAgents().find((workspace) => workspace.id === launched.workspaceId)?.agents[
        launched.agentId
      ]
      const preset = record?.cliPermissionPreset ?? request.permissionPreset
      return {
        ok: true,
        conversation: {
          workspaceId: launched.workspaceId,
          agentId: launched.agentId,
          sessionId: launched.sessionId,
          name: launched.name,
          cli: launched.cli,
          providerId: launched.providerId,
          modelId: launched.modelId,
          ...(preset ? { permissionPreset: preset } : {}),
          ...(preset && record?.cliPermissionMode ? { permissionMode: record.cliPermissionMode } : {}),
        },
      }
    },
    // The tailnet lane's redaction of secret-shaped members, for events, pages,
    // tool details and diffs alike. Paths stay as they are, because a client on
    // this machine reads this machine's files; the tailnet lane rewrites them
    // for a reader elsewhere.
    redact: (value) => redactConversationValue(value),
    // The same host's per-chat reads and watches the tailnet lane serves, and
    // the record's lifecycle the gateway's tools write.
    followed: {
      ...(host.watchQueued ? { watchQueued: (chat, listener) => host.watchQueued!(chat, listener) } : {}),
      ...(host.watchScheduled ? { watchScheduled: (chat, listener) => host.watchScheduled!(chat, listener) } : {}),
      ...(host.watchUsageLimits
        ? { watchUsageLimits: (chat, listener) => host.watchUsageLimits!(chat, listener) }
        : {}),
      ...(host.watchSubagents ? { watchSubagents: (chat, listener) => host.watchSubagents!(chat, listener) } : {}),
      ...(host.watchChanges ? { watchChanges: (chat, listener) => host.watchChanges!(chat, listener) } : {}),
      ...(host.changesDiff ? { changesDiff: (chat, selection) => host.changesDiff!(chat, selection) } : {}),
      ...(host.changedFile ? { changedFile: (chat, selection, path) => host.changedFile!(chat, selection, path) } : {}),
      ...(host.askSideQuestion
        ? {
            askSideQuestion: (key, clientId, questionId, question, history) =>
              host.askSideQuestion!(key, clientId, questionId, question, history),
          }
        : {}),
      ...(host.cancelSideQuestion
        ? { cancelSideQuestion: (clientId, questionId) => host.cancelSideQuestion!(clientId, questionId) }
        : {}),
      ...(host.contextBreakdown ? { contextBreakdown: (key) => host.contextBreakdown!(key) } : {}),
      ...(host.searchFiles
        ? { searchFiles: (key, clientId, query, limit) => host.searchFiles!(key, clientId, query, limit) }
        : {}),
      ...(host.listCommands ? { listCommands: (key, refresh) => host.listCommands!(key, refresh) } : {}),
      ...(deps.lifecycle
        ? {
            settle: (chat, settled, byOwner) => {
              const done = deps.lifecycle!.settle(chat.workspaceId, settled, byOwner ? 'gateway' : 'mobile')
              return done.ok ? { ok: true, settledAt: done.settledAt } : done
            },
            visit: (chat, visitedAt, byOwner) => {
              const done = deps.lifecycle!.visit(chat.workspaceId, visitedAt, byOwner ? 'gateway' : 'mobile')
              return done.ok ? { ok: true, lastVisitedAt: done.lastVisitedAt } : done
            },
          }
        : {}),
    },
  }
}
