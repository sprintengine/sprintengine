import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { chatManageOf, createTailnetMeshService } from './tailnet-mesh-service'
import { pairingUrl } from './tailnet-service'
import { TAILNET_IDENTITY_PATH, TAILNET_MCP_PATH, TAILNET_PAIR_PATH } from './tailnet-routes'

// A paired desktop's Stop watching on a chat over there: that machine's
// gateway tool, asked where it advertises it. The rest of a chat's management
// is that machine's Studio's (`tailnet-mesh-chat-lifecycle.test.ts`).

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
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-mesh-chat-manage-'))
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

test('Stop watching is the machine’s own conversation.pull_request_unwatch, by the agent and the address', async () => {
  const machine = await pairedMachine(['conversations', 'chat-unwatch-pull-request'], (call) =>
    success({ ok: true, ...call.arguments, stopped: 1 }),
  )
  try {
    const url = 'https://github.com/acme/app/pull/7'
    const answer = await machine.mesh.changeConversation({
      connectionId: machine.connectionId,
      workspaceId: 'ws-1',
      change: { kind: 'unwatch-pull-request', agentId: 'agent-1', url },
    })
    assert.deepEqual(answer, { ok: true, workspaceId: 'ws-1' })
    assert.deepEqual(machine.toolCalls, [
      { name: 'conversation.pull_request_unwatch', arguments: { workspaceId: 'ws-1', agentId: 'agent-1', url } },
    ])
    const unnamed = await machine.mesh.changeConversation({
      connectionId: machine.connectionId,
      workspaceId: 'ws-1',
      change: { kind: 'unwatch-pull-request', url },
    })
    assert.equal(!unnamed.ok && unnamed.code, 'invalid_arguments')
  } finally {
    await machine.close()
  }
})

test('the list says which of the management a machine takes: its Studio’s record, and Stop watching by its tool', () => {
  const none = { rename: false, autoCompact: false, unwatchPullRequest: false, deleteSettled: false, search: false }
  assert.deepEqual(chatManageOf(false, undefined), none)
  assert.deepEqual(chatManageOf(false, ['conversations']), none)
  assert.deepEqual(chatManageOf(true, ['conversations']), {
    rename: true,
    autoCompact: true,
    unwatchPullRequest: false,
    deleteSettled: true,
    search: true,
  })
  assert.deepEqual(chatManageOf(false, ['chat-unwatch-pull-request']), { ...none, unwatchPullRequest: true })
})
