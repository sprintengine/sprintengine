import { createGitWorktree, getGitRepoRoot, removeGitWorktree } from '../../main/git'
import { activeWorktreePool } from '../../main/worktree-pool/active-pool'
import { withGitHost } from '../../main/git-run'
import { powerActivity } from '../../main/power-activity'
import { writeDiagnosticLog } from '../../main/diagnostics-service'
import type { ConversationLaunchRequest, ConversationLaunchResult } from '../../main/conversation-launch-service'
import type { ConversationGatewayHost } from './conversation-host'
import { createScheduledPromptImages } from '../../main/scheduled-agents/prompt-images'
import { isRunChatWorking, runScheduledAgent } from '../../main/scheduled-agents/runner'
import { createScheduledRunOutcomes } from '../../main/scheduled-agents/run-outcomes'
import { recoverScheduledRuns } from '../../main/scheduled-agents/run-recovery'
import { createScheduledAgentsScheduler } from '../../main/scheduled-agents/scheduler'
import {
  createScheduledAgentsModuleRegistry,
  createScheduledAgentsService,
  withinOwnerModuleCeiling,
  type ScheduledAgentsModuleRegistry,
  type ScheduledAgentsService,
} from '../../main/scheduled-agents/service'
import { createScheduledAgentsStore, scheduledAgentsFilePath } from '../../main/scheduled-agents/store'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { ConversationSessionSummary } from '../../shared/conversation-runtime'
import { scheduledAgentTitle, type ScheduledAgent, type ScheduledAgentView } from '../../shared/scheduled-agents'
import type { StudioPlatform } from '../platform/platform'

// Scheduled agents, as every Studio server runs them: the desktop's core in
// process and out of process, a standalone server, a WSL distribution's and an
// SSH machine's. A schedule runs on the server whose store holds it, in its
// chats, from its worktree pool; nothing here asks which kind of server it is.
//
// The store, the scheduler, the runner and the recovery of runs a stop cut off
// are the `main/scheduled-agents` pieces; this is their composition, once, in
// the core (it used to be a bundled module that only the desktop loaded).
//
// Where a module kernel runs (the desktop), the person's Scheduled agents
// switch turns the scheduler on and off through it (`modules/scheduled-agents-switch.ts`);
// a server with no kernel turns it on at start.
//
// A schedule that cannot run here now is held, not failed: `waitingFor` says
// why (a CLI not signed in on this machine, an extension that owns it absent),
// the scheduler skips its time without counting it a failure, and the list
// shows the reason.

/** The client a scheduled run's first message is sent again as, after a restart. */
const SCHEDULED_RUN_CLIENT_ID = 'studio-scheduled-agents'

export type StudioScheduledAgentsDeps = {
  platform: Pick<StudioPlatform, 'paths' | 'clients'>
  conversations: {
    listSessions(input: {
      workspaceId?: string
    }): { ok: true; sessions: ConversationSessionSummary[] } | { ok: false; message?: string }
  }
  launch: (request: ConversationLaunchRequest) => Promise<ConversationLaunchResult>
  createConversationHost: () => Pick<ConversationGatewayHost, 'resolveKey' | 'command'>
  workspaceRecords: () => ReadonlyArray<{
    id: string
    agents: Record<string, { launchCommandId?: string } | undefined>
  }>
  /** The machine whose git answers for a run's folder, by its schedule's host; null for this one. */
  gitHost: (hostId: ExecutionHostId | null) => Parameters<typeof withGitHost>[0]
  /**
   * Why a schedule cannot run on this server now, in words ("Codex is not
   * signed in on build-box"); null when it can. Asked at each of its times,
   * and with `asked` when a person pressed Run now.
   */
  waitingFor?: (agent: ScheduledAgent, context?: { asked: boolean }) => string | null
}

export type StudioScheduledAgents = {
  service: ScheduledAgentsService
  /** The extension-facing registry, held to each module's own permissions. */
  moduleRegistry(
    getModulePermissions: (moduleId: string) => readonly string[] | undefined,
  ): ScheduledAgentsModuleRegistry
  /** What an extension's schedule is held to at each run; nothing (the strictest) until a kernel says. */
  setModulePermissions(read: (moduleId: string) => readonly string[] | undefined): void
  /**
   * Read the store, settle runs the last stop cut off, and start the
   * scheduler, once `after` (where given) has resolved; never when it
   * rejects. Again after `stop`, only the scheduler.
   */
  start(options?: { after?: Promise<unknown> }): Promise<void>
  /** Stop the scheduler; a run already starting finishes starting. */
  stop(): Promise<void>
  running(): boolean
  /** The schedules that would run on their own while this server lives: not paused, with a time to come. */
  upcoming(): ScheduledAgentView[]
}

export function createStudioScheduledAgents(deps: StudioScheduledAgentsDeps): StudioScheduledAgents {
  const warn = (message: string) => console.warn(`[scheduled-agents] ${message}`)
  const dataDir = deps.platform.paths.dataDir()
  let getModulePermissions: (moduleId: string) => readonly string[] | undefined = () => undefined
  const store = createScheduledAgentsStore({ filePath: scheduledAgentsFilePath(dataDir), warn })
  // Late-bound: the scheduler reports a finished run to the service, which
  // is built around the scheduler.
  let service: ScheduledAgentsService | null = null
  const outcomes = createScheduledRunOutcomes({
    store,
    notifyRan: (agent, run) => service?.notifyRan(agent, run),
    notifyChanged: () => service?.notifyChanged(),
    warn,
  })
  const scheduler = createScheduledAgentsScheduler({
    list: () => store.list(),
    beginRun: (commandId, run) => store.beginRun(commandId, run),
    endRun: (commandId) => store.endRun(commandId),
    recordRun: outcomes.recordRun,
    onRan: outcomes.onRan,
    isRunWorking: (workspaceId) => {
      const listed = deps.conversations.listSessions({ workspaceId })
      return listed.ok && isRunChatWorking(listed.sessions)
    },
    ...(deps.waitingFor ? { waitingFor: deps.waitingFor } : {}),
    pausedAll: () => store.pausedAll(),
    // A pause of everything that came to its until ends; the schedules
    // count on from now, so nothing missed while it held runs.
    onPauseAllEnded: (pause) => {
      void service?.resumeAll(pause).then((ended) => {
        if (!ended.ok) warn(ended.message)
      })
    },
    // A skipped time is not a failed run — nothing was tried, and the
    // schedule's card has nothing to say about it — but it is written down,
    // so "why did it not run at nine" has an answer.
    log: warn,
    onSkipped: (agent, reason, detail) => {
      // The skipped time moved its next run on: say so, or every window
      // keeps showing the passed time as "now" until something else changes.
      service?.notifyChanged()
      const workspaceId = agent.lastRun?.ok ? agent.lastRun.workspaceId : undefined
      const title = scheduledAgentTitle(agent.prompt, agent.name)
      void writeDiagnosticLog({
        level: 'info',
        source: 'agents',
        title: 'Scheduled run skipped',
        message:
          reason === 'still_working'
            ? `"${title}" did not start a run: its last run is still working.`
            : reason === 'waiting'
              ? `"${title}" did not start a run: it is waiting until ${detail ?? 'this machine can run it'}.`
              : `"${title}" did not start a run: its last one is still starting.`,
        ...(workspaceId ? { workspaceId } : {}),
      }).catch(() => undefined)
    },
    run: (agent, signal, commandId) =>
      runScheduledAgent(
        withinOwnerModuleCeiling(agent, getModulePermissions),
        commandId,
        {
          launchConversation: (request) => deps.launch(request),
          getRepoRoot: (folderPath, hostId) => withGitHost(deps.gitHost(hostId), () => getGitRepoRoot(folderPath)),
          createWorktree: async (input) => {
            const created = await withGitHost(deps.gitHost(input.hostId), () =>
              createGitWorktree({
                repoRoot: input.repoRoot,
                containerPath: input.containerPath,
                destinationPath: input.destinationPath,
                branchName: input.branchName,
                baseRef: 'HEAD',
                // On the default branch, from this server's worktree pool: a
                // run starts from what is merged, not from whatever branch the
                // checkout happens to be on.
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
            await withGitHost(deps.gitHost(hostId), () => removeGitWorktree({ repoRoot, path, force: true }))
          },
          onFirstSendFailed: (workspaceId, message) => outcomes.firstSendFailed(agent.id, workspaceId, message),
          // The run is done: its record goes.
          onFirstSendDone: () => {
            void store.endRun(commandId).catch((error: unknown) => {
              warn(`A finished run could not be let go of: ${String(error)}`)
            })
          },
        },
        signal,
      ),
  })
  const scheduledAgents = createScheduledAgentsService({
    store,
    scheduler,
    promptImages: createScheduledPromptImages({ dataDir }),
  })
  // Every change, a pause ending at its time included, reaches the windows
  // and every other client on the protocol's `schedules.changed`.
  service = scheduledAgents

  let prepared: Promise<void> | null = null
  let releaseWakeOnResume: (() => void) | null = null
  let on = false
  // Read once, and the runs the last process left on their way settled before
  // any schedule is looked at, so a one-time schedule is due or done.
  const prepare = () =>
    (prepared ??= (async () => {
      await store.load()
      await recoverScheduledRuns({
        store,
        outcomes,
        findChat: (commandId) => {
          for (const record of deps.workspaceRecords())
            for (const [agentId, agent] of Object.entries(record.agents))
              if (agent?.launchCommandId === commandId) return { workspaceId: record.id, agentId }
          return null
        },
        // The chat's ordinary send, which resumes a chat at rest.
        send: async (chat, commandId, message) => {
          const conversationHost = deps.createConversationHost()
          const key = conversationHost.resolveKey(chat.workspaceId, chat.agentId)
          if (!key) return { ok: false, message: 'The chat is no longer there.' }
          const sent = await conversationHost.command(key, SCHEDULED_RUN_CLIENT_ID, commandId, {
            kind: 'send',
            message: message.prompt,
            ...(message.skills.length > 0 ? { skills: message.skills } : {}),
          })
          return sent.ok ? { ok: true } : { ok: false, message: sent.message ?? 'The chat did not take it.' }
        },
        warn,
      }).catch((error: unknown) => {
        warn(`Runs cut off by the last stop could not be settled: ${String(error)}`)
      })
    })())

  return {
    service: scheduledAgents,
    moduleRegistry: (permissions) => createScheduledAgentsModuleRegistry(scheduledAgents, permissions),
    setModulePermissions(read) {
      getModulePermissions = read
    },
    async start(options = {}) {
      on = true
      await prepare()
      // Nothing runs before what is handed to another environment is taken
      // out (the hand-over's plan): a schedule handed over runs there only.
      // A plan that failed holds them: the store may still list what is the
      // machine's.
      if (
        options.after &&
        !(await options.after.then(
          () => true,
          () => false,
        ))
      )
        return
      // Stopped while the store was read: it stays stopped.
      if (!on || scheduler.isRunning()) return
      scheduler.start()
      scheduledAgents.notifyChanged()
      // A timer armed before a sleep counts only awake time, so a run that
      // came due during the nap is found on waking.
      releaseWakeOnResume?.()
      releaseWakeOnResume = powerActivity.onResume(() => scheduledAgents.notifyChanged())
    },
    async stop() {
      on = false
      releaseWakeOnResume?.()
      releaseWakeOnResume = null
      scheduler.stop()
    },
    running: () => scheduler.isRunning(),
    upcoming: () =>
      scheduler.isRunning() && !scheduledAgents.pausedAll()
        ? scheduledAgents.list().filter((agent) => agent.pausedAt === undefined && typeof agent.nextRunAt === 'number')
        : [],
  }
}
