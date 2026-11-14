import { hostname } from 'node:os'
import { join } from 'node:path'

import { normalizeCliPermissionPreset, parseCliPermissionPreset } from '../../shared/cli-permission-preset'
import { conversationWorkingRoot, defaultAgent } from '../../shared/agent-state'
import { getWorkspaceChangeSummary } from '../../main/workspace-change-summary'
import { isMachinePath } from '../../shared/machine-paths'
import { isWorkspaceTombstoned } from '../../shared/workspace-registry'
import { effectiveAgentLaunchSettings } from '../../shared/launch-settings'
import {
  gitHostIdForPath,
  wslHostId,
  type ExecutionHostId,
  type ExecutionHostSettings,
} from '../../shared/execution-host'
import { ensureSkillInstalled, resolveSkillById } from '../../main/builtin-skills'
import { cliResumeCapabilities } from '../../main/cli-resume-capabilities'
import {
  createAgentPermissionResolver,
  type AgentPermissionResolver,
} from '../../main/automation/launch-permission-cap'
import { createConversationGatewayHost } from './conversation-host'
import {
  CONVERSATION_COMMANDS_CACHE_FILE,
  createConversationCommandsDiskCache,
} from '../../main/conversation-commands/disk-cache'
import {
  createConversationCommandsService,
  type ConversationCommandsService,
} from '../../main/conversation-commands/service'
import { resolveCheckoutForCwd } from '../../main/checkout-resolve'
import {
  conversationBranchesOf,
  conversationCheckoutsOf,
  conversationHostOf,
  conversationPullRequestsOf,
  conversationLocalServersOf,
  tailnetSelfMachine,
  type ConversationMachineContext,
} from '../../main/automation/tailnet/tailnet-conversation-machine'
import { ConversationApprovalRuleStore } from '../../main/conversation-approval-rules'
import {
  ConversationAttachmentStore,
  CONVERSATION_ATTACHMENTS_DIRECTORY,
  CONVERSATION_TOOL_IMAGES_DIRECTORY,
} from '../../main/conversation-attachment-store'
import { TAILNET_UPLOADS_DIRNAME } from '../../main/automation/tailnet/tailnet-file-uploads'
import { WEB_UPLOADS_DIRNAME } from '../web/web-uploads'
import { attachmentImagesRoot } from '../../main/attachment-image-file'
import { createConversationLaunchService } from '../../main/conversation-launch-service'
import { createSubagentLifecycle, subagentChangesOf } from '../../main/subagent-lifecycle'
import { createConversationCheckoutChanges } from '../../main/conversation-checkout-changes'
import { createConversationImportService } from '../../main/conversation-import/conversation-import-service'
import { createConversationModelCatalog } from '../../main/conversation-model-catalog'
import { ConversationPlanStore } from '../../main/conversation-plan-store'
import { ConversationOutbox } from '../../main/conversation-outbox'
import { ConversationRuntime, type ConversationRuntimeOptions } from '../../main/conversation-runtime'
import { writeDiagnosticLog } from '../../main/diagnostics-service'
import { createGitWorktree, getGitRepoRoot } from '../../main/git'
import { listGitWorktrees } from '../../main/git-worktree-list'
import { startedDependencyInstall } from '../../main/worktree-pool/dependency-install'
import { installGitHostResolver, withGitHost } from '../../main/git-run'
import { createHostRegistry, installHostRegistry } from '../../main/hosts/host-registry'
import { createAgentLaunchSettingsStore } from '../../main/launch-settings-store'
import { setWorktreeBranchPrefixReader } from '../../main/worktree-branch-prefix'
import { readDiscoveredCliModelCatalogs } from '../../main/model-discovery/service'
import { listPluginRegistryEntries } from '../../main/plugin-registry-instance'
import { powerActivity } from '../../main/power-activity'
import { getSharedCredentialStore } from '../../main/secret-store'
import { createWorkspaceRegistryService } from '../../main/workspace-registry-service'
import { createWorkspaceRegistryStore } from '../../main/workspace-registry-store'
import { createWorkspaceSyncService } from '../../main/workspace-sync-service'
import { startWorkspaceStoreMigration } from '../../main/workspace-store-migration'
import { invalidateCliAvailabilityOnHost, knownCliAvailability } from '../../main/cli-availability'
import { createChatTitler } from '../../main/text-generation/chat-titler'
import { generateChatTitle } from '../../main/text-generation/text-generation-service'
import { createTextGenerationSettingsStore } from '../../main/text-generation/text-generation-settings-store'
import {
  createConversationLifecycle,
  latestTurnEnd,
  onlyOwnChatTurn,
} from '../../main/automation/conversation-lifecycle'
import { createConversationMove, isDirectory, moveConversationStorage } from '../../main/automation/conversation-move'
import { conversationSessionWorking, terminalAgentWorking } from '../../shared/conversation/phase'
import { forkedAgentPatch, forkName } from '../../shared/conversation/fork'
import {
  runsTurnMode,
  type ConversationMessageOrigin,
  type ConversationSessionSummary,
} from '../../shared/conversation-runtime'
import { installedStudioPlatform, installStudioPlatform, type StudioPlatform } from '../platform/platform'
import { createStudioExtensions, type StudioExtensionsDeps } from '../extensions/extensions-domain'
import { createStudioArtifacts, type StudioArtifactsShell } from '../artifacts/artifacts-domain'
import { listKnownWorkspaceRoots } from '../../main/workspace-roots'
import type { StudioPaths } from '../platform/studio-paths'
import { createPullRequestDomain } from '../pull-requests/pull-request-domain'
import { createLocalServerDomain } from '../local-servers/local-server-domain'
import { localConversationBackend, refuseOtherEnvironments, type ConversationBackend } from './conversation-backend'
import { environmentRouteOfRecord, type EnvironmentClients } from '../../shared/environment-clients'
import { createEnvironmentReplicas } from '../environment/environment-replicas'
import { createEnvironmentMigration } from '../environment/environment-migration'
import { chatSourceFiles } from '../environment/environment-chat-sources'
import { studioMigrationStores } from '../environment/environment-migration-stores'
import { combineEnvironmentClients, createWslEnvironmentClients } from '../wsl/wsl-environment-clients'
import type { WslServers } from '../wsl/desktop-wsl-servers'
import { followRelayedAgentState } from '../wsl/agent-state-relay'
import { createWslLaunchTokens } from '../wsl/wsl-launch-tokens'
import { createWslTerminalSessions, terminalHostOf, type WslTerminalSessions } from '../wsl/wsl-terminal-host-client'
import { createWslMachineAccess, followCliPathsChanged } from '../wsl/wsl-machine-client'
import { WslSetupError } from '../../main/hosts/wsl-setup-error'
import type { StudioRole } from './data-dir'
import { takeDataDir } from './take-data-dir'
import { createStudioUsageLimitResumes, studioConversationUsageLimits } from './studio-usage-limit-resumes'
import { studioPullRequestWakes } from './studio-pull-request-wakes'
import { createStudioScheduledAgents } from './studio-scheduled-agents'
import { keptImagesIn } from '../../main/scheduled-agents/prompt-images'
import { createEnvironmentReadiness } from '../environment/environment-readiness'
import { sharedGhRunner } from '../../main/github/gh'
import { createPullRequestChatFolders } from '../pull-requests/pull-request-chat-folders'
import { createStudioScheduledMessages, studioHeldMessages, studioScheduledSends } from './studio-scheduled-messages'
import { createStudioAutoCompact } from './studio-auto-compact'
import { createSettledChatsSettingsStore } from '../../main/settled-chats-settings-store'
import { createStudioSettlement } from './studio-settlement'
import { createStudioWorktreePool, WORKTREE_QUIT_WAIT_MS } from './studio-worktree-pool'
import { createStudioAgents, type StudioAgentServices } from './studio-agent-services'
import type { StudioAgentSkillsDeps } from './studio-agent-skills'
import {
  createStudioAgentTerminals,
  type StudioAgentTerminals,
  type StudioTerminalHost,
} from './studio-agent-terminals'

// The Studio core: the services the server owns (studio-server design, section
// 4.1), composed once. The desktop builds it inside Electron main, from
// `createAppServices`, with the Electron platform; the standalone server
// (src/server/main.ts) builds it under plain Node with the Node platform. Both
// go through this function, so there is one wiring of the core and not two
// that drift.
//
// What is here: launch settings and the machines they name, the workspace
// registry and its sync, git's machine resolver, the conversation runtime and
// the backend every caller drives chats through (providers, checkpoints, the
// thread index and transcripts are the runtime's), the model catalog, the
// launch service that starts a chat for a caller with no window, the worktree
// pool the chats' worktrees are leased from and brought back by, the pull
// request record, which reacts to chats and so is the server's (owner ruling
// 2026-10-03), and the local servers the agents started, which are checked
// where the agents run (owner ruling 2026-10-04). The MCP
// gateway is composed beside it (studio-gateway.ts), because the desktop adds
// tools to it that act on windows and terminals.
//
// And the terminals and their agents (studio-agent-terminals.ts): the ptys,
// the reporter's listener and the launches, here in every mode; and the agent
// CLIs and their setup (studio-agent-services.ts), in every mode too.
//
// What is not, yet: the module host and its bundled modules (they still take
// the shell's account bridge), and everything the shell owns.
// What is not, ever: the browser and the canvas (owner ruling 2026-10-02: the
// server draws nothing). They are toolsets a client offers, which the gateway
// lists and routes (src/server/tools/); the server keeps only the board files,
// read and written through `files.*`.

export type StudioCoreOptions = {
  /** Which kind of process this core runs in; decides the lock and secret rules below. */
  role: StudioRole
  /**
   * How a Claude chat's child reaches this process's MCP gateway, on the machine
   * its `claude` runs on. Null for no gateway entry.
   */
  resolveStudioMcpServer?: ConversationRuntimeOptions['resolveStudioMcpServer']
  /**
   * What the process around the core adds to its terminal agents: the
   * shell's part of a launch (over the shell bridge) and, in process, the
   * shell's observers of the sessions (studio-agent-terminals.ts). Absent,
   * terminals still run here, launched without the shell's preparation.
   */
  terminalHost?: StudioTerminalHost
  /**
   * The services the agents are set up with, when the process around the core
   * uses them too (the desktop's shell, in process): one of each. Absent, the
   * core builds its own (studio-agent-services.ts).
   */
  agentServices?: StudioAgentServices
  /** What the desktop's shell adds to the agents' skills and cards: its Trash and its window focus. */
  agentSkills?: Omit<StudioAgentSkillsDeps, 'mcpConfig'>
  /**
   * What a desktop's Studio is extended with (`extensions`): given, the core
   * holds the marketplace, the CLI catalogue, the extension scaffold and the
   * hosted feeds, and a card's `install.module` goes through its marketplace.
   * The shell adds Studio's own plugin in a workspace, which it installs, and
   * is told when what is installed changes. Absent (a server on a WSL or SSH
   * machine), none of it is served.
   */
  extensions?: Pick<StudioExtensionsDeps, 'studioPluginStatus' | 'changed'>
  /**
   * Where a desktop's Studio publishes its agents' pages (`artifacts`): given,
   * the core holds Settings ▸ Artifacts, its set-up and the agents'
   * `artifacts.*` tools. The shell adds a page's picture and asks the person
   * natively when no window is showing; the GitHub token is the process's.
   * Absent (a server on a WSL or SSH machine), none of it is served.
   */
  artifacts?: StudioArtifactsShell & { resolveGitHubToken(): Promise<string> }
  /**
   * Who turns the scheduler on. A process with a module kernel (the desktop,
   * in process and out) turns it on and off with the person's Scheduled
   * agents switch (`modules/scheduled-agents-switch.ts`); a server with none
   * runs its schedules from the start. `core` unless said.
   */
  scheduledAgentsSwitch?: 'core' | 'modules'
  /**
   * Windows: the Studio servers inside this PC's WSL distributions (phase 7),
   * each of which holds that distribution's chats (design-wsl-ssh-direct PR
   * 3c). This core supervises them and reaches each over its owner connection.
   */
  wslServers?: (deps: { readHostSettings: () => Partial<Record<ExecutionHostId, ExecutionHostSettings>> }) => WslServers
  /**
   * Other environments' Studios (an SSH machine's), as the desktop's own
   * callers reach a chat one holds: the gateway's tools and modules act on it
   * there, as a client of that machine (design-wsl-ssh-direct PR 1d).
   */
  environmentClients?: EnvironmentClients | null
  /**
   * A saved SSH machine's host, as its SSH config resolves it (else as it was
   * typed), and its resolved port: what its kind and colour are keyed by.
   * Without it a paired phone is not told which SSH machine a chat runs on.
   */
  sshMachineOf?(savedId: string): { host: string; port?: number | null } | null
}

export { StudioDataDirBusyError, StudioDataDirUnusableError } from './take-data-dir'

export type StudioCore = ReturnType<typeof createStudioCore>

/**
 * The searcher a paired device's mention searches run under: no window's
 * sender id is below zero, so its searches never supersede a window's, and
 * each device's own channel keeps its searches from superseding another's.
 */
const TAILNET_FILE_SEARCH_SENDER = -1

export function createStudioCore(platform: StudioPlatform, options: StudioCoreOptions) {
  // Installed first, so a free function deep in the graph (the credential
  // store, a resource lookup) reads this platform even when the caller has not
  // installed one. The desktop's entry has already installed the same one.
  if (installedStudioPlatform() !== platform) installStudioPlatform(platform)
  const dataDir = platform.paths.dataDir()
  const taken = takeDataDir(platform, options.role)
  const dataDirLock = taken.lock

  const logDiagnostic =
    (source: 'agents' | 'workspace') =>
    (diagnostic: { level: 'warning'; title: string; message: string; details?: string }) => {
      void writeDiagnosticLog({ ...diagnostic, source })
    }

  // The agent-launch settings (CLI runtimes, MCP, knowledge roots, last CLI,
  // spawn permission preset). The core owns them: clients read and patch this
  // store, and every launch the core makes reads it.
  const agentLaunchSettings = createAgentLaunchSettingsStore({
    resolveUserDataDir: () => platform.paths.dataDir(),
    logDiagnostic: logDiagnostic('agents'),
  })
  // The prefix every worktree branch this process names starts with, and the
  // ones its cleanup recognises: read from the record on each use, so a
  // change in Settings ▸ Worktrees names the next one.
  setWorktreeBranchPrefixReader(() => effectiveAgentLaunchSettings(agentLaunchSettings.get()).worktreeBranchPrefix)

  // The machines this computer offers (shared/execution-host.ts): this one,
  // and on Windows each WSL distribution. One registry, installed for the whole
  // process, so a launch, the reaper and the git runner resolve a host against
  // the same per-machine settings.
  // Built before the WSL servers (below), so their status is read when listed.
  let wslServersForHosts: WslServers | null = null
  const noWslServers = (distro: string) =>
    new WslSetupError(`Studio cannot start a server in ${distro} on this computer.`, { fatal: true, code: 'start' })
  // The launch tokens of this desktop's WSL terminal agents, which the gateway
  // of each distribution's own Studio proves them by (wsl-launch-tokens.ts).
  const wslLaunchTokens = createWslLaunchTokens(
    {
      connect: (distro) => {
        const servers = wslServersForHosts
        return servers ? servers.manager.connect(distro) : Promise.reject(noWslServers(distro))
      },
      current: (distro) => wslServersForHosts?.manager.current(distro) ?? null,
    },
    (message) => void writeDiagnosticLog({ level: 'info', source: 'terminal', title: 'WSL terminal agents', message }),
  )
  const hosts = createHostRegistry({
    readHostSettings: () => agentLaunchSettings.get().hosts,
    // Git, the home and watches in a distribution are its own Studio's.
    machine: createWslMachineAccess(() => wslServersForHosts?.manager ?? null, noWslServers),
    // A WSL terminal agent's plugin copy carries the Studio skills chosen here.
    enabledSkills: () => agents.services.areaSkills.enabledSkillDirs(),
    server: (distro) => {
      const servers = wslServersForHosts
      if (!servers) return undefined
      const status = servers.manager.status(distro)
      return {
        state: status.state,
        ...(status.transport ? { transport: status.transport } : {}),
        ...((status.reason ?? status.transportReason) ? { reason: status.reason ?? status.transportReason } : {}),
      }
    },
    // A WSL terminal's agent reports through, and reaches the tools of, its
    // distribution's server, which this core supervises: started for the
    // launch, held while it runs, told the launch's token.
    distribution: {
      connect: async (distro) => {
        const servers = wslServersForHosts
        if (!servers) throw noWslServers(distro)
        const connection = await servers.manager.connect(distro)
        return {
          agentStateSocket: connection.agentStateSocket,
          dataDir: connection.dataDir,
          sessionDir: connection.terminals.sessionDir,
          pidDir: connection.terminals.pidDir,
          nodePath: connection.terminals.nodePath,
          resourcesDir: connection.terminals.resourcesDir,
        }
      },
      terminalHost: async (distro, { start }) => {
        const servers = wslServersForHosts
        if (!servers) return null
        const connection = start ? await servers.manager.connect(distro) : servers.manager.current(distro)
        return connection ? terminalHostOf(connection) : null
      },
      hold: (distro, key) => wslServersForHosts?.manager.hold(distro, key),
      release: (distro, key) => wslServersForHosts?.manager.release(distro, key),
      issueLaunchToken: (distro, identity) => wslLaunchTokens.issue(distro, identity),
      revokeLaunchToken: (distro, token) => wslLaunchTokens.revoke(distro, token),
    },
  })
  installHostRegistry(hosts)
  let lastHostSettings = JSON.stringify(agentLaunchSettings.get().hosts)
  agentLaunchSettings.subscribe((record) => {
    const next = JSON.stringify(record.settings.hosts)
    if (next === lastHostSettings) return
    lastHostSettings = next
    hosts.notifyChanged()
  })
  // The agent CLIs on this machine and what they are set up with, served by
  // every Studio (`agent-runtimes`, `agent-setup`).
  // What a desktop's Studio is extended with, built before the agents so a
  // card's `install.module` goes through the same marketplace a window's does.
  const extensions = options.extensions
    ? createStudioExtensions({
        paths: platform.paths,
        mcpConfig: () => agents.services.mcpConfig,
        openWorkspaceRoots: () => listKnownWorkspaceRoots(workspaceSyncService.getSnapshot()),
        ...options.extensions,
      })
    : null
  const agents = createStudioAgents(platform, {
    agentLaunchSettings,
    ...(options.agentServices ? { services: options.agentServices } : {}),
    ...(options.agentSkills || extensions
      ? {
          skills: {
            ...options.agentSkills,
            ...(extensions ? { marketplace: extensions.marketplace.cardMarketplace } : {}),
          },
        }
      : {}),
  })

  // The authoritative workspace registry. Routing lives in the record, so no
  // side-map of names, folders or modes is needed beside it.
  const workspaceRegistryStore = createWorkspaceRegistryStore({
    resolveUserDataDir: () => platform.paths.dataDir(),
    logDiagnostic: logDiagnostic('workspace'),
  })
  const workspaceRegistry = createWorkspaceRegistryService({
    store: workspaceRegistryStore,
    logDiagnostic: logDiagnostic('workspace'),
  })
  const workspaceSyncService = createWorkspaceSyncService({
    registry: workspaceRegistry,
    resolveResumeCapabilities: cliResumeCapabilities,
  })
  // This PC's WSL distributions' Studio servers, supervised by this core
  // (Windows only), and every other environment's Studio this desktop's
  // callers reach a chat on: a distribution's over this core's own owner
  // connection to it, an SSH machine's over main's.
  const wslServers =
    process.platform === 'win32' && options.wslServers
      ? options.wslServers({ readHostSettings: () => agentLaunchSettings.get().hosts })
      : null
  const wslTerminalSessions: WslTerminalSessions | null = wslServers
    ? createWslTerminalSessions(wslServers.manager, (message) => {
        void writeDiagnosticLog({ level: 'info', source: 'terminal', title: 'WSL terminal agents', message })
      })
    : null
  if (wslServers) {
    wslServersForHosts = wslServers
    // Settings › Machines reads the server's state with the machine list.
    wslServers.onStatus(() => hosts.notifyChanged())
    // A new connection may have missed a revoke: it is told every live token.
    wslServers.onConnected((connection) => wslLaunchTokens.connected(connection.distro, connection))
    // The run's first connection to a distribution ends what an earlier run's
    // WSL terminals left running there.
    wslServers.onConnected((connection) => wslTerminalSessions?.connected(connection))
    // A CLI installed or removed in a distribution: what a launch knows of
    // that machine's CLIs is forgotten, and read again when next asked.
    wslServers.onConnected((connection) =>
      followCliPathsChanged(connection, (distro) => invalidateCliAvailabilityOnHost(wslHostId(distro))),
    )
  }
  const environmentClients = combineEnvironmentClients(
    wslServers
      ? createWslEnvironmentClients({
          manager: wslServers.manager,
          onConnected: (listener) => wslServers.onConnected(listener),
        })
      : null,
    options.environmentClients ?? null,
  )
  // This desktop's copies of the chats another environment holds (an SSH
  // machine's, a WSL distribution's), written only from what that Studio
  // says (environment-replicas.ts), and followed from each time it connects.
  const environmentReplicas = environmentClients
    ? createEnvironmentReplicas({
        clients: environmentClients,
        sync: workspaceSyncService,
        log: (message) => {
          void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'Another machine', message })
        },
      })
    : null

  // Git for a repository runs on the machine of the open workspace holding
  // it, which is where its agents run theirs: a `C:\` folder of a WSL
  // workspace in that distribution, and a folder inside a distribution on
  // This PC when its workspace runs here (owner ruling 2026-10-03). A folder
  // no workspace holds goes by where it lives. macOS and Linux have one
  // machine, so their git never asks.
  installGitHostResolver((cwd) => {
    if (process.platform !== 'win32') return null
    const id = gitHostIdForPath(cwd, workspaceSyncService.getSnapshot().state.workspaces)
    return id ? hosts.get(id) : null
  })

  // The terminal agents (studio-agent-terminals.ts), built once the chats and
  // sub-agents they read exist, below; read lazily by what is built before.
  let agentTerminals: StudioAgentTerminals | null = null

  // The worktree pool, its dependency installs, the `worktree.*` tools and the
  // chat-folder guard every turn passes (studio-worktree-pool.ts): this
  // core's in every mode, beside the agents that work in the slots.
  const worktrees = createStudioWorktreePool({
    platform,
    workspaceRegistry,
    workspaceSyncService,
    // Read when a step asks, long after `conversations` below is set.
    liveConversationPaths: () => conversations.liveConversationWorkspaceRoots(),
    conversations: () => conversations,
    // This core's own terminals, read where they run: one starting in a slot
    // holds it until it is live, through the same holds the pool takes.
    listTerminalSessions: () => agentTerminals?.list() ?? [],
  })

  // Where a desktop's Studio publishes its agents' pages: an agent publishes
  // from its chat's folders, its pool worktree among them.
  const artifacts = options.artifacts
    ? createStudioArtifacts({
        ...options.artifacts,
        paths: platform.paths,
        findWorkspace: (workspaceId) =>
          workspaceSyncService.getSnapshot().state.workspaces.find((workspace) => workspace.id === workspaceId) ?? null,
        poolWorktrees: async () => (await worktrees.pool.snapshots()).flatMap((snapshot) => snapshot.slots),
      })
    : null

  // The conversation runtime: chat sessions and the providers and agent CLI
  // children behind them, transcripts, the thread index and checkpoints. Owned
  // here so the owner's shutdown disposes its child processes.
  // The saved approvals, which a revoked app's tools leave with it.
  const approvalRules = new ConversationApprovalRuleStore(dataDir)
  const conversationRuntime = new ConversationRuntime({
    secretStore: getSharedCredentialStore(),
    approvalRules,
    attachmentStore: new ConversationAttachmentStore(dataDir),
    uploadRoots: [join(dataDir, TAILNET_UPLOADS_DIRNAME), join(dataDir, WEB_UPLOADS_DIRNAME)],
    planStore: new ConversationPlanStore(dataDir),
    outbox: new ConversationOutbox(dataDir),
    heldChatMode: ({ workspaceId, agentId }) => {
      const agent = workspaceRegistry.getRecord(workspaceId)?.agents[agentId]
      return agent?.conversationModeHeld && agent.conversationMode !== 'default' ? agent.conversationMode : undefined
    },
    subagentPresetCeiling: ({ workspaceId, agentId, current }) => {
      const agents = workspaceRegistry.getRecord(workspaceId)?.agents
      const agent = agents?.[agentId]
      if (!agent?.subagentOf) return undefined
      if (agent.subagentReadOnly) return current
      const parent = agents?.[agent.subagentOf.agentId]
      return parent?.cliPermissionPreset ? normalizeCliPermissionPreset(parent.cliPermissionPreset) : current
    },
    ...(options.resolveStudioMcpServer ? { resolveStudioMcpServer: options.resolveStudioMcpServer } : {}),
    // Every session start and turn, whoever sent it, finds the chat's folder
    // where it should be first: a slot the pool gave back is brought back.
    prepareChatFolder: worktrees.prepareChatFolder,
  })
  conversationRuntime.startIdleSweep(powerActivity)
  // The turns the last run left open end now, in their chats' logs, rather
  // than when someone next opens each chat: once the data directory is this
  // process's alone (a server it took over may still be finishing those
  // turns), and never by a process running without its lock.
  if (dataDirLock)
    void taken.whenFree
      .then(() => conversationRuntime.recoverInterruptedTurns())
      .catch((error: unknown) => {
        console.warn('[studio-core] open turns could not be closed:', error instanceof Error ? error.message : error)
      })
  // Each project's state lives in its store in the person's home, on the
  // machine its chats run on (main/workspace-store.ts). An older build kept it
  // in `<project>/.sprintengine/`: moved out the first time a folder reaches
  // the store, and in the background, from the next turn of the loop, for
  // every project the registry holds, so a chat's history is in place before
  // anyone opens it.
  startWorkspaceStoreMigration(
    () => workspaceSyncService.getSnapshot().state.workspaces.map((workspace) => workspace.folderPath),
    { log: (message) => console.info(`[workspace-store] ${message}`) },
  )
  // What only the runtime's owner does with it: the idle threshold, hearing
  // when one of this process's chats lets go of its turn, and the flush and
  // shutdown at the end. Everything else goes through the backend.
  const conversationOwner = {
    setIdleThresholdMs: (value: unknown) => conversationRuntime.setIdleThresholdMs(value),
    onSessionIdle: (listener: (summary: ConversationSessionSummary) => void) =>
      conversationRuntime.onSessionIdle(listener),
    flushTranscripts: () => conversationRuntime.flushTranscripts(),
    // Each WSL server drains its own chats, within the quit's ten seconds,
    // beside this process's, once it has ended what this desktop's WSL
    // terminals left there (ending `wsl.exe` does not reach Linux processes).
    shutdown: async () => {
      await Promise.all([
        (wslTerminalSessions?.endAll(2_000) ?? Promise.resolve())
          .then(() => wslServers?.manager.shutdown({ budgetMs: 8_000 }))
          .catch(() => undefined),
        wslServers?.access.close().catch(() => undefined),
        conversationRuntime.shutdown(),
      ])
    },
  }
  // What every caller drives chats through; the runtime itself is only for
  // what its owner does (the idle sweep, flush, shutdown). A chat another
  // environment holds (an SSH machine's, a WSL distribution's) never runs in
  // this process: it is that environment's Studio's, reached as its client.
  const conversations: ConversationBackend = refuseOtherEnvironments(localConversationBackend(conversationRuntime), {
    recordOf: (workspaceId) => workspaceRegistry.getRecord(workspaceId),
  })

  // What becomes of a sub-agent once it runs. Its end and its parent's stop
  // come from the runtime's events, here, and its record goes through the bus
  // so every window sees it.
  const subagentKey = (chat: { workspaceId: string; agentId: string }) => {
    const record = workspaceRegistry.getRecord(chat.workspaceId)
    const workspaceRoot = conversationWorkingRoot(record?.agents[chat.agentId], record?.folderPath)
    return workspaceRoot ? { ...chat, workspaceRoot } : null
  }
  const subagents = createSubagentLifecycle({
    // This core's chats only: a copy of another environment's chat has its
    // sub-agents there, and their ends are that Studio's to record.
    agentsOf: (workspaceId) => {
      const record = workspaceRegistry.getRecord(workspaceId)
      return record && !environmentRouteOfRecord(record) ? record.agents : null
    },
    workspaceIds: () =>
      workspaceRegistry
        .getRecords()
        .filter((record) => !environmentRouteOfRecord(record))
        .map((record) => record.id),
    writeEnd: ({ workspaceId, agentId }, subagentEnd) => {
      workspaceSyncService.updateWorkspaceAgent(workspaceId, agentId, { subagentEnd }, 'system')
    },
    removeAgent: ({ workspaceId, agentId }) => {
      workspaceSyncService.updateWorkspaceAgent(workspaceId, agentId, null, 'system')
    },
    session: (chat) => {
      const listed = conversations.listSessions({ workspaceId: chat.workspaceId, agentId: chat.agentId })
      return listed.ok ? listed.sessions.sort((a, b) => b.updatedAt - a.updatedAt)[0] : undefined
    },
    interrupt: (sessionId) => conversations.interrupt({ sessionId }),
    rest: (sessionId) => conversations.suspendSession({ sessionId }),
    readEvents: async (chat, turns) => {
      const key = subagentKey(chat)
      if (!key) return []
      const read = await conversations.readConversationSync(key, { turnLimit: turns })
      if (!read.ok) return []
      return read.kind === 'snapshot' ? read.page.events : read.events
    },
    deleteTranscript: async (chat) => {
      const key = subagentKey(chat)
      if (key) await conversations.deleteTranscript(key)
    },
    log: (message) => console.warn(`[subagents] ${message}`),
  })
  conversations.onEvent((event) => subagents.onConversationEvent(event))
  conversationRuntime.onSessionIdle((summary) => subagents.onSessionIdle(summary))
  workspaceSyncService.subscribeEvents((event) => {
    if (event.type === 'workspace.agents_updated') subagents.onAgentsChanged(event.payload.workspaceId)
  })
  subagents.reconcile()

  // The terminals and their agents run here, in every mode: the ptys, the
  // reporter's listener, the launch service every terminal launch goes
  // through, the control plane and the launch notices. None where this
  // process cannot load the pty module (a WSL or SSH machine's server).
  agentTerminals = createStudioAgentTerminals({
    platform,
    whenDataDirFree: taken.whenFree,
    // A desktop that could not take the directory carries on as builds
    // before the lock did, its reporter included; any other process listens
    // only with the lock, so two never share the socket.
    reporterListens: dataDirLock !== null || options.role === 'desktop',
    workspaceRegistry,
    workspaceSyncService,
    agentLaunchSettings,
    conversations,
    subagents,
    onChatIdle: (listener) => {
      conversationRuntime.onSessionIdle(listener)
    },
    setChatIdleThresholdMs: (value) => conversationRuntime.setIdleThresholdMs(value),
    ...(options.terminalHost ? { host: options.terminalHost } : {}),
  })
  // What this desktop's WSL terminals' agents report from inside their
  // distribution, relayed by its server on each connection to it.
  if (wslServers && agentTerminals) {
    const listener = agentTerminals.agentState
    wslServers.onConnected((connection) =>
      followRelayedAgentState(
        connection,
        (line) => listener.ingestLine(line),
        (message) => {
          void writeDiagnosticLog({ level: 'info', source: 'terminal', title: 'WSL terminal agents', message })
        },
      ),
    )
  }

  const conversationModelCatalog = createConversationModelCatalog({
    listClis: () => listPluginRegistryEntries(),
    readDiscovered: () => readDiscoveredCliModelCatalogs(),
    userModels: (cli) => agentLaunchSettings.get().cliRuntimes[cli]?.models,
    removedModels: (cli) => agentLaunchSettings.get().cliRuntimes[cli]?.removedModels,
  })

  // Starting a chat for a caller with no window to start it in (a paired
  // machine's New chat, `conversation.create`, a module). The record goes
  // through the sequenced bus like any agent the core registers, so every
  // client hears about the chat the moment it exists.
  const conversationLaunchService = createConversationLaunchService({
    getWorkspace: (workspaceId) => workspaceRegistry.getRecord(workspaceId) ?? null,
    getLaunchSettings: () => agentLaunchSettings.get(),
    writeAgent: (workspaceId, agentId, agent) =>
      workspaceSyncService.updateWorkspaceAgent(workspaceId, agentId, agent, 'system'),
    listWorkspaces: () => workspaceRegistry.getRecords(),
    createWorkspace: (request) => {
      const created = workspaceSyncService.createWorkspace(request, 'system')
      return created.ok ? { ok: true, workspaceId: created.result.workspace.id } : created
    },
    removeWorkspace: (workspaceId) => {
      workspaceSyncService.removeWorkspace(workspaceId, 'system')
    },
    startSession: (input) => conversations.startSession(input),
    send: (input) => conversations.sendTurn(input),
    recordProjectUse: (folderPath) => {
      agentLaunchSettings.update({ projectUse: { folderPath, at: Date.now() } }, 'system')
    },
    // A turn mode needs a provider that can run one; the others ignore it.
    runsTurnMode: (providerId, mode) => runsTurnMode(conversationRuntime.getProviderCapabilities(providerId), mode),
    // The levels the CLI's picker offers, from the same manifests it reads.
    reasoningLevels: (cli) =>
      listPluginRegistryEntries()
        .find((entry) => entry.id === cli)
        ?.reasoningSelection?.levels.map((level) => level.id) ?? [],
    // A new chat's worktree, cut by the machine the chat runs on, as a
    // scheduled run's is: from this core's worktree pool (a fresh one when the
    // pool declines), on the default branch, locked to its branch until the
    // chat claims it.
    getRepoRoot: (folderPath, hostId) =>
      withGitHost(hostId ? hosts.get(hostId) : null, () => getGitRepoRoot(folderPath)),
    createWorktree: async (input) => {
      const created = await withGitHost(input.hostId ? hosts.get(input.hostId) : null, () =>
        createGitWorktree({
          repoRoot: input.repoRoot,
          containerPath: input.containerPath,
          destinationPath: input.destinationPath,
          branchName: input.branchName,
          baseRef: 'HEAD',
          fromPool: true,
          copyIncludedFiles: true,
          // The chat is created after its worktree, so the branch names the owner.
          agentLockOwner: input.branchName,
          // Every caller here is a client with a call timeout of its own (a
          // paired device's New chat, `conversation.create`): the chat is
          // made while the project's dependency install runs, and its first
          // message waits for it instead.
          dependencyInstall: 'start',
        }),
      )
      if (!created.ok) return { ok: false, message: created.message }
      const installing = startedDependencyInstall(created.data.dependencyInstall)
      return {
        ok: true,
        path: created.data.path,
        branch: created.data.branch ?? input.branchName,
        baseRef: created.data.baseRef,
        ...(installing ? { dependencyInstall: installing } : {}),
      }
    },
    // The worktrees a new chat may be started in, read as `workspace.checkout`
    // reads them for the picker that named one: bare entries dropped, the main
    // worktree first. Asked of the machine the chat runs on.
    listWorktrees: async (repoRoot, hostId) => {
      const listed = await withGitHost(hostId ? hosts.get(hostId) : null, () =>
        listGitWorktrees(repoRoot, { resolvedRoot: true }),
      )
      if (!listed.ok) return null
      return listed.data.worktrees
        .filter((entry) => !entry.bare)
        .map((entry) => ({ path: entry.path, branch: entry.branch }))
    },
    // The same installer a terminal launch's skill-at-spawn uses, into the
    // folder the chat works in (a run's worktree when it has one).
    ensureSkillInstalled: (workingRoot, skillId) => ensureSkillInstalled(workingRoot, skillId),
    warn: (message) => {
      void writeDiagnosticLog({ level: 'warning', source: 'workspace', title: 'Chat launch', message })
    },
  })

  // The sessions a person ran in an agent CLI's own terminal, brought in as
  // chats (conversation-import-service.ts). The CLIs' homes it reads are this
  // machine's, so the chats it writes are this process's own runtime's: a
  // session ran here, in a folder here.
  const conversationImport = createConversationImportService({
    listWorkspaces: () => workspaceRegistry.getRecords(),
    createWorkspace: (request) => {
      const created = workspaceSyncService.createWorkspace(request, 'system')
      return created.ok ? { ok: true, workspaceId: created.result.workspace.id } : created
    },
    removeWorkspace: (workspaceId) => {
      workspaceSyncService.removeWorkspace(workspaceId, 'system')
    },
    importTranscript: (input) => conversationRuntime.importTranscript(input),
    getLaunchSettings: () => agentLaunchSettings.get(),
  })

  // The pull requests the conversations opened (pull-request-domain.ts): heard
  // from a chat's create calls, from a client's forwarded terminal tool calls,
  // and from the gateway's `pull_request.link`. Every client reads it through
  // `pullRequests.*`. With no `gh` on this machine it shows what it has, as
  // last read. A pull request an agent asked to have watched
  // (`pull_request.watch`) wakes its chat through the same send a resume
  // after a usage limit takes, marked as Studio's (studio-pull-request-wakes.ts).
  const pullRequests = createPullRequestDomain({
    dataDir,
    conversations,
    wakes: studioPullRequestWakes({
      conversations,
      workspaceRecord: (workspaceId) => workspaceRegistry.getRecord(workspaceId),
      workspaceRemoved: (workspaceId) => isWorkspaceTombstoned(workspaceRegistry.getTombstones(), workspaceId),
      // A WSL distribution's server and an SSH machine's hold no record of
      // their chats: a watched one's folder is kept here for its wakes.
      chatFolders: createPullRequestChatFolders({
        dataDir,
        log: (message) => {
          void writeDiagnosticLog({ level: 'warning', source: 'workspace', title: 'Pull request watch', message })
        },
      }),
      // Called only once a wake goes, long after the core is composed.
      createHost: (hostOptions) => createConversationHost(hostOptions),
      log: (message) => {
        void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'Pull request watch', message })
      },
    }),
    // An open pull request is probed every couple of minutes while a window
    // is in front, and far less often while none is.
    // A watch whose read fails for want of `gh` here holds, and says so.
    recordOptions: { focus: powerActivity, ghLacking: (reason) => readiness.ghLacking(reason) },
    workspaceFolder: (workspaceId) => workspaceRegistry.getRecord(workspaceId)?.folderPath ?? null,
    log: (message, error) => {
      void writeDiagnosticLog({
        level: 'warning',
        source: 'workspace',
        title: 'Pull request record',
        message,
        ...(error === undefined
          ? {}
          : { details: error instanceof Error ? (error.stack ?? error.message) : String(error) }),
      })
    },
  })

  // The local servers the conversations' agents started (local-server-domain.ts):
  // linked through the gateway's `local_server.link`, checked from here, where
  // the agents run, and read by every client through `localServers.*`. A
  // command the agent gave without a folder runs where its chat works (the
  // session's own root, a worktree, when it has one), else in the workspace's
  // folder; a folder on another machine is not one to run in here.
  const localFolder = (folder: string | null | undefined) => (folder && !isMachinePath(folder) ? folder : null)
  const localServers = createLocalServerDomain({
    dataDir,
    conversationFolder: (key) => {
      const listed = conversations.listSessions({ workspaceId: key.workspaceId, agentId: key.agentId })
      const latest = listed.ok ? [...listed.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0] : undefined
      const sessionRoot = latest ? conversations.sessionWorkspaceRoot(latest.sessionId) : null
      return localFolder(sessionRoot) ?? localFolder(workspaceRegistry.getRecord(key.workspaceId)?.folderPath)
    },
    // Read from the registry's tombstones rather than from a missing record:
    // a registry that failed to load is not a person removing every workspace.
    workspaceRemoved: (workspaceId) => isWorkspaceTombstoned(workspaceRegistry.getTombstones(), workspaceId),
    log: (message, error) => {
      void writeDiagnosticLog({
        level: 'warning',
        source: 'workspace',
        title: 'Local servers',
        message,
        ...(error === undefined
          ? {}
          : { details: error instanceof Error ? (error.stack ?? error.message) : String(error) }),
      })
    },
  })
  // A removed workspace's servers go with it, whichever door removed it.
  const stopPruningLocalServers = workspaceRegistry.subscribe(() => void localServers.prune())
  // A settled or deleted chat's pull request watches stop with it: there is
  // nobody to wake. Waking from sleep looks again at news a timer held.
  const stopFollowingWatchedChats = [
    workspaceRegistry.subscribe(() => pullRequests.pruneWatches()),
    powerActivity.onResume(() => pullRequests.wakeWatches()),
  ]

  // What an agent of this app is running on now, for the gateway's launch cap:
  // an agent may start agents only at its own preset or stricter.
  const resolveAgentPermissionPreset: AgentPermissionResolver = createAgentPermissionResolver({
    listConversationSessions: (agentId) => {
      const listed = conversations.listSessions({ agentId })
      return listed.ok ? listed.sessions : []
    },
    listTerminalSessions: () => agentTerminals?.list() ?? [],
    readAgentRecordPreset: (workspaceId, agentId) => {
      const agent = workspaceRegistry.getRecord(workspaceId)?.agents[agentId]
      return agent ? { found: true, preset: agent.cliPermissionPreset } : { found: false }
    },
  })

  /**
   * The conversation host every remote door wraps: the tailnet lane a paired
   * device follows chats through, and the Studio RPC a local app does. One
   * factory, so a chat lists, resumes and switches the same by either.
   */
  // The machine a chat runs on and its pull requests, as a paired phone's
  // list shows them: read from the registry, the launch settings and the pull
  // request record, never from a machine or GitHub.
  const machineContext = (): ConversationMachineContext => ({
    hostName: readHostName(),
    platform: process.platform,
    marks: agentLaunchSettings.get().machineMarks,
    ...(options.sshMachineOf ? { sshMachineOf: (id: string) => options.sshMachineOf?.(id) ?? null } : {}),
  })
  const listMarks = {
    // What a paired desktop's management of each chat reads: whether it
    // compacts by itself, by its own Auto compact switch or by this
    // machine's default where it left that unset.
    manageOf: (keys: Array<{ workspaceId: string; agentId: string }>) => {
      const byDefault = effectiveAgentLaunchSettings(agentLaunchSettings.get()).autoCompactChats === true
      return new Map(
        keys.map((key) => {
          const own = workspaceRegistry.getRecord(key.workspaceId)?.autoCompactEnabled
          return [`${key.workspaceId}:${key.agentId}`, { autoCompact: typeof own === 'boolean' ? own : byDefault }]
        }),
      )
    },
    machineReader: () => {
      const context = machineContext()
      return (workspaceId: string) => conversationHostOf(workspaceRegistry.getRecord(workspaceId) ?? null, context)
    },
    pullRequestsOf: async (keys: Array<{ workspaceId: string; agentId: string }>) => {
      const found = await pullRequests.list({ conversations: keys })
      return new Map(
        found.conversations.map((entry) => [
          `${entry.workspaceId}:${entry.agentId}`,
          conversationPullRequestsOf(entry.pullRequests),
        ]),
      )
    },
    // The local servers the chats' agents linked, as the record last checked
    // them: what a paired machine's strip draws under the chat.
    localServersOf: async (keys: Array<{ workspaceId: string; agentId: string }>) => {
      const found = await localServers.list({ conversations: keys })
      return new Map(
        found.conversations.map((entry) => [
          `${entry.workspaceId}:${entry.agentId}`,
          conversationLocalServersOf(entry.servers),
        ]),
      )
    },
    selfMachine: () => tailnetSelfMachine(machineContext()),
    // Only a folder on this computer: one on an SSH machine is that
    // machine's path, and this disk has nothing to read at it.
    branchesOf: (workspaceIds: string[]) =>
      conversationBranchesOf(
        workspaceIds,
        (workspaceId) => {
          const record = workspaceRegistry.getRecord(workspaceId)
          return record && !record.environment ? (record.folderPath ?? null) : null
        },
        resolveCheckoutForCwd,
      ),
    // The chat's own folder (its worktree, when the agent works in one),
    // counted from the sidebar's shared reading; again only on this computer.
    checkoutsOf: (keys: Array<{ workspaceId: string; agentId: string; live: boolean }>) =>
      conversationCheckoutsOf(
        keys,
        ({ workspaceId, agentId }) => {
          const record = workspaceRegistry.getRecord(workspaceId)
          if (!record || record.environment) return null
          const agent = record.agents[agentId]
          const path = conversationWorkingRoot(agent, record.folderPath)
          if (!path) return null
          const agentWorktree = agent?.execution?.mode === 'worktree' && Boolean(agent.execution.cwd?.trim())
          return { path, worktree: agentWorktree || Boolean(record.worktree) }
        },
        (checkoutPath) => getWorkspaceChangeSummary({ checkoutPath }),
      ),
  }
  // A chat's rest and its person-clocks, written for a paired device to the
  // same record the sidebar writes (conversation-lifecycle.ts). Busy is
  // anything ending the chat's processes would cut short: a chat's turn
  // starting, running or waiting on the person, an agent it launched still
  // working in the background under any parent phase, or one of its agent
  // terminals mid-turn (`conversationSessionWorking`, `terminalAgentWorking`).
  const terminalWorking = (workspaceId: string) =>
    (agentTerminals?.list() ?? []).some(
      (session) => session.kind === 'agent' && session.workspaceId === workspaceId && terminalAgentWorking(session),
    )
  const chatWorking = (workspaceId: string) => {
    const listed = conversations.listSessions({ workspaceId })
    if (listed.ok && listed.sessions.some(conversationSessionWorking)) return true
    return terminalWorking(workspaceId)
  }
  // An agent's own chat turn, and nothing else: no other chat or agent
  // terminal of the workspace at work (`onlyOwnChatTurn`).
  const onlyOwnTurn = (workspaceId: string, agentId: string) => {
    const listed = conversations.listSessions({ workspaceId })
    return listed.ok && onlyOwnChatTurn(listed.sessions, agentId) && !terminalWorking(workspaceId)
  }
  // A message held for the end of a turn: the scheduled messages, created
  // below, hold the ones a paired machine queued and the ones that came due
  // mid-turn.
  const messageWaitingIn = (workspaceId: string) =>
    scheduledMessages
      .state()
      .messages.some(
        (message) =>
          message.workspaceId === workspaceId &&
          !message.failure &&
          (message.queued === true || message.waitingSince !== undefined || message.sending === true),
      )
  const conversationLifecycle = createConversationLifecycle({
    getRecord: (workspaceId) => workspaceRegistry.getRecord(workspaceId),
    updateWorkspaceFields: (workspaceId, patch, actor) =>
      workspaceSyncService.updateWorkspaceFields(workspaceId, patch, actor),
    rewindVisit: (workspaceId, lastVisitedAt, actor) =>
      workspaceSyncService.rewindVisit(workspaceId, lastVisitedAt, actor),
    // A person's name, as a window's Rename writes one: locked, and stamped now.
    renameWorkspace: (workspaceId, name, actor) =>
      workspaceSyncService.renameWorkspace(workspaceId, name, true, actor, Date.now()),
    isWorking: chatWorking,
    // A window's own Settle and Snooze: an agent at work, not one waiting on the person.
    isBusy: (workspaceId) => settlement.isBusy(workspaceId),
    onlyTurnOf: onlyOwnTurn,
    messageWaiting: messageWaitingIn,
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'Conversation settle', message })
    },
    // The transcripts' index too, as the list reads it: after a restart a
    // chat-only conversation's finishes are on record only there.
    latestChatTurnEnd: async (workspaceId) => {
      const workspaceRoot = workspaceRegistry.getRecord(workspaceId)?.folderPath
      const indexed = workspaceRoot
        ? await conversations.listThreads({ workspaceId, workspaceRoot }).catch(() => null)
        : null
      const indexedEnd = Math.max(
        -1,
        ...(indexed?.ok ? indexed.threads : []).map((thread) => thread.lastTurnEndedAt ?? -1),
      )
      const listed = conversations.listSessions({ workspaceId })
      return latestTurnEnd(listed.ok ? listed.sessions : [], { workspaceId }, indexedEnd)
    },
  })
  // A settle an agent asked for on its own chat goes ahead, or is let go, on
  // that chat's events: every chat's, a distribution's or an SSH machine's
  // included. For the core's life, as the chats are.
  conversations.onEvent((event) => conversationLifecycle.onConversationEvent(event))
  // Moving a chat to another folder and its project (conversation-move.ts):
  // the chat's sessions end, its history goes to the new project's store, and
  // its agent starts there on the next turn. A move its agent asked for waits
  // on that agent's turn, as a settle does.
  const conversationMove = createConversationMove({
    getRecord: (workspaceId) => workspaceRegistry.getRecord(workspaceId),
    updateWorkspaceFields: (workspaceId, patch, actor) =>
      workspaceSyncService.updateWorkspaceFields(workspaceId, patch, actor),
    isFolder: isDirectory,
    isWorking: chatWorking,
    onlyTurnOf: onlyOwnTurn,
    messageWaiting: messageWaitingIn,
    stopChats: async (workspaceId) => {
      const listed = conversations.listSessions({ workspaceId })
      const live = listed.ok ? listed.sessions.filter((session) => session.status !== 'stopped') : []
      for (const session of live) await conversations.stopSession({ sessionId: session.sessionId })
      await conversationRuntime.flushTranscripts()
    },
    moveStorage: moveConversationStorage,
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'Conversation move', message })
    },
  })
  conversations.onEvent((event) => conversationMove.onConversationEvent(event))

  // The rest sweep (studio-settlement.ts): main settles a quiet chat and
  // wakes a resting one that works again, with or without a window open, on
  // the Settled chats settings each window pushes here. A desktop's only: it
  // is the desktop's sidebar the rest is for, and a server holds no windows to
  // know what is on screen.
  const settledChatsSettings = createSettledChatsSettingsStore({
    resolveUserDataDir: () => platform.paths.dataDir(),
    logDiagnostic: logDiagnostic('workspace'),
  })
  const settlement = createStudioSettlement({
    registry: workspaceRegistry,
    conversations,
    pullRequests: {
      whenLoaded: () => pullRequests.record.whenLoaded(),
      forWorkspace: (workspaceId) => pullRequests.record.forWorkspace(workspaceId),
      onChanged: (listener) => pullRequests.onChanged(listener),
    },
    settings: settledChatsSettings,
    terminals: {
      list: () => agentTerminals?.list() ?? [],
      ...(agentTerminals
        ? {
            onChanged: agentTerminals.onChanged,
            end: (workspaceId: string) => agentTerminals.endWorkspaceTerminals(workspaceId),
          }
        : {}),
    },
    lifecycle: conversationLifecycle,
    recordTurnEnd: (workspaceId, at) => {
      workspaceSyncService.updateWorkspaceFields(workspaceId, { lastTurnEndedAt: at }, 'system')
    },
    onResume: (listener) => powerActivity.onResume(listener),
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'Rest sweep', message })
    },
  })
  if (options.role === 'desktop') settlement.start()
  function stopSettlementSweep(): void {
    settlement.dispose()
  }
  // The composer's `/` lists, one set for the process, made on first ask: a
  // window's `conversation-commands:list` (server-ipc.ts) and a paired
  // desktop's read of a chat here (`conversation-commands`) share its probes,
  // their limits and its disk cache.
  let commandLists: ConversationCommandsService | null = null
  const conversationCommands = (): ConversationCommandsService =>
    (commandLists ??= createConversationCommandsService({
      cliRuntimes: () => agentLaunchSettings.get().cliRuntimes,
      cache: createConversationCommandsDiskCache({ file: join(dataDir, CONVERSATION_COMMANDS_CACHE_FILE) }),
    }))
  // `origin` is for Studio's own sends (a resume after a usage limit): they
  // are not the person writing, so each is recorded as Studio's and the chat
  // keeps its place in the lists ordered by when the person last did.
  // `lifecycleList` is for a door that advertises `conversation-lifecycle`
  // (the tailnet lane and the Studio RPC): its list leaves settled chats out,
  // in the sidebar's order.
  const createConversationHost = (hostOptions: { origin?: ConversationMessageOrigin; lifecycleList?: boolean } = {}) =>
    createConversationGatewayHost(
      conversations,
      (workspaceId) => workspaceRegistry.getRecord(workspaceId)?.folderPath ?? null,
      () =>
        workspaceRegistry
          .getRecords()
          .filter((record) => Boolean(record.folderPath))
          .map((record) => ({
            workspaceId: record.id,
            workspaceRoot: record.folderPath!,
          })),
      // A chat's own agent record carries the preset the person last chose
      // for it; a chat without one starts on the app-wide spawn default, as a
      // new chat in a window does.
      (key) =>
        parseCliPermissionPreset(
          workspaceRegistry.getRecord(key.workspaceId)?.agents[key.agentId]?.cliPermissionPreset,
        ) ?? effectiveAgentLaunchSettings(agentLaunchSettings.get()).lastAgentSpawnPermissionPreset,
      // The agent record's name — the same record, and the same field, this
      // desktop's tab and sidebar read — so a remote lists the chat by the
      // name it has here rather than by its first message.
      (key) => workspaceRegistry.getRecord(key.workspaceId)?.agents[key.agentId]?.name,
      // The chat's CLI catalog as this machine's own picker lists it, so a
      // paired device offers the same models and can switch to no other.
      conversationModelCatalog,
      listMarks,
      {
        workspaceOf: (workspaceId) => workspaceRegistry.getRecord(workspaceId),
        // What chats sent, the pictures their steps returned, and pasted images.
        imageRoots: () => [
          join(dataDir, CONVERSATION_ATTACHMENTS_DIRECTORY),
          join(dataDir, CONVERSATION_TOOL_IMAGES_DIRECTORY),
          attachmentImagesRoot(),
        ],
        ...(hostOptions.lifecycleList ? { lifecycleList: true } : {}),
        ...(hostOptions.origin
          ? { sendOrigin: hostOptions.origin }
          : {
              noteUserMessage: (workspaceId: string, at: number) =>
                conversationLifecycle.noteUserMessage(workspaceId, at, 'gateway'),
            }),
        reasoningEffortOf: (key) =>
          workspaceRegistry.getRecord(key.workspaceId)?.agents[key.agentId]?.conversationReasoningEffort,
        // A phone's switch moves the chat's record as the chat view's own does,
        // through the same bus, so it outlives the session it was applied to.
        writeAgentChoice: (key, patch) => {
          if (!workspaceRegistry.getRecord(key.workspaceId)?.agents[key.agentId]) return
          workspaceSyncService.updateWorkspaceAgent(key.workspaceId, key.agentId, patch, 'system')
        },
        // A message a paired machine queued while the chat's turn ran is held
        // here, among the scheduled messages below, and sent from here when the
        // turn ends: the machine that typed it may sleep or close meanwhile.
        heldMessages: studioHeldMessages(() => scheduledMessages, dataDir),
        // A fork a paired machine asked for joins the chat's workspace as a
        // window's Fork from here adds one (forkFromHere.tsx): named after the
        // chat beside the workspace's others, the chat's twin in its engine,
        // folder and choices, written through the same bus.
        forks: {
          name: (chat, newAgentId) => {
            const record = workspaceRegistry.getRecord(chat.workspaceId)
            const parent = record?.agents[chat.agentId]
            if (!record || !parent?.conversation) return { ok: false, message: 'This chat cannot be forked here.' }
            if (record.agents[newAgentId]) return { ok: false, message: 'That chat id is taken in this workspace.' }
            const taken = Object.values(record.agents).map((agent) => agent.name)
            return { ok: true, name: forkName(parent.name || 'Chat', taken) }
          },
          add: (chat, newAgentId, name) => {
            const parent = workspaceRegistry.getRecord(chat.workspaceId)?.agents[chat.agentId]
            if (!parent?.conversation) return { ok: false, message: 'The chat it was forked from is gone.' }
            const written = workspaceSyncService.updateWorkspaceAgent(
              chat.workspaceId,
              newAgentId,
              { ...defaultAgent(newAgentId, name), ...forkedAgentPatch(parent, name) },
              'system',
            )
            return written.ok ? { ok: true } : { ok: false, message: written.message }
          },
        },
        // A paired desktop's composer: the files a mention names, searched as
        // the @ picker here searches, and the chat CLI's `/` list. Only a
        // folder on this computer is searched: an SSH machine's path names
        // nothing on this disk, and its command list is the one its sessions
        // published, never a probe started here.
        searchFiles: async (input) => {
          if (workspaceRegistry.getRecord(input.workspaceId)?.environment)
            return {
              ok: false,
              message: 'This chat runs on an SSH machine, whose files are not searched from here.',
              engine: null,
            }
          // Loaded on the first search: the searcher's ignore-file reader is
          // a dependency a server bundle resolves only beside node_modules,
          // and starting must not need it.
          const { searchFiles } = await import('../../main/filesystem-search')
          return searchFiles(TAILNET_FILE_SEARCH_SENDER, {
            rootPath: input.rootPath,
            query: input.query,
            limit: input.limit,
            purpose: 'mention',
            channel: input.channel,
          })
        },
        commandsOf: (input) =>
          conversationCommands().list({
            cli: input.cli,
            cwd: input.cwd,
            ...(input.refresh ? { refresh: true } : {}),
            ...(workspaceRegistry.getRecord(input.workspaceId)?.environment ? { probe: false as const } : {}),
          }),
        // A message a paired machine scheduled into a chat here for a time is
        // kept among the same scheduled messages, and sent from here then.
        scheduledSends: studioScheduledSends(() => scheduledMessages),
        // What this machine's agents reported of their plans' limits, and the
        // resume it sends a chat a limit stopped, for a paired machine's strip
        // and tray.
        usageLimits: studioConversationUsageLimits(() => usageLimitResumes),
        // What moves a paired machine's panel for a chat here.
        subagentChanges: subagentChangesOf({
          onEvent: (listener) => conversations.onEvent(listener),
          onRecords: (listener) => workspaceRegistry.subscribe(listener),
        }),
        // A paired machine's Diff tab for a chat here: read in the chat's own
        // folder, and only a folder on this computer, as its counts are.
        checkoutChanges: createConversationCheckoutChanges({
          checkoutOf: ({ workspaceId, agentId }) => {
            const record = workspaceRegistry.getRecord(workspaceId)
            if (!record || record.environment) return null
            return conversationWorkingRoot(record.agents[agentId], record.folderPath)
          },
        }),
      },
    )

  // A chat a usage limit stopped picks up again when the limit resets
  // (usage-limits/resume.ts, wired in studio-usage-limit-resumes.ts). The
  // limits are reported in this process, by the chats it runs; the resume goes
  // through the same send a paired device's does, marked as Studio's.
  const usageLimitResumes = createStudioUsageLimitResumes({
    dataDir,
    conversations,
    workspaceRecord: (workspaceId) => workspaceRegistry.getRecord(workspaceId),
    createHost: (hostOptions) => createConversationHost(hostOptions),
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'Usage limits', message })
    },
  })
  void usageLimitResumes.start()
  const stopFollowingResumes = [
    // A timer stands still while the computer sleeps; waking reads the clock again.
    powerActivity.onResume(() => usageLimitResumes.wake()),
    powerActivity.onScreenLockChange((locked) => {
      if (!locked) usageLimitResumes.wake()
    }),
    // A deleted chat's resume goes with it.
    workspaceRegistry.subscribe(() => usageLimitResumes.prune()),
  ]

  // A Claude chat with Auto compact on is compacted by Studio while it sits
  // idle, just before its prompt cache expires (conversation-auto-compact.ts,
  // wired in studio-auto-compact.ts): this core's own chats' sessions (a
  // distribution's and an SSH machine's are compacted there); the send goes
  // through the same door a resume after a usage limit takes, marked as
  // Studio's. Looked at again whenever a chat, its record or the default
  // moves, and on waking, since a timer stands still while the machine sleeps.
  const autoCompact = createStudioAutoCompact({
    conversations,
    workspaceRecord: (workspaceId) => workspaceRegistry.getRecord(workspaceId),
    enabledByDefault: () => effectiveAgentLaunchSettings(agentLaunchSettings.get()).autoCompactChats,
    createHost: (hostOptions) => createConversationHost(hostOptions),
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'Auto compact', message })
    },
  })
  const stopFollowingAutoCompact = [
    workspaceRegistry.subscribe(() => autoCompact.recompute()),
    agentLaunchSettings.subscribe(() => autoCompact.recompute()),
    powerActivity.onResume(() => autoCompact.recompute()),
  ]

  // Messages a person scheduled into a chat from its composer's "+"
  // (scheduled-messages/scheduled-messages.ts, wired in
  // studio-scheduled-messages.ts): sent when their time comes through the same
  // send a paired device's takes, as the person's own words.
  const scheduledMessages = createStudioScheduledMessages({
    dataDir,
    conversations,
    workspaceRecord: (workspaceId) => workspaceRegistry.getRecord(workspaceId),
    createHost: () => createConversationHost(),
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'Scheduled messages', message })
    },
  })
  void scheduledMessages.start()
  const stopFollowingScheduledMessages = [
    powerActivity.onResume(() => scheduledMessages.wake()),
    powerActivity.onScreenLockChange((locked) => {
      if (!locked) scheduledMessages.wake()
    }),
    // A deleted chat's scheduled messages go with it.
    workspaceRegistry.subscribe(() => scheduledMessages.prune()),
  ]

  // The modules beside this core, once a kernel has loaded them: what an
  // extension's schedule is held to, and whether its extension is here.
  // Null on a server with no kernel (standalone, WSL, SSH).
  let moduleKernel: {
    permissions(moduleId: string): readonly string[] | undefined
    loaded(): readonly string[]
  } | null = null

  // What this machine has and lacks for its background work
  // (environment-readiness.ts): what holds a schedule or a watch, and what
  // `environment.readiness` answers.
  const readiness = createEnvironmentReadiness({
    machine: readHostName,
    clis: () => {
      const known = knownCliAvailability({ cliRuntimes: agentLaunchSettings.get().cliRuntimes })
      return listPluginRegistryEntries().map((entry) => ({
        id: entry.id,
        name: entry.displayName || entry.id,
        installed: known[entry.id] ? known[entry.id]!.installed === true : null,
      }))
    },
    mcpServers: () => agentLaunchSettings.get().mcp?.servers,
    skillKnown: (skillId) => resolveSkillById(skillId) !== null,
    extensions: () => moduleKernel?.loaded() ?? null,
    gh: readGhHere,
    schedules: () => scheduledAgents.service.list(),
    watches: () =>
      pullRequests.record.watches().flatMap((watched) => {
        const entry = pullRequests.record
          .forConversation(watched.conversation)
          .find((candidate) => candidate.url === watched.url)
        return entry
          ? [
              {
                url: watched.url,
                title: entry.title || `#${entry.number}`,
                ...(entry.watch?.waiting ? { waiting: entry.watch.waiting } : {}),
              },
            ]
          : []
      }),
  })

  // Scheduled agents (studio-scheduled-agents.ts): this server's schedules,
  // run in its chats from its worktree pool, whatever kind of server it is.
  const scheduledAgents = createStudioScheduledAgents({
    platform,
    conversations,
    launch: (request) => conversationLaunchService.launch(request),
    createConversationHost: () => createConversationHost(),
    workspaceRecords: () => workspaceRegistry.getRecords(),
    gitHost: (hostId) => (hostId ? hosts.get(hostId) : null),
    // Run now goes past a sign-in this machine only believes is missing: the
    // CLI then says for itself whether it is signed in.
    waitingFor: (agent, context) => readiness.scheduleWaitingFor(agent, { signIn: !context?.asked }),
  })
  if ((options.scheduledAgentsSwitch ?? 'core') === 'core') void scheduledAgents.start()

  // What this desktop kept for another environment's chats (an SSH machine's,
  // a WSL distribution's) goes to that environment's Studio
  // (environment-migration.ts): planned at start and on each connect,
  // delivered once it is reachable. Only then are this desktop's records of
  // its chats the machine's copies, followed from what it says.
  const environmentMigration = environmentClients
    ? createEnvironmentMigration({
        dataDir,
        clients: environmentClients,
        spellingOf: (route) => environmentClients.spellingOf(route),
        stores: studioMigrationStores({
          workspaceRegistry,
          scheduledAgents: scheduledAgents.service,
          scheduledMessages,
          usageLimitResumes,
          pullRequests: pullRequests.record,
          scheduledImages: (prompt) => keptImagesIn(prompt, dataDir),
          chatSources: (chat) => chatSourceFiles({ dataDir, ...chat }),
          approvalRules,
        }),
        log: (message) => {
          void writeDiagnosticLog({ level: 'info', source: 'workspace', title: 'Another machine', message })
        },
      })
    : null
  const handOver = async (route: string) => {
    if (!environmentMigration || !environmentReplicas || !environmentClients) return
    // A WSL distribution says how it spells a drive path only once its
    // server is up, and its records are planned only then: reach it first
    // (starting it, so a distribution with chats or schedules runs from the
    // desktop's start, target 7). Until its records are planned none of
    // them is taken for handed over.
    if (!environmentClients.spellingOf(route) && !(await environmentClients.clientFor(route)).ok) return
    await environmentMigration.plan()
    if ((await environmentMigration.deliver(route)) && environmentMigration.handedOver(route))
      await environmentReplicas.follow(route)
  }
  if (environmentMigration && environmentClients) {
    environmentClients.onConnected((route) => void handOver(route).catch(() => undefined))
    // At start: every machine this desktop holds chats or waiting records
    // for, reached if it is connected already; the rest wait for their connect.
    void environmentMigration
      .plan()
      .then(() => {
        const routes = new Set(environmentMigration.waiting())
        for (const record of workspaceRegistry.getRecords()) {
          const route = environmentRouteOfRecord(record)
          if (route) routes.add(route)
        }
        for (const route of routes) void handOver(route).catch(() => undefined)
      })
      .catch(() => undefined)
  }

  // A chat is titled here, from its own events, rather than by a window: the
  // chats that most need a title are the ones a phone or a paired machine
  // started while no window was watching (chat-titler.ts). The heuristic
  // lands at once; a model-written title replaces it when the person has them
  // on, on the setting each window pushes to this process (absent, the
  // window's own default: on, with the engine left to the CLIs installed).
  const textGenerationSettings = createTextGenerationSettingsStore({
    resolveUserDataDir: () => platform.paths.dataDir(),
    logDiagnostic: logDiagnostic('agents'),
  })
  const chatTitler = createChatTitler({
    onEvent: (listener) => conversations.onEvent(listener),
    getWorkspace: (workspaceId) => workspaceRegistry.getRecord(workspaceId),
    rename: (workspaceId, name) => workspaceSyncService.renameWorkspace(workspaceId, name, true, 'system').ok,
    settings: () => textGenerationSettings.get(),
    candidateClis: () => listPluginRegistryEntries().map((entry) => entry.id),
    // The availability this process already holds, never a fresh probe: a
    // CLI it has not looked at yet is kept, and the generator itself answers
    // for one that turns out to be missing.
    installed: (cli) => knownCliAvailability({ cliRuntimes: agentLaunchSettings.get().cliRuntimes })[cli]?.installed,
    cliRuntimes: () => agentLaunchSettings.get().cliRuntimes,
    generate: (request) => generateChatTitle(request),
    log: (message) => {
      void writeDiagnosticLog({ level: 'info', source: 'agents', title: 'Chat title not generated', message })
    },
  })

  // Both of Studio's own sends stop before the chats do, listeners first, so
  // none comes due on the way out and starts an agent the quit then has to
  // stop (or, stopped already, would be recorded as sent). The desktop's quit
  // runs these as legs of its own; `shutdown` below for a process that owns
  // nothing else.
  function stopUsageLimitResumes(): Promise<void> {
    for (const stop of stopFollowingResumes.splice(0)) stop()
    return usageLimitResumes.dispose()
  }
  function stopScheduledMessages(): Promise<void> {
    for (const stop of stopFollowingScheduledMessages.splice(0)) stop()
    return scheduledMessages.dispose()
  }
  /** The modules a kernel loaded beside this core: an extension's schedules are held to them. */
  function attachModules(kernel: NonNullable<typeof moduleKernel>): void {
    moduleKernel = kernel
    scheduledAgents.setModulePermissions((moduleId) => kernel.permissions(moduleId))
    scheduledAgents.service.notifyChanged()
  }
  function stopAutoCompact(): void {
    for (const stop of stopFollowingAutoCompact.splice(0)) stop()
    autoCompact.dispose()
  }

  /**
   * The core's own end, for a process that owns nothing else: the registry
   * flushed around the chats' end, the machines' helpers told to stop, the
   * data directory let go. The desktop runs the same steps as legs of its own
   * quit (app-lifecycle.ts), interleaved with the shell's.
   *
   * The lock is let go last, once the chats' shutdown has closed every
   * transcript, so a process that takes the directory next never finds a log
   * still being written. A stop cut short leaves the lock to be found
   * abandoned instead.
   */
  async function shutdown(): Promise<void> {
    const legs: Array<() => unknown> = [
      () => workspaceSyncService.flush(),
      () => pullRequests.flush(),
      () => localServers.flush(),
      () => conversationRuntime.flushTranscripts(),
      stopSettlementSweep,
      stopUsageLimitResumes,
      stopScheduledMessages,
      () => scheduledAgents.stop(),
      stopAutoCompact,
      // An install the quit cuts short is not recorded, so its worktree
      // installs again at its next lease.
      () => worktrees.installer.shutdown({ waitMs: WORKTREE_QUIT_WAIT_MS }),
      () => chatTitler.dispose(),
      () => agents.stop(),
      // A child's notices are kept for the next run, the reporter stops
      // hearing frames, and every pty ends with its painted screen kept.
      () => agentTerminals?.launchNotices.freeze(),
      () => agentTerminals?.stopAgentState(),
      () => agentTerminals?.shutdown(),
      // What the command lists learned is written before the process goes.
      () => commandLists?.dispose(),
      () => conversationOwner.shutdown(),
      // A lease or return in flight finishes its write, and each pool's
      // container lock is given up so another Studio can take it over.
      () => worktrees.pool.shutdown({ waitMs: WORKTREE_QUIT_WAIT_MS }),
      () => {
        for (const stop of stopFollowingWatchedChats.splice(0)) stop()
        pullRequests.dispose()
      },
      // The servers the Studio itself started stop with it: nothing would be
      // left to stop them from.
      () => {
        stopPruningLocalServers()
        return localServers.dispose()
      },
      () => workspaceSyncService.flush(),
      () => hosts.dispose(),
    ]
    for (const leg of legs) {
      try {
        await leg()
      } catch {
        // Best effort, leg by leg: the process is leaving either way.
      }
    }
    dataDirLock?.release()
  }

  return {
    /** Other environments' Studios, as this desktop's callers reach a chat one holds; null where it reaches none. */
    environmentClients,
    /** This desktop's copies of the chats other environments hold; null where it reaches none. */
    environmentReplicas,
    platform,
    role: options.role,
    /** Null only in a desktop that could not take the directory and carried on, as builds before the lock did. */
    dataDirLock,
    /** Resolves once a Studio server this desktop displaced has exited; a gateway or socket opens after it. */
    whenDataDirFree: taken.whenFree,
    agentLaunchSettings,
    hosts,
    workspaceRegistry,
    workspaceSyncService,
    conversations,
    conversationOwner,
    subagents,
    /** Windows: the WSL servers chats may run on, for Settings' status; null elsewhere. */
    wslServers,
    approvalRules,
    conversationModelCatalog,
    conversationLaunchService,
    conversationImport,
    resolveAgentPermissionPreset,
    createConversationHost,
    /** This machine's own kind and colour, as a paired device draws it. */
    selfMachine: () => tailnetSelfMachine(machineContext()),
    conversationLifecycle,
    conversationMove,
    /** The Settled chats settings, as the windows push them; the rest sweep reads them. */
    settledChatsSettings,
    /** The rest sweep, for the module run states the windows push. */
    settlement,
    stopSettlementSweep,
    pullRequests,
    localServers,
    usageLimitResumes,
    scheduledMessages,
    /** This server's scheduled agents (studio-scheduled-agents.ts). */
    scheduledAgents,
    /** What this machine has and lacks for its background work (`environment.readiness`). */
    readiness,
    attachModules,
    /** The worktree pool, its installs and tools, the chat-folder guard (studio-worktree-pool.ts). */
    worktrees,
    /** The terminals and their agents (studio-agent-terminals.ts); null where no pty can start. */
    agentTerminals,
    /** The model-written chat titles setting, as the windows push it. */
    textGenerationSettings,
    /** The agent CLIs (detection, installs, the version check) and their setup (studio-agent-services.ts). */
    agents,
    /** The marketplace, the CLI catalogue, the scaffold and the feeds; null where this Studio serves none. */
    extensions,
    /** Settings ▸ Artifacts, its set-up question and the `artifacts.*` tools; null where this Studio serves none. */
    artifacts,
    /** The composer's `/` lists, which a window's IPC and a paired desktop's reads share. */
    conversationCommands,
    stopUsageLimitResumes,
    stopScheduledMessages,
    stopAutoCompact,
    shutdown,
  }
}

/**
 * The stdio bridge agents run to reach the gateway: shipped under
 * `resources/automation`, which an installed build unpacks into its resources
 * directory and a source checkout keeps at its root.
 */
export function studioBridgeScriptPath(paths: StudioPaths): string {
  const root = paths.isPackaged() ? paths.resourcesDir() : join(paths.appRoot() ?? process.cwd(), 'resources')
  return join(root ?? '', 'automation', 'mcp-stdio-bridge.mjs')
}

/** `gh` on this machine: its command, and whether it holds a sign-in (`gh auth token`). */
async function readGhHere(): Promise<{ installed: boolean | null; signedIn: boolean | null }> {
  const asked = await sharedGhRunner()
    .run(['auth', 'token'], { timeoutMs: 10_000 })
    .catch(() => null)
  if (!asked) return { installed: null, signedIn: null }
  if (!asked.found) return { installed: false, signedIn: null }
  if (asked.timedOut) return { installed: true, signedIn: null }
  return { installed: true, signedIn: asked.code === 0 && asked.stdout.trim().length > 0 }
}

/** This machine's host name, or empty when the OS will not say. */
function readHostName(): string {
  try {
    return hostname().trim()
  } catch {
    return ''
  }
}
