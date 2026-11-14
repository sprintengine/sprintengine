import { ipc as ipcRenderer } from '../ipc-router'

import type { ElectronApi } from '../../shared/electron-api'
import { STUDIO_WINDOW_TICKET_CHANNEL, type StudioWindowTicket } from '../../shared/studio-connection'

// This window's way to its Studio: a ticket from main for each connection,
// which the page's client opens as a WebSocket to the server's window
// listener. Nothing the page holds outlives the connection it is for.

/** The slice of `ipcRenderer` this reads: tests hand in their own. */
type Ipc = { invoke(channel: string): Promise<unknown> }

type StudioConnectionApi = Pick<ElectronApi, 'studioWindowTicket'>

export function createStudioConnectionApi(ipc: Ipc): StudioConnectionApi {
  return {
    studioWindowTicket: async () => (await ipc.invoke(STUDIO_WINDOW_TICKET_CHANNEL)) as StudioWindowTicket,
  }
}

export const studioConnectionApi = createStudioConnectionApi({ invoke: (channel) => ipcRenderer.invoke(channel) })
