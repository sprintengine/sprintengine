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
import { isMachinePath } from '../../shared/machine-paths'
import { SIDECAR_DIR_NAME } from '../../shared/workspace-sidecar'
import type { StudioUpdates } from '../update/studio-updates'
import type { StudioTerminals } from '../terminals/studio-terminals'
import type { StudioCore } from './studio-core'
import type { StudioGateway } from './studio-gateway'
import type { StudioModules } from '../rpc/studio-modules'

// The Studio RPC over a core: the owner socket in `<dataDir>/run` that local
// applications follow, drive and start chats through. It serves the same
// conversation host the tailnet lane does, starts chats through the same
// launch service, and audits into the gateway's one log, which is why it is
// composed from both. The desktop and the standalone server build it here, so
// it is wired once; each starts it beside its gateway and stops it first. Its
// paths, version and the push to Settings are the core's platform's.

export function createStudioRpc(
  core: StudioCore,
  gateway: StudioGateway,
  options: {
    hostKind?: StudioRpcServiceOptions['hostKind']
    updates?: StudioUpdates
    /** What the modules of the kernel beside it say; a Studio without one leaves `module.*` unserved. */
    modules?: StudioModules
    /** The terminals on this machine, where this process holds the terminal runtime. */
    terminals?: StudioTerminals
  } = {},
): StudioRpcService {
  const service = createStudioRpcService({
    ...(options.hostKind ? { hostKind: options.hostKind } : {}),
    // How this Studio is updated: the host says (a desktop itself, a WSL or
    // SSH server by the desktop that manages it, a hand-started one by hand).
    ...(options.updates ? { updates: options.updates } : {}),
    ...(options.modules ? { modules: options.modules } : {}),
    paths: core.platform.paths,
    identity: core.platform.identity,
    clients: core.platform.clients,
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
    // What the conversations' branches have on GitHub, which every client
    // displays and none decides.
    pullRequests: core.pullRequests,
    // The servers the conversations' agents started, checked here and drawn
    // by every client.
    localServers: core.localServers,
    ...(options.terminals ? { terminals: options.terminals } : {}),
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
