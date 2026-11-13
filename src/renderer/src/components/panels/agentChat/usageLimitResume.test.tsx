// @vitest-environment jsdom
//
// A chat a usage limit stopped: the tray row says which limit and when it
// resets, offers Resume at reset, Dismiss and the setting; with a resume
// scheduled it says when it goes out, and Cancel takes it back.
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import type { UsageLimitResumeNotice } from '../../../../../shared/usage-limit-resume'
import { formatResumeClock, UsageLimitNoticeRow, usageLimitResumeWords } from './usageLimitResume'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
// 21:27 local today, so a reset two hours on is still today, and one a few days on is not.
const NOW = new Date(2026, 9, 7, 21, 27, 0).getTime()

function notice(overrides: Partial<UsageLimitResumeNotice> = {}): UsageLimitResumeNotice {
  return {
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    provider: 'claude',
    limit: 'session',
    resetsAt: NOW + 2 * HOUR + 13 * MINUTE + 30_000,
    hitAt: NOW - MINUTE,
    resumeAt: null,
    ...overrides,
  }
}

// The rows read the real clock, so what they draw is set against it.
const LIVE = Date.now()
const live = (overrides: Partial<UsageLimitResumeNotice> = {}) =>
  notice({ resetsAt: LIVE + 2 * HOUR, hitAt: LIVE - MINUTE, ...overrides })

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function render(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(node))
  return host
}

const buttons = (element: HTMLElement) => [...element.querySelectorAll('button')].map((button) => button.textContent)

async function click(element: HTMLElement, label: string) {
  const button = [...element.querySelectorAll('button')].find((candidate) => candidate.textContent === label)!
  await act(async () => button.click())
}

test('the notice names the limit and says when it resets, or when the chat resumes', () => {
  expect(usageLimitResumeWords(notice(), NOW)).toBe(
    `Claude's session limit is used up. It resets at ${clock(notice().resetsAt!)} (in 2h 13m).`,
  )
  const resumeAt = NOW + 2 * HOUR + 15 * MINUTE
  expect(usageLimitResumeWords(notice({ resumeAt, provider: 'codex', limit: 'weekly' }), NOW)).toBe(
    `Codex's weekly limit is used up. Resumes at ${clock(resumeAt)} (in 2h 15m).`,
  )
  expect(usageLimitResumeWords(notice({ limit: null, resetsAt: null }), NOW)).toBe(
    "Claude's usage limit is used up. It did not say when it resets.",
  )
})

test('a reset on another day names the day', () => {
  expect(formatResumeClock(NOW + HOUR, NOW)).toBe(clock(NOW + HOUR))
  expect(formatResumeClock(NOW + 3 * 24 * HOUR, NOW)).toMatch(new RegExp(`^\\S+ ${clock(NOW + 3 * 24 * HOUR)}$`))
  expect(formatResumeClock(NOW + 9 * 24 * HOUR, NOW)).toMatch(new RegExp(`, ${clock(NOW + 9 * 24 * HOUR)}$`))
})

// The row as a chat draws it from what its server says of it (`usageLimits`):
// each button asks the server, which sends the resume.
async function renderRow(said: Partial<UsageLimitResumeNotice> | null, autoResume = false) {
  const acts: Array<[string, boolean | undefined]> = []
  const row = await render(
    <UsageLimitNoticeRow
      notice={said ? live(said) : null}
      autoResume={autoResume}
      onAct={(action, always) => acts.push([action, always])}
    />,
  )
  return { row, acts }
}

test('a chat a limit stopped offers Resume at reset, Dismiss and the setting, and each asks its server', async () => {
  const { row, acts } = await renderRow({})
  expect(row.textContent).toMatch(/^Claude's session limit is used up\. It resets at /)
  expect(buttons(row)).toEqual(['Always resume at reset', 'Resume at reset', 'Dismiss'])
  await click(row, 'Resume at reset')
  await click(row, 'Dismiss')
  await click(row, 'Always resume at reset')
  expect(acts).toEqual([
    ['schedule', undefined],
    ['dismiss', undefined],
    ['schedule', true],
  ])
})

test('with the setting on the link is not offered; with no reset known nothing can be scheduled', async () => {
  const { row } = await renderRow({ resetsAt: null }, true)
  expect(buttons(row)).toEqual(['Dismiss'])
})

test('a scheduled resume says when it goes out, and Cancel takes it back', async () => {
  const { row, acts } = await renderRow({ resumeAt: LIVE + 2 * HOUR + 2 * MINUTE }, true)
  expect(row.textContent).toMatch(/ Resumes at /)
  expect(buttons(row)).toEqual(['Cancel'])
  await click(row, 'Cancel')
  expect(acts).toEqual([['cancel', undefined]])
})

test('no notice, or one whose limit has reset with nothing scheduled, draws nothing', async () => {
  expect((await renderRow(null)).row.textContent).toBe('')
  await act(async () => root?.unmount())
  host?.remove()
  expect((await renderRow({ resetsAt: LIVE - MINUTE })).row.textContent).toBe('')
})

test('a resume the chat refused says why, with Retry, even after the limit has reset', async () => {
  const { row, acts } = await renderRow(
    { resetsAt: LIVE - MINUTE, failure: 'The chat has no folder on this machine' },
    true,
  )
  expect(row.textContent).toMatch(/^Couldn't resume: the chat has no folder on this machine\./)
  expect(buttons(row)).toEqual(['Retry', 'Dismiss'])
  await click(row, 'Retry')
  expect(acts).toEqual([['retry', undefined]])
})
