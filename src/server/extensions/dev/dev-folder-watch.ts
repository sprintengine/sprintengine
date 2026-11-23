import { watch, type FSWatcher } from 'node:fs'
import { relative, sep } from 'node:path'

import { isDevelopmentSkippedPath } from '../../../../packages/extension-sdk/src/module-files'

// Hears every save in the development folders the owner registered, so Studio
// reads the folder again within a moment (extension-reload.ts). Each folder is
// watched whole; a change under node_modules, .git or a dotted folder (a
// tool's, an editor's) is not an edit, since none of it is ever served or run.
// A burst of saves is one change after a short quiet. A folder that cannot be
// watched (gone, or a network share) is read again by
// `sprintengine-extension dev load`, which reads a registered folder again.

export type DevFolderWatch = {
  /** Watch exactly these folders now: new ones are followed, gone ones let go. */
  follow(folders: readonly string[]): void
  close(): void
}

export function watchDevFolders(onChange: (folder: string) => void, quietMs = 150): DevFolderWatch {
  const watchers = new Map<string, FSWatcher>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let closed = false

  const changed = (folder: string, name: string | null) => {
    if (closed) return
    if (name) {
      const path = relative(folder, `${folder}${sep}${name}`).split(sep).join('/')
      if (path && isDevelopmentSkippedPath(path)) return
    }
    const pending = timers.get(folder)
    if (pending) clearTimeout(pending)
    timers.set(
      folder,
      setTimeout(() => {
        timers.delete(folder)
        if (!closed) onChange(folder)
      }, quietMs),
    )
  }

  return {
    follow(folders) {
      if (closed) return
      const wanted = new Set(folders)
      for (const [folder, watcher] of watchers) {
        if (wanted.has(folder)) continue
        watcher.close()
        watchers.delete(folder)
      }
      for (const folder of wanted) {
        if (watchers.has(folder)) continue
        try {
          const watcher = watch(folder, { recursive: true, persistent: false }, (_event, name) =>
            changed(folder, typeof name === 'string' ? name : null),
          )
          watcher.on('error', () => {
            watcher.close()
            watchers.delete(folder)
          })
          watchers.set(folder, watcher)
        } catch {
          // Not watchable here: `dev load` reads it again.
        }
      }
    },
    close() {
      closed = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
    },
  }
}
