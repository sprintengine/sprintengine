import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import type { createConversationTerminalHandoff } from '../../main/conversation-terminal-handoff'
import type { HostRegistry } from '../../main/hosts/host-registry'
import { registerAutomationIpc } from '../../main/ipc/automation-ipc'
import { createConversationService } from '../../main/conversation-service'
import { registerHostsIpc } from '../../main/ipc/hosts-ipc'
import { registerMeshIpc } from '../../main/ipc/mesh-ipc'
import { registerStudioLocalAppsIpc } from '../../main/ipc/studio-local-apps-ipc'
import { registerWorkspaceBackupIpc } from '../../main/ipc/workspace-backup-ipc'
import { registerWorkspaceSyncIpc } from '../../main/ipc/workspace-sync-ipc'
import type { AgentLaunchSettingsStore } from '../../main/launch-settings-store'
import { createStudioChatBackend } from '../../main/studio-rpc/studio-chat-backend'
import type { StudioRpcService } from '../../main/studio-rpc/studio-rpc-service'
import type { WorkspaceBackupService } from '../../main/workspace-backup'
import type { StudioCore } from '../core/studio-core'
import type { StudioGateway } from '../core/studio-gateway'
import { knownFolders } from '../files/known-folders'

// The `window.api` domains the Studio server owns (phase 6 spec, sections 5
// and 6.2), registered in one place. Main registers them on `ipcMain` when the
// server runs in process, which it does by default; the server registers the
// very same calls on its IPC tunnel when it runs in a process of its own, and
// the preload routes their channels there (SERVER_IPC_CHANNELS, which the
// completeness test holds to this list).
//
// What is here: the workspace bus and registry hydration, launch settings and
// machines, the gateway's settings and the tailnet and mesh, the paired local
// apps, workspace backups, model discovery, the composer's command lists,
// the GitHub token, the chats, with the copy of the model-written titles setting the
// server titles them by. The worktree pool and settled chats are the Studio
// protocol's (`worktrees.*`, `settledChats.*`).
// What is not: anything that acts on a window, a terminal or the shell's own
// caches (the rest of the git panel, the file explorer, skills and the marketplace,
// modules' enablement and trust), which stays with the shell until phase 10.

/** `ipcMain`, or the server's tunnel registry, which has its shape. */
type IpcRegistryLike = Pick<IpcMain, 'handle' | 'on' | 'removeHandler' | 'removeListener'>

export type ServerDomainIpcDeps = {
  core: Pick<
    StudioCore,
    | 'workspaceSyncService'
    | 'workspaceRegistry'
    | 'agentLaunchSettings'
    | 'hosts'
    | 'conversations'
    | 'conversationLifecycle'
    | 'settledChatsSettings'
    | 'settlement'
    | 'platform'
    | 'textGenerationSettings'
    | 'conversationCommands'
  > & { hosts: HostRegistry; agentLaunchSettings: AgentLaunchSettingsStore }
  gateway: StudioGateway
  studioRpc: StudioRpcService
  workspaceBackup: WorkspaceBackupService
  terminalHandoff: ReturnType<typeof createConversationTerminalHandoff>['handoff']
  /** Only an app window may pair a local app: `assertAppSender` in main; the port is the check in the server. */
  assertAppSender: (event: IpcMainInvokeEvent) => void
}

export type ServerDomainIpcHandles = {
  conversationCommands: { dispose(): Promise<void> }
}

export function registerServerDomainIpc(registry: IpcRegistryLike, deps: ServerDomainIpcDeps): ServerDomainIpcHandles {
  const ipc = registry as IpcMain
  const { core } = deps
  const dataDir = () => core.platform.paths.dataDir()
  registerWorkspaceSyncIpc(ipc, core.workspaceSyncService, {
    registry: core.workspaceRegistry,
    markUnread: (workspaceId) => core.conversationLifecycle.markUnread(workspaceId, 'ui'),
    lifecycle: (request) => core.conversationLifecycle.fromWindow(request),
    setSettledChatsSettings: (settings) => core.settledChatsSettings.set(settings),
    setModuleRunStates: (states) => core.settlement.setModuleRunStates(states),
  })
  registerAutomationIpc(ipc, deps.gateway)
  registerStudioLocalAppsIpc(ipc, deps.studioRpc, deps.assertAppSender)
  registerMeshIpc(ipc, deps.gateway)
  registerWorkspaceBackupIpc(ipc, deps.workspaceBackup)
  // The core's own `/` lists, which every window and a paired desktop read over the protocol.
  const conversationCommands = core.conversationCommands()
  registerHostsIpc(ipc, { hosts: core.hosts })
  // One conversation service over the core's chats, which the Studio RPC's
  // chat surface serves to every client, the app's own windows included.
  const conversationService = {
    ...createConversationService(core.conversations),
    terminalHandoff: deps.terminalHandoff,
  }
  deps.studioRpc.provideChat(
    createStudioChatBackend({
      conversation: conversationService,
      hasReceipt: (sessionId, commandId) => core.conversations.hasCommandReceipt(sessionId, commandId),
      readableRoots: () => knownFolders(core.workspaceRegistry, dataDir()),
      commands: (input) => conversationCommands.list(input),
      // Export chat: the chat as its record says, its transcript and its
      // pictures, read here where they are kept, for any client to write out.
      exportSource: async (chat) => {
        const { readChatExport } = await import('../../main/chat-export/chat-export-source')
        const record = core.workspaceRegistry.getRecord(chat.workspaceId)
        return readChatExport(core.conversations, record ? [record] : [], chat)
      },
    }),
  )
  return { conversationCommands }
}
