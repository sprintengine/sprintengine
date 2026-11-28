import type { EnvironmentTarget } from '../../../studio/environmentStudio'
import { pairedTarget } from '../../../studio/environmentStudio'
import type { Workspace } from '../../../../../shared/workspace'
import { environmentTargetOf } from './environmentChat'

// The chat a pane shows, by where it lives: the environment whose Studio holds
// it and its id there. Every chat pane (this computer's, an SSH machine's, a
// WSL distribution's and a paired desktop's) is one view over the transport of
// that environment (`AgentChatView`).
//
// What the pane reads of the chat's agents comes from one of two places, by
// what this window holds. A chat whose record the window keeps (its own, and
// an SSH machine's or a WSL distribution's copy) is read off that record. A
// chat the window keeps no record of (a paired desktop's) is read off its
// environment's list (`listed`). That second kind is every non-local chat once
// copies go (design-environments PR 3c-5).

export type PaneChat = {
  /** The environment that holds the chat; null for this window's own Studio. */
  environment: EnvironmentTarget | null
  /** The chat's id on that environment. */
  chatId: string
  /**
   * Set for a chat whose record this window does not keep: what its tab
   * carries to follow it on its environment's list until that list is read.
   */
  listed?: { connectionId: string; title?: string }
}

/**
 * The chat a record here shows. This is the one bridge from a window record to
 * a chat's address in the pane (design-environments PR 3c-4a removes it).
 */
export function paneChatOfRecord(record: Pick<Workspace, 'id' | 'environment'>): PaneChat {
  return { environment: environmentTargetOf(record.environment), chatId: record.id }
}

/** What a paired chat's tab saves to follow it (`MESH_CONVERSATION_COMPONENT`). */
export type PairedChatTabConfig = {
  connectionId?: string
  machineName?: string
  remoteWorkspaceId?: string
  remoteAgentId?: string
  title?: string
}

/** The chat a paired chat's tab shows, and its agent there; null for a tab that does not say. */
export function paneChatOfPairedTab(
  config: PairedChatTabConfig | undefined,
): { chat: PaneChat; agentId: string } | null {
  if (!config?.connectionId || !config.remoteWorkspaceId || !config.remoteAgentId) return null
  return {
    chat: {
      environment: pairedTarget({
        id: config.connectionId,
        machineName: config.machineName ?? 'Remote machine',
      }),
      chatId: config.remoteWorkspaceId,
      listed: { connectionId: config.connectionId, ...(config.title ? { title: config.title } : {}) },
    },
    agentId: config.remoteAgentId,
  }
}
