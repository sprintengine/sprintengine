import assert from 'node:assert/strict'
import { test } from 'vitest'

import { STUDIO_AGENT_SETUP_METHODS } from '../src/agent-setup'
import { STUDIO_METHOD_ACCESS, parseStudioMethodParams } from '../src/methods'

// What a Studio's agents are set up with, as a Studio reads the params: what
// is kept, what is dropped, and what is refused before a domain is asked.

const ok = <T>(parsed: { ok: boolean; params?: T }) => (parsed.ok ? parsed.params : undefined)
const refused = (parsed: { ok: boolean }) => parsed.ok === false

test('a knowledge root is a workspace (or none) and a path inside it; a preview names a note', () => {
  assert.deepEqual(
    ok(parseStudioMethodParams('memory.index', { workspaceFolder: '/Users/dev/app', relativeRoot: 'docs', x: 1 })),
    {
      workspaceFolder: '/Users/dev/app',
      relativeRoot: 'docs',
    },
  )
  assert.deepEqual(ok(parseStudioMethodParams('memory.resolveRoot', { workspaceFolder: null })), {
    workspaceFolder: null,
    relativeRoot: null,
  })
  assert.ok(refused(parseStudioMethodParams('memory.index', { workspaceFolder: 7, relativeRoot: null })))
  assert.ok(refused(parseStudioMethodParams('memory.readPreview', { workspaceFolder: '/a', relativeRoot: null })))
})

test('every mutation carries a command id; the activity hook names its workspace and root', () => {
  for (const [method, spec] of Object.entries(STUDIO_AGENT_SETUP_METHODS))
    if (spec.mutation) assert.ok(refused(parseStudioMethodParams(method as never, {})), method)
  assert.ok(refused(parseStudioMethodParams('memoryActivity.install', { commandId: 'c', workspaceFolder: '/a' })))
  assert.deepEqual(
    ok(
      parseStudioMethodParams('memoryActivity.install', {
        commandId: 'c',
        workspaceFolder: '/a',
        memoryRelativeRoot: 'docs',
      }),
    ),
    { commandId: 'c', workspaceFolder: '/a', memoryRelativeRoot: 'docs' },
  )
})

test('an MCP sync keeps its own members; an area skill is one Studio ships', () => {
  const settings = { syncEnabled: true, servers: {} }
  assert.deepEqual(
    ok(
      parseStudioMethodParams('mcp.sync', {
        commandId: 'c',
        workspaceRoot: '/a',
        settings,
        write: true,
        injected: 1,
      }),
    ),
    { commandId: 'c', workspaceRoot: '/a', settings, write: true },
  )
  assert.ok(refused(parseStudioMethodParams('mcp.sync', { commandId: 'c', workspaceRoot: '/a', settings: [] })))
  assert.ok(
    refused(parseStudioMethodParams('areaSkills.setEnabled', { commandId: 'c', skillId: 'rm-rf', enabled: true })),
  )
  assert.deepEqual(ok(parseStudioMethodParams('agentConfig.detect', { sources: ['codex', 'other'] })), {
    sources: ['codex'],
  })
})

test('reading is files:read or providers:read; switching an area skill settings:write; writing what CLIs run an owner’s', () => {
  assert.deepEqual(STUDIO_METHOD_ACCESS['memory.index'], { permissions: ['filesystem:read'] })
  assert.deepEqual(STUDIO_METHOD_ACCESS['builtinSkills.list'], { permissions: ['providers:read'] })
  assert.deepEqual(STUDIO_METHOD_ACCESS['areaSkills.setEnabled'], { permissions: ['settings:write'] })
  const owners = Object.keys(STUDIO_AGENT_SETUP_METHODS).filter((method) => {
    const access = STUDIO_METHOD_ACCESS[method as keyof typeof STUDIO_METHOD_ACCESS]
    return 'permissions' in access && access.owner !== undefined
  })
  assert.deepEqual(owners.sort(), [
    'agentConfig.adopt',
    'mcp.sync',
    'memoryActivity.install',
    'memoryActivity.uninstall',
  ])
})
