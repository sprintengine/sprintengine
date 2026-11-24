import type { IpcMain } from 'electron'

import type { BrowserTabAutoCloseSetting } from '../browser/browser-tab-auto-close'

/**
 * Settings' read and write of "Close browser tabs unused for". Main owns the
 * value, because main closes the tabs with no window to ask
 * (browser-tab-auto-close.ts); both answer with what main now holds: hours,
 * or null for never.
 */
export function registerBrowserTabAutoCloseIpc(ipcMain: IpcMain, setting: BrowserTabAutoCloseSetting): void {
  ipcMain.handle('app:get-browser-tab-auto-close', (): number | null => setting.hours())
  ipcMain.handle('app:set-browser-tab-auto-close', (_event, hours: unknown): number | null => {
    setting.set(typeof hours === 'number' || hours === null ? hours : setting.hours())
    return setting.hours()
  })
}
