/**
 * Sends every module's app-level state (`appSettings.moduleSettings`, the
 * `module:<id>` namespaces a Settings section writes) to the window's Studio
 * (`module.setAppState`).
 *
 * A module's `entry.main` reads its settings there (`MainHost.getModuleAppState`)
 * with no window to ask — a scheduler's run time, a poller's interval — so
 * the Studio keeps a persisted copy. Same one-way contract as the
 * text-generation setting: the window owns the values, the Studio keeps the
 * copy, and there is no read path back.
 *
 * Mounted once from `WorkspaceManager`. The first push runs on mount so main
 * converges even when this window's values came from another window or an
 * import; after that only a change that moved the bag is sent.
 */
import { useWorkspaceStore } from '../store/workspaceStore'
import { extensionsApi, windowHasStudio } from '../studio/extensions'

export function initModuleAppStateSync(): () => void {
  if (!windowHasStudio()) return () => undefined
  const api = extensionsApi

  let lastPushed: string | null = null
  let lastBag: unknown = null
  const push = (): void => {
    const bag = useWorkspaceStore.getState().appSettings.moduleSettings
    // Identity first: most store writes leave the bag untouched.
    if (bag === lastBag && lastPushed !== null) return
    lastBag = bag
    const key = JSON.stringify(bag ?? {})
    if (key === lastPushed) return
    lastPushed = key
    void api.setModuleAppState(bag ?? {}).catch(() => {
      // Retry on the next change; the Studio keeps the last good copy meanwhile.
      lastPushed = null
    })
  }

  push()
  return useWorkspaceStore.subscribe(push)
}
