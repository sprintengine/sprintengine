import type { createConversationTerminalHandoff } from '../../main/conversation-terminal-handoff'
import { createConversationService } from '../../main/conversation-service'
import type { AgentLaunchSettingsStore } from '../../main/launch-settings-store'
import { createStudioChatBackend } from '../../main/studio-rpc/studio-chat-backend'
import type { StudioRpcService } from '../../main/studio-rpc/studio-rpc-service'
import type { StudioCore } from '../core/studio-core'
import type { StudioGateway } from '../core/studio-gateway'
import { knownFolders } from '../files/known-folders'

// The chat surface the Studio server serves every client, set up in one place
// for each way the server runs: in process (main), in a process of its own
// (desktop-server.ts) and behind the web front door. It used to also register
// the `window.api` channels the server owned; every one of those is a Studio
// protocol method now (the last were the machines this computer offers,
// `hosts.*`), so nothing here touches IPC.

export type ServerDomainIpcDeps = {
  core: Pick<
    StudioCore,
    | 'workspaceRegistry'
    | 'agentLaunchSettings'
    | 'conversations'
    | 'platform'
    | 'textGenerationSettings'
    | 'conversationCommands'
  > & { agentLaunchSettings: AgentLaunchSettingsStore }
  gateway: StudioGateway
  studioRpc: StudioRpcService
  terminalHandoff: ReturnType<typeof createConversationTerminalHandoff>['handoff']
}

export type ServerDomainIpcHandles = {
  conversationCommands: { dispose(): Promise<void> }
}

export function provideServerChat(deps: ServerDomainIpcDeps): ServerDomainIpcHandles {
  const { core } = deps
  const dataDir = () => core.platform.paths.dataDir()
  // The core's own `/` lists, which every window and a paired desktop read over the protocol.
  const conversationCommands = core.conversationCommands()
  // One conversation service over the core's chats, which the Studio RPC's
  // chat surface serves to every client, the app's own windows included.
  const conversationService = {
    ...createConversationService(core.conversations),
    terminalHandoff: deps.terminalHandoff,
  }
  deps.studioRpc.provideChat(
    createStudioChatBackend({
      conversation: conversationService,
      commandReceipt: (sessionId, commandId) => core.conversations.commandReceipt(sessionId, commandId),
      readableRoots: () => knownFolders(core.workspaceRegistry, dataDir()),
      commands: (input) => conversationCommands.list(input),
      onListChanged: (listener) => deps.gateway.onListChanged(listener),
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
