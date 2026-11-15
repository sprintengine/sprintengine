import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import type { UsageWireArgs } from '../../../../packages/studio-protocol/src/public'
import type { StudioChatStores } from '../../../server/chat-stores/chat-stores-domain'
import type { TailnetScope } from '../../../shared/tailnet'
import type { UsageSpeedRow } from '../../usage/usage-aggregate'
import { createUsageFleet, encodeUsageAnswer, fleetRowsOf } from '../../usage/usage-mesh'
import { createPricing } from '../../usage/usage-pricing'
import { createTailnetMeshService } from './tailnet-mesh-service'
import { pairingUrl } from './tailnet-service'
import { deviceRig } from './tailnet-studio.test-helper'

// A paired machine's usage, as the dashboard here asks for it: the machine's
// own rows on its Studio's `usage.rows`, over its tailnet listener, on a
// pairing that may read its workspaces. A pairing that may not read, one
// revoked and a machine away are each told apart.

const H0 = Date.parse('2026-10-20T09:00:00.000Z')

/** A machine paired from here with these scopes, whose Studio answers `usage.rows` from one row of its own. */
async function pairedMachine(scopes: TailnetScope[] = ['workspace:read', 'conversation:read']) {
  const asked: UsageWireArgs[] = []
  const rows: UsageSpeedRow[] = [
    {
      day: String(H0),
      providerId: 'claude-agent',
      model: 'm',
      sessionId: 'theirs',
      chatTitle: 'Their chat',
      tokens: { input: 40, output: 0, cacheRead: 0, cacheWrite: 0 },
      requests: 1,
      reportedCostUsd: null,
    },
  ]
  // Only what this test asks of the stores: the rows.
  const chatStores = {
    usageRows: async (args: UsageWireArgs) => {
      asked.push(args)
      return encodeUsageAnswer({ rows: fleetRowsOf(rows), scannedAt: H0, scanning: false, sources: [] })
    },
  } as unknown as StudioChatStores
  const peer = await deviceRig({ chatStores })
  const offer = peer.devices.offerPairing({ scopes })
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-remote-usage-'))
  const mesh = createTailnetMeshService({
    resolveUserDataDir: () => dir,
    resolveDeviceName: () => 'dev-macbook-air',
    resolvePeerName: async () => null,
  })
  const paired = await mesh.pair({ pairingUrl: pairingUrl('127.0.0.1', peer.port(), offer.token) })
  assert.ok(paired.ok, paired.ok ? '' : paired.message)
  let stopped = false
  return {
    mesh,
    peer,
    dir,
    asked,
    read: () =>
      mesh.readUsage({ connectionId: paired.connection.id, args: { from: H0, to: H0 + 3_600_000 }, timeoutMs: 2_000 }),
    async stop() {
      if (stopped) return
      stopped = true
      await peer.dispose()
    },
    async close() {
      mesh.shutdown()
      await this.stop()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test("a paired machine's usage is its Studio's own rows, asked for over the protocol", async () => {
  const machine = await pairedMachine()
  try {
    const read = await machine.read()
    assert.ok(read.ok, read.ok ? '' : read.message)
    assert.deepEqual(machine.asked, [{ from: H0, to: H0 + 3_600_000 }])
    assert.equal((read.value as { rows: unknown[] }).rows.length, 1)
  } finally {
    await machine.close()
  }
})

test('a pairing that may not read workspaces, and one revoked, are refused as such', async () => {
  const narrow = await pairedMachine(['conversation:read'])
  try {
    const read = await narrow.read()
    assert.ok(!read.ok && read.status === 'unauthorized')
    assert.equal(narrow.asked.length, 0)
  } finally {
    await narrow.close()
  }
  const operate = await pairedMachine(['workspace:operate'])
  try {
    assert.equal((await operate.read()).ok, true, 'operate grants read')
  } finally {
    await operate.close()
  }
  const revoked = await pairedMachine()
  try {
    for (const device of revoked.peer.devices.listDevices()) revoked.peer.devices.revokeDevice(device.id)
    const read = await revoked.read()
    assert.ok(!read.ok && read.status === 'unauthorized', JSON.stringify(read))
    assert.equal(revoked.asked.length, 0)
  } finally {
    await revoked.close()
  }
})

test('the dashboard counts a paired machine over the wire, and keeps counting it once it is away', async () => {
  const machine = await pairedMachine()
  try {
    const pricing = createPricing(new Map([['m', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }]]), {
      source: 'live',
      fetchedAt: 1,
    })
    const fleet = createUsageFleet({
      service: { localRows: async () => ({ rows: [], scannedAt: H0, sources: [], pricing }) },
      dataDir: () => machine.dir,
      peers: () => machine.mesh.listConnections(),
      askPeer: (connectionId, args, options) =>
        machine.mesh.readUsage({ connectionId, args, timeoutMs: options.timeoutMs }),
      localMachine: () => ({ label: 'air', kind: 'laptop', color: 'blue' }),
      pairedMachine: () => ({ kind: 'mini', color: 'teal' }),
      now: () => H0 + 3_600_000,
      askTimeoutMs: 2_000,
    })
    const window = { from: H0 - 3_600_000, to: H0 + 3_600_000 }
    const asked = await fleet.report({ ...window, peers: 'ask' })
    assert.ok(asked.ok)
    assert.equal(asked.report.totals.costUsd, 40)
    assert.equal(asked.report.machines[1]?.status, 'ok')

    await machine.stop()
    const away = await fleet.report({ ...window, peers: 'ask' })
    assert.ok(away.ok)
    assert.equal(away.report.machines[1]?.status, 'cached')
    assert.equal(away.report.totals.costUsd, 40)
  } finally {
    await machine.close()
  }
})
