import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { WorkspaceSyncEvent } from '../../shared/workspace-sync'
import { AGENT_LEASE_RELEASE_DELAY_MS, createAgentLeaseRelease, leaseOwnersEndedBy } from './agent-lease-release'

const event = (type: string, payload: unknown) =>
  ({ id: 'e', type, sourceWindowId: 'w', sequence: 1, createdAt: 1, payload }) as unknown as WorkspaceSyncEvent

test('a settle, a removal, an agent removed and a sub-agent’s end each end leases; nothing else does', () => {
  assert.deepEqual(
    leaseOwnersEndedBy(event('workspace.fields_updated', { workspaceId: 'ws-1', patch: { settledAt: 5 } })),
    [{ workspaceId: 'ws-1' }],
  )
  assert.deepEqual(leaseOwnersEndedBy(event('workspace.removed', { workspaceId: 'ws-1', removedAt: 5 })), [
    { workspaceId: 'ws-1' },
  ])
  assert.deepEqual(
    leaseOwnersEndedBy(event('workspace.agents_updated', { workspaceId: 'ws-1', agentId: 'a-1', patch: null })),
    [{ workspaceId: 'ws-1', agentId: 'a-1' }],
  )
  assert.deepEqual(
    leaseOwnersEndedBy(
      event('workspace.agents_updated', {
        workspaceId: 'ws-1',
        agentId: 'a-1',
        patch: { subagentEnd: { outcome: 'done', at: 5 } },
      }),
    ),
    [{ workspaceId: 'ws-1', agentId: 'a-1' }],
  )
  // Bringing a chat back, renaming an agent, a visit: nothing ends.
  assert.deepEqual(
    leaseOwnersEndedBy(event('workspace.fields_updated', { workspaceId: 'ws-1', patch: { settledAt: null } })),
    [],
  )
  assert.deepEqual(
    leaseOwnersEndedBy(
      event('workspace.agents_updated', { workspaceId: 'ws-1', agentId: 'a-1', patch: { name: 'x' } }),
    ),
    [],
  )
  assert.deepEqual(
    leaseOwnersEndedBy(event('workspace.fields_updated', { workspaceId: 'ws-1', patch: { lastVisitedAt: 5 } })),
    [],
  )
})

test('the release waits for the chat’s processes to end, and asks once per burst', async () => {
  const jobs: Array<{ job: () => void; ms: number }> = []
  const released: unknown[] = []
  const hear = createAgentLeaseRelease({
    release: async (owner) => released.push(owner),
    schedule: (job, ms) => jobs.push({ job, ms }),
  })
  const settle = event('workspace.fields_updated', { workspaceId: 'ws-1', patch: { settledAt: 5 } })
  hear(settle)
  hear(settle)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0]!.ms, AGENT_LEASE_RELEASE_DELAY_MS)
  assert.deepEqual(released, [])
  jobs[0]!.job()
  await Promise.resolve()
  assert.deepEqual(released, [{ workspaceId: 'ws-1' }])
  hear(settle)
  assert.equal(jobs.length, 2, 'a later change asks again')
})
