import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { createTailnetMeshService } from './tailnet-mesh-service'
import { pairingUrl } from './tailnet-service'
import { TAILNET_IDENTITY_PATH, TAILNET_MCP_PATH, TAILNET_PAIR_PATH } from './tailnet-routes'

// What a paired machine's browse says of each workspace's rest. Settling a
// chat there, saying it was looked at and its row menu are its Studio's
// (`tailnet-mesh-chat-lifecycle.test.ts`).

type ToolCall = { name: string; arguments: Record<string, unknown> }

async function pairedMachine(
  capabilities: string[] | undefined,
  answer: (call: ToolCall) => Record<string, unknown>,
  scopes: string[] = ['conversation:read', 'conversation:operate'],
) {
  const toolCalls: ToolCall[] = []
  const device = {
    deviceId: 'device-1',
    deviceName: 'dev-macbook-air',
    scopes,
    transportVersion: 2,
    ...(capabilities ? { capabilities } : {}),
  }
  const peer: Server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://peer.invalid').pathname
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      if (path === TAILNET_PAIR_PATH) return json(200, { ...device, deviceToken: 'device-token' })
      if (path === TAILNET_IDENTITY_PATH) return json(200, device)
      if (path === TAILNET_MCP_PATH) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          id: string
          params: { name: string; arguments: Record<string, unknown> }
        }
        toolCalls.push({ name: body.params.name, arguments: body.params.arguments })
        return json(200, { jsonrpc: '2.0', id: body.id, ...answer(body.params) })
      }
      return json(404, { error: { code: 'not_found', message: `No route for ${path}.` } })
    })
  })
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
  const port = (peer.address() as { port: number }).port
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-mesh-lifecycle-'))
  const mesh = createTailnetMeshService({
    resolveUserDataDir: () => dir,
    resolveDeviceName: () => 'dev-macbook-air',
    resolvePeerName: async () => null,
  })
  const paired = await mesh.pair({ pairingUrl: pairingUrl('127.0.0.1', port, 'pairing-token') })
  assert.ok(paired.ok, paired.ok ? '' : paired.message)
  await mesh.checkReachability(paired.connection.id)
  return {
    mesh,
    connectionId: paired.connection.id,
    toolCalls,
    async close() {
      mesh.shutdown()
      await new Promise<void>((resolve) => peer.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const success = (structured: Record<string, unknown>) => ({
  result: { content: [{ type: 'text', text: '' }], structuredContent: structured },
})

test('a browse reads when each workspace was settled, and null for one in the list or from an older machine', async () => {
  const machine = await pairedMachine(
    ['conversations', 'conversation-lifecycle'],
    () =>
      success({
        workspaces: [
          { id: 'resting', name: 'Done', mode: 'standard', folderPath: '/Users/dev/app', settledAt: 3_000 },
          { id: 'open', name: 'Going', mode: 'standard', folderPath: '/Users/dev/app', settledAt: null },
          { id: 'older', name: 'Before', mode: 'standard', folderPath: '/Users/dev/app' },
        ],
      }),
    ['workspace:read', 'conversation:read'],
  )
  try {
    const browsed = await machine.mesh.browse(machine.connectionId)
    assert.deepEqual(
      browsed.workspaces.map((workspace) => [workspace.id, workspace.settledAt]),
      [
        ['resting', 3_000],
        ['open', null],
        ['older', null],
      ],
    )
  } finally {
    await machine.close()
  }
})

// The row menu on a paired machine's chat: Star, Highlight color, Snooze and
// Auto-settle (`chat-row-menu` there), and Mark unread (`chat-mark-unread`).
