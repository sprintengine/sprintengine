import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  connect,
  webSocketTransport,
  type StudioClient,
  type StudioWebSocketConstructor,
} from '../../../../packages/client-runtime/src/public'
import { createFakeBackend, startTestServer } from '../../../server/rpc/studio-rpc.test-helper'
import type { TailnetScope } from '../../../shared/tailnet'
import type { ConversationGatewayHost } from '../../../server/core/conversation-host'
import type { ConversationRuntime } from '../../conversation-runtime'
import {
  createStudioConversationBackend,
  type StudioConversationBackendDeps,
} from '../../studio-rpc/studio-conversation-backend'
import { createTailnetDeviceStore, type TailnetDeviceStore } from './tailnet-devices'
import {
  createTailnetGatewayServer,
  type TailnetGatewayServer,
  type TailnetGatewayServerOptions,
} from './tailnet-gateway-server'
import { TAILNET_STUDIO_PATH, TAILNET_WS_TICKET_PATH } from './tailnet-routes'

// A paired device on the Studio protocol, for a family's grant tests: the real
// tailnet listener on loopback handing its socket to a real Studio server
// over a fake conversation backend, and the shared client runtime on the
// other end with a device's token, as the phone and a paired desktop run it.

/** The Studio's options; its conversations are a fake backend's unless one is given. */
type ServerInput = Parameters<typeof startTestServer>[0]

export type DeviceRig = {
  gateway: TailnetGatewayServer
  devices: TailnetDeviceStore
  port(): number
  /** Pair a device with these scopes; answers its id and token. */
  pair(scopes: TailnetScope[], name?: string): { id: string; token: string }
  /** A client of the Studio with this device's token, saying no Origin. */
  client(token: string): Promise<StudioClient>
  dispose(): Promise<void>
}

export async function deviceRig(
  server: ServerInput,
  options: { port?: number; gateway?: Pick<TailnetGatewayServerOptions, 'fileUploads' | 'machine'> } = {},
): Promise<DeviceRig> {
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-studio-family-'))
  const devices = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
  const studio = await startTestServer({ backend: createFakeBackend(['agent-1']), ...server })
  const gateway = createTailnetGatewayServer({
    bindAddress: '127.0.0.1',
    // A fixed port lets a test stop the listener and start it again where a client looks for it.
    port: options.port ?? 0,
    serverName: 'sprintengine-studio',
    serverVersion: '9.9.9',
    resolveTools: () => [],
    isMutation: () => false,
    devices,
    peers: { identify: async () => null, resolve: async () => null },
    ...options.gateway,
    // As the core links it (src/server/core/studio-rpc.ts → connectDevice).
    studio: () => ({
      attach: (stream, authenticator, workBudget) =>
        void studio.server.attach(stream, {
          authenticator,
          ownWindow: false,
          audited: true,
          knownFoldersOnly: true,
          workBudget,
        }),
    }),
  })
  await gateway.start()
  const port = () => gateway.address()!.port
  const clients: StudioClient[] = []
  const NodeWebSocket = (globalThis as unknown as { WebSocket: StudioWebSocketConstructor }).WebSocket
  return {
    gateway,
    devices,
    port,
    pair(scopes, name = 'android-phone') {
      const minted = devices.mintDevice({ name, scopes, origin: { kind: 'code', by: null } })
      return { id: minted.device.id, token: minted.deviceToken }
    },
    async client(token) {
      const client = await connect({
        client: { name: 'Phone' },
        transport: webSocketTransport({
          WebSocket: NodeWebSocket,
          ticket: async () => {
            const response = await fetch(`http://127.0.0.1:${port()}${TAILNET_WS_TICKET_PATH}`, {
              method: 'POST',
              headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
              body: '{}',
            })
            const body = (await response.json()) as { ticket?: string }
            if (!body.ticket) throw new Error(`ticket refused: ${response.status}`)
            return {
              url: `ws://127.0.0.1:${port()}${TAILNET_STUDIO_PATH}?ticket=${encodeURIComponent(body.ticket)}`,
              token: body.ticket,
            }
          },
        }),
        reconnect: { initialDelayMs: 20, maxDelayMs: 100 },
      })
      clients.push(client)
      return client
    },
    async dispose() {
      for (const client of clients.splice(0)) client.close()
      await gateway.stop()
      await studio.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** The refusal code a call failed with, or null when it answered. */
export async function refusalOf(call: Promise<unknown>): Promise<string | null> {
  try {
    await call
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? 'thrown'
  }
}

/** Wait for a condition, failing after three seconds. */
export async function until(check: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 300; tries++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/**
 * The Studio's conversation backend over a real conversation host, as the
 * core builds it (src/server/core/studio-rpc.ts), for a rig whose chats are
 * a real runtime's: what a device reads and runs is the host's own doing.
 */
export function hostBackend(
  host: ConversationGatewayHost,
  runtime: ConversationRuntime,
  deps: Partial<StudioConversationBackendDeps> = {},
): NonNullable<NonNullable<ServerInput>['backend']> {
  return createStudioConversationBackend({
    host,
    launch: async () => ({ ok: false, code: 'unavailable', message: 'No chat is started in this test.' }),
    listSessions: (input) => runtime.listSessions(input),
    stopSession: (input) => runtime.stopSession(input),
    getWorkspaceAgents: () => [],
    ...deps,
  }) as never
}
