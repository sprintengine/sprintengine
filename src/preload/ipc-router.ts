import { ipcRenderer } from 'electron'

import { SERVER_PORT_CHANNEL } from '../shared/server-port'
import { createIpcRouter, type RendererIpc, type RouterPort } from './ipc-router-core'

// This window's IPC: the router in `ipc-router-core.ts` over Electron's
// `ipcRenderer`. The web client's build swaps this module for one over the
// browser's socket.

export * from './ipc-router-core'

/** This window's router, over Electron's `ipcRenderer`. */
function createWindowRouter() {
  const router = createIpcRouter({ ipcRenderer })
  // Outside a renderer (a unit test that loads an api module) there is no
  // `ipcRenderer` to hear a port on.
  ipcRenderer?.on(SERVER_PORT_CHANNEL, (event) => {
    const [port] = event.ports
    if (port) router.attachPort(port as unknown as RouterPort)
  })
  return router
}

export const ipc: RendererIpc = createWindowRouter()
