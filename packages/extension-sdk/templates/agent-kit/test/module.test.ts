// Your tests, in TypeScript: `npm test` runs test/*.test.ts with `node --test`
// (see AGENTS.md). The MCP server answers one message at a time through
// `handle`, so it is tested without starting a process; the last test starts
// it as an agent does, with plain `node`.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { countWords, handle } from '../extension/src/server.mjs'
import { manifest } from './manifest'

test('the server says who it is and that it serves tools', () => {
  const answer = handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  assert.deepEqual(answer?.result, {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 'word-count', version: '0.1.0' },
  })
  assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null)
})

test('count_words counts, and a call without text is refused', () => {
  const listed = handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  assert.deepEqual(
    (listed?.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name),
    ['count_words'],
  )
  const counted = handle({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'count_words', arguments: { text: 'three short words' } },
  })
  assert.deepEqual(counted?.result, { content: [{ type: 'text', text: '3' }] })
  assert.equal(
    handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'count_words' } })?.error?.code,
    -32602,
  )
  assert.equal(countWords('  spaced   out  '), 2)
})

test('extension.json hands agents the skill and the server, run from source', () => {
  assert.deepEqual(
    manifest.contributes.skills.map((skill) => skill.id),
    ['word-budget'],
  )
  const [server] = manifest.contributes.mcpServers
  assert.equal(server?.transport, 'stdio')
  assert.deepEqual(server?.args, ['${extensionPath}/src/stdio.mjs'])
})

test('the server answers over stdio, as an agent starts it', () => {
  const program = fileURLToPath(new URL('../extension/src/stdio.mjs', import.meta.url))
  const run = spawnSync(process.execPath, [program], {
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`,
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.equal(run.status, 0, run.stderr)
  const [answer] = run.stdout.trim().split('\n')
  assert.deepEqual(
    (JSON.parse(answer!) as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name),
    ['count_words'],
  )
})
