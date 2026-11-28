import { useMemo } from 'react'

import type { ModuleEnablementOverrides } from '../../../../../shared/modules/manifest'
import type { Workspace, WorkspaceMode } from '../../../../../shared/workspace'
import { useEnvironments } from '../../../hooks/useEnvironments'
import { reachedOverTailnet } from '../../../studio/environmentStudio'
import { isHiddenFromRail } from '../../../utils/workspaceVisibility'
import { environmentIdOfRoute } from './environmentChatsNow'
import { chatRecordsByAddress, environmentChatRows, type RemoteConversation } from './remoteSessionsModel'
import { useRemoteSessions } from './useRemoteSessions'

/**
 * Every followed environment's chats as rows, by address, kept current as
 * each environment's source moves: the rows the sidebar draws (the same
 * environments, the same hidden kinds, none of a paired desktop's while this
 * device is off the tailnet), for a list that shows them beside it (the
 * palette), or the chats each has settled (Settings ▸ Settled chats).
 */
export function useEnvironmentChatRows(
  workspaces: readonly Pick<Workspace, 'id' | 'environment' | 'remoteOrigin'>[],
  moduleOverrides: ModuleEnablementOverrides | undefined,
  /** The chats each environment has settled instead (Settings ▸ Settled chats). */
  settled = false,
): readonly RemoteConversation[] {
  const { sources, link } = useRemoteSessions()
  const environments = useEnvironments()
  return useMemo(
    () =>
      environmentChatRows({
        sources,
        environments,
        records: chatRecordsByAddress(workspaces, environmentIdOfRoute(environments, sources)),
        hiddenMode: (mode) => mode !== null && isHiddenFromRail({ mode: mode as WorkspaceMode }, moduleOverrides),
        onTailnet: link !== 'down',
        reachedOverTailnet,
        settled,
      }),
    [sources, environments, workspaces, moduleOverrides, link, settled],
  )
}
