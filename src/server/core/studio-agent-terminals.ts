import { join } from 'node:path'

import { createAgentControlPlane } from '../../main/agent-control-plane'
import {
  createAgentLaunchNotices,
  LAUNCH_NOTICES_FILE,
  launchNoticesFileStorage,
} from '../../main/agent-launch-notices'
import { createAgentLaunchService, type AgentLaunchService } from '../../main/agent-launch-service'
import type { AgentCompactIpcDependencies } from '../../main/ipc/agent-compact-ipc'
import { createAgentPromptStore, registeredAgentOwners } from '../../main/agent-prompt-store'
import { resolveAgentStateSocketPath } from '../../main/agent-state-service'
import { resolveCheckoutForCwd, type ResolvedCheckoutFacts } from '../../main/checkout-resolve'
import { cliResumeCapabilities } from '../../main/cli-resume-capabilities'
import { chatHandoffStart, createConversationTerminalHandoff } from '../../main/conversation-terminal-handoff'
import { writeDiagnosticLog } from '../../main/diagnostics-service'
import type { AgentLaunchSettingsStore } from '../../main/launch-settings-store'
import { createLaunchedAgentRegistration, withLaunchedAgentRegistration } from '../../main/launched-agent-registration'
import { resolveMemoryRoot } from '../../main/memory-graph'
import { getPluginRegistry } from '../../main/plugin-registry-instance'
import { declaredPermissionModes, declaredPermissionPresets } from '../../main/plugin-render'
import { powerActivity } from '../../main/power-activity'
import type { SubagentLifecycle } from '../../main/subagent-lifecycle'
import {
  createTerminalRuntime,
  getTerminalSessionById,
  listLiveTerminalSessions,
  ptyAvailable,
  type TerminalRuntimeOptions,
} from '../../main/terminal-runtime'
import { isTerminalProcessAlive } from '../../main/terminal-session'
import { createTerminalSnapshotSidecarStore } from '../../main/terminal-snapshot-sidecar'
import { usageLimitsStore, usageRateLimit } from '../../main/usage-limits/store'
import type { WorkspaceRegistryService } from '../../main/workspace-registry-service'
import type { WorkspaceSyncService } from '../../main/workspace-sync-service'
import { worktreeLeases } from '../../main/worktree-leases'
import type { AgentLaunchRequest, AgentLaunchResult } from '../../shared/agent-launch'
import { conversationSummaryPhase, terminalAgentWorking } from '../../shared/conversation/phase'
import { isSettledWorkspace } from '../../shared/workspace-lifecycle'
import type { StudioPlatform } from '../platform/platform'
import { createAgentStateListener } from '../terminals/agent-state-listener'
import { createStudioTerminals } from '../terminals/studio-terminals'
import type { TerminalLaunchPreparation } from '../terminals/terminal-launch-preparation'
import { headlessTerminalViewer } from '../terminals/terminal-viewer'
import type { ConversationBackend } from './conversation-backend'

// The terminal agents, as the Studio core owns them (design-terminal-service):
// the terminal runtime and its ptys, the agent-state reporter's listener that
// moves their phases, the launch service every terminal launch goes through
// (`agent.launch`, `backlog.work`, a schedule, Resume in terminal, a tour, a
// module), the control plane that types at an agent, the notices an agent
// that launched another hears, and the terminals as the Studio protocol serves
// them. Built by `createStudioCore` in every mode, so the ptys run in the
// server's process: Electron main in process, the desktop's server out of
// process, a standalone server under plain Node.
//
// A process that cannot load the native pty module (a WSL or SSH machine's
// server tree, which carries no native code) builds none of it, and its server
// does not advertise `terminals`.
//
// What the desktop adds to a launch (its plugin copy, MCP sync, skills, the
// hook install) comes in as `host.launchPreparation`, which the shell bridge
// carries; what the shell hears of its agents (changelists, written files,
// pull request marks, git activity) comes in as observers, given in process
// only: out of process the shell reads the server.

/** What the process around the core adds to its terminal agents. Every member is optional. */
export type StudioTerminalHost = {
  /** The shell's part of a launch, over the shell bridge; absent, agents launch without it. */
  launchPreparation?: TerminalLaunchPreparation
  /** In-process observers of the sessions (the shell's changelists, written files, pull request marks). */
  observers?: Pick<
    TerminalRuntimeOptions,
    'onAgentLaunched' | 'onAgentFileEdit' | 'onAgentSessionExit' | 'onObservedCheckoutResolved' | 'onAgentToolCall'
  >
  /** Git answered for an agent's checkout: the shell's git view re-reads it now. */
  onCheckoutResolved?: (facts: ResolvedCheckoutFacts) => void
  /** Whether a window has focus: the reap sweep slows down while none has. */
  isAppFocused?: () => boolean
  diagnosticsEnabled?: boolean
  logMainPerfEvent?: TerminalRuntimeOptions['logMainPerfEvent']
  /** Whether a window may take over a running terminal's output (the pane pop-out guard). */
  mayAttach?: (windowKey: string, sessionId: string) => boolean
  /** A launch went through: the shell's analytics hear its shape. */
  onLaunched?: (request: AgentLaunchRequest, result: Extract<AgentLaunchResult, { ok: true }>) => void
}

export type StudioAgentTerminalsDeps = {
  platform: Pick<StudioPlatform, 'paths'>
  /** Resolves once the data directory is this process's; the reporter's socket is opened then. */
  whenDataDirFree: Promise<unknown>
  /** Whether this process opens the reporter's socket at all (it holds the directory, or is a desktop carrying on without). */
  reporterListens: boolean
  workspaceRegistry: Pick<WorkspaceRegistryService, 'getRecord' | 'getState' | 'subscribe' | 'needsHydration'>
  workspaceSyncService: WorkspaceSyncService
  agentLaunchSettings: Pick<AgentLaunchSettingsStore, 'get'>
  conversations: ConversationBackend
  subagents: Pick<SubagentLifecycle, 'result' | 'onStopped'>
  onChatIdle: (listener: (summary: { sessionId: string; workspaceId: string; agentId: string }) => void) => void
  setChatIdleThresholdMs: (value: unknown) => void
  host?: StudioTerminalHost
}

export type StudioAgentTerminals = NonNullable<ReturnType<typeof createStudioAgentTerminals>>

/** What the core's other parts read of a live terminal: where it works and what its agent is doing. */
export type StudioTerminalView = {
  sessionId: string
  kind?: string
  workspaceId?: string
  agentId?: string
  processAlive: boolean
  suspended?: boolean
  activity?: { kind: string }
  agentState?: { phase?: string }
  lastTurnEndedAt?: number | null
  agentRecord?: { cliPermissionPreset?: unknown }
  cwd?: string
  observedCheckout?: { cwd?: string | null; gitRoot?: string | null } | null
}

const log =
  (title: string, level: 'info' | 'warning' = 'info') =>
  (message: string) => {
    void writeDiagnosticLog({ level, source: 'workspace', title, message })
  }

export function createStudioAgentTerminals(deps: StudioAgentTerminalsDeps) {
  if (!ptyAvailable()) return null
  const { workspaceRegistry, workspaceSyncService, agentLaunchSettings, conversations } = deps
  const host = deps.host ?? {}
  const dataDir = deps.platform.paths.dataDir()
  const logTerminal = (diagnostic: Parameters<NonNullable<TerminalRuntimeOptions['logDiagnostic']>>[0]) => {
    void writeDiagnosticLog({ ...diagnostic, source: 'terminal' })
  }

  // An agent's captured prompts outlive its session, for the conversation
  // peek; an agent removed from the registry takes them with it.
  const agentPrompts = createAgentPromptStore({
    resolveUserDataDir: () => dataDir,
    agentExists: ({ workspaceId, agentId }) => {
      const record = workspaceRegistry.getRecord(workspaceId)
      if (record) return Object.hasOwn(record.agents, agentId)
      // Gone only once the registry is authoritative; before hydration nothing is known.
      return workspaceRegistry.needsHydration() ? undefined : false
    },
    logDiagnostic: logTerminal,
  })
  let registeredAgents = registeredAgentOwners(workspaceRegistry.getState())
  const stopFollowingAgents = workspaceRegistry.subscribe((state) => {
    const next = registeredAgentOwners(state)
    for (const [key, owner] of registeredAgents) if (!next.has(key)) void agentPrompts.remove(owner)
    registeredAgents = next
  })

  const prepare = host.launchPreparation
  const runtime = createTerminalRuntime({
    diagnosticsEnabled: host.diagnosticsEnabled ?? false,
    logMainPerfEvent: host.logMainPerfEvent ?? (() => undefined),
    ...(host.isAppFocused ? { isAppFocused: host.isAppFocused } : {}),
    // Asked at every turn end and session start, which is when a checkout's
    // working tree most likely moved: the shell's git view hears it.
    resolveObservedCheckout: async (cwd) => {
      const facts = await resolveCheckoutForCwd(cwd)
      if (facts?.gitRoot) host.onCheckoutResolved?.(facts)
      return facts
    },
    ...host.observers,
    // Suspended agent terminals keep their painted screen on disk and reopen
    // painted after a restart.
    snapshotSidecars: createTerminalSnapshotSidecarStore({
      resolveUserDataDir: () => dataDir,
      logDiagnostic: logTerminal,
    }),
    agentPrompts,
    logDiagnostic: logTerminal,
    ...(prepare
      ? {
          prepareLaunchIntegration: prepare.prepareLaunchIntegration,
          syncMcpConfig: prepare.syncMcpConfig,
          ensureBuiltinSkillInstalled: prepare.ensureBuiltinSkillInstalled,
          excludeWorktreeMcpConfig: prepare.excludeWorktreeMcpConfig,
          prepareAgentStateHook: prepare.prepareAgentStateHook,
        }
      : {}),
    resolveWorkspaceHostId: (workspaceId) => {
      const hostId = workspaceSyncService
        .getSnapshot()
        .state.workspaces.find((workspace) => workspace.id === workspaceId)?.hostId
      return typeof hostId === 'string' ? hostId : null
    },
    // The same holds the worktree pool takes (worktree-leases.ts): a terminal
    // starting in a slot holds it until it is live, and waits for a return
    // already under way. One process's, so the two always meet.
    worktreeLeases,
  })

  // The reporter's frames move the sessions' phases. Its socket is derived
  // from the data directory, as the launch environment and the shell's
  // plugin copy derive it, and opened once the directory is this process's.
  const agentState = createAgentStateListener({
    socketPath: resolveAgentStateSocketPath(dataDir),
    onFrame: (frame) => runtime.ingestAgentStateFrame(frame),
    logDiagnostic: (diagnostic) => {
      void writeDiagnosticLog({ ...diagnostic, source: 'workspace' })
    },
  })
  if (deps.reporterListens) void deps.whenDataDirFree.then(() => agentState.start()).catch(() => undefined)

  // The one way to type at a live agent, terminal or chat: concurrent prompts
  // serialise per session, and no window is needed.
  const controlPlane = createAgentControlPlane({
    terminal: {
      list: () => runtime.sessions.listTerminals(),
      write: (sessionId, data) => runtime.sessions.writeTerminal(sessionId, data),
      read: (sessionId) => runtime.readTerminalOutput(sessionId),
      readSince: (sessionId, cursor) => runtime.readTerminalOutputSince(sessionId, cursor),
    },
    conversation: {
      list: () => {
        const result = conversations.listSessions()
        return result.ok ? result.sessions : []
      },
      sendTurn: async ({ sessionId, message, origin }) => {
        const result = await conversations.sendTurn({ sessionId, message, ...(origin ? { origin } : {}) })
        return result.ok
          ? { ok: true }
          : { ok: false, message: result.message, ...(result.code ? { code: result.code } : {}) }
      },
      interrupt: async ({ sessionId }) => {
        const result = await conversations.interrupt({ sessionId })
        return result.ok ? { ok: true } : { ok: false, message: result.message }
      },
    },
  })

  // An agent that launched another hears when that one finishes or stops to
  // ask. A notice waits out a usage limit on the parent's provider.
  const launchNotices = createAgentLaunchNotices({
    plane: controlPlane,
    readChatReply: (sessionId) => {
      const listed = conversations.listSessions()
      return listed.ok
        ? listed.sessions.find((session) => session.sessionId === sessionId)?.lastAssistantTail
        : undefined
    },
    readSubagentResult: (child) => deps.subagents.result(child),
    readChild: (child) => {
      const agent = workspaceRegistry.getRecord(child.workspaceId)?.agents[child.agentId]
      if (!agent?.subagentOf) return undefined
      const listed = conversations.listSessions({ workspaceId: child.workspaceId, agentId: child.agentId })
      const summary = listed.ok ? listed.sessions.sort((a, b) => b.updatedAt - a.updatedAt)[0] : undefined
      if (!summary) return undefined
      const phase = conversationSummaryPhase(summary)
      return {
        waiting: phase === 'waiting_for_approval' || phase === 'waiting_for_input',
        ...(agent.subagentEnd ? { end: agent.subagentEnd } : {}),
      }
    },
    usageLimit: (provider) => usageRateLimit(provider),
    onUsageLimitsChanged: (listener) => {
      usageLimitsStore().onChanged(listener)
    },
    isSettled: (workspaceId) => {
      const record = workspaceRegistry.getRecord(workspaceId)
      return record ? isSettledWorkspace(record) : false
    },
    // Kept across a restart: a parent still hears of a child the quit stopped.
    storage: launchNoticesFileStorage(join(dataDir, LAUNCH_NOTICES_FILE)),
    log: log('Launch notices'),
  })
  deps.subagents.onStopped((chat) => launchNotices.subagentStopped(chat))
  void launchNotices.restore()
  const stopFollowingPower = [
    // A hold's timer stood still while the computer slept.
    powerActivity.onResume(() => launchNotices.wake()),
    powerActivity.onScreenLockChange((locked) => {
      if (!locked) launchNotices.wake()
    }),
  ]
  runtime.registerAgentPhaseListener((event) => launchNotices.onAgentPhase(event))
  runtime.registerAgentSessionExitListener((event) => launchNotices.onAgentSessionExit(event))
  const stopFollowingChats = conversations.onEvent((event) => launchNotices.onConversationEvent(event))
  // A chat parent is told when its turn has let go of it, not on the turn's end event.
  deps.onChatIdle((summary) => launchNotices.onChatIdle(summary))

  const pluginOf = (cli: string) =>
    getPluginRegistry()
      .loaded()
      .find((candidate) => candidate.manifest.id === cli)
  const permissionPresetsForCli = (cli: string) => {
    const plugin = pluginOf(cli)
    return plugin ? declaredPermissionPresets(plugin.manifest) : null
  }

  // Every terminal launch comes through here, whoever asks, and starts
  // headless: its pty runs and buffers, and the first pane that opens it over
  // the Studio protocol takes it over.
  const composed = createAgentLaunchService({
    listWorkspaces: () => workspaceSyncService.getSnapshot().state.workspaces,
    getLaunchSettings: () => agentLaunchSettings.get(),
    // Hooks-only selectability: a known plugin with no agentStateSpec is refused as an agent.
    isAgentSelectableCli: (cli) => {
      const plugin = pluginOf(cli)
      return plugin ? Boolean(plugin.manifest.agentStateSpec) : true
    },
    permissionPresetsForCli,
    permissionModeLevelForCli: (cli, mode) => {
      const plugin = pluginOf(cli)
      return (plugin && declaredPermissionModes(plugin.manifest).find((own) => own.id === mode)?.level) ?? null
    },
    cliResumesSessions: (cli) => cliResumeCapabilities(cli).resumeSession,
    resolveKnowledgeRoot: (input) => resolveMemoryRoot(input.workspaceRoot, input.relativeRoot),
    terminal: {
      list: () => runtime.sessions.listTerminals(),
      spawn: (payload) => runtime.sessions.spawnTerminal(headlessTerminalViewer(), payload),
      kill: (sessionId) => runtime.sessions.killTerminal(sessionId),
    },
  })
  // The launched agent goes into the registry here, at launch, so every
  // client and paired device hears of it however it was started.
  const launchedAgentRegistration = createLaunchedAgentRegistration({
    registry: workspaceRegistry as Parameters<typeof createLaunchedAgentRegistration>[0]['registry'],
    workspaceSync: workspaceSyncService,
    listLaunchedSessions: () =>
      listLiveTerminalSessions()
        .filter((session) => session.agentRecord !== undefined)
        .map((session) => ({
          sessionId: session.sessionId,
          kind: session.kind,
          processAlive: isTerminalProcessAlive(session),
          workspaceId: session.workspaceId,
          agentRecord: session.agentRecord,
          worktreeId: session.worktreeId,
          cliSessionId: session.cliSessionId,
        })),
    hasSession: (sessionId) => {
      const session = getTerminalSessionById(sessionId)
      return session !== null && !session.isDisposed
    },
  })
  const registered = withLaunchedAgentRegistration(composed, launchedAgentRegistration)
  const launchService: AgentLaunchService = {
    ...registered,
    async launch(request) {
      const result = await registered.launch(request)
      if (result.ok) host.onLaunched?.(request, result)
      return result
    },
  }
  // A live launched session whose agent is missing from its workspace is adopted.
  const stopReconciling = runtime.subscribeSessionsChanged(() => launchedAgentRegistration.reconcile())

  // Resume in terminal: a chat's CLI session handed to a terminal agent,
  // through the same launch.
  const handoff = createConversationTerminalHandoff({
    runtime: conversations,
    launch: (request) => launchService.launch(request),
    cliResumesSessions: (cli) => cliResumeCapabilities(cli).resumeSession,
    permissionPresetsForCli,
    chatName: (workspaceId, agentId) => workspaceRegistry.getRecord(workspaceId)?.agents[agentId]?.name,
    chatStart: (workspaceId, agentId) =>
      chatHandoffStart(
        workspaceSyncService.getSnapshot().state.workspaces.find((workspace) => workspace.id === workspaceId),
        agentId,
        agentLaunchSettings.get(),
      ),
  })

  // The terminals as the Studio protocol serves them, to every client.
  const studioTerminals = createStudioTerminals({
    runtime: {
      ...runtime.sessions,
      onSessionsDelta: runtime.onSessionsDelta,
      onPromptUndelivered: runtime.onPromptUndelivered,
    },
    ...(host.mayAttach ? { mayAttach: host.mayAttach } : {}),
    // One idle-suspend setting governs both: ptys and headless chat children.
    onIdleSuspendMs: (value) => deps.setChatIdleThresholdMs(value),
  })

  /**
   * The live sessions, as the pool, the rest sweep and the launch cap read
   * them: the session objects, not snapshots, since only a few fields are read.
   */
  const list = (): StudioTerminalView[] =>
    listLiveTerminalSessions().map((session) => ({
      sessionId: session.sessionId,
      kind: session.kind,
      workspaceId: session.workspaceId,
      agentId: session.agentId,
      processAlive: isTerminalProcessAlive(session),
      suspended: session.suspended,
      activity: session.activity,
      agentState: session.agentState,
      lastTurnEndedAt: session.lastTurnEndedAt ?? null,
      agentRecord: session.agentRecord,
      ...(session.cwd ? { cwd: session.cwd } : {}),
      ...(session.observedCheckout ? { observedCheckout: session.observedCheckout } : {}),
    }))

  /**
   * End the terminals of a chat the rest sweep settled: every pty of the
   * workspace but an agent mid-turn or stopped on a question, which keeps
   * running. A resting chat holds no processes.
   */
  function endWorkspaceTerminals(workspaceId: string): void {
    for (const session of runtime.sessions.listTerminals()) {
      if (session.workspaceId !== workspaceId) continue
      if (session.kind === 'agent' && terminalAgentWorking(session)) continue
      if (session.kind === 'agent' && session.processAlive && session.agentState?.phase === 'awaiting_input') continue
      runtime.sessions.killTerminal(session.sessionId)
    }
  }

  /** The reporter stops hearing frames; nothing else stops yet. */
  async function stopAgentState(): Promise<void> {
    await agentState.stop()
  }
  /** Every pty ends (its painted screen kept), and the prompts are written. */
  async function shutdown(): Promise<void> {
    for (const stop of stopFollowingPower.splice(0)) stop()
    stopFollowingChats()
    stopReconciling()
    stopFollowingAgents()
    await runtime.shutdown()
  }

  return {
    runtime,
    /** The reporter's listener: a WSL distribution's relayed lines go to `ingestLine`. */
    agentState,
    controlPlane,
    launchNotices,
    launchService,
    handoff,
    studioTerminals,
    list,
    onChanged: (listener: () => void) => runtime.subscribeSessionsChanged(listener),
    endWorkspaceTerminals,
    stopAgentState,
    shutdown,
  }
}

/** What Compact on an agent tab reads and types through: the session as this runtime sees it, and the control plane. */
export function compactDeps(terminals: StudioAgentTerminals): AgentCompactIpcDependencies {
  return {
    findTerminal: (sessionId) =>
      terminals.runtime.sessions.listTerminals().find((session) => session.sessionId === sessionId) ?? null,
    sendPrompt: async (sessionId, text, precondition) => {
      const result = await terminals.controlPlane.send({ sessionId }, text, { submit: true, precondition })
      return result.ok ? { ok: true } : { ok: false, message: result.message }
    },
  }
}
