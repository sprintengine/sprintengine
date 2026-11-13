import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { app, BrowserWindow, dialog, type IpcMain } from 'electron'

import { suggestedPatchFileName } from '../git-patch'
import { getGitRepoWatch } from '../../server/git/checkout-watch'

// What a window asks of this computer about git: saving a patch through the
// system's save dialog, modal to the window that asked. A shell channel: the
// dialog and the file it writes are this computer's. Reading and running git
// is the Studio protocol's (`git.*`, served by the Studio server's core).
//
// While no window of the app is focused, the checkout watch the core keeps in
// this process holds what changed and delivers it as one batch on the next
// focus. Blur is checked a tick later, because moving focus between two of
// our own windows blurs one before it focuses the other.

export function registerGitShellIpc(ipcMain: IpcMain): void {
  // The dialog belongs to main because the window it must be modal to does.
  ipcMain.handle('git:save-patch', async (event, repoRoot: string, patch: string, defaultFileName?: string) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    // A BARE NAME, or none. This is joined to the repository root, so
    // `../../.zshrc` or `/etc/hosts` would put the save dialog somewhere the
    // person did not ask for — and the dialog's default path is what a
    // hurried Enter accepts.
    const suggestion = bareFileName(defaultFileName) ?? suggestedPatchFileName(repoRoot)
    const options = {
      title: 'Create patch',
      defaultPath: join(repoRoot, suggestion),
      filters: [{ name: 'Patch', extensions: ['patch', 'diff'] }],
    }
    const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { ok: true, path: null, message: null }
    try {
      await writeFile(result.filePath, patch, 'utf-8')
      return { ok: true, path: result.filePath, message: null }
    } catch (error) {
      return { ok: false, path: null, message: error instanceof Error ? error.message : String(error) }
    }
  })

  const watch = getGitRepoWatch()
  app.on?.('browser-window-focus', () => watch.setFocused(true))
  app.on?.('browser-window-blur', () => {
    setTimeout(() => watch.setFocused(anyWindowFocused()), 0)
  })
}

function anyWindowFocused(): boolean {
  try {
    return BrowserWindow.getFocusedWindow() !== null
  } catch {
    return true
  }
}

/**
 * A file NAME — no directory in it, no climbing out of one, nothing a shell or
 * a path join would read as an instruction. Null when the caller gave nothing
 * usable, so the caller falls back to a name it made itself.
 */
export function bareFileName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (!name || name === '.' || name === '..') return null
  if (/[\\/]/.test(name)) return null
  // A leading dot is a hidden file, not a traversal; `..anything` is neither,
  // and a NUL byte is a path the fs layer would refuse anyway.
  if (name.includes('\0')) return null
  return name
}
