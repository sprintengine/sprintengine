import assert from 'node:assert/strict'

import { test } from 'vitest'

import { EXTENSION_MAIN_HOST_METHODS } from '../../../packages/extension-sdk/src/services'
import { studioGrantPrincipal, studioPrincipal } from '../../../packages/studio-protocol/src/permissions'
import type { CapabilityManifest } from '../../shared/modules/manifest'
import { toolSuccess } from '../../shared/modules/mcp-tools'
import { createStudioGatewayTools } from '../automation/studio-gateway-tools'
import { currentInvoker, ownerInvoker, runAsInvoker, type ExtensionInvoker } from './extension-invocation'
import { createMainKernel } from './main-host'
import * as serviceTokens from './service-tokens'

// The host's gate (extension-host-gate.ts), as an extension meets it: every
// call into Studio is held to what the person approved for the extension and
// to what whoever set the call off may do themselves.

const reader: CapabilityManifest = {
  id: 'local.reader',
  displayName: 'Reader',
  version: '1.0.0',
  defaultEnabled: true,
  source: 'third-party',
  permissions: [
    'conversation:own',
    'backlog:operate',
    'backlog:read',
    'github:api',
    'tools:contribute',
    'agents:companion',
  ],
}
const bare: CapabilityManifest = {
  id: 'local.bare',
  displayName: 'Bare',
  version: '1.0.0',
  defaultEnabled: true,
  source: 'third-party',
  permissions: [],
}
const bundled: CapabilityManifest = { id: 'bundled', displayName: 'Bundled', version: 1, defaultEnabled: true }

/** A paired device with workspace access only, over its Studio connection. */
const DEVICE: ExtensionInvoker = {
  principal: studioGrantPrincipal({ owner: false, scopes: ['workspaces:read', 'workspaces:operate'] }),
  permissionCeiling: 'bypass',
  label: 'the device "build-box"',
}

function setup(approved: () => readonly string[] | null = () => reader.permissions ?? []) {
  const manifests = new Map([reader, bare, bundled].map((manifest) => [manifest.id, manifest]))
  const calls: string[] = []
  const listeners: Array<() => void> = []
  const kernel = createMainKernel({
    resolveModuleManifest: (id) => manifests.get(id),
    isModulePresent: (id) => manifests.has(id),
    resolveDeclaredMcpTools: () => [{ name: 'reader_peek', description: 'Peeks.', access: 'read' }],
    resolveExtensionGrant: (id) => (id === reader.id ? approved() : (manifests.get(id)?.permissions ?? [])),
  })
  const host = kernel.hostFor('@host')
  host.provideService(
    serviceTokens.ConversationModuleServiceToken,
    () =>
      ({
        list: (moduleId: string) => (calls.push(`list:${moduleId}`), []),
        subscribe: (moduleId: string, _ref: unknown, cb: () => void) => {
          calls.push(`subscribe:${moduleId}`)
          listeners.push(cb)
          return () => calls.push(`unsubscribe:${moduleId}`)
        },
        create: async (moduleId: string) => (calls.push(`create:${moduleId}`), { ok: true }),
        internals: () => 'not for extensions',
      }) as never,
  )
  host.provideService(
    serviceTokens.CompanionAgentsModuleServiceToken,
    () =>
      ({
        attach: (moduleId: string) => {
          calls.push(`attach:${moduleId}`)
          return {
            agentId: 'guide',
            status: () => 'idle',
            send: async (message: string) => void calls.push(`send:${message}`),
            secret: () => 'a member the table does not know',
          }
        },
      }) as never,
  )
  host.provideService(
    serviceTokens.GitHubModuleServiceToken,
    () =>
      ({
        request: async (moduleId: string) => (calls.push(`github:${moduleId}`), { ok: true }),
      }) as never,
  )
  host.provideService(
    serviceTokens.BacklogModuleServiceToken,
    () =>
      ({
        create: async (moduleId: string) => (calls.push(`backlog:${moduleId}`), { ok: true }),
        getLocation: async (moduleId: string) => (calls.push(`location:${moduleId}`), { ok: true }),
      }) as never,
  )
  return { kernel, calls, listeners }
}

type Chats = {
  list(moduleId: string): unknown[]
  create(moduleId: string): Promise<{ ok: boolean; code?: string; message?: string }>
  internals(): string
}

test('a call needs the permission of the extension’s approval, and is refused as its method tells a refusal', async () => {
  const { kernel, calls } = setup()
  const chats = kernel
    .hostFor('local.bare')
    .requireService(serviceTokens.ConversationModuleServiceToken) as unknown as Chats
  // A method with a failure shape answers it; one without throws.
  const refused = await chats.create('local.bare')
  assert.equal(refused.code, 'not_permitted')
  assert.match(refused.message ?? '', /not approved for "conversation:own"/)
  assert.throws(() => chats.list('local.bare'), /not approved for "conversation:own"/)
  // A member the table does not hold is no host method an extension may call.
  const own = kernel
    .hostFor('local.reader')
    .requireService(serviceTokens.ConversationModuleServiceToken) as unknown as Chats
  assert.throws(() => own.internals(), /not a host method an extension may call/)
  assert.deepEqual(calls, [])
  assert.deepEqual(own.list('local.reader'), [])
  assert.deepEqual(calls, ['list:local.reader'])
})

test('whoever set the call off must hold what it needs: a device cannot read chats through an extension', async () => {
  const { kernel, calls } = setup()
  const chats = kernel
    .hostFor('local.reader')
    .requireService(serviceTokens.ConversationModuleServiceToken) as unknown as Chats
  // The extension's own work runs as the person who approved it.
  assert.deepEqual(chats.list('local.reader'), [])
  // Set off by a device granted workspaces only, the same call is refused.
  assert.throws(
    () => runAsInvoker(DEVICE, () => chats.list('local.reader')),
    /needs "conversation:read", which the device "build-box" does not hold/,
  )
  const created = await runAsInvoker(DEVICE, () => chats.create('local.reader'))
  assert.equal(created.code, 'not_permitted')
  // The GitHub sign-in is the person's alone, whatever a client holds.
  const github = kernel.hostFor('local.reader').requireService(serviceTokens.GitHubModuleServiceToken) as unknown as {
    request(moduleId: string): Promise<{ ok: boolean; code?: string }>
  }
  const everything: ExtensionInvoker = {
    principal: studioPrincipal({
      owner: false,
      permissions: studioGrantPrincipal({ owner: true, scopes: [] }).permissions,
    }),
    permissionCeiling: null,
    label: '"another app"',
  }
  assert.equal((await runAsInvoker(everything, () => github.request('local.reader'))).code, 'not_permitted')
  assert.equal((await runAsInvoker(ownerInvoker(), () => github.request('local.reader'))).ok, true)
  assert.deepEqual(calls, ['list:local.reader', 'github:local.reader'])
})

test('an extension no longer approved as it was loaded is refused approval_required, alike for every call', async () => {
  let approval: readonly string[] | null = reader.permissions ?? []
  const { kernel, calls } = setup(() => approval)
  const host = kernel.hostFor('local.reader')
  const chats = host.requireService(serviceTokens.ConversationModuleServiceToken) as unknown as Chats
  approval = null
  assert.equal((await chats.create('local.reader')).code, 'approval_required')
  assert.throws(() => chats.list('local.reader'), /not approved as it is now/)
  assert.throws(() => host.registerMcpTools([]), /not approved as it is now/)
  assert.deepEqual(calls, [])
})

test('an extension’s method runs as whoever called it, and what it reaches is held to them', async () => {
  const { kernel, calls } = setup()
  const host = kernel.hostFor('local.reader')
  const chats = host.requireService(serviceTokens.ConversationModuleServiceToken) as unknown as Chats
  host.registerMethods({
    peek: {
      access: 'read',
      params: () => ({ ok: true, params: {} }),
      // A timer it starts while serving the call still serves that caller.
      handler: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1))
        return { ok: true, result: chats.list('local.reader').length }
      },
    },
  })
  const call = (invoker: ExtensionInvoker) =>
    kernel.callModuleMethod({
      moduleId: 'local.reader',
      method: 'peek',
      access: 'read',
      params: {},
      clientId: 'c',
      invoker,
    })
  assert.deepEqual(await call(ownerInvoker()), { ok: true, answer: { ok: true, result: 0 } })
  await assert.rejects(call(DEVICE), /does not hold/)
  assert.deepEqual(calls, ['list:local.reader'])
})

test('a window half’s host services are held to the connection that sent the call', async () => {
  const { kernel, calls } = setup()
  const found = kernel.hostServicesFor('local.reader', DEVICE)
  assert.ok(found.ok)
  const refused = await found.services.backlog!.create('local.reader', 'ws', { title: 'x' })
  assert.equal(!refused.ok && refused.code, 'not_permitted')
  const asOwner = kernel.hostServicesFor('local.reader', ownerInvoker())
  assert.ok(asOwner.ok)
  assert.deepEqual(await asOwner.services.backlog!.create('local.reader', 'ws', { title: 'x' }), { ok: true })
  assert.deepEqual(calls, ['backlog:local.reader'])
  // The module id is the client's word: naming one of the app's own modules
  // does not skip what the connection itself must hold.
  const named = kernel.hostServicesFor('bundled', DEVICE)
  assert.ok(named.ok)
  const viaBundled = await named.services.backlog!.create('bundled', 'ws', { title: 'x' })
  assert.equal(!viaBundled.ok && viaBundled.code, 'not_permitted')
  assert.deepEqual(calls, ['backlog:local.reader'])
})

test('the app’s own modules are not held to the gate', async () => {
  const { kernel } = setup()
  const chats = kernel
    .hostFor('bundled')
    .requireService(serviceTokens.ConversationModuleServiceToken) as unknown as Chats
  assert.equal(chats.internals(), 'not for extensions')
  assert.deepEqual(
    runAsInvoker(DEVICE, () => chats.list('bundled')),
    [],
  )
})

test('an extension tool an agent or a device calls runs as that caller', async () => {
  const { kernel, calls } = setup()
  const host = kernel.hostFor('local.reader')
  const chats = host.requireService(serviceTokens.ConversationModuleServiceToken) as unknown as Chats
  host.registerMcpTools([
    {
      name: 'reader_peek',
      description: 'Peeks.',
      inputSchema: { type: 'object' },
      handler: async () => toolSuccess({ chats: chats.list('local.reader').length }),
    },
  ])
  const tools = createStudioGatewayTools({
    appTools: [],
    resolveModuleTools: () => kernel.mcpToolRegistrations(),
    isModuleEnabled: () => true,
    callerInvoker: (context) => (context?.metadata.kind === 'remote-tailnet' ? DEVICE : ownerInvoker()),
  })()
  const peek = tools.find((tool) => tool.name === 'reader_peek')!
  assert.deepEqual((await peek.handler({}, { metadata: { kind: 'studio-agent' } })).structuredContent, { chats: 0 })
  await assert.rejects(
    peek.handler({}, { metadata: { kind: 'remote-tailnet', deviceId: 'd1', verified: true } }),
    /does not hold/,
  )
  assert.deepEqual(calls, ['list:local.reader'])
})

test('every member of an extension’s MainHost has a row in the table', () => {
  const { kernel } = setup()
  const members = Object.keys(kernel.hostFor('local.reader')).sort()
  assert.deepEqual(members, Object.keys(EXTENSION_MAIN_HOST_METHODS).sort())
})

test('an extension’s params validator runs as whoever called the method, as its handler does', async () => {
  const { kernel, calls } = setup()
  const host = kernel.hostFor('local.reader')
  const chats = host.requireService(serviceTokens.ConversationModuleServiceToken) as unknown as Chats
  const seen: string[] = []
  host.registerMethods({
    peek: {
      access: 'read',
      params: (value) => {
        try {
          chats.list('local.reader')
          seen.push('read')
        } catch {
          seen.push('refused')
        }
        return { ok: true, params: value }
      },
      handler: () => ({ ok: true, result: null }),
    },
  })
  const call = (invoker: ExtensionInvoker) =>
    kernel.callModuleMethod({
      moduleId: 'local.reader',
      method: 'peek',
      access: 'read',
      params: {},
      clientId: 'c',
      invoker,
    })
  await call(DEVICE)
  await call(ownerInvoker())
  assert.deepEqual(seen, ['refused', 'read'])
  assert.deepEqual(calls, ['list:local.reader'])
})

type Companion = {
  agentId: string
  status(): string
  send(message: string): Promise<void>
  secret(): string
}

test('what a service hands back is held to the gate at each call, as whoever calls it then', async () => {
  let approval: readonly string[] | null = reader.permissions ?? []
  const { kernel, calls } = setup(() => approval)
  const companions = kernel
    .hostFor('local.reader')
    .requireService(serviceTokens.CompanionAgentsModuleServiceToken) as unknown as {
    attach(moduleId: string): Companion
  }
  // Attached as the extension's own work (as in activate), driven later by a device.
  const handle = companions.attach('local.reader')
  assert.equal(handle.agentId, 'guide', 'data on the handle reads as it is')
  await assert.rejects(
    runAsInvoker(DEVICE, () => handle.send('from the device')),
    /"companion-agents\.module-service\.attach\.send" .*needs "conversation:create"/,
  )
  await handle.send('from the person')
  // A member without a row is no host method an extension may call.
  assert.throws(() => handle.secret(), /not a host method an extension may call/)
  // The approval is read at each call: gone, the handle it kept stops.
  approval = null
  assert.throws(() => handle.status(), /not approved as it is now/)
  await assert.rejects(handle.send('after'), /not approved as it is now/)
  assert.deepEqual(calls, ['attach:local.reader', 'send:from the person'])
})

test('what the host calls back runs as the extension’s own work, not as whoever registered it', () => {
  const { kernel, listeners } = setup()
  const chats = kernel
    .hostFor('local.reader')
    .requireService(serviceTokens.ConversationModuleServiceToken) as unknown as {
    subscribe(moduleId: string, ref: unknown, cb: () => void): () => void
  }
  const agent: ExtensionInvoker = {
    principal: studioPrincipal({ owner: false, permissions: ['conversation:read'] }),
    permissionCeiling: 'auto',
    label: 'the agent',
  }
  const heard: string[] = []
  runAsInvoker(agent, () => chats.subscribe('local.reader', {}, () => heard.push(currentInvoker().label)))
  // A resource made during the agent's call delivers later, still inside its context.
  runAsInvoker(agent, () => listeners[0]!())
  assert.deepEqual(heard, ['you'])
})
