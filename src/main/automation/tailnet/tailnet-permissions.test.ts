import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import gatewayToolsList from '../__fixtures__/gateway-tools-list.json'
import { authorizeStudioAccess, isStudioPermission } from '../../../../packages/studio-protocol/src/permissions'
import {
  TAILNET_SCOPES,
  TAILNET_SCOPE_PERMISSIONS,
  tailnetDevicePrincipal,
  tailnetScopeGrantsAccess,
  type TailnetScope,
} from '../../../shared/tailnet'
import { TAILNET_DEVICES_FILENAME, createTailnetDeviceStore } from './tailnet-devices'
import { tailnetDeviceRouteOf, tailnetUpgradeRouteOf } from './tailnet-gateway-server'
import {
  TAILNET_IDENTITY_PATH,
  TAILNET_STREAM_PATH,
  TAILNET_STUDIO_PATH,
  TAILNET_MCP_PATH,
  TAILNET_WS_TICKET_PATH,
} from './tailnet-routes'
import { TAILNET_ROUTE_ACCESS, tailnetToolAccess, type TailnetDeviceRoute } from './tailnet-scopes'

// What a paired device (another desktop, the phone) may ask, before and after
// every check went through `authorizeStudioAccess`. The oracles below are the
// checks as they stood, frozen, and every set of the six scopes is held to
// them for every route and tool.

function* scopeSubsets(): Generator<TailnetScope[]> {
  for (let mask = 0; mask < 1 << TAILNET_SCOPES.length; mask++)
    yield TAILNET_SCOPES.filter((_scope, index) => (mask & (1 << index)) !== 0)
}

const legacy = (scopes: TailnetScope[], needed: TailnetScope) => tailnetScopeGrantsAccess(new Set(scopes), needed)

// The tool rule as it stood before permissions, copied, so the live rule is
// held to it rather than to itself.
const LEGACY_TERMINAL_LAUNCH_TOOLS = new Set(['terminal.create', 'agent.launch', 'backlog.work'])
const LEGACY_CHAT_TO_CHAT_TOOLS = new Set([
  'conversation.send',
  'conversation.read',
  'conversation.wait',
  'conversation.interrupt',
  'subagent.start',
  'subagent.status',
  'subagent.cancel',
])
const LEGACY_CHAT_LIFECYCLE_TOOLS = new Set([
  'conversation.settle',
  'conversation.visit',
  'conversation.mark_unread',
  'conversation.snooze',
  'conversation.highlight',
  'conversation.auto_settle',
])
function legacyLocalOnly(toolName: string): boolean {
  return (
    toolName.startsWith('tailnet.') ||
    LEGACY_TERMINAL_LAUNCH_TOOLS.has(toolName) ||
    toolName.startsWith('pull_request.') ||
    toolName.startsWith('local_server.') ||
    toolName === 'artifacts.setup' ||
    toolName === 'artifacts.publish' ||
    toolName === 'artifacts.update' ||
    toolName === 'artifacts.delete' ||
    toolName.startsWith('extension.') ||
    toolName.startsWith('plugin.') ||
    toolName.startsWith('worktree.') ||
    LEGACY_CHAT_TO_CHAT_TOOLS.has(toolName) ||
    toolName.startsWith('visual.') ||
    // Since `schedules.*` on the protocol: a device's way to the schedules.
    toolName.startsWith('schedule.') ||
    // Since `conversation.settle` and `chat-lifecycle` on the protocol: a device's way to a chat's record.
    LEGACY_CHAT_LIFECYCLE_TOOLS.has(toolName) ||
    // Since `canvas.*` on the protocol: a device's way to the boards.
    toolName.startsWith('canvas.') ||
    toolName.startsWith('terminal.') ||
    // Since a device was found reading the person's in-app browser pane: the agents' tools here alone.
    toolName.startsWith('browser.')
  )
}
function legacyRequiredScopeForTool(toolName: string, isMutation: boolean): TailnetScope {
  if (toolName.startsWith('conversation.')) return isMutation ? 'conversation:operate' : 'conversation:read'
  const family = toolName.startsWith('backlog.') ? 'backlog' : 'workspace'
  return `${family}:${isMutation ? 'operate' : 'read'}` as TailnetScope
}

/** Each route's check, as the gateway wrote it by hand. */
const LEGACY_ROUTES: { [R in TailnetDeviceRoute]: (scopes: TailnetScope[]) => boolean } = {
  identity: () => true,
  'ws-ticket': () => true,
  mcp: () => true,
  stream: () => true,
  // Newer still: the Studio protocol, whose methods are judged one by one by the Studio router.
  studio: () => true,
}

test('each of the six scopes carries only permissions from the closed set, and none a device was never given', () => {
  for (const scope of TAILNET_SCOPES)
    for (const permission of TAILNET_SCOPE_PERMISSIONS[scope]) assert.equal(isStudioPermission(permission), true)
  const carried = new Set(TAILNET_SCOPES.flatMap((scope) => TAILNET_SCOPE_PERMISSIONS[scope]))
  for (const permission of [
    'filesystem:read',
    'filesystem:write',
    'settings:write',
    'environment:maintain',
    'conversation:create',
    'tools:offer',
  ])
    assert.equal(carried.has(permission as never), false, permission)
  assert.equal(tailnetDevicePrincipal(TAILNET_SCOPES).owner, false, 'a device is never an owner')
})

test('every route a device token opens is declared, and every set of scopes reaches exactly what it did', () => {
  assert.deepEqual(Object.keys(TAILNET_ROUTE_ACCESS).sort(), Object.keys(LEGACY_ROUTES).sort())
  for (const scopes of scopeSubsets()) {
    const principal = tailnetDevicePrincipal(scopes)
    for (const route of Object.keys(TAILNET_ROUTE_ACCESS) as TailnetDeviceRoute[])
      assert.equal(
        authorizeStudioAccess(principal, TAILNET_ROUTE_ACCESS[route]).ok,
        LEGACY_ROUTES[route](scopes),
        `${route} for [${scopes.join(', ')}]`,
      )
  }
})

test('an authenticated request names its route, and anything else is no route', () => {
  assert.equal(tailnetDeviceRouteOf('GET', TAILNET_IDENTITY_PATH), 'identity')
  assert.equal(tailnetDeviceRouteOf('POST', TAILNET_WS_TICKET_PATH), 'ws-ticket')
  assert.equal(tailnetDeviceRouteOf('POST', TAILNET_MCP_PATH), 'mcp')
  assert.equal(tailnetDeviceRouteOf('GET', TAILNET_MCP_PATH), null, 'the wrong verb is no route')
  // The conversation lane's routes went when every client moved to the Studio socket.
  for (const gone of ['upload', 'conversation-image', 'conversation-files', 'conversation-commands'])
    assert.equal(
      tailnetDeviceRouteOf('GET', `/tailnet/v1/${gone}`) ?? tailnetDeviceRouteOf('POST', `/tailnet/v1/${gone}`),
      null,
      gone,
    )
  assert.equal(tailnetDeviceRouteOf('GET', '/tailnet/v1/terminal'), null)
  assert.equal(tailnetDeviceRouteOf('GET', '/tailnet/v1/constructor'), null)
})

test('each upgrade path names its route, and every declared route is one some request resolves to', () => {
  assert.equal(tailnetUpgradeRouteOf(TAILNET_STREAM_PATH), 'stream')
  // The lanes went to the Studio socket: boards with `canvas.*`, chats and
  // the change feed with `conversation.*` and `conversations.changed`.
  for (const gone of ['/tailnet/v1/canvas', '/tailnet/v1/conversation', '/tailnet/v1/events'])
    assert.equal(tailnetUpgradeRouteOf(gone), null, gone)
  assert.equal(tailnetUpgradeRouteOf(TAILNET_STUDIO_PATH), 'studio')
  assert.equal(tailnetUpgradeRouteOf(TAILNET_MCP_PATH), null)
  // No path reaches a machine this desktop holds: SSH and WSL machines are reached from this desktop only.
  assert.equal(tailnetUpgradeRouteOf('/tailnet/v1/environments/env-build-box/studio'), null)
  // No entry in the table goes unconsulted: each is what some request is judged by.
  const resolved = new Set<string>([
    ...[TAILNET_STREAM_PATH, TAILNET_STUDIO_PATH].map((path) => tailnetUpgradeRouteOf(path)!),
    tailnetDeviceRouteOf('GET', TAILNET_IDENTITY_PATH)!,
    tailnetDeviceRouteOf('POST', TAILNET_WS_TICKET_PATH)!,
    tailnetDeviceRouteOf('POST', TAILNET_MCP_PATH)!,
  ])
  assert.deepEqual([...resolved].sort(), Object.keys(TAILNET_ROUTE_ACCESS).sort())
})

test('every tool, local-only or served, is judged for every set of scopes as before', () => {
  const corpus = new Set<string>([
    ...Object.values(gatewayToolsList).flatMap((list) => list.map((tool) => tool.name)),
    // Names no registration holds today, across every family and prefix rule.
    'tailnet.mint_admin',
    'artifacts.publish',
    'artifacts.list',
    'conversation.wait',
    'agent.launch',
    'terminal.write',
    'pull_request.merge',
    'local_server.kill',
    'extension.publish',
    'worktree.claim',
    'visual.render',
    'backlog.purge',
    'conversation.export',
    'widget_write',
    'module.something_new',
    '',
  ])
  let compared = 0
  for (const scopes of scopeSubsets()) {
    const principal = tailnetDevicePrincipal(scopes)
    for (const tool of corpus)
      for (const isMutation of [false, true]) {
        const before = !legacyLocalOnly(tool) && legacy(scopes, legacyRequiredScopeForTool(tool, isMutation))
        const decision = authorizeStudioAccess(principal, tailnetToolAccess(tool, isMutation))
        assert.equal(decision.ok, before, `${tool} (${isMutation ? 'mutation' : 'read'}) [${scopes.join(', ')}]`)
        // A local-only tool is refused as one, whatever the grant.
        if (legacyLocalOnly(tool)) assert.equal(!decision.ok && decision.reason, 'local_only')
        compared++
      }
  }
  assert.ok(compared > 64 * 2 * 100)
})

test('a device stored before permissions loads as it was and is judged by its scopes, without pairing again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tailnet-permissions-'))
  try {
    writeFileSync(
      join(dir, TAILNET_DEVICES_FILENAME),
      JSON.stringify({
        version: 1,
        devices: [
          {
            id: 'dev-1',
            name: 'android-phone',
            tokenHash: 'stored-hash',
            createdAt: '2026-09-01T00:00:00.000Z',
            // A scope retired with the terminals, beside two that still mean something.
            scopes: ['terminal:control', 'conversation:operate', 'backlog:read'],
          },
        ],
      }),
      { mode: 0o600 },
    )
    const store = createTailnetDeviceStore({ resolveUserDataDir: () => dir })
    const [device] = store.listDevices()
    assert.deepEqual(device.scopes, ['backlog:read', 'conversation:operate'])
    const principal = tailnetDevicePrincipal(device.scopes)
    assert.deepEqual([...principal.permissions].sort(), ['backlog:read', 'conversation:operate', 'conversation:read'])
    assert.equal(authorizeStudioAccess(principal, tailnetToolAccess('workspace.list', false)).ok, false)
    assert.equal(authorizeStudioAccess(principal, tailnetToolAccess('terminal.read', false)).ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
