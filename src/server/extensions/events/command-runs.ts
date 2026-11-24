// A worker's `studio.runCommand(action)`: one of Studio's own actions, run in
// the window whose call set the worker off (a command it ran in place of
// that action, from its palette, a shortcut or a menu). Studio's actions are
// the window's, so the worker's ask goes to that window's connection alone,
// over its `extension.commandRuns` stream, and the window runs the built-in
// action, never another extension's replacement of it. Work no window set
// off (a background worker's, an event's) has no window to run it in.

export type ExtensionCommandRun = { moduleId: string; action: string }

export type ExtensionCommandRuns = {
  /** Hear the runs asked of one connection; returns the stopper. */
  listen(connectionId: string, deliver: (run: ExtensionCommandRun) => void): () => void
  /** Ask the connection to run it: whether one is listening. */
  run(connectionId: string, run: ExtensionCommandRun): boolean
}

export function createExtensionCommandRuns(): ExtensionCommandRuns {
  const listeners = new Map<string, Set<(run: ExtensionCommandRun) => void>>()
  return {
    listen(connectionId, deliver) {
      const set = listeners.get(connectionId) ?? new Set()
      set.add(deliver)
      listeners.set(connectionId, set)
      return () => {
        set.delete(deliver)
        if (set.size === 0 && listeners.get(connectionId) === set) listeners.delete(connectionId)
      }
    },
    run(connectionId, run) {
      const set = listeners.get(connectionId)
      if (!set || set.size === 0) return false
      for (const deliver of [...set]) deliver({ ...run })
      return true
    },
  }
}

/** The server's one hub: the main host asks, the window's connection listens. */
export const extensionCommandRuns = createExtensionCommandRuns()
