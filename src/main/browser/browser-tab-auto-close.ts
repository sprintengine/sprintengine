import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { STUDIO_BROWSER_TAB_MAX_TEXT, type StudioBrowserTab } from '../../../packages/studio-protocol/src/public'
import { isRecord } from '../../shared/records'
import { writeFileAtomicSync } from '../../server/platform/atomic-file'
import type { BrowserTabListing } from './browser-manager'

// Built-in browser tabs nobody is using are closed (Settings → Agents → Built-in
// browser). An agent opens a page to check its work and moves on; the page
// stays open in a pane nobody looks at, and can keep playing sound for days.
// A tab is closed once it has gone unused for the setting's time (a day by
// default) AND its chat's agent has not worked for as long, or is gone: the
// chat was settled or removed. The tab the person has in front of them is
// never closed, whatever its clocks say. "Never" turns this off.
//
// Only tabs: programs agents started are listed in Processes and stopped by
// hand, never here (owner ruling 2026-11-24), because some, a report server
// say, are kept running on purpose long after their agent is done.

/** The choices Settings offers, in hours; null is "Never". */
export const BROWSER_TAB_AUTO_CLOSE_CHOICES: readonly (number | null)[] = [4, 24, 72, 168, null]
/** A day, unless the person chose otherwise. */
export const BROWSER_TAB_AUTO_CLOSE_DEFAULT_HOURS = 24
/** How often the open tabs are looked over. */
export const BROWSER_TAB_SWEEP_MS = 10 * 60_000

const HOUR_MS = 60 * 60_000
const FILE_NAME = 'browser-tab-auto-close.json'

export type BrowserTabAutoCloseSetting = {
  /** Hours unused before a tab is closed; null for never. */
  hours(): number | null
  set(hours: number | null): void
}

/** One of the offered choices, or the default for anything else. */
export function readAutoCloseHours(value: unknown): number | null {
  return BROWSER_TAB_AUTO_CLOSE_CHOICES.includes(value as number | null)
    ? (value as number | null)
    : BROWSER_TAB_AUTO_CLOSE_DEFAULT_HOURS
}

export function createBrowserTabAutoCloseSetting(deps: {
  resolveUserDataDir: () => string
  log?: (message: string) => void
}): BrowserTabAutoCloseSetting {
  let cached: { hours: number | null } | null = null
  const path = () => join(deps.resolveUserDataDir(), FILE_NAME)
  return {
    hours() {
      if (cached) return cached.hours
      try {
        const raw: unknown = JSON.parse(readFileSync(path(), 'utf8'))
        cached = { hours: readAutoCloseHours(isRecord(raw) ? raw.afterHours : undefined) }
      } catch {
        cached = { hours: BROWSER_TAB_AUTO_CLOSE_DEFAULT_HOURS }
      }
      return cached.hours
    },
    set(hours) {
      const next = readAutoCloseHours(hours)
      if (this.hours() === next) return
      cached = { hours: next }
      try {
        writeFileAtomicSync(path(), `${JSON.stringify({ afterHours: next })}\n`)
      } catch {
        deps.log?.('The browser tab setting could not be saved; it applies until Studio quits.')
      }
    },
  }
}

export type TabAutoCloseInput = {
  now: number
  /** Hours unused before a tab is closed; null for never. */
  hours: number | null
  lastUsedAt: number
  /** When the chat's agent last worked; null when it is gone (settled, removed). */
  agentLastWorkedAt: number | null
  inView: boolean
}

/** When this tab will be closed for going unused; null when it will not be. */
export function tabClosesAt(input: Omit<TabAutoCloseInput, 'now'>): number | null {
  if (input.hours === null || input.inView) return null
  const after = input.hours * HOUR_MS
  return Math.max(input.lastUsedAt, input.agentLastWorkedAt ?? 0) + after
}

/** Whether a tab is closed now for going unused. */
export function shouldAutoCloseTab(input: TabAutoCloseInput): boolean {
  const at = tabClosesAt(input)
  return at !== null && input.now >= at
}

export type BrowserTabSweepDeps = {
  listTabs: () => BrowserTabListing[]
  close: (tabId: string) => Promise<boolean>
  setting: Pick<BrowserTabAutoCloseSetting, 'hours'>
  agentLastWorkedAt: (workspaceId: string) => number | null
  now?: () => number
  log?: (message: string) => void
}

/** Close what has gone unused, every `BROWSER_TAB_SWEEP_MS`. */
export function createBrowserTabSweep(deps: BrowserTabSweepDeps) {
  const now = deps.now ?? Date.now
  let timer: NodeJS.Timeout | null = null
  let running = false
  const sweep = async (): Promise<string[]> => {
    if (running) return []
    running = true
    try {
      const hours = deps.setting.hours()
      if (hours === null) return []
      const at = now()
      const stale = deps.listTabs().filter((tab) =>
        shouldAutoCloseTab({
          now: at,
          hours,
          lastUsedAt: tab.lastUsedAt,
          agentLastWorkedAt: deps.agentLastWorkedAt(tab.workspaceId),
          inView: tab.inView,
        }),
      )
      const closed: string[] = []
      for (const tab of stale) if (await deps.close(tab.tabId).catch(() => false)) closed.push(tab.tabId)
      if (closed.length > 0) deps.log?.(`Closed ${closed.length} browser tab(s) unused for ${hours} hours.`)
      return closed
    } finally {
      running = false
    }
  }
  return {
    sweep,
    start() {
      if (timer) return
      timer = setInterval(() => void sweep(), BROWSER_TAB_SWEEP_MS)
      timer.unref?.()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}

/** The tabs as `browserTabs.list` carries them, each with when it will be closed for going unused. */
export function listedBrowserTabs(
  tabs: readonly BrowserTabListing[],
  hours: number | null,
  agentLastWorkedAt: (workspaceId: string) => number | null,
): StudioBrowserTab[] {
  return tabs.map((tab) => {
    const closesAt = tabClosesAt({
      hours,
      lastUsedAt: tab.lastUsedAt,
      agentLastWorkedAt: agentLastWorkedAt(tab.workspaceId),
      inView: tab.inView,
    })
    return {
      tabId: tab.tabId,
      workspaceId: tab.workspaceId,
      title: tab.title.slice(0, STUDIO_BROWSER_TAB_MAX_TEXT),
      url: tab.url.slice(0, STUDIO_BROWSER_TAB_MAX_TEXT),
      openedAt: tab.openedAt,
      lastUsedAt: tab.lastUsedAt,
      audible: tab.audible,
      agentIds: tab.agentIds,
      inView: tab.inView,
      ...(closesAt === null ? {} : { closesAt }),
    }
  })
}
