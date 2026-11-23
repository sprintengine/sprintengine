import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { McpConnectionContext } from '../../shared/modules/mcp-tools'
import type { ModuleLifecycle } from '../modules/module-lifecycle'
import { createExtensionDevEvents } from '../../server/extensions/dev/dev-events'
import { createExtensionDevTools, EXTENSION_DEV_TOOL_NAMES, type ExtensionDevBackend } from './extension-dev-tools'

// The dev loop's tools: paths on this machine, so never a paired device's;
// and an agent Studio launched does not approve an extension.

function tools(loads: Array<{ path: string; approve?: string }>) {
  const lifecycle = {
    devLoad: async (path: string, options: { approve?: string } = {}) => {
      loads.push({ path, ...options })
      return {
        ok: true,
        moduleId: 'local.notes',
        path,
        added: true,
        approval: { state: 'approved', fingerprint: 'sha256-a' },
      }
    },
    devFolders: async () => [{ path: '/Users/dev/notes', moduleId: 'local.notes' }],
  } as unknown as ModuleLifecycle
  const backend: ExtensionDevBackend = {
    lifecycle: () => lifecycle,
    callModuleMethod: async () => ({ ok: true, answer: { ok: true, result: 'hi' } }) as never,
    runHook: async () => ({ verdict: 'pass' }),
    emit: () => undefined,
  }
  const registrations = createExtensionDevTools({ backend: () => backend, events: createExtensionDevEvents() })
  return (name: string) => registrations.find((tool) => tool.name === name)!
}

const local: McpConnectionContext = { metadata: { kind: 'external-local' } }
const agent: McpConnectionContext = {
  metadata: { kind: 'studio-agent', agentId: 'a', workspaceId: 'w', verified: true },
}
const device: McpConnectionContext = { metadata: { kind: 'remote-tailnet', deviceId: 'd', verified: true } }

test('the tools are the dev loop’s, by name', () => {
  const tool = tools([])
  for (const name of EXTENSION_DEV_TOOL_NAMES) assert.ok(tool(name), name)
})

test('the person at a terminal may approve with the fingerprint they were shown; an agent Studio launched may not', async () => {
  const loads: Array<{ path: string; approve?: string }> = []
  const load = tools(loads)('extension.dev.load')
  const byPerson = await load.handler({ path: '/Users/dev/notes', approve: 'sha256-a' }, local)
  assert.notEqual(byPerson.isError, true)
  assert.deepEqual(loads, [{ path: '/Users/dev/notes', approve: 'sha256-a' }])
  const byAgent = await load.handler({ path: '/Users/dev/notes', approve: 'sha256-a' }, agent)
  assert.equal(byAgent.isError, true)
  assert.equal((byAgent.structuredContent as { error: { code: string } }).error.code, 'approval_required')
  assert.equal(loads.length, 1, 'nothing was loaded or approved for the agent')
  const plain = await load.handler({ path: '/Users/dev/notes' }, agent)
  assert.notEqual(plain.isError, true, 'an agent may load the folder; the person approves it')
})

test('a paired device cannot use development folders', async () => {
  const tool = tools([])
  for (const name of EXTENSION_DEV_TOOL_NAMES) {
    const answer = await tool(name).handler(
      { path: '/Users/dev/notes', method: 'm', topic: 't', point: 'x', event: {} },
      device,
    )
    assert.equal(answer.isError, true, name)
    assert.equal((answer.structuredContent as { error: { code: string } }).error.code, 'not_permitted', name)
  }
})

test('a folder must be named absolutely, on the machine Studio runs on', async () => {
  const answer = await tools([])('extension.dev.load').handler({ path: 'notes' }, local)
  assert.equal((answer.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
})
