import { openExternalFileWindow } from '../components/auxWindows/openFileWindow'
import { openFileSurface } from './openFileSurface'
import { splitTreePath } from './fileTreeEntries'

// Open file…: any one file on this computer, picked in its own open dialog, in
// a workspace or not. The file opens where every other open goes
// (`openFileSurface`), so the person's choice between the editor window and
// the editor pane holds here too; a file outside the workspace's folder shows
// in the editor window's tree as the pinned "Outside this workspace" row.
//
// The dialog is this computer's, and so are the files the window's editor
// reads: a chat on a paired machine does not change which disk this opens on.
// Its files are that machine's, which the panel says ("On <machine>") and
// which this window does not open.

/** Whether this window's shell has an open dialog to pick a file in. */
export function canOpenAnyFile(): boolean {
  return typeof window !== 'undefined' && typeof window.api?.openFileDialog === 'function'
}

/** The picked file's path, or null when the dialog was cancelled or there is none. */
export async function pickAnyFile(defaultPath?: string): Promise<string | null> {
  if (!canOpenAnyFile()) return null
  try {
    return (await window.api.openFileDialog?.(defaultPath ? { defaultPath } : undefined)) ?? null
  } catch {
    return null
  }
}

/** Pick a file and open it, for the workspace the person is in (empty for none). */
export async function openAnyFile(input: { workspaceId: string; defaultPath?: string }): Promise<boolean> {
  const path = await pickAnyFile(input.defaultPath)
  if (!path) return false
  const name = splitTreePath(path).name || path
  // With no workspace in front there is no editor pane to open it in; the
  // editor window needs none, and works the tree out from the file itself.
  if (!input.workspaceId) void openExternalFileWindow({ workspaceId: '', path, name })
  else openFileSurface({ workspaceId: input.workspaceId, path, name })
  return true
}
