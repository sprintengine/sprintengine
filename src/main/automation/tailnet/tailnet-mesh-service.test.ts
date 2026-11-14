import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test, vi } from 'vitest'

import type { MeshConnection, MeshEvent } from '../../../shared/tailnet-mesh'
import { createPowerActivity, type PowerActivity } from '../../power-activity'
import { createTailnetMeshService, type TailnetMeshService } from './tailnet-mesh-service'
import type { StoredMeshConnection, TailnetMeshStore } from './tailnet-mesh-store'

// The mesh's own clocks, with the wire stood in for: when each paired machine
// is asked whether it answers. The loopback suites next door cover the wire.

const wire = vi.hoisted(() => ({ readRemoteIdentity: vi.fn() }))

vi.mock('./tailnet-remote-client', async (original) => ({
  ...(await original<typeof import('./tailnet-remote-client')>()),
  readRemoteIdentity: wire.readRemoteIdentity,
}))

// A machine that answers its identity is asked which machines it relays, on
// its Studio socket: here it serves no list, at once, with no socket opened.
vi.mock('./tailnet-peer-studio', async (original) => ({
  ...(await original<typeof import('./tailnet-peer-studio')>()),
  createPeerStudios: () => ({
    ask: async (_target: unknown, work: (client: { supports(capability: string): boolean }) => unknown) =>
      work({ supports: () => false }),
    forget: () => undefined,
    closeAll: () => undefined,
  }),
}))

const connection: StoredMeshConnection = {
  id: 'tnc_mini',
  machineName: 'mac-mini',
  endpoint: 'mac-mini.tail1234.ts.net:8443',
  deviceId: 'dev_air',
  deviceName: 'dev-macbook-air',
  deviceToken: 'token',
  scopes: ['conversation:read'],
  pairedAt: '2026-09-01T00:00:00.000Z',
  lastConnectedAt: null,
  pairedVia: 'link',
}

function memoryStore(initial: StoredMeshConnection[]): TailnetMeshStore {
  let connections = [...initial]
  const publicView = ({ deviceToken: _token, ...rest }: StoredMeshConnection): MeshConnection => rest
  return {
    list: () => connections.map(publicView),
    find: (id) => connections.find((entry) => entry.id === id) ?? null,
    add: () => {
      throw new Error('not used here')
    },
    updateScopes: () => undefined,
    markConnected: () => undefined,
    noteEnvironment: () => false,
    forget(id) {
      const before = connections.length
      connections = connections.filter((entry) => entry.id !== id)
      return connections.length < before
    },
  }
}

const identity = {
  ok: true,
  value: {
    deviceId: 'dev_air',
    deviceName: 'dev-macbook-air',
    scopes: ['conversation:read'],
    transportVersion: 2,
  },
}

type Harness = {
  mesh: TailnetMeshService
  activity: PowerActivity
  events: MeshEvent[]
  looking: { value: boolean }
  store: TailnetMeshStore
}

let dir = ''
let harness: Harness | null = null

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'mesh-service-'))
  wire.readRemoteIdentity.mockReset()
})

afterEach(() => {
  harness?.mesh.shutdown()
  harness = null
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function startMesh(connections: StoredMeshConnection[] = [connection]): Harness {
  const activity = createPowerActivity({ focused: false })
  const events: MeshEvent[] = []
  const looking = { value: true }
  const store = memoryStore(connections)
  const mesh = createTailnetMeshService({
    resolveUserDataDir: () => dir,
    resolveDeviceName: () => 'dev-macbook-air',
    resolvePeerName: async () => null,
    createStore: () => store,
    hasWindow: () => looking.value,
    activity,
    onEvent: (event) => events.push(event),
  })
  harness = { mesh, activity, events, looking, store }
  return harness
}

test('the reachability timer runs only while a machine is paired', async () => {
  wire.readRemoteIdentity.mockResolvedValue(identity)
  const empty = startMesh([])
  empty.mesh.start()
  assert.equal(vi.getTimerCount(), 0, 'nothing paired, nothing armed')
  empty.mesh.shutdown()

  const h = startMesh()
  h.mesh.start()
  await vi.advanceTimersByTimeAsync(0)
  assert.ok(vi.getTimerCount() > 0)
  h.mesh.forget(connection.id)
  assert.equal(vi.getTimerCount(), 0, 'forgetting the last machine stops the timer')
})
