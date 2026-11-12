import { createGitWorktree, getGitRepoRoot, removeGitWorktree } from '../git'
import { activeWorktreePool } from '../worktree-pool/active-pool'
import { withGitHost } from '../git-run'
import { hostRegistry } from '../hosts/host-registry'
import { powerActivity } from '../power-activity'
import { writeDiagnosticLog } from '../diagnostics-service'
import {
  ConversationHostToken,
  ConversationLaunchServiceToken,
  ConversationRuntimeToken,
  ScheduledAgentsModuleServiceToken,
  ScheduledAgentsServiceToken,
  WorkspaceRegistryToken,
} from '../module-host/service-tokens'
import type { CapabilityModule } from '../module-host/load-modules'
import { createScheduledPromptImages } from '../scheduled-agents/prompt-images'
import { isRunChatWorking, runScheduledAgent } from '../scheduled-agents/runner'
import { createScheduledRunOutcomes } from '../scheduled-agents/run-outcomes'
import { recoverScheduledRuns } from '../scheduled-agents/run-recovery'
import { createScheduledAgentsScheduler } from '../scheduled-agents/scheduler'
import {
  createScheduledAgentsModuleRegistry,
  createScheduledAgentsService,
  withinOwnerModuleCeiling,
  type ScheduledAgentsService,
} from '../scheduled-agents/service'
import { createScheduledAgentsStore, scheduledAgentsFilePath } from '../scheduled-agents/store'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  SCHEDULED_AGENTS_CHANGED_CHANNEL,
  SCHEDULED_AGENTS_PAUSE_CHANGED_CHANNEL,
  scheduledAgentTitle,
  type ScheduledAgentView,
} from '../../shared/scheduled-agents'
import type { StudioPlatform } from '../../server/platform/platform'

/** The client a scheduled run's first message is sent again as, after a restart. */
const SCHEDULED_RUN_CLIENT_ID = 'studio-scheduled-agents'

// The machine whose git answers for a folder: the run's own machine, so its
// worktree names a gitdir that machine can follow. Nothing named leaves the
// resolver to decide.
function gitHostFor(hostId: ExecutionHostId | null) {
  return hostId ? hostRegistry().get(hostId) : null
}

/**
 * `paths` places the schedule file; `clients` hears every change to the list;
 * `getModulePermissions` is what an extension's schedule is held to.
 */
export function createScheduledAgentsModule(
  platform: Pick<StudioPlatform, 'paths' | 'clients'>,
  getModulePermissions: (moduleId: string) => readonly string[] | undefined,
): CapabilityModule {
  const broadcastScheduledAgents = (agents: ScheduledAgentView[], service: ScheduledAgentsService): void => {
    platform.clients.publish(SCHEDULED_AGENTS_CHANGED_CHANNEL, agents)
    // Said with every change rather than only its own: a pause ending at its
    // time is a change too, and a window that missed one hears the next.
    platform.clients.publish(SCHEDULED_AGENTS_PAUSE_CHANGED_CHANNEL, service.pausedAll())
  }
  return {
    manifest: {
      id: 'scheduled-agents',
      displayName: 'Scheduled agents',
      version: 1,
      publisher: 'sprintengine',
      category: 'orchestration',
      summary: 'Start a chat agent with a prompt on a schedule.',
      defaultEnabled: true,
      dependsOn: ['agent-runtime'],
    },
    registerMain(host) {
      const conversationLaunchService = host.requireService(ConversationLaunchServiceToken)
      const conversations = host.requireService(ConversationRuntimeToken)
      const createConversationHost = host.requireService(ConversationHostToken)
      const workspaceRegistry = host.requireService(WorkspaceRegistryToken)
      const store = createScheduledAgentsStore({
        filePath: scheduledAgentsFilePath(platform.paths.dataDir()),
        warn: (message) => console.warn(`[scheduled-agents] ${message}`),
      })
      // Late-bound: the scheduler reports a finished run to the service, which
      // is built around the scheduler.
      let service: ScheduledAgentsService | null = null
      const outcomes = createScheduledRunOutcomes({
        store,
        notifyRan: (agent, run) => service?.notifyRan(agent, run),
        notifyChanged: () => service?.notifyChanged(),
        warn: (message) => console.warn(`[scheduled-agents] ${message}`),
      })
      const scheduler = createScheduledAgentsScheduler({
        list: () => store.list(),
        beginRun: (commandId, run) => store.beginRun(commandId, run),
        endRun: (commandId) => store.endRun(commandId),
        recordRun: outcomes.recordRun,
        onRan: outcomes.onRan,
        isRunWorking: (workspaceId) => {
          const listed = conversations.listSessions({ workspaceId })
          return listed.ok && isRunChatWorking(listed.sessions)
        },
        pausedAll: () => store.pausedAll(),
        // A pause of everything that came to its until ends; the schedules
        // count on from now, so nothing missed while it held runs.
        onPauseAllEnded: (pause) => {
          void service?.resumeAll(pause).then((ended) => {
            if (!ended.ok) console.warn(`[scheduled-agents] ${ended.message}`)
          })
        },
        // A skipped time is not a failed run — nothing was tried, and the
        // schedule's card has nothing to say about it — but it is written down,
        // so "why did it not run at nine" has an answer.
        log: (message) => console.warn(`[scheduled-agents] ${message}`),
        onSkipped: (agent, reason) => {
          // The skipped time moved its next run on: say so, or every window
          // keeps showing the passed time as "now" until something else changes.
          service?.notifyChanged()
          const workspaceId = agent.lastRun?.ok ? agent.lastRun.workspaceId : undefined
          void writeDiagnosticLog({
            level: 'info',
            source: 'agents',
            title: 'Scheduled run skipped',
            message:
              reason === 'still_working'
                ? `"${scheduledAgentTitle(agent.prompt, agent.name)}" did not start a run: its last run is still working.`
                : `"${scheduledAgentTitle(agent.prompt, agent.name)}" did not start a run: its last one is still starting.`,
            ...(workspaceId ? { workspaceId } : {}),
          }).catch(() => undefined)
        },
        run: (agent, signal, commandId) =>
          runScheduledAgent(
            withinOwnerModuleCeiling(agent, getModulePermissions),
            commandId,
            {
              launchConversation: (request) => conversationLaunchService.launch(request),
              getRepoRoot: (folderPath, hostId) => withGitHost(gitHostFor(hostId), () => getGitRepoRoot(folderPath)),
              createWorktree: async (input) => {
                const created = await withGitHost(gitHostFor(input.hostId), () =>
                  createGitWorktree({
                    repoRoot: input.repoRoot,
                    containerPath: input.containerPath,
                    destinationPath: input.destinationPath,
                    branchName: input.branchName,
                    baseRef: 'HEAD',
                    // On the default branch, from the worktree pool when this
                    // process keeps one: a run starts from what is merged, not
                    // from whatever branch the checkout happens to be on.
                    fromPool: true,
                    copyIncludedFiles: true,
                    // The chat is created after its worktree, so the branch names the owner.
                    agentLockOwner: input.branchName,
                    // Named to the pool too: it serves this machine's own git
                    // alone, and a run on a WSL machine (its folder may well be a
                    // Windows drive) must get a fresh worktree from that git.
                    ...(input.hostId ? { hostId: input.hostId } : {}),
                  }),
                )
                return created.ok
                  ? {
                      ok: true,
                      path: created.data.path,
                      branch: created.data.branch ?? input.branchName,
                      leaseId: created.data.leaseId,
                    }
                  : { ok: false, message: created.message }
              },
              // A pool slot goes back to the pool; a fresh worktree is removed.
              discardWorktree: async ({ repoRoot, path, leaseId, hostId }) => {
                const pool = leaseId ? activeWorktreePool() : null
                if (pool && leaseId) {
                  await pool.release(leaseId)
                  return
                }
                await withGitHost(gitHostFor(hostId), () => removeGitWorktree({ repoRoot, path, force: true }))
              },
              onFirstSendFailed: (workspaceId, message) => outcomes.firstSendFailed(agent.id, workspaceId, message),
              // The run is done: its record goes.
              onFirstSendDone: () => {
                void store.endRun(commandId).catch((error: unknown) => {
                  console.warn(`[scheduled-agents] A finished run could not be let go of: ${String(error)}`)
                })
              },
            },
            signal,
          ),
      })
      const scheduledAgents = createScheduledAgentsService({
        store,
        scheduler,
        promptImages: createScheduledPromptImages({ dataDir: platform.paths.dataDir() }),
      })
      service = scheduledAgents
      host.provideService(ScheduledAgentsServiceToken, () => scheduledAgents)
      host.provideService(ScheduledAgentsModuleServiceToken, () =>
        createScheduledAgentsModuleRegistry(scheduledAgents, getModulePermissions),
      )
      const unsubscribe = scheduledAgents.onChanged((agents) => broadcastScheduledAgents(agents, scheduledAgents))
      host.onShutdown(unsubscribe)

      // The Schedules window's channels are the server domains' (scheduled-agents-ipc.ts),
      // which reach this service while the module is on.

      let releaseWakeOnResume: (() => void) | null = null
      host.registerSidecar(
        {
          id: 'scheduled-agents-scheduler',
          kind: 'scheduler',
          description: 'Starts each scheduled agent’s chat when its schedule comes round.',
          startOn: 'startup',
        },
        {
          start: async () => {
            await store.load()
            // Runs the last process left on their way are settled before any
            // schedule is looked at, so a one-time schedule is due or done.
            await recoverScheduledRuns({
              store,
              outcomes,
              findChat: (commandId) => {
                for (const record of workspaceRegistry.getRecords())
                  for (const [agentId, agent] of Object.entries(record.agents))
                    if (agent?.launchCommandId === commandId) return { workspaceId: record.id, agentId }
                return null
              },
              // The chat's ordinary send, which resumes a chat at rest.
              send: async (chat, commandId, message) => {
                const conversationHost = createConversationHost()
                const key = conversationHost.resolveKey(chat.workspaceId, chat.agentId)
                if (!key) return { ok: false, message: 'The chat is no longer there.' }
                const sent = await conversationHost.command(key, SCHEDULED_RUN_CLIENT_ID, commandId, {
                  kind: 'send',
                  message: message.prompt,
                  ...(message.skills.length > 0 ? { skills: message.skills } : {}),
                })
                return sent.ok ? { ok: true } : { ok: false, message: sent.message ?? 'The chat did not take it.' }
              },
              warn: (message) => console.warn(`[scheduled-agents] ${message}`),
            }).catch((error: unknown) => {
              console.warn(`[scheduled-agents] Runs cut off by the last stop could not be settled: ${String(error)}`)
            })
            scheduler.start()
            scheduledAgents.notifyChanged()
            // A timer armed before a sleep counts only awake time, so a run
            // that came due during the nap is found on waking.
            releaseWakeOnResume?.()
            releaseWakeOnResume = powerActivity.onResume(() => scheduledAgents.notifyChanged())
          },
          stop: async () => {
            releaseWakeOnResume?.()
            releaseWakeOnResume = null
            scheduler.stop()
          },
          status: () => ({ state: scheduler.isRunning() ? 'running' : 'stopped' }),
        },
      )
    },
  }
}
