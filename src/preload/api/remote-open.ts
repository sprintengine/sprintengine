import { ipc as ipcRenderer } from '../ipc-router'
import { REMOTE_OPEN_REQUESTED_CHANNEL } from '../../shared/tailnet'
import type { ElectronApi } from '../../shared/electron-api'

// The shell's one remote push: main brought a window forward after a
// notification about a pairing or a paired machine was clicked, and asks it
// to open the Remote popover. Everything the popover shows is the Studio
// protocol's (`tailnet.*`, `mesh.*`; `src/renderer/src/studio/tailnet.ts`).
export const remoteOpenApi = {
  onRemoteOpenRequested: (cb: () => void): (() => void) => {
    const handler = () => cb()
    ipcRenderer.on(REMOTE_OPEN_REQUESTED_CHANNEL, handler)
    return () => ipcRenderer.removeListener(REMOTE_OPEN_REQUESTED_CHANNEL, handler)
  },
} satisfies Pick<ElectronApi, 'onRemoteOpenRequested'>
