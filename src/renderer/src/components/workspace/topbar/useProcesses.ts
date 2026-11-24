import { useCallback, useEffect, useRef, useState } from 'react'

import type { StudioClient } from '../../../../../../packages/client-runtime/src/public'
import {
  STUDIO_BROWSER_TABS_CAPABILITY,
  STUDIO_PROCESSES_CAPABILITY,
  type StudioAgentProcess,
  type StudioBrowserTab,
  type StudioProcessesUnavailable,
  type StudioProcessStopOutcome,
} from '../../../../../../packages/studio-protocol/src/public'
import { watchWindowStudio, windowStudioClient } from '../../../studio/windowStudioClient'
import { isWindowVisible } from '../../../utils/windowActivity'

// The programs agents started on this window's machine, and the built-in
// browser's tabs, for the account menu's Processes: read from the window's
// Studio (`processes.list`, `browserTabs.list`), whichever machine that is.
// Nothing pushes these, so they are asked for: every few seconds while the
// list is on screen, and now and then otherwise, so the account row can say
// how many were left behind.

export type ProcessesView = {
  /** The window's Studio serves either list; until then the row is absent. */
  offered: boolean
  loaded: boolean
  processes: readonly StudioAgentProcess[]
  tabs: readonly StudioBrowserTab[]
  unavailable: StudioProcessesUnavailable | null
}

const NONE: ProcessesView = { offered: false, loaded: false, processes: [], tabs: [], unavailable: null }

/** How often the list is read while it is open. */
export const OPEN_POLL_MS = 5_000
/** How often it is read while closed, for the account row's count. */
export const CLOSED_POLL_MS = 60_000

async function studio(): Promise<StudioClient | null> {
  const api = typeof window === 'undefined' ? null : window.api
  if (typeof api?.studioWindowTicket !== 'function') return null
  try {
    return await windowStudioClient(api)
  } catch {
    return null
  }
}

function commandId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function useProcesses(open: boolean) {
  const [view, setView] = useState<ProcessesView>(NONE)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const ask = useCallback(async (): Promise<void> => {
    const client = await studio()
    if (!client) return
    const servesProcesses = client.supports(STUDIO_PROCESSES_CAPABILITY)
    const servesTabs = client.supports(STUDIO_BROWSER_TABS_CAPABILITY)
    if (!servesProcesses && !servesTabs) {
      if (alive.current) setView(NONE)
      return
    }
    const [processes, tabs] = await Promise.all([
      servesProcesses ? client.request('processes.list', {}).catch(() => null) : Promise.resolve(null),
      servesTabs ? client.request('browserTabs.list', {}).catch(() => null) : Promise.resolve(null),
    ])
    if (!alive.current) return
    setView((current) => ({
      offered: true,
      loaded: true,
      // A read that reached nobody leaves what is on screen alone.
      processes: processes ? processes.processes : current.processes,
      tabs: tabs ? tabs.tabs : current.tabs,
      unavailable: processes ? (processes.unavailable ?? null) : current.unavailable,
    }))
  }, [])

  useEffect(() => {
    void ask()
    const timer = setInterval(
      () => {
        // A window nobody can see asks nothing.
        if (!isWindowVisible()) return
        void ask()
      },
      open ? OPEN_POLL_MS : CLOSED_POLL_MS,
    )
    return () => clearInterval(timer)
  }, [ask, open])

  // A Studio that came back (or another one, after a reconnect) is asked again.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.api) return
    return watchWindowStudio(window.api, () => void ask())
  }, [ask])

  /** Stop these rows; answers how many could not be stopped. */
  const stop = useCallback(
    async (ids: readonly string[]): Promise<{ notStopped: number }> => {
      const client = await studio()
      if (!client || ids.length === 0) return { notStopped: ids.length }
      try {
        const answer = await client.request('processes.stop', { ids: [...ids], commandId: commandId() })
        const failed = (outcome: StudioProcessStopOutcome) => outcome === 'failed' || outcome === 'refused'
        await ask()
        return { notStopped: answer.results.filter((result) => failed(result.outcome)).length }
      } catch {
        return { notStopped: ids.length }
      }
    },
    [ask],
  )

  const closeTab = useCallback(
    async (tabId: string): Promise<boolean> => {
      const client = await studio()
      if (!client) return false
      try {
        const { closed } = await client.request('browserTabs.close', { tabId, commandId: commandId() })
        await ask()
        return closed
      } catch {
        return false
      }
    },
    [ask],
  )

  return { view, stop, closeTab, refresh: ask }
}

/** What the account row says at its end: what was left behind, else what is playing sound, else how many. */
export function processesRowCounts(view: ProcessesView): { leftBehind: number; playing: number; total: number } {
  return {
    leftBehind: view.processes.filter((entry) => entry.state === 'left-behind').length,
    playing: view.tabs.filter((tab) => tab.audible).length,
    total: view.processes.length + view.tabs.length,
  }
}
