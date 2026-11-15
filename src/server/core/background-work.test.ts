// The work a server does on its own, as the idle rule, the WSL servers' idle
// stop and the quit question read it.
import assert from 'node:assert/strict'
import { test } from 'vitest'

import { backgroundWorkOf, hasBackgroundWork, parseBackgroundWork, quitStopsOf } from './background-work'

function core(over: { upcoming?: unknown[]; watches?: unknown[]; messages?: unknown[]; notices?: unknown[] } = {}) {
  return {
    scheduledAgents: { upcoming: () => over.upcoming ?? [] },
    pullRequests: {
      record: {
        watches: () => over.watches ?? [],
        forConversation: () => [{ url: 'https://github.com/acme/app/pull/7', title: 'Fix the login', number: 7 }],
      },
    },
    scheduledMessages: { state: () => ({ messages: over.messages ?? [] }) },
    usageLimitResumes: { state: () => ({ autoResume: false, notices: over.notices ?? [] }) },
  } as never
}

test('a server with nothing of its own to do has no background work', () => {
  const work = backgroundWorkOf(core())
  assert.deepEqual(work, { schedules: [], watches: [], messages: 0, resumes: 0 })
  assert.equal(hasBackgroundWork(work), false)
})

test('a schedule to run, a watch, a message to send or a resume set is work, named where it can be', () => {
  const work = backgroundWorkOf(
    core({
      upcoming: [{ id: 'sa-1', prompt: 'Nightly triage', nextRunAt: 5 }],
      watches: [{ url: 'https://github.com/acme/app/pull/7', conversation: { workspaceId: 'ws', agentId: 'a' } }],
      messages: [{ id: 'm1' }, { id: 'm2', failure: 'The chat is gone.' }],
      notices: [{ resumeAt: 9 }, { resumeAt: null }],
    }),
  )
  assert.deepEqual(work, {
    schedules: [{ id: 'sa-1', title: 'Nightly triage', nextRunAt: 5 }],
    watches: [{ url: 'https://github.com/acme/app/pull/7', title: 'Fix the login' }],
    messages: 1,
    resumes: 1,
  })
  assert.equal(hasBackgroundWork(work), true)
  assert.equal(hasBackgroundWork({ schedules: [], watches: [], messages: 0, resumes: 1 }), true)
})

test('what another process sends is read leniently; an older build refusing the channel is none', () => {
  assert.equal(parseBackgroundWork(null), null)
  assert.equal(parseBackgroundWork('nope'), null)
  assert.deepEqual(
    parseBackgroundWork({ schedules: [{ id: 'a', title: 'A', nextRunAt: 1 }, { id: 2 }], watches: 'x', messages: -1 }),
    { schedules: [{ id: 'a', title: 'A', nextRunAt: 1 }], watches: [], messages: 0, resumes: 0 },
  )
})

test('the quit question names this machine’s schedules and watches, and each WSL server’s by its distribution', () => {
  const local = {
    schedules: [{ id: 'a', title: 'Nightly triage', nextRunAt: 1 }],
    watches: [],
    messages: 0,
    resumes: 0,
  }
  const wsl = [
    {
      distro: 'Ubuntu',
      work: { schedules: [], watches: [{ url: 'u', title: 'Fix the login' }], messages: 0, resumes: 0 },
    },
  ]
  assert.deepEqual(quitStopsOf(local, wsl), {
    schedules: ['Nightly triage'],
    watches: ['Fix the login (WSL: Ubuntu)'],
  })
})
