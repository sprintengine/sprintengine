import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { parseEnvironmentRoute, type EnvironmentRoute } from '../../../packages/studio-protocol/src/environment'
import { ENVIRONMENT_CHANNELS, type EnvironmentTicketResult } from '../../shared/environments'
import { studioWindowOrigin } from '../../shared/studio-connection'
import type { DesktopEnvironments } from '../environments/desktop-environments'
import { assertAppSender } from './ipc-sender'

// The window's way to the machines this desktop knows (design-environments):
// the one list every surface draws, a push when it reads differently, Retry,
// and a ticket for one connection to a machine's Studio. A shell channel: the
// saved list is this client's own state, and the credentials that reach each
// machine are kept here, never in a window.

/** Who buys a window's ticket for a route: the owner of that kind of route. */
export type EnvironmentTicketIssuer = (route: EnvironmentRoute, origin: string) => Promise<EnvironmentTicketResult>

export function registerEnvironmentsIpc(
  ipcMain: IpcMain,
  deps: {
    environments: Pick<DesktopEnvironments, 'list' | 'onChanged' | 'retry'>
    broadcast: (channel: string) => void
    ticket: EnvironmentTicketIssuer
  },
): () => void {
  ipcMain.handle(ENVIRONMENT_CHANNELS.list, () => deps.environments.list())
  ipcMain.handle(ENVIRONMENT_CHANNELS.retry, async (_event, payload: unknown) => {
    // Only a route the list holds is asked: a window is trusted with asking, nothing more.
    const route = (payload as { route?: unknown } | null)?.route
    if (typeof route !== 'string' || !parseEnvironmentRoute(route)) return
    await deps.environments.retry(route)
  })
  // A ticket is a credential: only an app window's own top-level document is
  // given one (a subframe, a webview guest or a page the window navigated to
  // gets none), and it is good only from that document's origin.
  ipcMain.handle(
    ENVIRONMENT_CHANNELS.ticket,
    async (event: IpcMainInvokeEvent, payload: unknown): Promise<EnvironmentTicketResult> => {
      assertAppSender(event)
      const origin = studioWindowOrigin(event.senderFrame?.url ?? '')
      if (!origin) return { ok: false, code: 'unauthorized', message: 'This window has no origin Studio can admit.' }
      const route = parseEnvironmentRoute((payload as { route?: unknown } | null)?.route)
      if (!route) return { ok: false, code: 'unknown_route', message: 'That is not a machine this desktop knows.' }
      return deps.ticket(route, origin)
    },
  )
  const off = deps.environments.onChanged(() => deps.broadcast(ENVIRONMENT_CHANNELS.changed))
  return () => {
    off()
    ipcMain.removeHandler(ENVIRONMENT_CHANNELS.list)
    ipcMain.removeHandler(ENVIRONMENT_CHANNELS.retry)
    ipcMain.removeHandler(ENVIRONMENT_CHANNELS.ticket)
  }
}
