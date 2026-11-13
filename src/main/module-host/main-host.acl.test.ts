import assert from 'node:assert/strict'

import type { CapabilityManifest } from '../../shared/modules/manifest'
import type { McpToolRegistration } from '../../shared/modules/mcp-tools'
import { createMainKernel, createServiceToken, THIRD_PARTY_SERVICE_KEYS } from './main-host'
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
  permissions: ['mcp:tools'],
}
const otherThirdParty: CapabilityManifest = {
  id: 'acme-other',
  displayName: 'Acme Other',
  version: 1,
  defaultEnabled: true,
  source: 'third-party',
}

function kernelWith(...manifests: CapabilityManifest[]) {
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]))
  return createMainKernel({ resolveModuleManifest: (id) => byId.get(id) })
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
  kernel.hostFor('@host').provideService(serviceTokens.ModuleStorageToken, () => storage as never)
  kernel.hostFor('@host').provideService(serviceTokens.WorkspaceServiceToken, () => storage as never)

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
  // A service that names no module, and a first-party module, are handed it as is.
  assert.equal(kernel.hostFor('acme-deck').requireService(serviceTokens.WorkspaceServiceToken), storage)
  assert.equal(kernel.hostFor('bundled').requireService(serviceTokens.ModuleStorageToken), storage)
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

test('a third-party module needs mcp:tools to register MCP tools', () => {
  const kernel = kernelWith(thirdParty, otherThirdParty, bundled)
  assert.throws(
    () => kernel.hostFor('acme-other').registerMcpTools([tool('acme_other_list')]),
    /must declare the "mcp:tools" permission/,
  )
  assert.equal(kernel.mcpToolRegistrations().length, 0)
  kernel.hostFor('acme-deck').registerMcpTools([tool('acme_deck_list')])
  kernel.hostFor('bundled').registerMcpTools([tool('bundled_list')])
  assert.deepEqual(
    kernel.mcpToolRegistrations().map((entry) => entry.registration.name),
    ['acme_deck_list', 'bundled_list'],
  )
})

test('third-party MCP tools mutate unless they say they do not', () => {
  const kernel = kernelWith(thirdParty, bundled)
  kernel
    .hostFor('acme-deck')
    .registerMcpTools([tool('acme_write'), tool('acme_read', { mutates: false }), tool('acme_set', { mutates: true })])
  kernel.hostFor('bundled').registerMcpTools([tool('bundled_read')])
  const mutates = Object.fromEntries(
    kernel.mcpToolRegistrations().map((entry) => [entry.registration.name, entry.registration.mutates]),
  )
  assert.deepEqual(mutates, { acme_write: true, acme_read: false, acme_set: true, bundled_read: undefined })
})

test('MainHost no longer hands out ipcMain or launch contributions', () => {
  const host = kernelWith(thirdParty).hostFor('acme-deck') as unknown as Record<string, unknown>
  assert.equal('ipcMain' in host, false)
  assert.equal('registerLaunchContribution' in host, false)
})
