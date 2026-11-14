import { ipc as ipcRenderer } from '../ipc-router'
import type { ElectronApi } from '../../shared/electron-api'
import { ENVIRONMENT_CHANNELS, type EnvironmentEntry, type EnvironmentTicketResult } from '../../shared/environments'

// The machines this desktop knows, one list for every surface (design-environments).
export const environmentsApi = {
  environmentsList: (): Promise<EnvironmentEntry[]> => ipcRenderer.invoke(ENVIRONMENT_CHANNELS.list),
  environmentsRetry: (route: string): Promise<void> => ipcRenderer.invoke(ENVIRONMENT_CHANNELS.retry, { route }),
  environmentsTicket: (route: string): Promise<EnvironmentTicketResult> =>
    ipcRenderer.invoke(ENVIRONMENT_CHANNELS.ticket, { route }),
  onEnvironmentsChanged: (cb: () => void): (() => void) => {
    const handler = () => cb()
    ipcRenderer.on(ENVIRONMENT_CHANNELS.changed, handler)
    return () => ipcRenderer.removeListener(ENVIRONMENT_CHANNELS.changed, handler)
  },
} satisfies Partial<ElectronApi>
