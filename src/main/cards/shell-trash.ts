import { shell } from 'electron'

// What a card's Go and a removed skill need of the desktop's shell, which the
// Studio server cannot do itself: moving a folder to this computer's Trash.
// In process the core is handed it; out of process the server asks for it
// over the control channel.

/** This computer's Trash, which only the shell (Electron's `shell`) can reach. */
export function shellTrash(path: string): Promise<void> {
  return shell.trashItem(path)
}
