import { meshConversationSessionId } from '../../../../shared/tailnet-mesh'
import type { Workspace } from '../../../../shared/workspace'
import { searchEnvironmentChats, searchStudioChats } from '../../studio/environmentChatRecords'
import { windowStudioClient } from '../../studio/windowStudioClient'
import { openConversationMatch, requestConversationJump } from '../../utils/conversationHistoryNavigation'
import { workspaceSwitchRowId } from '../commandPaletteSearch'
import { environmentChatSourceViews, environmentChatsNow } from '../workspace/remoteBand/environmentChatsNow'
import {
  environmentChatKey,
  openSpecOfConversation,
  type RemoteSessionOpenSpec,
} from '../workspace/remoteBand/remoteSessionsModel'
import type { ChatSearchPlace } from './conversationHistoryProvider'

// The environments whose chats the palette searches (design-environments
// PR 3): this computer's, through the window's own Studio, then every
// environment the window follows whose Studio takes a search from here, each
// through its own. A match opens the chat as its sidebar row does.

export type ChatSearchPlacesInput = {
  /** This window's own chats the palette lists (rail-visible), by id. */
  chats: () => ReadonlyMap<string, Pick<Workspace, 'id' | 'mode' | 'folderPath'>>
  /** Every record this window keeps, for which of them follows another environment's chat. */
  records: () => readonly Pick<Workspace, 'id' | 'environment' | 'remoteOrigin'>[]
  /** Open another environment's chat as its row does; the id of the chat here that shows it, or null. */
  openEnvironmentChat: (spec: RemoteSessionOpenSpec) => string | null
}

export function chatSearchPlaces(input: ChatSearchPlacesInput): ChatSearchPlace[] {
  const here: ChatSearchPlace = {
    badge: null,
    search: (query) => searchStudioChats(windowStudioClient(), query),
    rowOf: (chat) => {
      const workspace = input.chats().get(chat.workspaceId)
      if (!workspace?.folderPath) return null
      const workspaceRoot = workspace.folderPath
      return {
        id: workspaceSwitchRowId(workspace.id),
        mark: { kind: 'chat', workspaceId: workspace.id, mode: workspace.mode },
        open: (match) => void openConversationMatch({ workspaceRoot, workspaceId: workspace.id, ...match }),
      }
    },
  }
  const elsewhere = environmentChatSourceViews()
    // One that rests, or whose Studio takes no search from this pairing, is not asked.
    .filter((source) => source.live && source.entry.manage?.search === true)
    .map((source): ChatSearchPlace => ({
      badge: source.machineName,
      // One not connected now (off the tailnet, asleep) says so at once rather than holding the list up.
      search: (query) =>
        searchEnvironmentChats({ route: source.route, name: source.machineName }, query, { onlyWhenConnected: true }),
      rowOf: (chat) => {
        const key = environmentChatKey(source.environmentId, source.route, chat.workspaceId)
        return {
          id: workspaceSwitchRowId(key),
          mark: { kind: 'chat', workspaceId: key, mode: 'standard' },
          open: (match) => {
            const row = environmentChatsNow(input.records()).find(
              (candidate) => candidate.route === source.route && candidate.workspaceId === chat.workspaceId,
            )
            if (!row) return
            const spec = openSpecOfConversation(row, match.agentId)
            // The pane follows the agent the match is in, listed or not.
            const opened = input.openEnvironmentChat(
              spec.attachedWorkspaceId || !spec.agent || spec.agent.agentId === match.agentId
                ? spec
                : {
                    ...spec,
                    agent: {
                      ...spec.agent,
                      agentId: match.agentId,
                      sessionId: meshConversationSessionId(chat.workspaceId, match.agentId),
                    },
                  },
            )
            if (opened) requestConversationJump(opened, match.agentId, match.seq)
          },
        }
      },
    }))
  return [here, ...elsewhere]
}
