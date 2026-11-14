import { mkdirSync, readdirSync, watch, type FSWatcher } from 'fs'
import { join } from 'path'

/**
 * Tell the windows when the drop-in module folder changes, so a module copied
 * in while Studio runs is listed without a reload: the folder is watched, and
 * each module folder in it, since a module's manifest is often written after
 * its folder appears. A save fires several events, and one can arrive before
 * the file is complete, so they are gathered into one change after a short
 * quiet. The listing itself is read from disk when a window asks.
 *
 * Returns the stop. A folder that cannot be watched leaves things as before:
 * the list is current after a reload.
 */
export function watchUserModuleRoot(root: string, onChange: () => void, quietMs = 300): () => void {
  const watchers = new Map<string, FSWatcher>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const watchDir = (dir: string, onEvent: () => void): void => {
    if (watchers.has(dir)) return
    try {
      const watcher = watch(dir, { persistent: false }, onEvent)
      watcher.on('error', () => {
        watcher.close()
        watchers.delete(dir)
      })
      watchers.set(dir, watcher)
    } catch {
      // Gone, or not watchable here.
    }
  }

  // One watch per module folder now in the root; a folder that went is closed.
  const followModuleFolders = (): void => {
    let names: string[] = []
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
    } catch {
      names = []
    }
    const wanted = new Set(names.map((name) => join(root, name)))
    for (const [dir, watcher] of watchers) {
      if (dir === root || wanted.has(dir)) continue
      watcher.close()
      watchers.delete(dir)
    }
    for (const dir of wanted) watchDir(dir, changed)
  }

  function changed(): void {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (stopped) return
      followModuleFolders()
      onChange()
    }, quietMs)
  }

  try {
    mkdirSync(root, { recursive: true })
  } catch {
    // Unwritable: watched if it exists, otherwise nothing to follow.
  }
  watchDir(root, changed)
  followModuleFolders()

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    for (const watcher of watchers.values()) watcher.close()
    watchers.clear()
  }
}
