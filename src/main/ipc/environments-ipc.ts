import type { IpcMain } from 'electron'

import { parseEnvironmentRoute } from '../../../packages/studio-protocol/src/environment'
import { ENVIRONMENT_CHANNELS } from '../../shared/environments'
import type { DesktopEnvironments } from '../environments/desktop-environments'

// The window's way to the machines this desktop knows (design-environments):
// the one list every surface draws, a push when it reads differently, and
// Retry. A shell channel: the saved list is this client's own state.

export function registerEnvironmentsIpc(
  ipcMain: IpcMain,
  deps: {
    environments: Pick<DesktopEnvironments, 'list' | 'onChanged' | 'retry'>
    broadcast: (channel: string) => void
  },
): () => void {
  ipcMain.handle(ENVIRONMENT_CHANNELS.list, () => deps.environments.list())
  ipcMain.handle(ENVIRONMENT_CHANNELS.retry, async (_event, payload: unknown) => {
    // Only a route the list holds is asked: a window is trusted with asking, nothing more.
    const route = (payload as { route?: unknown } | null)?.route
    if (typeof route !== 'string' || !parseEnvironmentRoute(route)) return
    await deps.environments.retry(route)
  })
  const off = deps.environments.onChanged(() => deps.broadcast(ENVIRONMENT_CHANNELS.changed))
  return () => {
    off()
    ipcMain.removeHandler(ENVIRONMENT_CHANNELS.list)
    ipcMain.removeHandler(ENVIRONMENT_CHANNELS.retry)
  }
}
