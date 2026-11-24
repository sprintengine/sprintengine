import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import type { BrowserTabListing } from './browser-manager'
import {
  BROWSER_TAB_AUTO_CLOSE_DEFAULT_HOURS,
  createBrowserTabAutoCloseSetting,
  createBrowserTabSweep,
  listedBrowserTabs,
  shouldAutoCloseTab,
  tabClosesAt,
} from './browser-tab-auto-close'

// Which built-in browser tabs are closed for going unused, and the setting
// that says after how long.

const HOUR = 60 * 60_000
const NOW = Date.UTC(2026, 10, 24, 12)

test('a tab closes once both it and its agent have been idle for the setting’s time', () => {
  const base = { now: NOW, hours: 24, inView: false }
  // Unused a day and more, agent quiet as long: closed.
  assert.equal(shouldAutoCloseTab({ ...base, lastUsedAt: NOW - 25 * HOUR, agentLastWorkedAt: NOW - 30 * HOUR }), true)
  // Exactly a day is a day.
  assert.equal(shouldAutoCloseTab({ ...base, lastUsedAt: NOW - 24 * HOUR, agentLastWorkedAt: NOW - 24 * HOUR }), true)
  // Used an hour ago: kept.
  assert.equal(shouldAutoCloseTab({ ...base, lastUsedAt: NOW - HOUR, agentLastWorkedAt: NOW - 30 * HOUR }), false)
  // The agent worked an hour ago: kept, though the tab itself is old.
  assert.equal(shouldAutoCloseTab({ ...base, lastUsedAt: NOW - 50 * HOUR, agentLastWorkedAt: NOW - HOUR }), false)
  // The agent is gone (settled, removed): the tab's own clock decides.
  assert.equal(shouldAutoCloseTab({ ...base, lastUsedAt: NOW - 25 * HOUR, agentLastWorkedAt: null }), true)
  assert.equal(shouldAutoCloseTab({ ...base, lastUsedAt: NOW - 2 * HOUR, agentLastWorkedAt: null }), false)
})

test('the tab in front of the person, and every tab with the setting at Never, stays open', () => {
  const stale = { now: NOW, lastUsedAt: NOW - 100 * HOUR, agentLastWorkedAt: null }
  assert.equal(shouldAutoCloseTab({ ...stale, hours: 24, inView: true }), false)
  assert.equal(shouldAutoCloseTab({ ...stale, hours: null, inView: false }), false)
  assert.equal(tabClosesAt({ hours: null, lastUsedAt: 0, agentLastWorkedAt: null, inView: false }), null)
  assert.equal(tabClosesAt({ hours: 4, lastUsedAt: NOW, agentLastWorkedAt: NOW - HOUR, inView: false }), NOW + 4 * HOUR)
})

test('the setting reads a day by default, keeps only the offered choices, and survives a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tab-auto-close-'))
  const setting = () => createBrowserTabAutoCloseSetting({ resolveUserDataDir: () => dir })
  assert.equal(setting().hours(), BROWSER_TAB_AUTO_CLOSE_DEFAULT_HOURS)
  setting().set(null)
  assert.equal(setting().hours(), null)
  setting().set(72)
  assert.equal(setting().hours(), 72)
  const odd = setting()
  odd.set(5)
  assert.equal(odd.hours(), BROWSER_TAB_AUTO_CLOSE_DEFAULT_HOURS)
  writeFileSync(join(dir, 'browser-tab-auto-close.json'), '{"afterHours":"soon"}')
  assert.equal(setting().hours(), BROWSER_TAB_AUTO_CLOSE_DEFAULT_HOURS)
})

function tab(tabId: string, workspaceId: string, lastUsedAt: number, extra: Partial<BrowserTabListing> = {}) {
  return {
    tabId,
    workspaceId,
    title: 'Game',
    url: 'http://localhost:5173/',
    openedAt: lastUsedAt,
    lastUsedAt,
    audible: false,
    agentIds: [],
    inView: false,
    ...extra,
  } satisfies BrowserTabListing
}

test('a sweep closes only what has gone unused, and nothing while the setting is Never', async () => {
  const tabs = [
    tab('old', 'ws-gone', NOW - 48 * HOUR, { audible: true }),
    tab('fresh', 'ws-gone', NOW - HOUR),
    tab('busy', 'ws-busy', NOW - 48 * HOUR),
    tab('watched', 'ws-gone', NOW - 48 * HOUR, { inView: true }),
  ]
  const closed: string[] = []
  let hours: number | null = 24
  const sweep = createBrowserTabSweep({
    listTabs: () => tabs,
    close: async (tabId) => {
      closed.push(tabId)
      return true
    },
    setting: { hours: () => hours },
    agentLastWorkedAt: (workspaceId) => (workspaceId === 'ws-busy' ? NOW - 10 * 60_000 : null),
    now: () => NOW,
  })
  assert.deepEqual(await sweep.sweep(), ['old'])
  assert.deepEqual(closed, ['old'])
  hours = null
  assert.deepEqual(await sweep.sweep(), [])
})

test('listed tabs carry when each will close, and none for the one in view', () => {
  const listed = listedBrowserTabs(
    [tab('a', 'ws', NOW - HOUR), tab('b', 'ws', NOW - HOUR, { inView: true, title: 'x'.repeat(5000) })],
    24,
    () => NOW - 2 * HOUR,
  )
  assert.equal(listed[0]!.closesAt, NOW + 23 * HOUR)
  assert.equal('closesAt' in listed[1]!, false)
  assert.equal(listed[1]!.title.length, 2048)
})
