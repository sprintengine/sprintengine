import { shell, type IpcMain } from 'electron'

import { writeViewedImageFile, type AttachmentImageInput } from '../attachment-image-file'

// What a window asks of this computer's desktop about a file: show it in the
// system's file manager, open an HTML file in the system's browser, open a
// chat's picture in the system's image viewer. Shell channels: each acts on
// this computer's screen and apps. Reading and changing files is the Studio
// protocol's (`files.*`, served by the Studio server's core).

type FilesystemShellIpcDependencies = {
  showItemInFolder(targetPath: string): Promise<void>
  openHtmlFileInBrowser(targetPath: string): Promise<void>
}

export function registerFilesystemShellIpc(ipcMain: IpcMain, deps: FilesystemShellIpcDependencies): void {
  ipcMain.handle('fs:show-item-in-folder', async (_, targetPath: string): Promise<void> => {
    await deps.showItemInFolder(targetPath)
  })

  ipcMain.handle('fs:open-html-file-in-browser', async (_, targetPath: string): Promise<void> => {
    await deps.openHtmlFileInBrowser(targetPath)
  })

  // An image attached to a conversation turn lives as base64 in the renderer and
  // has no path to hand anyone, so opening it means writing it out first. The
  // bytes never leave the app's own temp folder, and the operating system picks
  // the viewer — the app owes the person their own image viewer here, not a
  // second-rate one of its own.
  ipcMain.handle('fs:open-image-attachment', async (_, input: AttachmentImageInput): Promise<void> => {
    const filePath = await writeViewedImageFile(input, 'image')
    // `openPath` reports failure by resolving with the message, not by throwing:
    // a non-empty string is the error the caller must see.
    const failure = await shell.openPath(filePath)
    if (failure) throw new Error(failure)
  })
}
