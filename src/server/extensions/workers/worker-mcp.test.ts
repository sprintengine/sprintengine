import assert from 'node:assert/strict'

import { afterEach, test } from 'vitest'

import { createMcpDispatcher } from '../../../main/automation/mcp-dispatch'
import { createStudioGatewayTools } from '../../../main/automation/studio-gateway-tools'
import { ownerInvoker } from '../../../main/module-host/extension-invocation'
import { startWorkerHarness, type WorkerHarness } from '../../../../tests/extension-workers'
import { widerThanDeclared } from './worker-manager'

// A worker extension's MCP tools as an agent meets them: through the
// gateway's own tools/list and tools/call, before its worker has ever run.

const SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string', description: 'The text to count.' } },
  required: ['text'],
  additionalProperties: false,
}

const COUNTER = (schema: Record<string, unknown>) => `exports.activate = (studio) => studio.registerMcpTools([{
  name: 'words_count',
  description: 'from code',
  inputSchema: ${JSON.stringify(schema)},
  handler: async (args) => ({ content: [{ type: 'text', text: String(args.text).split(' ').length + ' words' }] }),
}])\n`

let harness: WorkerHarness | null = null
afterEach(async () => {
  await harness?.close()
  harness = null
})

function gateway(current: WorkerHarness) {
  const tools = createStudioGatewayTools({
    appTools: [],
    resolveModuleTools: () => current.load.kernel.mcpToolRegistrations(),
    isModuleEnabled: () => true,
    callerInvoker: () => ownerInvoker('auto', 'the agent'),
  })
  const dispatcher = createMcpDispatcher({
    serverName: 'test',
    serverVersion: '0.0.0-test',
    resolveTools: () => tools(),
  })
  const context = { metadata: { kind: 'external-local' as const } }
  return async (method: string, params: Record<string, unknown>) => {
    const outcome = await dispatcher.dispatch(method, params, context)
    assert.equal(outcome.kind, 'result', JSON.stringify(outcome))
    return (outcome as { value: Record<string, unknown> }).value
  }
}

function counterExtension(registered: Record<string, unknown>) {
  return {
    id: 'words',
    main: COUNTER(registered),
    permissions: ['tools:contribute'],
    mcpTools: [{ name: 'words_count', description: 'Count the words.', access: 'read' as const, inputSchema: SCHEMA }],
  }
}

test('a tool’s parameters, from extension.json, are listed before its worker has run, and the first call works', async () => {
  harness = startWorkerHarness([counterExtension(SCHEMA)])
  const call = gateway(harness)
  const listed = (await call('tools/list', {})).tools as Array<{ name: string; inputSchema: unknown }>
  assert.deepEqual(listed.find((tool) => tool.name === 'words_count')?.inputSchema, SCHEMA)
  assert.equal(harness.workers.status('local.words')?.state, 'idle', 'listing did not start it')
  const result = await call('tools/call', { name: 'words_count', arguments: { text: 'one two three' } })
  assert.deepEqual(result.content, [{ type: 'text', text: '3 words' }])
})

test('a worker whose tool takes more than extension.json says does not start', async () => {
  harness = startWorkerHarness([counterExtension({ type: 'object', properties: { text: { type: 'string' } } })], {
    maxRestarts: 0,
  })
  const result = await gateway(harness)('tools/call', { name: 'words_count', arguments: { text: 'one' } })
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result.content), /takes more than its extension.json says/)
})

test('a registered schema matches or narrows the declared one', () => {
  assert.equal(widerThanDeclared(SCHEMA, SCHEMA), null)
  assert.equal(widerThanDeclared({ ...SCHEMA, properties: {} }, SCHEMA), null, 'taking fewer parameters narrows')
  assert.match(widerThanDeclared({ ...SCHEMA, required: [] }, SCHEMA) ?? '', /does not require "text"/)
  assert.match(
    widerThanDeclared({ ...SCHEMA, properties: { text: { type: 'number' } } }, SCHEMA) ?? '',
    /"text" is "number" there/,
  )
  assert.match(
    widerThanDeclared({ ...SCHEMA, properties: { ...SCHEMA.properties, more: { type: 'string' } } }, SCHEMA) ?? '',
    /takes "more"/,
  )
  assert.match(widerThanDeclared({ type: 'object' }, SCHEMA) ?? '', /does not refuse parameters/)
})
