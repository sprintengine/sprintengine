import { useCallback, useEffect, useState } from 'react'

import type { HostsListResult } from '../../../shared/execution-host'
import { hostsApi } from '../studio/hosts'

/**
 * The machines this computer offers, as the window's Studio lists them
 * (`hosts.list`): this one first, then
 * (on Windows) its WSL distributions — every one with `all` (Settings ▸
 * Machines), the enabled ones otherwise (the New chat machine dropdown).
 *
 * Read once on mount and again whenever the Studio says the list may read
 * differently (`hosts.changed`: a setting moved, a refresh landed, a
 * distribution's server changed state). Never on window focus:
 * listing WSL starts a process on Windows. `refresh()` asks WSL again, for
 * Settings' own Refresh.
 *
 * Null until the first answer; a window whose Studio does not list them
 * stays null, which every caller reads as "this machine only".
 */
export function useExecutionHosts(options: { all?: boolean; refreshOnMount?: boolean; enabled?: boolean } = {}): {
  listing: HostsListResult | null
  refresh: () => Promise<void>
} {
  const all = options.all === true
  const refreshOnMount = options.refreshOnMount === true
  // False holds off the first read (and the subscription) until a caller that
  // mounts early actually needs the list.
  const enabled = options.enabled !== false
  const [listing, setListing] = useState<HostsListResult | null>(null)
  const load = useCallback(
    async (refresh: boolean): Promise<void> => {
      try {
        setListing(await hostsApi.hostsList({ all, refresh }))
      } catch {
        // Keep what was there: a failed read is not "no machines".
      }
    },
    [all],
  )
  useEffect(() => {
    if (!enabled) return
    void load(refreshOnMount)
    const unsubscribe = hostsApi.onHostsChanged(() => void load(false))
    return () => unsubscribe()
  }, [enabled, load, refreshOnMount])
  const refresh = useCallback(() => load(true), [load])
  return { listing, refresh }
}
