import assert from 'node:assert/strict'

import type { IpcMainInvokeEvent } from 'electron'
import { test } from 'vitest'

import { SCHEDULED_AGENTS_IPC } from '../../shared/scheduled-agents'
import { registerScheduledAgentsIpc, SCHEDULED_AGENTS_OFF_MESSAGE } from './scheduled-agents-ipc'
import type { ScheduledAgentsService } from './service'

// The Schedules window's channels are registered once, whether or not the
// module is on: on, they reach its service; off, each call is refused saying so.

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function registry() {
  const handlers = new Map<string, Handler>()
  return {
    ipc: { handle: (channel: string, handler: Handler) => void handlers.set(channel, handler) },
    call: (channel: string, input?: unknown) => {
      const handler = handlers.get(channel)
      assert.ok(handler, `${channel} is registered`)
      return Promise.resolve(handler({} as IpcMainInvokeEvent, input))
    },
    channels: () => [...handlers.keys()].sort(),
  }
}

test('every Schedules channel is registered whether or not the module is on', () => {
  const { ipc, channels } = registry()
  registerScheduledAgentsIpc(ipc, { service: () => null })
  assert.deepEqual(channels(), Object.values(SCHEDULED_AGENTS_IPC).sort())
})

test('while the module is off, every call is refused saying so', async () => {
  const { ipc, call } = registry()
  registerScheduledAgentsIpc(ipc, { service: () => null })
  for (const channel of Object.values(SCHEDULED_AGENTS_IPC)) {
    await assert.rejects(call(channel, { id: 'a' }), new RegExp(SCHEDULED_AGENTS_OFF_MESSAGE))
  }
})

test('while it is on, a call reaches the service, and a read waits for the file', async () => {
  const { ipc, call } = registry()
  const asked: Array<[string, unknown[]]> = []
  let loaded = false
  const service = {
    loaded: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      loaded = true
    },
    list: () => (loaded ? [{ id: 'a' }] : []),
    pausedAll: () => (loaded ? { since: 1, until: null } : null),
    pause: async (...args: unknown[]) => {
      asked.push(['pause', args])
      return { ok: true }
    },
    update: async (...args: unknown[]) => {
      asked.push(['update', args])
      return { ok: true }
    },
    markFailureSeen: async (...args: unknown[]) => {
      asked.push(['markFailureSeen', args])
    },
    pauseAll: async (...args: unknown[]) => {
      asked.push(['pauseAll', args])
      return { ok: true }
    },
  } as unknown as ScheduledAgentsService
  let on = false
  registerScheduledAgentsIpc(ipc, { service: () => (on ? service : null) })

  await assert.rejects(call(SCHEDULED_AGENTS_IPC.list), /switched off/)
  on = true
  assert.deepEqual(await call(SCHEDULED_AGENTS_IPC.list), [{ id: 'a' }], 'the list is read after the file')
  assert.deepEqual(await call(SCHEDULED_AGENTS_IPC.pauseState), { since: 1, until: null })
  await call(SCHEDULED_AGENTS_IPC.pause, { id: 'a' })
  await call(SCHEDULED_AGENTS_IPC.update, { id: 'a', draft: { prompt: 'hi' } })
  assert.deepEqual(await call(SCHEDULED_AGENTS_IPC.markSeen, { id: 'a' }), { ok: true })
  await call(SCHEDULED_AGENTS_IPC.pauseAll, { until: 5 })
  await call(SCHEDULED_AGENTS_IPC.pauseAll, 'junk')
  assert.deepEqual(asked, [
    ['pause', ['a']],
    ['update', ['a', { prompt: 'hi' }]],
    ['markFailureSeen', ['a']],
    ['pauseAll', [5]],
    ['pauseAll', [null]],
  ])
})
