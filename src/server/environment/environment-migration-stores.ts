import { formatEnvironmentRoute } from '../../../packages/studio-protocol/src/environment'
import type { ScheduledAgentsService } from '../../main/scheduled-agents/service'
import type { ScheduledMessages } from '../../main/scheduled-messages/scheduled-messages'
import type { UsageLimitResumer } from '../../main/usage-limits/resume'
import type { WorkspaceRegistryService } from '../../main/workspace-registry-service'
import { environmentRouteOfRecord } from '../../shared/environment-clients'
import { parseMachinePath } from '../../shared/machine-paths'
import type { PullRequestRecord } from '../pull-requests/pull-request-record'
import type { EnvironmentMigrationStores, MigratingRecord } from './environment-migration'

// This desktop's stores as the hand-over reads and empties them
// (environment-migration.ts): each record that names a chat or folder another
// environment holds, found by the chat's record here (its `environment`) or
// by its folder (`ssh://<id>/…`), and taken out through the store's own way.

export function studioMigrationStores(stores: {
  workspaceRegistry: Pick<WorkspaceRegistryService, 'getRecords'>
  scheduledAgents: Pick<ScheduledAgentsService, 'loaded' | 'list' | 'remove'>
  scheduledMessages: Pick<ScheduledMessages, 'state' | 'carriedOf' | 'update'>
  usageLimitResumes: Pick<UsageLimitResumer, 'state' | 'update'>
  pullRequests: Pick<PullRequestRecord, 'whenLoaded' | 'handingOver' | 'letGo'>
  /** The pictures a schedule's prompt names from this desktop's data directory (`keptImagesIn`). */
  scheduledImages?: (prompt: string) => Promise<Array<{ path: string; name: string; mediaType: string }>>
}): EnvironmentMigrationStores {
  return {
    async collect(workspacesOf) {
      const found: MigratingRecord[] = []
      // The chats another environment holds, by the route of their record here.
      const routeOfWorkspace = new Map<string, string>()
      for (const record of stores.workspaceRegistry.getRecords()) {
        const route = environmentRouteOfRecord(record)
        if (!route) continue
        routeOfWorkspace.set(record.id, route)
        if (workspacesOf(route))
          found.push({ route, kind: 'workspace', id: record.id, body: record as unknown as Record<string, unknown> })
      }
      await stores.scheduledAgents.loaded()
      for (const agent of stores.scheduledAgents.list()) {
        const machine = parseMachinePath(agent.folderPath)
        if (!machine) continue
        // The pictures its prompt names go with it, each by the path the prompt names it by.
        const images = (await stores.scheduledImages?.(agent.prompt)) ?? []
        found.push({
          route: formatEnvironmentRoute({ kind: 'ssh', machine: machine.id }),
          kind: 'schedule',
          id: agent.id,
          body: agent as unknown as Record<string, unknown>,
          ...(images.length
            ? { carried: { images: images.map((image) => ({ ...image, promptPath: image.path })) } }
            : {}),
        })
      }
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
