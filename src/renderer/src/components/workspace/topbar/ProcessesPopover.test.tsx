// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'

import type { StudioAgentProcess, StudioBrowserTab } from '../../../../../../packages/studio-protocol/src/public'
import { OverlaySurfaceContext } from '../../ui'
import { ProcessesPopover } from './ProcessesPopover'
import { chatLabel, durationWords, groupProcesses, portsWords, type KnownChat } from './processesModel'
import { processesRowCounts, type ProcessesView } from './useProcesses'

// The Processes list: programs by the chat that started them, the built-in
// browser's tabs with whether each is making sound, and what Stop and Close
// send.

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOW = Date.now()
const DAY = 24 * 60 * 60_000

const row = (over: Partial<StudioAgentProcess> = {}): StudioAgentProcess => ({
  id: '4242-1700000000',
  pid: 4242,
  startedAt: NOW - 9 * DAY,
  name: 'Vite dev server',
  kind: 'server',
  command: 'node /Users/dev/app/node_modules/.bin/vite --port 5173',
  ports: [5173],
  memoryBytes: 45 * 1024 * 1024,
  childCount: 1,
  state: 'left-behind',
  agentRunning: false,
  workspaceId: 'ws-1',
  agentId: 'agent-1',
  ...over,
})

const tab = (over: Partial<StudioBrowserTab> = {}): StudioBrowserTab => ({
  tabId: 'tab-1',
  workspaceId: 'ws-1',
  title: 'Space game',
  url: 'http://localhost:5173/',
  openedAt: NOW - 7 * DAY,
  lastUsedAt: NOW - 7 * DAY,
  audible: true,
  agentIds: [],
  inView: false,
  ...over,
})

const CHATS = new Map<string, KnownChat>([['ws-1', { name: 'Website', agents: { 'agent-1': { name: 'Builder' } } }]])

test('rows are grouped by chat, named from what the window knows, and a closed chat is said in words', () => {
  const groups = groupProcesses(
    [
      row({ id: '1-1', startedAt: NOW - DAY, state: 'with-agent' }),
      row({ id: '2-1', workspaceId: 'ws-gone', agentId: 'agent-9' }),
      row({ id: '3-1' }),
    ],
    CHATS,
  )
  expect(groups.map((group) => [group.label, group.rows.map((entry) => entry.id), group.leftBehind.length])).toEqual([
    ['Website · Builder', ['1-1', '3-1'], 1],
    ['Chat no longer open', ['2-1'], 1],
  ])
  expect(chatLabel('ws-1', undefined, CHATS).label).toBe('Website')
  expect(durationWords(9 * DAY + 5_000)).toBe('9 days')
  expect(durationWords(90 * 60_000)).toBe('1 hour')
  expect(durationWords(10_000)).toBe('1 minute')
  expect(portsWords([5173, 5174])).toBe(':5173 :5174')
})

test('the account row counts what was left behind first, then what is playing sound', () => {
  const view: ProcessesView = {
    offered: true,
    loaded: true,
    processes: [row(), row({ id: '9-9', state: 'with-agent' })],
    tabs: [tab(), tab({ tabId: 'tab-2', audible: false })],
    unavailable: null,
  }
  expect(processesRowCounts(view)).toEqual({ leftBehind: 1, playing: 1, total: 4 })
})

let root: Root | null = null
let host: HTMLElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

function render(view: ProcessesView, calls: { stopped: string[][]; closed: string[] }) {
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  act(() =>
    root!.render(
      <OverlaySurfaceContext.Provider value={true}>
        <ProcessesPopover
          view={view}
          chats={CHATS}
          onStop={async (ids) => {
            calls.stopped.push([...ids])
            return { notStopped: 0 }
          }}
          onCloseTab={async (tabId) => {
            calls.closed.push(tabId)
            return true
          }}
        />
      </OverlaySurfaceContext.Provider>,
    ),
  )
  return host
}

test('each row says its state and age in words, and Stop, Stop all and Close send what they name', async () => {
  const calls = { stopped: [] as string[][], closed: [] as string[] }
  const view: ProcessesView = {
    offered: true,
    loaded: true,
    processes: [row(), row({ id: '5-5', pid: 5, name: 'Headless Chrome', kind: 'browser', ports: [] })],
    tabs: [tab()],
    unavailable: null,
  }
  const el = render(view, calls)
  const text = el.textContent ?? ''
  expect(text).toContain('Browser tabs')
  expect(text).toContain('Playing sound')
  expect(text).toContain('Website · Builder')
  expect(text).toContain('Left behind')
  expect(text).toContain(':5173')
  expect(text).toContain('running 9 days')
  expect(el.querySelector('[data-browser-tab-row="tab-1"]')?.getAttribute('data-audible')).toBe('true')

  const button = (label: string) =>
    [...el.querySelectorAll('button')].find((candidate) => candidate.getAttribute('aria-label') === label) ??
    [...el.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label)
  await act(async () => button('Close Space game')!.click())
  expect(calls.closed).toEqual(['tab-1'])
  await act(async () => button('Stop Headless Chrome')!.click())
  expect(calls.stopped).toEqual([['5-5']])
  await act(async () => button('Stop all left behind')!.click())
  expect(calls.stopped[1]?.sort()).toEqual(['4242-1700000000', '5-5'])
})

test('on Windows the list says it is not available yet, and nothing reads as empty', () => {
  const el = render(
    { offered: true, loaded: true, processes: [], tabs: [], unavailable: 'platform' },
    { stopped: [], closed: [] },
  )
  expect(el.textContent).toContain('Not available on Windows yet')
})
