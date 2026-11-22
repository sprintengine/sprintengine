import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { StudioGrant } from '../../../../packages/studio-protocol/src/envelope'
import { starterOfGrant } from '../../rpc/studio-rpc-router'
import { createConversationLaunchService } from '../../../main/conversation-launch-service'
import { clampToInvoker, runAsInvoker } from '../../../main/module-host/extension-invocation'
import { emptyAgentLaunchSettings } from '../../../shared/launch-settings'
import type { AgentState } from '../../../shared/agent-state'
import type { ConversationSessionSummary } from '../../../shared/conversation-runtime'
import { personStartsWindowAgents } from '../../../main/workspace-sync-service'
import { createHookInvokers, invokerOfGrant } from './hook-invokers'

// Who a hook runs as: whoever started the agent, kept on its record as a
// structured starter (never parsed out of a launch id), read as it stands at
// each hook and never looser than the chat's own preset; a gateway caller under
// its own launch ceiling; and no one where Studio cannot say who.

const app: StudioGrant = {
  clientId: 'app-1',
  name: 'Notes app',
  owner: false,
  scopes: ['workspaces:read'],
  ceiling: 'auto',
}
const device: StudioGrant = {
  clientId: 'tailnet:dev-7',
  name: 'android-phone',
  owner: false,
  scopes: ['conversation:read', 'conversation:operate'],
  ceiling: 'bypass',
}
const grants = new Map([app, device].map((grant) => [grant.clientId, grant]))

function invokers(presets: Record<string, string> = {}) {
  const made = createHookInvokers({
    resolveAgentPermissionPreset: ({ agentId }) => (presets[agentId] as never) ?? null,
  })
  made.bindClients((clientId) => grants.get(clientId) ?? null)
  return made
}

test('an owner chat runs its hooks as the person, held to the chat’s own preset', () => {
  const invoker = invokers().ofAgent({ startedBy: { kind: 'person' }, cliPermissionPreset: 'manual' })
  assert.equal(invoker.principal.owner, true)
  assert.equal(invoker.permissionCeiling, 'manual')
})

test('an app-started chat runs its hooks as the app as it holds now, never looser than the chat', () => {
  const invoker = invokers().ofAgent({ startedBy: starterOfGrant(app), cliPermissionPreset: 'bypass' })
  assert.deepEqual(invoker, { ...invokerOfGrant(app), permissionCeiling: 'auto' })
  assert.equal(invoker.principal.owner, false)
})

test('a device-started chat keeps the device’s whole client id, and runs its hooks as that device', () => {
  const starter = starterOfGrant(device)
  assert.deepEqual(starter, { kind: 'client', clientId: 'tailnet:dev-7' })
  const invoker = invokers().ofAgent({ startedBy: starter, cliPermissionPreset: 'auto' })
  assert.equal(invoker.label, '"android-phone"')
  assert.ok(invoker.principal.permissions.size > 0, 'the device’s own permissions, not no one’s')
  // Revoked since: no one.
  grants.delete('tailnet:dev-7')
  assert.equal(invokers().ofAgent({ startedBy: starter }).principal.permissions.size, 0)
  grants.set('tailnet:dev-7', device)
})

test('an agent that says no starter runs its hooks as no one, never as the person', () => {
  for (const agent of [undefined, {}, { startedBy: { kind: 'nobody' as const } }]) {
    const invoker = invokers().ofAgent(agent)
    assert.equal(invoker.principal.owner, false)
    assert.equal(invoker.principal.permissions.size, 0)
  }
})

test('an agent a window adds is the person’s, and one already there keeps what it was', () => {
  const state = { workspaces: [{ id: 'ws-1', agents: { known: { startedBy: { kind: 'nobody' } } } }] } as never
  const added = personStartsWindowAgents(
    { type: 'workspace.update_agent', payload: { workspaceId: 'ws-1', agentId: 'new', patch: {}, configEditedAt: 1 } },
    state,
  )
  assert.deepEqual((added as { payload: { patch: Partial<AgentState> } }).payload.patch.startedBy, { kind: 'person' })
  const kept = personStartsWindowAgents(
    {
      type: 'workspace.update_agent',
      payload: { workspaceId: 'ws-1', agentId: 'known', patch: {}, configEditedAt: 1 },
    },
    state,
  )
  assert.equal((kept as { payload: { patch: Partial<AgentState> } }).payload.patch.startedBy, undefined)
})

test('a chat an extension creates keeps who its call served, so its hooks after that call ended run as them', async () => {
  const written: AgentState[] = []
  const service = createConversationLaunchService({
    getWorkspace: () => ({ id: 'ws-1', folderPath: '/repo/a', agents: {} }),
    getLaunchSettings: () => emptyAgentLaunchSettings(),
    writeAgent: (_workspaceId, _agentId, agent) => {
      if (agent) written.push(agent)
      return { ok: true }
    },
    listWorkspaces: () => [],
    createWorkspace: () => ({ ok: false, message: 'not here' }),
    removeWorkspace: () => undefined,
    startSession: async (input) => ({
      ok: true,
      session: {
        sessionId: 'conv_1',
        workspaceId: input.workspaceId,
        agentId: input.agentId,
      } as ConversationSessionSummary,
    }),
    send: async () => ({ ok: true }) as never,
  })
  // The extension's call serves the device; the chat is made during it.
  await runAsInvoker(invokerOfGrant(device), () => service.launch({ workspaceId: 'ws-1', cli: 'claude-code' }))
  const record = written[0]!
  assert.deepEqual(record.startedBy, { kind: 'client', clientId: 'tailnet:dev-7' })
  // Later, outside any call: the device, not the person.
  const invoker = invokers().ofAgent(record)
  assert.equal(invoker.principal.owner, false)
  assert.equal(invoker.label, '"android-phone"')
})

test('a hook for a Manual agent’s action cannot start a Bypass chat: the agent’s ceiling holds', () => {
  const context = { metadata: { kind: 'studio-agent', agentId: 'agent-m', workspaceId: 'ws-1' } } as never
  const invoker = invokers({ 'agent-m': 'manual' }).ofGatewayCaller(context)
  assert.equal(invoker.permissionCeiling, 'manual')
  assert.equal(
    runAsInvoker(invoker, () => clampToInvoker('bypass')),
    'manual',
    'a chat the hook starts is lowered to the agent’s own preset',
  )
  // An agent chat's own tool hooks hold to that chat's preset, whoever started it.
  const chatHook = invokers().ofAgent({ startedBy: { kind: 'agent', ceiling: 'auto' }, cliPermissionPreset: 'manual' })
  assert.equal(
    runAsInvoker(chatHook, () => clampToInvoker('bypass')),
    'manual',
  )
  // A paired device calling through the gateway is that device.
  const remote = invokers().ofGatewayCaller({ metadata: { kind: 'remote-tailnet', deviceId: 'dev-7' } } as never)
  assert.equal(remote.label, '"android-phone"')
})
