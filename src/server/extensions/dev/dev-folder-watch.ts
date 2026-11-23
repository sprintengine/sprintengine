import { lstatSync, readdirSync, watch, type Dirent, type FSWatcher } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { isDevelopmentSkippedPath } from '../../../../packages/extension-sdk/src/module-files'

// Hears every save in the development folders the owner registered, so Studio
// reads the folder again within a moment (extension-reload.ts). Each folder is
// watched whole; a change under node_modules, .git or a dotted folder (a
// tool's, an editor's) is not an edit, since none of it is ever served or run.
// On Linux a recursive watch puts a watch on every folder under it, so there
// each folder that is not left out is watched on its own, and a new one is
// followed as it appears. A burst of saves is one change after a short quiet. A folder that cannot be
// watched (gone, or a network share) is read again by
// `sprintengine-extension dev load`, which reads a registered folder again.

export type DevFolderWatch = {
  /** Watch exactly these folders now: new ones are followed, gone ones let go. */
  follow(folders: readonly string[]): void
  close(): void
}

/** A watch on one folder and what is under it; `onEvent` hears each change's path, relative to `folder`. */
type TreeWatch = { close(): void }

/**
 * Linux: one watch per folder under `folder` that is not left out
 * (node_modules, .git, dotted folders), only on folders (never a file or a
 * link), and new folders followed as they appear. A folder deleted or
 * replaced (`src/` removed and made again) lets go of its watch and those
 * under it, and the new one is followed in its place.
 */
export function watchTreeByFolder(
  folder: string,
  onEvent: (name: string | null) => void,
  onError: () => void,
): TreeWatch & { watching(): string[] } {
  const watchers = new Map<string, FSWatcher>()
  const evict = (dir: string) => {
    for (const [path, watcher] of watchers) {
      if (path !== dir && !path.startsWith(`${dir}${sep}`)) continue
      watcher.close()
      watchers.delete(path)
    }
  }
  const add = (dir: string) => {
    try {
      if (!lstatSync(dir).isDirectory()) return
    } catch {
      return
    }
    if (watchers.has(dir)) return
    const rel = relative(folder, dir).split(sep).join('/')
    if (rel && isDevelopmentSkippedPath(rel)) return
    let watcher: FSWatcher
    try {
      watcher = watch(dir, { persistent: false }, (event, name) => {
        const path = typeof name === 'string' ? (rel ? `${rel}/${name}` : name) : null
        onEvent(path)
        if (event === 'rename' && typeof name === 'string') {
          // Gone, made, or replaced: whatever was watched there is let go, and what is there now followed.
          const child = join(dir, name)
          evict(child)
          add(child)
        }
      })
    } catch {
      return
    }
    watcher.on('error', () => {
      watcher.close()
      watchers.delete(dir)
      if (dir === folder) onError()
    })
    watchers.set(dir, watcher)
    let entries: Dirent[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) if (entry.isDirectory()) add(join(dir, entry.name))
  }
  add(folder)
  if (!watchers.has(folder)) throw new Error(`${folder} cannot be watched.`)
  return {
    close() {
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
    },
    watching: () => [...watchers.keys()],
  }
}

function watchTree(folder: string, onEvent: (name: string | null) => void, onError: () => void): TreeWatch {
  if (process.platform === 'linux') return watchTreeByFolder(folder, onEvent, onError)
  const watcher = watch(folder, { recursive: true, persistent: false }, (_event, name) =>
    onEvent(typeof name === 'string' ? name : null),
  )
  watcher.on('error', () => {
    watcher.close()
    onError()
  })
  return watcher
}

export function watchDevFolders(onChange: (folder: string) => void, quietMs = 150): DevFolderWatch {
  const watchers = new Map<string, TreeWatch>()
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
          const watcher = watchTree(
            folder,
            (name) => changed(folder, name),
            () => watchers.delete(folder),
          )
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
