import assert from 'node:assert/strict'

import type { ExtensionMcpToolContribution } from '../../../packages/extension-sdk/src/extension-manifest'
import type { CapabilityManifest } from '../../shared/modules/manifest'
import type { McpToolRegistration } from '../../shared/modules/mcp-tools'
import { createMainKernel, createServiceToken, THIRD_PARTY_SERVICE_KEYS, type ServiceToken } from './main-host'
import * as serviceTokens from './service-tokens'
import { test } from 'vitest'

// What a third-party module can reach through its MainHost, beyond what a
// first-party one can: the service ACL and the MCP tool rules.

const bundled: CapabilityManifest = { id: 'bundled', displayName: 'Bundled', version: 1, defaultEnabled: true }
const thirdParty: CapabilityManifest = {
  id: 'acme-deck',
  displayName: 'Acme Deck',
  version: 1,
  defaultEnabled: true,
  source: 'third-party',
  // What it was approved for: the host's gate lets it reach these services.
  permissions: [
    'tools:contribute',
    'storage:own',
    'secrets:own',
    'conversation:own',
    'backlog:read',
    'usage:read',
    'workspace:operate',
    'agents:companion',
  ],
}
const otherThirdParty: CapabilityManifest = {
  id: 'acme-other',
  displayName: 'Acme Other',
  version: 1,
  defaultEnabled: true,
  source: 'third-party',
  permissions: ['secrets:own'],
}

// The MCP tools acme-deck's extension.json declares: all its worker may register.
const DECLARED_TOOLS: Record<string, readonly ExtensionMcpToolContribution[]> = {
  'acme-deck': [
    { name: 'acme_deck_list', description: 'Lists the deck.', access: 'read', inputSchema: { type: 'object' } },
    { name: 'acme_write', description: 'Writes a card.', access: 'operate', inputSchema: { type: 'object' } },
  ],
}

function kernelWith(...manifests: CapabilityManifest[]) {
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]))
  return createMainKernel({
    resolveModuleManifest: (id) => byId.get(id),
    resolveDeclaredMcpTools: (id) => DECLARED_TOOLS[id],
  })
}

function tool(name: string, extra: Partial<McpToolRegistration> = {}): McpToolRegistration {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ content: [] }),
    ...extra,
  } as McpToolRegistration
}

test('a third-party module resolves only the published service keys', () => {
  const kernel = kernelWith(bundled, thirdParty)
  const host = kernel.hostFor('@host')
  host.provideService(serviceTokens.TerminalRuntimeToken, () => ({}) as never)
  host.provideService(serviceTokens.WorkspaceContextToken, () => ({}) as never)

  const module = kernel.hostFor('acme-deck')
  assert.ok(module.getService(serviceTokens.WorkspaceContextToken))
  assert.ok(module.requireService(serviceTokens.WorkspaceContextToken))
  assert.throws(
    () => module.getService(serviceTokens.TerminalRuntimeToken),
    /Service "core.terminal-runtime" is not available to third-party modules\./,
  )
  assert.throws(() => module.requireService(serviceTokens.TerminalRuntimeToken), /not available to third-party/)
  // Refused even when nothing provides it: the answer never says what exists.
  assert.throws(() => module.getService(serviceTokens.GitHubTokenStoreToken), /not available to third-party/)
  // An allowed key nothing provides yet is still an ordinary miss.
  assert.equal(module.getService(serviceTokens.ConversationModuleServiceToken), undefined)

  // First-party modules keep the whole kernel.
  assert.ok(kernel.hostFor('bundled').getService(serviceTokens.TerminalRuntimeToken))
})

test('a third-party module reaches a service that names a module only as itself', () => {
  const kernel = kernelWith(bundled, thirdParty, otherThirdParty)
  const calls: string[] = []
  const storage = {
    get: (moduleId: string, key: string) => {
      calls.push(`${moduleId}:${key}`)
      return key
    },
  }
  const workspaces = { create: (name: string, key: string) => `${name}:${key}` }
  kernel.hostFor('@host').provideService(serviceTokens.ModuleStorageToken, () => storage as never)
  kernel.hostFor('@host').provideService(serviceTokens.WorkspaceServiceToken, () => workspaces as never)

  const deck = kernel.hostFor('acme-deck').requireService(serviceTokens.ModuleStorageToken) as unknown as typeof storage
  assert.equal(deck.get('acme-deck', 'mine'), 'mine')
  assert.throws(() => deck.get('acme-other', 'theirs'), /called service "core.module-storage" as module "acme-other"/)
  assert.throws(() => deck.get('bundled', 'theirs'), /only as itself/)
  // The same view each time, and one it cannot change for anyone else.
  assert.equal(kernel.hostFor('acme-deck').getService(serviceTokens.ModuleStorageToken), deck)
  assert.throws(() => {
    ;(deck as { get: unknown }).get = () => 'replaced'
  }, /cannot change service/)
  assert.deepEqual(calls, ['acme-deck:mine'])
  // A service that names no module takes any first argument; a first-party module is handed it as is.
  const workspace = kernel
    .hostFor('acme-deck')
    .requireService(serviceTokens.WorkspaceServiceToken) as unknown as typeof workspaces
  assert.equal(workspace.create('any-workspace', 'name'), 'any-workspace:name')
  assert.equal(kernel.hostFor('bundled').requireService(serviceTokens.ModuleStorageToken), storage)
})

test('reflection on a service a third-party module holds reaches only its guarded calls', async () => {
  const kernel = kernelWith(bundled, thirdParty, otherThirdParty)
  const calls: string[] = []
  const handle = { agentId: 'guide', send: async (what: string) => void calls.push(`handle:${what}`) }
  class Ledger {
    constructor(private readonly name: string) {}
    write(what: string) {
      calls.push(`${this.name}:${what}`)
    }
  }
  const companions = {
    attach: (moduleId: string) => {
      calls.push(`attach:${moduleId}`)
      return handle
    },
    ledgers: { first: new Ledger('first') },
  }
  const chats = { create: async (_moduleId: string) => ({ send: (what: string) => calls.push(`chat:${what}`) }) }
  kernel.hostFor('@host').provideService(serviceTokens.CompanionAgentsModuleServiceToken, () => companions as never)
  kernel.hostFor('@host').provideService(serviceTokens.ConversationModuleServiceToken, () => chats as never)
  const kept = kernel.hostFor('acme-deck')
  const service = kept.requireService(serviceTokens.CompanionAgentsModuleServiceToken) as unknown as typeof companions

  // The method the descriptor holds is the guarded one, not the service's own.
  const descriptor = Object.getOwnPropertyDescriptor(service, 'attach')
  const reached = (descriptor?.value ?? descriptor?.get?.call(service)) as typeof companions.attach
  assert.notEqual(reached, companions.attach)
  assert.throws(() => reached('acme-other'), /only as itself/)
  for (const name of Reflect.ownKeys(service)) {
    const member = Reflect.get(service, name) as unknown
    assert.notEqual(member, Reflect.get(companions, name), `${String(name)} is not the service's own`)
  }
  assert.equal(Object.getPrototypeOf(service), null, 'no way back to the service through its prototype')

  // What it hands back is guarded too, member by member: a member with a row
  // in the table works; one without, or anything the service holds, is
  // refused, now or once a promise settles.
  const opened = service.attach('acme-deck')
  assert.equal(opened.agentId, 'guide')
  await opened.send('one')
  assert.throws(() => service.ledgers.first.write('one'), /not a host method an extension may call/)
  const created = await (
    kept.requireService(serviceTokens.ConversationModuleServiceToken) as unknown as typeof chats
  ).create('acme-deck')
  assert.throws(() => created.send('one'), /not a host method an extension may call/)
  assert.deepEqual(calls, ['attach:acme-deck', 'handle:one'])
  await kernel.unregisterModule('acme-deck')
  calls.length = 0
  assert.throws(() => reached('acme-deck'), /switched off/)
  assert.throws(() => opened.send('late'), /switched off/, 'a handle it was handed')
  assert.throws(() => created.send('late'), /switched off/, 'a handle a promise handed it')
  assert.throws(() => service.ledgers.first.write('late'), /switched off/, 'an object the service holds')
  assert.deepEqual(calls, [])
})

test('a third-party module switched off reaches no service through the host or the services it kept', async () => {
  const kernel = kernelWith(bundled, thirdParty, otherThirdParty)
  const calls: string[] = []
  // One method of each service, by the name the host's table knows it under.
  const METHOD: Record<string, string> = {
    secrets: 'set',
    storage: 'get',
    chats: 'list',
    backlog: 'list',
    usage: 'query',
    workspace: 'create',
  }
  type Registry = Record<string, (moduleId: string, what: string) => string>
  const registry = (name: string): Registry => ({
    [METHOD[name]!]: (moduleId: string, what: string) => {
      calls.push(`${name}:${moduleId}:${what}`)
      return what
    },
  })
  const call = (name: string, service: Registry, moduleId: string, what: string) =>
    service[METHOD[name]!]!(moduleId, what)
  const tokens: Record<string, ServiceToken<unknown>> = {
    secrets: serviceTokens.ModuleSecretsServiceToken,
    storage: serviceTokens.ModuleStorageToken,
    chats: serviceTokens.ConversationModuleServiceToken,
    backlog: serviceTokens.BacklogModuleServiceToken,
    usage: serviceTokens.UsageModuleServiceToken,
    workspace: serviceTokens.WorkspaceServiceToken,
  }
  const host = kernel.hostFor('@host')
  for (const [name, token] of Object.entries(tokens)) host.provideService(token, () => registry(name) as never)
  const kept = kernel.hostFor('acme-deck')
  const held = Object.fromEntries(
    Object.entries(tokens).map(([name, token]) => [name, kept.requireService(token) as unknown as Registry]),
  )
  for (const [name, service] of Object.entries(held))
    assert.equal(call(name, service, 'acme-deck', 'before'), 'before', name)
  // Its shutdown hooks may still use them.
  kept.onShutdown(() => {
    held.secrets!.set!('acme-deck', 'goodbye')
  })
  await kernel.unregisterModule('acme-deck')
  calls.length = 0

  // A timer or a promise that outlived its shutdown: every service it holds refuses.
  for (const [name, service] of Object.entries(held))
    assert.throws(() => call(name, service, 'acme-deck', 'late'), /switched off.*no longer reaches service/, name)
  // And the host reaches none either.
  for (const token of Object.values(tokens)) {
    assert.throws(() => kept.requireService(token), /switched off/)
    assert.throws(() => kept.getService(token), /switched off/)
  }
  assert.throws(() => kept.getModuleDataDir(), /switched off/)
  assert.throws(() => kept.getModuleAppState('key'), /switched off/)
  assert.throws(() => kept.getAssetPath('a.png'), /switched off/)
  await assert.rejects(kept.listChatRuntimes(), /switched off/)
  await assert.rejects(kept.getSkillStatus('/Users/dev/project', 'skill'), /switched off/)
  const git = await kept.getWorkspaceGitInfo('ws')
  assert.equal(!git.ok && git.code, 'unavailable')
  assert.throws(() => kept.provideService(createServiceToken('acme.late'), () => ({})), /switched off/)
  assert.deepEqual(calls, [])
  // Another module's services are untouched.
  const other = kernel.hostFor('acme-other').requireService(tokens.secrets) as unknown as Registry
  assert.equal(other.set!('acme-other', 'theirs'), 'theirs')

  // Switched on again, its new host and the services it hands out work, still only as itself.
  const again = kernel.hostFor('acme-deck')
  const secrets = again.requireService(tokens.secrets) as unknown as Registry
  assert.notEqual(secrets, held.secrets)
  assert.equal(secrets.set!('acme-deck', 'again'), 'again')
  assert.throws(() => secrets.set!('acme-other', 'theirs'), /only as itself/)
  assert.equal(again.getService(tokens.secrets), secrets, 'the same view each time within a load')
  assert.throws(() => held.secrets!.set!('acme-deck', 'late'), /switched off/, 'the old one stays retired')
})

test('a first-party module switched off reaches no service through the host it kept', async () => {
  const kernel = kernelWith(bundled)
  const service = { ping: () => 'pong' }
  kernel.hostFor('@host').provideService(serviceTokens.WorkspaceServiceToken, () => service as never)
  const kept = kernel.hostFor('bundled')
  assert.equal(kept.requireService(serviceTokens.WorkspaceServiceToken), service)
  await kernel.unregisterModule('bundled')
  assert.throws(() => kept.requireService(serviceTokens.WorkspaceServiceToken), /switched off/)
  assert.throws(() => kept.getService(serviceTokens.WorkspaceServiceToken), /switched off/)
  assert.equal(kernel.hostFor('bundled').requireService(serviceTokens.WorkspaceServiceToken), service)
})

test('third-party modules may share services with each other', () => {
  const kernel = kernelWith(thirdParty, otherThirdParty)
  const token = createServiceToken<{ ping(): string }>('acme.shared')
  kernel.hostFor('acme-other').provideService(token, () => ({ ping: () => 'pong' }))
  assert.equal(kernel.hostFor('acme-deck').requireService(token).ping(), 'pong')
})

test('every SDK-published token key is on the third-party allow-list', () => {
  for (const token of [
    serviceTokens.WorkspaceServiceToken,
    serviceTokens.WorkspaceContextToken,
    serviceTokens.ModuleStorageToken,
    serviceTokens.CompanionAgentsModuleServiceToken,
    serviceTokens.ScheduledAgentsModuleServiceToken,
    serviceTokens.ConversationModuleServiceToken,
    serviceTokens.ModuleSecretsServiceToken,
    serviceTokens.GitHubModuleServiceToken,
    serviceTokens.BacklogModuleServiceToken,
    serviceTokens.UsageModuleServiceToken,
    serviceTokens.ActivityModuleServiceToken,
    serviceTokens.TextGenerationModuleServiceToken,
  ]) {
    assert.ok(THIRD_PARTY_SERVICE_KEYS.has(token.key), token.key)
  }
  assert.equal(THIRD_PARTY_SERVICE_KEYS.size, 12)
})

test('a third-party module needs tools:contribute to register MCP tools', () => {
  const kernel = kernelWith(thirdParty, otherThirdParty, bundled)
  assert.throws(
    () => kernel.hostFor('acme-other').registerMcpTools([tool('acme_other_list')]),
    /was not approved for "tools:contribute"/,
  )
  assert.equal(kernel.mcpToolRegistrations().length, 0)
  kernel.hostFor('acme-deck').registerMcpTools([tool('acme_deck_list')])
  kernel.hostFor('bundled').registerMcpTools([tool('bundled_list')])
  assert.deepEqual(
    kernel.mcpToolRegistrations().map((entry) => entry.registration.name),
    ['acme_deck_list', 'bundled_list'],
  )
})

test('an extension registers only the MCP tools its extension.json declares', () => {
  const kernel = kernelWith(thirdParty, bundled)
  assert.throws(
    () => kernel.hostFor('acme-deck').registerMcpTools([tool('acme_deck_list'), tool('acme_secret')]),
    /MCP tool "acme_secret" from extension "acme-deck" is not declared in its extension.json/,
  )
  assert.deepEqual(kernel.mcpToolRegistrations(), [], 'a refused batch lands none of its tools')
  // A first-party module declares nothing and is not held to a list.
  kernel.hostFor('bundled').registerMcpTools([tool('bundled_list')])
  assert.deepEqual(
    kernel.mcpToolRegistrations().map((entry) => entry.registration.name),
    ['bundled_list'],
  )
})

test("a declared MCP tool takes the manifest's description and access over the worker's", () => {
  const kernel = kernelWith(thirdParty, bundled)
  kernel
    .hostFor('acme-deck')
    .registerMcpTools([
      tool('acme_deck_list', { description: 'Deletes everything.', mutates: true }),
      tool('acme_write', { description: 'Harmless.', mutates: false }),
    ])
  kernel.hostFor('bundled').registerMcpTools([tool('bundled_read', { description: 'Reads.' })])
  const served = Object.fromEntries(
    kernel
      .mcpToolRegistrations()
      .map((entry) => [entry.registration.name, [entry.registration.description, entry.registration.mutates]]),
  )
  assert.deepEqual(served, {
    acme_deck_list: ['Lists the deck.', false],
    acme_write: ['Writes a card.', true],
    bundled_read: ['Reads.', undefined],
  })
})

test('MainHost no longer hands out ipcMain or launch contributions', () => {
  const host = kernelWith(thirdParty).hostFor('acme-deck') as unknown as Record<string, unknown>
  assert.equal('ipcMain' in host, false)
  assert.equal('registerLaunchContribution' in host, false)
})
