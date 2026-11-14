import type { ScheduledAgentsService } from '../../main/scheduled-agents/service'
import type { ScheduledMessages } from '../../main/scheduled-messages/scheduled-messages'
import type { UsageLimitResumer } from '../../main/usage-limits/resume'
import type { WorkspaceRegistryService } from '../../main/workspace-registry-service'
import { environmentRouteOfRecord } from '../../shared/environment-clients'
import { isMachinePath } from '../../shared/machine-paths'
import { machineRouteOfPath } from '../../shared/machine-spelling'
import { parseEnvironmentRoute } from '../../../packages/studio-protocol/src/environment'
import type { PullRequestRecord } from '../pull-requests/pull-request-record'
import type { ConversationApprovalRuleStore } from '../../main/conversation-approval-rules'
import { conversationWorkingRoot } from '../../shared/agent-state'
import type { EnvironmentMigrationStores, MigratingRecord } from './environment-migration'
import type { ChatSourceFile } from './environment-chat-sources'

// This desktop's stores as the hand-over reads and empties them
// (environment-migration.ts): each record that names a chat or folder another
// environment holds, found by the chat's record here (its `environment`, or
// a WSL workspace's `hostId`) or by its folder (`ssh://<id>/…`, a WSL share),
// and taken out through the store's own way.

export function studioMigrationStores(stores: {
  workspaceRegistry: Pick<WorkspaceRegistryService, 'getRecords'>
  scheduledAgents: Pick<ScheduledAgentsService, 'loaded' | 'list' | 'remove'>
  scheduledMessages: Pick<ScheduledMessages, 'state' | 'carriedOf' | 'update' | 'loaded'>
  usageLimitResumes: Pick<UsageLimitResumer, 'state' | 'update'>
  pullRequests: Pick<PullRequestRecord, 'whenLoaded' | 'handingOver' | 'letGo'>
  /** The pictures a schedule's prompt names from this desktop's data directory (`keptImagesIn`). */
  scheduledImages?: (prompt: string) => Promise<Array<{ path: string; name: string; mediaType: string }>>
  /**
   * What a chat this desktop ran itself in a WSL distribution's folders keeps
   * here that the distribution does not have (environment-chat-sources.ts).
   */
  chatSources?: (chat: {
    distro: string
    workspaceRoot: string
    workspaceId: string
    agentId: string
  }) => Promise<ChatSourceFile[]>
  /** This desktop's saved approvals, and the way one is let go. */
  approvalRules?: Pick<ConversationApprovalRuleStore, 'list' | 'revoke'>
}): EnvironmentMigrationStores {
  return {
    async collect(workspacesOf) {
      const found: MigratingRecord[] = []
      // The chats another environment holds, by the route of their record here.
      const routeOfWorkspace = new Map<string, string>()
      // The folders a WSL workspace's chats work in, by route.
      const rootsOf = new Map<string, string>()
      for (const record of stores.workspaceRegistry.getRecords()) {
        const route = environmentRouteOfRecord(record)
        if (!route) continue
        routeOfWorkspace.set(record.id, route)
        if (!workspacesOf(route)) continue
        found.push({ route, kind: 'workspace', id: record.id, body: record as unknown as Record<string, unknown> })
        // A WSL workspace's chats ran through `wsl.exe` on this desktop, which
        // kept their files: they go with the record, with the folders they work in.
        const distro = parseEnvironmentRoute(route)
        if (distro?.kind !== 'wsl') continue
        for (const [agentId, agent] of Object.entries(record.agents ?? {})) {
          const workspaceRoot = conversationWorkingRoot(agent, record.folderPath)
          if (!workspaceRoot) continue
          rootsOf.set(workspaceRoot, route)
          if (!agent.conversation || !stores.chatSources) continue
          const files = await stores.chatSources({
            distro: distro.distro,
            workspaceRoot,
            workspaceId: record.id,
            agentId,
          })
          if (files.length)
            found.push({
              route,
              kind: 'chat',
              id: `${record.id}:${agentId}`,
              body: { workspaceId: record.id, agentId, workspaceRoot },
              chatFiles: files,
            })
        }
        if (record.folderPath) rootsOf.set(record.folderPath, route)
      }
      // The approvals saved for the folders those chats work in. (A share's
      // folder a chat on This PC works in keeps its own: decision R88.)
      for (const rule of (await stores.approvalRules?.list()) ?? []) {
        const route = rootsOf.get(rule.workspaceRoot)
        if (route && workspacesOf(route))
          found.push({ route, kind: 'approval-rule', id: rule.id, body: rule as unknown as Record<string, unknown> })
      }
      await stores.scheduledAgents.loaded()
      for (const agent of stores.scheduledAgents.list()) {
        // Its folder's machine, as a chat's record says it: an SSH machine's
        // path, or a WSL workspace's machine (its `hostId`, else its folder).
        // One picked to run on This PC in a distribution's folder stays
        // (decision R88), as a workspace's record does.
        const route = isMachinePath(agent.folderPath)
          ? (machineRouteOfPath(agent.folderPath) ?? null)
          : environmentRouteOfRecord(agent)
        if (!route) continue
        // The pictures its prompt names go with it, each by the path the prompt names it by.
        const images = (await stores.scheduledImages?.(agent.prompt)) ?? []
        found.push({
          route,
          kind: 'schedule',
          id: agent.id,
          body: agent as unknown as Record<string, unknown>,
          ...(images.length
            ? { carried: { images: images.map((image) => ({ ...image, promptPath: image.path })) } }
            : {}),
        })
      }
      // Read from their file first: one not yet read would be left to go from here.
      await stores.scheduledMessages.loaded()
      for (const message of stores.scheduledMessages.state().messages) {
        const route = routeOfWorkspace.get(message.workspaceId)
        // One on its way into its chat now is left to go; a later plan finds it if it did not.
        if (!route || message.sending) continue
        const carried = stores.scheduledMessages.carriedOf(message.id)
        const { carries: _names, waitingSince: _waiting, failure: _failure, ...body } = message
        found.push({
          route,
          kind: 'scheduled-message',
          id: message.id,
          body: {
            ...body,
            ...(carried?.skills?.length || carried?.mentions?.length
              ? {
                  carried: {
                    ...(carried.skills?.length ? { skills: carried.skills } : {}),
                    ...(carried.mentions?.length ? { mentions: carried.mentions } : {}),
                  },
                }
              : {}),
          },
          ...(carried?.images?.length || carried?.files?.length
            ? {
                carried: {
                  ...(carried.images?.length
                    ? {
                        images: carried.images.map(({ path, name, mediaType }) => ({ path, name, mediaType })),
                      }
                    : {}),
                  ...(carried.files?.length ? { files: carried.files.map(({ path, name }) => ({ path, name })) } : {}),
                },
              }
            : {}),
        })
      }
      for (const notice of stores.usageLimitResumes.state().notices) {
        const route = routeOfWorkspace.get(notice.workspaceId)
        // Only a resume that is scheduled is kept there; a notice alone is this window's to read.
        if (!route || notice.resumeAt === null) continue
        found.push({
          route,
          kind: 'usage-limit-resume',
          id: `${notice.workspaceId}:${notice.agentId}`,
          // The notice as the machine's resumer keeps it, with when it goes.
          body: {
            workspaceId: notice.workspaceId,
            agentId: notice.agentId,
            provider: notice.provider,
            limit: notice.limit,
            resetsAt: notice.resetsAt,
            hitAt: notice.hitAt,
            createdAt: notice.hitAt,
            fireAt: notice.resumeAt,
          },
        })
      }
      await stores.pullRequests.whenLoaded()
      for (const row of stores.pullRequests.handingOver(new Set(routeOfWorkspace.keys()))) {
        const route = routeOfWorkspace.get(row.workspaceId)
        if (route) found.push({ route, kind: 'pull-request', id: row.url, body: { ...row } })
      }
      return found
    },
    async release(records) {
      const urls: string[] = []
      for (const record of records) {
        switch (record.kind) {
          case 'workspace':
            // Stays, as the machine's copy.
            break
          case 'chat':
            // Its files stay where they are, never written again: the
            // distribution's Studio runs the chat from its own copies.
            break
          case 'approval-rule':
            await stores.approvalRules?.revoke(record.id)
            break
          case 'schedule':
            await stores.scheduledAgents.remove(record.id)
            break
          case 'scheduled-message':
            // Its pictures and files were copied under the hand-over's folder first.
            stores.scheduledMessages.update({ kind: 'delete', id: record.id })
            break
          case 'usage-limit-resume':
            stores.usageLimitResumes.update({
              kind: 'dismiss',
              workspaceId: String(record.body.workspaceId),
              agentId: String(record.body.agentId),
            })
            break
          case 'pull-request':
            urls.push(record.id)
            break
        }
      }
      if (urls.length) stores.pullRequests.letGo(urls)
    },
  }
}
