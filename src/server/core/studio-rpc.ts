import { hostname } from 'node:os'
import { join } from 'node:path'

import { writeDiagnosticLog } from '../../main/diagnostics-service'
import {
  conversationStartedBy,
  createStudioConversationBackend,
} from '../../main/studio-rpc/studio-conversation-backend'
import {
  createStudioRpcService,
  type StudioRpcService,
  type StudioRpcServiceOptions,
} from '../../main/studio-rpc/studio-rpc-service'
import { canvasBoardStoreDir } from '../../main/canvas/canvas-board-store'
import { workspaceStoreRoot } from '../../main/workspace-store'
import { storePathOfLegacy } from '../../main/workspace-store-migration'
import { createStudioFiles } from '../rpc/studio-files'
import { createStudioFileSystem, type StudioFileSystemShell } from '../files/studio-file-system'
import { knownFolders, workspaceFolders } from '../files/known-folders'
import { createStudioGit } from '../git/studio-git'
import { createStudioWorktrees } from '../worktrees/studio-worktrees'
import { createStudioWorkspaceSync } from '../workspaces/studio-workspace-sync'
import type { GitHubTokenStore } from '../../main/github-token-store'
import { createStudioDiscovery } from './studio-discovery'
import { isMachinePath } from '../../shared/machine-paths'
import { SIDECAR_DIR_NAME } from '../../shared/workspace-sidecar'
import type { StudioUpdates } from '../update/studio-updates'
import type { SignIns } from '../machine/machine-sign-in'
import type { StudioCore } from './studio-core'
import { createConversationPullRequests } from '../../main/automation/conversation-pull-request-tools'
import { studioPullRequestCreationDeps } from '../pull-requests/pull-request-creation'
import type { StudioGateway } from './studio-gateway'
import type { StudioModules } from '../rpc/studio-modules'
import { createStudioAgentSettings } from '../agent-settings/agent-settings-domain'
import { createStudioChatStores } from '../chat-stores/chat-stores-domain'
import { createStudioSchedulesDomain } from '../schedules/schedules-domain'
import { createStudioChatLifecycleDomain } from '../chat-lifecycle/chat-lifecycle-domain'
import { searchChatsHere } from '../../main/automation/conversation-search'
import { isSettledWorkspace, workspaceLastUserMessageAt } from '../../shared/workspace-lifecycle'
import { createStudioCanvasDomain, type StudioCanvasHost } from '../canvas/canvas-domain'
import { effectiveAgentLaunchSettings } from '../../shared/launch-settings'
import { createStudioPhoneReads } from '../backlog/backlog-domain'
import { createTailnetShareService, readTailnetWebTargets } from '../../main/automation/tailnet/tailnet-share-service'
import { createTailnetFileUploads, TAILNET_UPLOADS_DIRNAME } from '../../main/automation/tailnet/tailnet-file-uploads'
import { listKnownWorkspaceRoots, uniqueResolvedRoots } from '../../main/workspace-roots'

// The Studio RPC over a core: the owner socket in `<dataDir>/run` that local
// applications follow, drive and start chats through. It serves the same
// conversation host the tailnet lane does, starts chats through the same
// launch service, and audits into the gateway's one log, which is why it is
// composed from both. The desktop and the standalone server build it here, so
// it is wired once; each starts it beside its gateway and stops it first. Its
// paths and version are the core's platform's.

export function createStudioRpc(
  core: StudioCore,
  gateway: StudioGateway,
  options: {
    hostKind?: StudioRpcServiceOptions['hostKind']
    updates?: StudioUpdates
    /** What the modules of the kernel beside it say; a Studio without one leaves `module.*` unserved. */
    modules?: StudioModules
    /** What the shell around this Studio adds to its files: the Trash and an image codec, on a desktop. */
    fileSystemShell?: StudioFileSystemShell
    /** The GitHub token this Studio keeps, where its process holds one; without it `github.*` says so. */
    githubTokens?: GitHubTokenStore
    /**
     * The machine's one canvas service, where it runs in this process (the
     * desktop with its server in process): another device's boards are served
     * from it (`canvas-boards`). Absent, they are not served.
     */
    canvas?: StudioCanvasHost
    /** A CLI's login on this machine with no terminal; a Studio without it leaves `providers.signIn*` unserved. */
    signIns?: () => Promise<SignIns>
  } = {},
): StudioRpcService {
  const service = createStudioRpcService({
    ...(options.hostKind ? { hostKind: options.hostKind } : {}),
    // How this Studio is updated: the host says (a desktop itself, a WSL or
    // SSH server by the desktop that manages it, a hand-started one by hand).
    ...(options.updates ? { updates: options.updates } : {}),
    ...(options.modules ? { modules: options.modules } : {}),
    ...(options.canvas ? { canvas: createStudioCanvasDomain(options.canvas) } : {}),
    ...(options.signIns ? { signIns: options.signIns } : {}),
    paths: core.platform.paths,
    identity: core.platform.identity,
    // Who may reach the agents from this machine (`access`): the gateway's
    // status and its HTTP endpoint's tokens, beside the apps this RPC pairs.
    gatewayAccess: {
      gatewayStatus: () => gateway.getStatus(),
      mcpHttpStatus: () => gateway.getMcpHttpStatus(),
      createMcpHttp: (name) => gateway.createMcpHttpClient(name),
      revokeMcpHttp: (id) => gateway.revokeMcpHttpClient(id),
    },
    backend: () =>
      createStudioConversationBackend({
        // Listed as `conversation-lifecycle` promises, which this socket
        // advertises: settled chats left out, in the sidebar's order.
        host: core.createConversationHost({ lifecycleList: true }),
        launch: (request) => core.conversationLaunchService.launch(request),
        listSessions: (input) => core.conversations.listSessions(input),
        stopSession: (input) => core.conversations.stopSession(input),
        // The live workspace state the module conversation service reads too.
        getWorkspaceAgents: () => core.workspaceSyncService.getSnapshot().state.workspaces,
        lifecycle: core.conversationLifecycle,
        // A paired device's files sent with a message, kept where the tailnet's
        // upload route keeps them, so one store prunes both.
        fileUploads: createTailnetFileUploads({ root: join(core.platform.paths.dataDir(), TAILNET_UPLOADS_DIRNAME) }),
      }),
    audit: () => gateway.gatewayAudit(),
    tools: gateway.clientTools,
    forgetToolApprovals: (toolsets) => core.approvalRules.forgetGatewayToolsets(toolsets),
    // A workspace's folder, the board store Studio keeps for it under its
    // data directory (the canvas reads and writes its boards through these),
    // and its project's store in the person's home, where its captures,
    // recordings and transcripts are.
    files: createStudioFiles({
      resolveRoot: (root) => {
        const folder = core.workspaceSyncService
          .getSnapshot()
          .state.workspaces.find((workspace) => workspace.id === root.workspaceId)?.folderPath
        if (!folder) return null
        // A folder on an SSH machine (`ssh://…`) is not on this disk, so it is
        // no root here, and neither is its project's store, which is on that
        // machine; its board store, kept under the data directory, is.
        if (root.kind === 'workspace') return isMachinePath(folder) ? null : folder
        if (root.kind === 'store') {
          try {
            return workspaceStoreRoot(folder)
          } catch {
            return null
          }
        }
        return canvasBoardStoreDir(core.platform.paths.dataDir(), folder)
      },
      // A client that learned `.sprintengine/browser/…` from an older Studio
      // still reads the file, from the store the move put it in.
      moved: (root, path) => {
        if (root.kind !== 'workspace') return null
        const [first, ...rest] = path.split('/')
        const inStore = first === SIDECAR_DIR_NAME ? storePathOfLegacy(rest) : null
        return inStore ? { root: { kind: 'store', workspaceId: root.workspaceId }, path: inStore.join('/') } : null
      },
    }),
    // The files on this machine by path, for every client: a non-owner's
    // paths held to the folders Studio knows, its writes to the workspaces'.
    fileSystem: createStudioFileSystem({
      ...options.fileSystemShell,
      readableRoots: () => knownFolders(core.workspaceRegistry, core.platform.paths.dataDir()),
      writableRoots: () => workspaceFolders(core.workspaceRegistry),
    }),
    ...(core.sshMachineCall ? { machine: core.sshMachineCall } : {}),
    // Git on this machine, for every client: its repositories held to the
    // folders Studio knows for any client but an owner, as its files are.
    git: createStudioGit({
      dataDir: () => core.platform.paths.dataDir(),
      ...(options.githubTokens ? { githubTokens: options.githubTokens } : {}),
    }),
    // The worktrees its agents run in, from the pool this core keeps, and
    // deleting settled chats, whose worktrees go back to it.
    worktrees: createStudioWorktrees(core.worktrees),
    // The registry its desktop's windows mirror and change, with their
    // backup and the folders of chats without a project.
    workspaceSync: createStudioWorkspaceSync(core),
    // What a desktop's Studio is extended with: its marketplace, the CLI
    // catalogue, the extension scaffold and the hosted feeds.
    ...(core.extensions ? { extensions: core.extensions } : {}),
    // Where a desktop's Studio publishes its agents' pages.
    ...(core.artifacts ? { artifacts: core.artifacts } : {}),
    // What the conversations' branches have on GitHub, which every client
    // displays and none decides.
    pullRequests: core.pullRequests,
    // A chat's "Create PR", in its checkout here, for an owner's client.
    pullRequestCreation: createConversationPullRequests(studioPullRequestCreationDeps(core)),
    // The servers the conversations' agents started, checked here and drawn
    // by every client.
    localServers: core.localServers,
    // The terminals on this machine, where the core holds the runtime.
    ...(core.agentTerminals ? { terminals: core.agentTerminals.studioTerminals } : {}),
    // The agent CLIs on this machine and what they are set up with: the
    // core's, in every mode.
    runtimes: core.agents.runtimes,
    agentSetup: core.agents.setup,
    agentSkills: core.agents.skills,
    // What every launch here reads, and what the CLIs write for it, served
    // where the launch settings and the model catalog cache are.
    agentSettings: createStudioAgentSettings({
      launchSettings: core.agentLaunchSettings,
      textGenerationSettings: core.textGenerationSettings,
    }),
    // What a client reads before it starts a chat: the gateway's own tools
    // answer it, so the protocol and MCP read one thing.
    discovery: createStudioDiscovery(() => gateway.ownTools()),
    // What this machine lacks for its schedules and watches, which every
    // client shows and none can fix from afar.
    readiness: () => core.readiness.read(),
    // What the core keeps beside its chats, for every chat at once: the usage
    // limits and the resumes after them, the usage dashboard's report and the import of a CLI's saved sessions.
    chatStores: createStudioChatStores({
      resumes: core.usageLimitResumes,
      imports: core.conversationImport,
      dataDir: () => core.platform.paths.dataDir(),
      getWorkspaces: () => core.workspaceSyncService.getSnapshot().state.workspaces,
      mesh: () => gateway.mesh(),
      hostName: () => hostname(),
      machineMarks: () => core.agentLaunchSettings.get().machineMarks,
    }),
    // The scheduled agents this server runs, every server its own: made and
    // changed by the rules the gateway's `schedule.*` tools follow.
    schedules: createStudioSchedulesDomain({
      service: core.scheduledAgents.service,
      findWorkspace: (workspaceId) =>
        core.workspaceSyncService.getSnapshot().state.workspaces.find((workspace) => workspace.id === workspaceId) ??
        null,
      defaultCli: () => effectiveAgentLaunchSettings(core.agentLaunchSettings.get()).lastSelectedCli ?? null,
    }),
    // What the phone reads beside its chats: the projects' backlogs (each
    // item's status and triage it may change), the pages this machine shares
    // on the tailnet, and a pull request read in full. No local path leaves.
    phoneReads: (() => {
      const shareService = createTailnetShareService()
      return createStudioPhoneReads({
        roots: () => uniqueResolvedRoots(listKnownWorkspaceRoots(core.workspaceSyncService.getSnapshot())),
        readShares: () => readTailnetWebTargets(shareService),
      })
    })(),
    // A chat's record beyond its rest, for the phone and another desktop:
    // its marks and name written by the same lifecycle the sidebar's are, its
    // delete made as a window's Delete makes it, and a search of what was
    // said in the chats this sidebar lists, most recently spoken in first.
    chatLifecycle: createStudioChatLifecycleDomain({
      lifecycle: core.conversationLifecycle,
      deletion: (actor) => core.worktrees.settledChatDeletion(actor),
      hasChat: (workspaceId) =>
        core.workspaceSyncService.getSnapshot().state.workspaces.some((workspace) => workspace.id === workspaceId),
      searchChats: (query) =>
        searchChatsHere(query, {
          chats: () =>
            core.workspaceRegistry
              .getRecords()
              .filter((record) => record.folderPath && !record.remoteOrigin && !isSettledWorkspace(record))
              .sort((a, b) => workspaceLastUserMessageAt(b) - workspaceLastUserMessageAt(a))
              .map((record) => ({ workspaceId: record.id, workspaceRoot: record.folderPath!, chatTitle: record.name })),
          search: (input) => core.conversations.searchThreads(input),
        }),
    }),
    log: (message) => {
      void writeDiagnosticLog({ level: 'warning', source: 'workspace', title: 'Local app socket', message })
    },
  })
  // An app's tools reach the chats it started, and as far as its pairing says.
  gateway.linkClientTools({
    reachOf: (clientId) => service.toolReachOf(clientId),
    startedBy: (conversation) =>
      conversationStartedBy(core.workspaceSyncService.getSnapshot().state.workspaces, conversation),
  })
  // A paired device's Studio socket on the tailnet listener is served here,
  // by the same server the windows use: one contract, one set of receipts.
  gateway.linkStudio({ attach: (stream, authenticator) => void service.connectDevice(stream, authenticator) })
  // Like the gateway, it binds only once a Studio server this desktop
  // displaced has gone: that server's listener still answers until then, and
  // this one would refuse to start beside it.
  return {
    ...service,
    start: async () => {
      await core.whenDataDirFree
      return service.start()
    },
  }
}
