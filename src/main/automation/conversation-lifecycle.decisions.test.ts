import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { WorkspaceRegistryActor, WorkspaceRegistryRecord } from '../../shared/workspace-registry'
import { applyWorkspaceFieldsPatch, type WorkspaceFieldsPatch } from '../../shared/workspace-sync'
import { chatRestSeen, workspaceLifecycleSnapshot } from '../../shared/workspace-lifecycle'
import { createConversationLifecycle } from './conversation-lifecycle'

// Every decision about a chat's rest is main's, taken on the reading of the
// chat it was made on: one made on a chat that has moved on since is refused,
// and the clock that stamps it is main's, read as it lands.

const DAY = 24 * 60 * 60 * 1000
const BORN = 1_000_000_000_000

function fixture(record: Partial<WorkspaceRegistryRecord> = {}, options: { working?: boolean } = {}) {
  const stored = {
    id: 'ws-1',
    name: 'Fix the login',
    mode: 'standard',
    createdAt: BORN,
    autoSettleEnabled: true,
    ...record,
  } as WorkspaceRegistryRecord
  const writes: Array<{ patch: WorkspaceFieldsPatch; actor: WorkspaceRegistryActor }> = []
  let clock = BORN + 10 * DAY
  const lifecycle = createConversationLifecycle({
    getRecord: (workspaceId) => (workspaceId === stored.id ? stored : null),
    updateWorkspaceFields: (_workspaceId, patch, actor) => {
      writes.push({ patch, actor })
      applyWorkspaceFieldsPatch(stored as unknown as Record<string, unknown>, patch)
      return { ok: true, event: {} as never }
    },
    rewindVisit: () => assert.fail('nothing here moves the visit clock'),
    isWorking: () => options.working === true,
    now: () => clock,
  })
  return {
    stored,
    writes,
    lifecycle,
    snapshot: () => workspaceLifecycleSnapshot(stored),
    seen: () => chatRestSeen(stored, clock),
    advance: (ms: number) => {
      clock += ms
    },
    now: () => clock,
  }
}

test('a sweep settle lands with the clock read as it lands, as Studio, and records no hand decision', () => {
  const f = fixture()
  const snapshot = f.snapshot()
  f.advance(5_000)
  const result = f.lifecycle.applySweepDecision({ workspaceId: 'ws-1', decision: 'settle', snapshot })
  assert.deepEqual(result, { ok: true, workspaceId: 'ws-1', settledAt: f.now() })
  assert.equal(f.stored.settledAt, f.now(), 'stamped with main’s clock at commit, not the decider’s')
  assert.equal(f.stored.settledOverride, null)
  assert.equal(f.writes[0]?.actor, 'system')
})

test('a sweep decision taken on a chat that has changed since is refused', () => {
  const f = fixture()
  const snapshot = f.snapshot()
  // A message lands between the reading and the commit.
  f.stored.lastUserMessageAt = f.now()
  const result = f.lifecycle.applySweepDecision({ workspaceId: 'ws-1', decision: 'settle', snapshot })
  assert.equal(result.ok === false && result.code, 'stale')
  assert.equal(f.writes.length, 0, 'nothing is written')

  // So is one whose rest moved meanwhile: a hand Settle made between.
  const g = fixture()
  const before = g.snapshot()
  g.lifecycle.settle('ws-1', true, 'ui')
  const woke = g.lifecycle.applySweepDecision({ workspaceId: 'ws-1', decision: 'wake', snapshot: before })
  assert.equal(woke.ok === false && woke.code, 'stale')
  assert.equal(typeof g.stored.settledAt, 'number', 'the hand Settle stands')
})

test('a sweep settle is refused for a chat a hand decision, a star, a snooze or the switch has taken out of reach', () => {
  const cases: Array<[string, Partial<WorkspaceRegistryRecord>]> = [
    ['held active by an Un-settle', { settledOverride: 'active' }],
    ['starred', { highlight: { starred: true, color: null } }],
    ['asleep', { snoozedUntil: BORN + 20 * DAY }],
    ['switched off', { autoSettleEnabled: null }],
  ]
  for (const [why, record] of cases) {
    const f = fixture(record)
    const result = f.lifecycle.applySweepDecision({ workspaceId: 'ws-1', decision: 'settle', snapshot: f.snapshot() })
    assert.equal(result.ok === false && result.code, 'not_applicable', why)
    assert.equal(f.writes.length, 0, why)
  }
})

test('a sweep wake of a chat already awake writes nothing, so a repeated decision is harmless', () => {
  const f = fixture()
  const result = f.lifecycle.applySweepDecision({ workspaceId: 'ws-1', decision: 'wake', snapshot: f.snapshot() })
  assert.deepEqual(result, { ok: true, workspaceId: 'ws-1', settledAt: null })
  assert.equal(f.writes.length, 0)
})

test('a wake while resting spends the kept snooze: activity, or a snooze woken by hand', () => {
  const f = fixture({ snoozedUntil: BORN + 12 * DAY })
  f.lifecycle.settle('ws-1', true, 'ui')
  f.lifecycle.snooze('ws-1', null, 'mobile')
  f.lifecycle.settle('ws-1', false, 'ui')
  assert.equal(f.stored.snoozedUntil ?? null, null, 'a snooze woken by hand stays woken')

  const g = fixture({ snoozedUntil: BORN + 12 * DAY })
  g.lifecycle.settle('ws-1', true, 'ui')
  g.lifecycle.noteUserMessage('ws-1', g.now(), 'gateway')
  assert.equal(g.stored.settledAt, null, 'a message wakes the chat')
  assert.equal(g.stored.snoozedUntil ?? null, null, 'and the chat is back now, not asleep')
})

test('a settle or snooze sent with the row it was asked on is refused once the chat has moved on since', () => {
  const f = fixture({ lastTurnEndedAt: BORN + DAY })
  const seen = f.seen()
  f.advance(1_000)
  f.stored.lastUserMessageAt = f.now()
  const settled = f.lifecycle.settle('ws-1', true, 'gateway', null, { seen })
  assert.equal(settled.ok, false)
  assert.equal(settled.ok ? null : settled.code, 'stale')
  assert.equal(f.stored.settledAt ?? null, null, 'nothing written')
  const snoozed = f.lifecycle.snooze('ws-1', f.now() + DAY, 'gateway', { seen })
  assert.equal(snoozed.ok ? null : snoozed.code, 'stale')
  // Asked again on the chat as it reads now, it goes through.
  assert.equal(f.lifecycle.settle('ws-1', true, 'gateway', null, { seen: f.seen() }).ok, true)
})

test('a settle carries the asking window’s keystroke clock, never past this Studio’s own', () => {
  const f = fixture()
  const ahead = f.now() + DAY
  assert.equal(f.lifecycle.settle('ws-1', true, 'gateway', null, { seen: f.seen(), lastInputAt: ahead }).ok, true)
  assert.equal(f.stored.lastTerminalActivityAt, f.now(), 'clamped to now')
  const g = fixture()
  const typed = g.now() - 1_000
  assert.equal(g.lifecycle.settle('ws-1', true, 'gateway', null, { lastInputAt: typed }).ok, true)
  assert.equal(g.stored.lastTerminalActivityAt, typed)
})
