import type { IpcMain, IpcMainEvent } from 'electron'

import { EXTENSION_OPEN_ACK_CHANNEL } from '../../shared/extension-open-ipc'
import type { ExtensionOpenBroker } from '../extension-open-broker'

/**
 * The windows' half of `extension.open` (`extension-open-broker.ts`).
 *
 * Every answer is attributed to the WebContents that sent it, resolved here
 * rather than read from the message, so one window cannot answer for another.
 * Only workspace windows are heard: no other window shows a workspace.
 */
export function registerExtensionOpenIpc(
  ipcMain: IpcMain,
  broker: Pick<ExtensionOpenBroker, 'handleAck'>,
  options: { senderId: (event: IpcMainEvent) => unknown | null },
): void {
  ipcMain.on(EXTENSION_OPEN_ACK_CHANNEL, (event, payload: unknown) => {
    const from = options.senderId(event)
    if (from !== null) broker.handleAck(from, payload)
  })
}
