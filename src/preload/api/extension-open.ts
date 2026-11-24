import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'

import {
  EXTENSION_OPEN_ACK_CHANNEL,
  EXTENSION_OPEN_REQUEST_CHANNEL,
  type ExtensionOpenAck,
  type ExtensionOpenWindowRequest,
} from '../../shared/extension-open-ipc'
import type { ElectronApi } from '../../shared/electron-api'

// `extension.open`'s window half (src/main/extension-open-broker.ts): asks in,
// answers out. Every answer is attributed by main to the window that sent it.

export const extensionOpenApi = {
  onExtensionOpenRequest: (cb: (request: ExtensionOpenWindowRequest) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, request: ExtensionOpenWindowRequest): void => cb(request)
    ipcRenderer.on(EXTENSION_OPEN_REQUEST_CHANNEL, handler)
    return () => ipcRenderer.removeListener(EXTENSION_OPEN_REQUEST_CHANNEL, handler)
  },
  ackExtensionOpen: (ack: ExtensionOpenAck): void => {
    ipcRenderer.send(EXTENSION_OPEN_ACK_CHANNEL, ack)
  },
} satisfies Pick<ElectronApi, 'onExtensionOpenRequest' | 'ackExtensionOpen'>
