import { ipcRenderer, type IpcRendererEvent } from 'electron'

// This window's IPC: Electron's `ipcRenderer`, which carries the shell's
// channels alone (src/shared/ipc-inventory.ts). Everything the Studio serves
// is reached on the Studio protocol, over the window's connection to its
// server. Every api module imports `ipc` from here rather than `ipcRenderer`
// from Electron, so the web client's build can swap this one module for the
// browser's stand-ins (src/renderer/src/web/webIpcRouter.ts).

export type RendererIpc = {
  invoke(channel: string, ...args: unknown[]): Promise<any>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void): unknown
  once(channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void): unknown
  removeListener(channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void): unknown
  removeAllListeners(channel: string): unknown
}

export const ipc: RendererIpc = ipcRenderer
