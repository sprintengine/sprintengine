import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { StudioSchedule } from '../../../../packages/studio-protocol/src/public'
import type { StudioSchedulesDomain } from '../../../server/schedules/schedules-domain'
import type { TailnetScope } from '../../../shared/tailnet'
import {
  createPairedScheduledAgent,
  pairedScheduledAgentAction,
  pairedScheduledAgents,
  scheduledAgentViewOf,
  updatePairedScheduledAgent,
} from '../../../renderer/src/studio/pairedSchedules'
import type { MeshScheduledAgentAction } from '../../../shared/tailnet-mesh'
import { pairedWindow } from '../../../../tests/paired-window'
import { deviceRig } from './tailnet-studio.test-helper'
import type { StudioChatBackend } from '../../../server/rpc/studio-rpc-types'

// A paired machine's scheduled agents, driven by this desktop's window over its
// own client of that machine's Studio's
// `schedules.*`: listed, run, paused, resumed and closed, made there with
// what this door would have scheduled here, and saved from this editor whole.
// A machine whose Studio does not serve them is told to update.

const listed: StudioSchedule = {
  id: 'sa-1',
  name: 'Morning triage',
  prompt: 'Triage new issues',
  schedule: { cron: '0 9 * * 1-5', timezone: 'Europe/London' },
  folderPath: '/Users/dev/app',
  hostId: 'wsl:Ubuntu',
  cli: 'claude-code',
  cliModel: null,
  permissionPreset: 'auto',
  skills: [{ id: 'gh-triage', name: 'GitHub triage' }],
  mcpServers: [],
  worktree: { name: '' },
  ownerModuleId: null,
  createdAt: 1_000,
  updatedAt: 2_000,
  lastRun: { at: 3_000, ok: false, message: 'The CLI is not installed.' },
  lastFailureSeenAt: null,
  pausedAt: Date.parse('2026-10-05T08:00:00.000Z'),
  nextRunAt: null,
  waiting: 'Codex is not signed in on build-box',
  scheduleWords: 'Weekdays at 9:00 AM',
}

type Call = { method: string; params: unknown }

/** What the machine's Studio is asked, and its answers: the list above, and that row for every change. */
function fakeSchedules(calls: Call[]): StudioSchedulesDomain {
  const one = async (method: string, params: unknown) => {
    calls.push({ method, params })
    return { ok: true as const, value: listed }
  }
  return {
    list: () => {
      calls.push({ method: 'list', params: {} })
      return { schedules: [listed, { id: 'broken' } as unknown as StudioSchedule], pausedAll: null }
    },
    create: (draft) => one('create', draft),
    update: (change) => one('update', change),
    pause: (id) => one('pause', id),
    resume: (id) => one('resume', id),
    runNow: async (id) => {
      calls.push({ method: 'runNow', params: id })
      return { ok: true, value: { workspaceId: 'ws-run' } }
    },
    remove: async (id) => {
      calls.push({ method: 'remove', params: id })
      return { ok: true, value: { removed: id } }
    },
    markSeen: (id) => one('markSeen', id),
    pauseAll: async () => ({ ok: true, value: { pausedAll: { since: 1, until: null } } }),
    resumeAll: async () => ({ ok: true, value: { pausedAll: null } }),
    onChanged: () => () => undefined,
  }
}

async function pairedMachine(options: { serves?: boolean; scopes?: TailnetScope[] } = {}) {
  const calls: Call[] = []
  // That machine knows its project's folder, as its chat surface says it: what starts a schedule is held to it.
  const knows = { isKnownFolder: async (path: string) => path === '/Users/dev/app' } as unknown as StudioChatBackend
  const peer = await deviceRig(options.serves === false ? {} : { schedules: fakeSchedules(calls), chat: knows })
  const window = await pairedWindow(peer, options.scopes ?? ['workspace:read', 'workspace:operate'])
  return {
    machine: window.machine,
    calls,
    async close() {
      await window.close()
      await peer.dispose()
    },
  }
}

test('A paired machine’s schedules read back as this machine’s own list does', async () => {
  const machine = await pairedMachine()
  try {
    const answer = await pairedScheduledAgents(machine.machine)
    assert.ok(answer.ok, answer.ok ? '' : answer.message)
    assert.equal(answer.canCreate, true)
    assert.equal(answer.pausedAll, null)
    assert.equal(answer.agents.length, 1, 'a row it cannot read is left out')
    const [agent] = answer.agents
    assert.equal(agent!.name, 'Morning triage')
    assert.equal(agent!.pausedAt, Date.parse('2026-10-05T08:00:00.000Z'))
    assert.equal(agent!.nextRunAt, null)
    assert.equal(agent!.waiting, 'Codex is not signed in on build-box', 'why it waits, in that machine’s words')
    assert.equal(agent!.hostId, null, 'a machine there names nothing here')
    assert.deepEqual(agent!.lastRun, { at: 3_000, ok: false, message: 'The CLI is not installed.' })
  } finally {
    await machine.close()
  }
})

test('Run, pause, resume and close are the machine’s own schedule methods', async () => {
  const machine = await pairedMachine()
  try {
    for (const action of ['run', 'pause', 'resume', 'delete'] as const) {
      const answer = await pairedScheduledAgentAction(machine.machine, 'sa-1', action)
      assert.deepEqual(answer, { ok: true, id: 'sa-1', action })
    }
    assert.deepEqual(
      machine.calls.map((call) => call.method),
      // What starts a schedule reads where it runs first, to hold it to the folders the asker may name.
      ['list', 'runNow', 'pause', 'list', 'resume', 'remove'],
    )
    const unknown = await pairedScheduledAgentAction(machine.machine, 'sa-1', 'edit' as MeshScheduledAgentAction)
    assert.equal(!unknown.ok && unknown.code, 'invalid_arguments')
  } finally {
    await machine.close()
  }
})

test('A schedule is made there with what this door would have scheduled here', async () => {
  const machine = await pairedMachine()
  try {
    const once = Date.parse('2026-11-02T15:30:00.000Z')
    const answer = await createPairedScheduledAgent(machine.machine, {
      workspaceId: 'ws-seat',
      prompt: '  Check the deploy  ',
      cron: '30 15 2 11 *',
      timezone: 'UTC',
      once,
      cli: 'claude-code',
      model: null,
      permissionPreset: 'auto',
      worktreeName: '',
      skills: ['gh-triage'],
      mcpServers: [],
    })
    assert.ok(answer.ok, answer.ok ? '' : answer.message)
    assert.equal(answer.agent.id, 'sa-1')
    assert.deepEqual(machine.calls, [
      {
        method: 'create',
        params: {
          workspaceId: 'ws-seat',
          prompt: 'Check the deploy',
          cron: '30 15 2 11 *',
          timezone: 'UTC',
          once,
          cli: 'claude-code',
          permissionPreset: 'auto',
          worktree: true,
          skills: ['gh-triage'],
        },
      },
    ])
  } finally {
    await machine.close()
  }
})

test('A schedule there is saved from this editor on its `schedules.update`, whole', async () => {
  const machine = await pairedMachine()
  try {
    const answer = await updatePairedScheduledAgent(machine.machine, {
      id: 'sa-1',
      prompt: ' Triage new issues, then label them ',
      cron: '0 9 * * 1-5',
      timezone: 'Europe/London',
      cli: 'claude-code',
      model: null,
      permissionPreset: 'auto',
      worktreeName: null,
      skills: [],
      mcpServers: [],
    })
    assert.ok(answer.ok, answer.ok ? '' : answer.message)
    assert.deepEqual(machine.calls, [
      {
        method: 'update',
        params: {
          id: 'sa-1',
          prompt: 'Triage new issues, then label them',
          cron: '0 9 * * 1-5',
          timezone: 'Europe/London',
          cli: 'claude-code',
          permissionPreset: 'auto',
          // What the editor took off is taken off there, not kept.
          model: '',
          worktree: false,
          skills: [],
          mcpServers: [],
        },
      },
    ])
  } finally {
    await machine.close()
  }
})

test('A machine whose Studio does not serve schedules is told to update, and a read-only pairing changes none', async () => {
  const older = await pairedMachine({ serves: false })
  const reader = await pairedMachine({ scopes: ['workspace:read'] })
  try {
    const listedThere = await pairedScheduledAgents(older.machine)
    assert.equal(!listedThere.ok && listedThere.code, 'scheduled_agents_unsupported')
    const refused = await createPairedScheduledAgent(older.machine, {
      workspaceId: 'ws-seat',
      prompt: 'x',
      cron: '0 9 * * *',
      timezone: 'UTC',
      cli: 'claude-code',
    })
    assert.equal(!refused.ok && refused.code, 'scheduled_agents_unsupported')

    assert.ok((await pairedScheduledAgents(reader.machine)).ok)
    const run = await pairedScheduledAgentAction(reader.machine, 'sa-1', 'run')
    assert.equal(!run.ok && run.code, 'scope_required')
    assert.deepEqual(
      reader.calls.map((call) => call.method),
      ['list'],
    )
  } finally {
    await older.close()
    await reader.close()
  }
})

test('A row without what it needs is not a schedule', () => {
  assert.equal(scheduledAgentViewOf({ id: 'x', prompt: 'p' }), null)
  assert.equal(scheduledAgentViewOf({ prompt: 'p', schedule: { cron: '* * * * *' } }), null)
  assert.ok(scheduledAgentViewOf({ id: 'x', prompt: 'p', schedule: { cron: '* * * * *' } }))
})
