import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { McpConnectionContext } from '../../shared/modules/mcp-tools'
import type { ModuleLifecycle } from '../modules/module-lifecycle'
import { createExtensionDevEvents } from '../../server/extensions/dev/dev-events'
import type { ModuleMethodCallRequest } from '../module-host/main-host'
import { clampToInvoker, ownerInvoker, type ExtensionInvoker } from '../module-host/extension-invocation'
import {
  bindDevToolsToCaller,
  createExtensionDevTools,
  EXTENSION_DEV_TOOL_NAMES,
  type ExtensionDevBackend,
} from './extension-dev-tools'
import { createExtensionInstallTools } from './extension-install-tools'
import { createExtensionShotTool } from './extension-shot-tool'

// The dev loop's tools: paths on this machine, so never a paired device's;
// nothing over the socket approves an extension; and they drive development
// folders only, as their caller.

function tools(
  loads: Array<{ path: string }>,
  seen: {
    request?: ModuleMethodCallRequest
    hook?: ExtensionInvoker
    studioEvent?: { moduleId: string; event: string; payload: unknown }
    studioEventBy?: ExtensionInvoker
  } = {},
) {
  const lifecycle = {
    devLoad: async (path: string) => {
      loads.push({ path })
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
    callModuleMethod: async (request) => {
      seen.request = request
      return { ok: true, answer: { ok: true, result: 'hi' } } as never
    },
    runHook: async (_moduleId, _point, _event, invoker) => {
      seen.hook = invoker
      return { verdict: 'pass' }
    },
    emit: () => undefined,
    studioEvent: (moduleId, event, payload, invoker) => {
      seen.studioEvent = { moduleId, event, payload }
      seen.studioEventBy = invoker
      return { worker: null, surfaces: 1 }
    },
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

test('nothing over the socket approves: not an agent, not an anonymous local connection; an agent may register', async () => {
  const loads: Array<{ path: string }> = []
  const load = tools(loads)('extension.dev.load')
  for (const caller of [local, agent]) {
    const answer = await load.handler({ path: '/Users/dev/notes', approve: 'sha256-a' }, caller)
    assert.equal(answer.isError, true)
    assert.equal((answer.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments')
  }
  assert.equal(loads.length, 0, 'nothing was loaded or approved')
  const plain = await load.handler({ path: '/Users/dev/notes' }, agent)
  assert.notEqual(plain.isError, true, 'an agent may register the folder; the person approves it in Studio')
  assert.deepEqual(loads, [{ path: '/Users/dev/notes' }])
})

test('request, hook and emit reach development folders only, never an installed extension', async () => {
  const tool = tools([])
  for (const name of [
    'extension.dev.request',
    'extension.dev.hook',
    'extension.dev.emit',
    'extension.dev.studioEvent',
  ]) {
    const answer = await tool(name).handler(
      {
        moduleId: 'acme.installed',
        method: 'm',
        topic: 't',
        point: 'agent.prompt.before',
        event: name === 'extension.dev.studioEvent' ? 'workspace.created' : {},
        payload: {},
      },
      local,
    )
    assert.equal(answer.isError, true, name)
    assert.equal((answer.structuredContent as { error: { code: string } }).error.code, 'not_found', name)
  }
})

test('a request and a hook run as their caller: a manual agent’s cannot start a bypass chat', async () => {
  const seen: { request?: ModuleMethodCallRequest; hook?: ExtensionInvoker } = {}
  const bound = bindDevToolsToCaller(
    ['extension.dev.request', 'extension.dev.hook'].map((name) => tools([], seen)(name)),
    (context) => ownerInvoker(context?.metadata.kind === 'studio-agent' ? 'manual' : null, 'the agent'),
  )
  const request = await bound[0]!.handler({ moduleId: 'local.notes', method: 'm' }, agent)
  assert.notEqual(request.isError, true)
  assert.equal(seen.request?.invoker?.permissionCeiling, 'manual')
  assert.equal(clampToInvoker('bypass', seen.request?.invoker?.permissionCeiling ?? null), 'manual')
  const hook = await bound[1]!.handler({ moduleId: 'local.notes', point: 'agent.prompt.before', event: {} }, agent)
  assert.notEqual(hook.isError, true)
  assert.equal(seen.hook?.permissionCeiling, 'manual')
})

test('a Studio event is fired as its caller: a manual agent’s reaches the extension held to manual', async () => {
  const seen: { studioEventBy?: ExtensionInvoker } = {}
  const [tool] = bindDevToolsToCaller([tools([], seen)('extension.dev.studioEvent')], (context) =>
    ownerInvoker(context?.metadata.kind === 'studio-agent' ? 'manual' : null, 'the agent'),
  )
  const workspace = { workspaceId: 'ws-1', name: 'Notes', kind: 'folder', folderPath: null, branch: null }
  const answer = await tool!.handler({ moduleId: 'local.notes', event: 'workspace.created', payload: workspace }, agent)
  assert.notEqual(answer.isError, true)
  assert.equal(seen.studioEventBy?.permissionCeiling, 'manual', 'the agent’s ceiling rides the event')
  await tool!.handler({ moduleId: 'local.notes', event: 'workspace.created', payload: workspace }, local)
  assert.equal(seen.studioEventBy?.permissionCeiling, null, 'the person’s own call is not capped')
})

test('a capped agent is refused a shot, whose surface calls are answered as the person', async () => {
  let shot = 0
  const [tool] = bindDevToolsToCaller(
    [
      createExtensionShotTool(async () => {
        shot += 1
        return {
          path: '/Users/dev/a.png',
          width: 1,
          height: 1,
          theme: 'dark',
          settled: true,
          pendingRequests: 0,
          errors: [],
        }
      }),
    ],
    (context) => ownerInvoker(context?.metadata.kind === 'studio-agent' ? 'auto' : null),
  )
  const args = { moduleId: 'local.notes', point: 'panels', id: 'p', out: '/Users/dev/a.png' }
  const refused = await tool!.handler(args, agent)
  assert.equal((refused.structuredContent as { error: { code: string } }).error.code, 'not_permitted')
  assert.equal(shot, 0)
  assert.notEqual((await tool!.handler(args, local)).isError, true)
  assert.equal(shot, 1)
})

test('a capped agent is refused extension.open, whose panel or editor answers as the person in their window', async () => {
  let opened = 0
  const lifecycle = {
    installed: async () => ({
      modules: [
        {
          manifest: { id: 'acme.notes' },
          approval: { state: 'approved', fingerprint: 'sha256-x' },
          extension: { contributes: { panels: [{ id: 'main', title: 'Notes' }], customEditors: [] } },
        },
      ],
      rejected: [],
    }),
    list: () => [{ id: 'acme.notes', enabled: true }],
  } as unknown as ModuleLifecycle
  const open = createExtensionInstallTools({
    backend: () => ({ lifecycle: () => lifecycle }),
    openInWindow: async () => {
      opened += 1
      return { ok: true, workspaceId: 'ws-1' }
    },
  }).find((tool) => tool.name === 'extension.open')!
  for (const preset of ['manual', 'auto'] as const) {
    const [tool] = bindDevToolsToCaller([open], (context) =>
      ownerInvoker(context?.metadata.kind === 'studio-agent' ? preset : null),
    )
    const refused = await tool!.handler({ moduleId: 'acme.notes' }, agent)
    assert.equal((refused.structuredContent as { error: { code: string } }).error.code, 'not_permitted', preset)
    assert.equal(opened, 0, preset)
  }
  // The person's own call, and an agent on the loosest preset, open it.
  const [tool] = bindDevToolsToCaller([open], (context) =>
    ownerInvoker(context?.metadata.kind === 'studio-agent' ? 'bypass' : null),
  )
  assert.notEqual((await tool!.handler({ moduleId: 'acme.notes' }, local)).isError, true)
  assert.notEqual((await tool!.handler({ moduleId: 'acme.notes' }, agent)).isError, true)
  assert.equal(opened, 2)
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

test('a made-up Studio event reaches a development folder’s extension alone, its payload checked against the event’s shape', async () => {
  const seen: { studioEvent?: { moduleId: string; event: string; payload: unknown } } = {}
  const tool = tools([], seen)('extension.dev.studioEvent')
  const workspace = { workspaceId: 'ws-1', name: 'Notes', kind: 'folder', folderPath: null, branch: null }
  const answer = await tool.handler({ path: '/Users/dev/notes', event: 'workspace.created', payload: workspace }, local)
  assert.notEqual(answer.isError, true)
  assert.deepEqual(answer.structuredContent, {
    moduleId: 'local.notes',
    event: 'workspace.created',
    worker: 'queued',
    surfaces: 1,
  })
  assert.deepEqual(seen.studioEvent, { moduleId: 'local.notes', event: 'workspace.created', payload: workspace })
  seen.studioEvent = undefined
  for (const [event, payload] of [
    ['workspace.created', { ...workspace, kind: 'drive' }],
    ['workspace.changed', workspace],
    ['agent.status.changed', { agentId: 'a', where: 'chat', state: 'asleep', failed: false }],
    ['workspace.exploded', workspace],
  ] as const) {
    const refused = await tool.handler({ moduleId: 'local.notes', event, payload }, local)
    assert.equal((refused.structuredContent as { error: { code: string } }).error.code, 'invalid_arguments', event)
  }
  assert.equal(seen.studioEvent, undefined, 'nothing was fired')
  const remote = await tool.handler({ moduleId: 'local.notes', event: 'workspace.created', payload: workspace }, device)
  assert.equal(remote.isError, true)
})
