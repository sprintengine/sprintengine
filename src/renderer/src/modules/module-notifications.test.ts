import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { ModuleNotificationDelivery } from '../../../shared/modules/notifications'
import type { DiagnosticLogEntry } from '../../../shared/workspace'
import { moduleNotificationEntry, startModuleNotificationIngest } from './module-notifications'

function delivery(over: Partial<ModuleNotificationDelivery> = {}): ModuleNotificationDelivery {
  return {
    id: 'k1-1',
    sourceModuleId: 'acme.radar',
    sourceModuleName: 'PR Radar',
    severity: 'warning',
    title: 'Changes requested on acme/app#12',
    emittedAt: Date.UTC(2026, 9, 9, 12, 0, 0),
    ...over,
  }
}

test('a delivery becomes a bell row under the stamped module identity', () => {
  const entry = moduleNotificationEntry(
    delivery({ body: 'Two comments.', target: { surfaceId: 'radar', viewId: 'activity' } }),
  )
  assert.deepEqual(entry, {
    id: 'module:k1-1',
    timestamp: '2026-10-09T12:00:00.000Z',
    level: 'warning',
    source: 'module',
    title: 'Changes requested on acme/app#12',
    message: 'Two comments.',
    sourceModule: { id: 'acme.radar', name: 'PR Radar' },
    surfaceTarget: { surfaceId: 'acme.radar:radar', viewId: 'activity' },
    extensionsRow: 'acme.radar:radar',
  })
  const bare = moduleNotificationEntry(delivery())
  assert.equal(bare.message, '', 'no body is an empty message, never undefined')
  assert.equal(bare.surfaceTarget, undefined)
  assert.equal(bare.extensionsRow, undefined, 'an untargeted row names no drawer row itself')
})

test('an extension names its door by its extension.json id; a built-in module names its surface as it is', () => {
  const extension = moduleNotificationEntry(delivery({ target: { surfaceId: 'board' } }))
  assert.deepEqual(extension.surfaceTarget, { surfaceId: 'acme.radar:board' }, 'filed under the extension’s key')
  assert.equal(extension.extensionsRow, 'acme.radar:board')
  const builtIn = moduleNotificationEntry(
    delivery({ sourceModuleId: 'backlog', sourceModuleName: 'Backlog', target: { surfaceId: 'backlog' } }),
  )
  assert.deepEqual(
    builtIn.surfaceTarget,
    { surfaceId: 'backlog' },
    'a module id that is no install key is not rewritten',
  )
  assert.equal(builtIn.extensionsRow, 'backlog')
})

test('kept rows and live rows from the stream are filed once each, across a resend; junk is ignored', () => {
  const filed = new Map<string, DiagnosticLogEntry>()
  let push: ((notification: unknown) => void) | null = null
  let unsubscribed = false
  const stop = startModuleNotificationIngest({
    subscribe: (cb) => {
      push = cb
      return () => {
        unsubscribed = true
      }
    },
    file: (id, entry) => {
      if (filed.has(id)) return false
      filed.set(id, entry)
      return true
    },
  })
  // The kept rows first, then a live one, then the kept rows again (a reconnect).
  push!(delivery({ id: 'k1-0', title: 'Failed to load' }))
  push!(delivery())
  push!({ nonsense: true })
  push!(delivery({ id: 'k1-0', title: 'Failed to load' }))
  push!(delivery())
  assert.deepEqual([...filed.keys()], ['k1-0', 'k1-1'], 'each row once, in the order the stream sent them')
  stop()
  assert.equal(unsubscribed, true)
  push!(delivery({ id: 'k1-2' }))
  assert.equal(filed.has('k1-2'), false, 'nothing is filed after stopping')
})
