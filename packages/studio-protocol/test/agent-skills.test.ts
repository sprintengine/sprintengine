import assert from 'node:assert/strict'
import { test } from 'vitest'

import { STUDIO_AGENT_SKILLS_METHODS } from '../src/agent-skills'
import { STUDIO_AGENT_SKILLS_CAPABILITY } from '../src/handshake'
import { STUDIO_METHOD_ACCESS, parseStudioMethodParams } from '../src/methods'

// The `agent-skills` family's validators and grants: what each method takes,
// the names a folder travels under, and which are an owner's.

const ok = <T>(parsed: { ok: boolean; params?: T }) => (parsed.ok ? parsed.params : undefined)
const refused = (parsed: { ok: boolean }) => parsed.ok === false

test('every method is offered as agent-skills, and every mutation carries a command id', () => {
  for (const [method, spec] of Object.entries(STUDIO_AGENT_SKILLS_METHODS)) {
    assert.equal(spec.capability, STUDIO_AGENT_SKILLS_CAPABILITY, method)
    if (spec.mutation) assert.ok(refused(parseStudioMethodParams(method as never, {})), method)
  }
})

test('a folder a client that is not an owner may name travels as a folder, never as a conversation address', () => {
  // `workspaceRoot` is how a conversation is addressed, which the router
  // refuses to anyone but an owner: these take `workspaceFolder` instead.
  assert.ok(
    refused(parseStudioMethodParams('skills.uninstall', { commandId: 'c', workspaceRoot: '/a', dirName: 'd' })) ||
      !(
        'workspaceRoot' in
        (ok(parseStudioMethodParams('skills.uninstall', { commandId: 'c', workspaceRoot: '/a', dirName: 'd' })) ?? {})
      ),
  )
  assert.deepEqual(
    ok(parseStudioMethodParams('workspaceSkills.list', { workspaceFolder: '/Users/dev/app', includeGlobal: true })),
    { workspaceFolder: '/Users/dev/app', includeGlobal: true },
  )
  assert.deepEqual(ok(parseStudioMethodParams('workspaceSkills.list', {})), { workspaceFolder: null })
  assert.ok(refused(parseStudioMethodParams('workspaceSkills.list', { workspaceFolder: 7 })))
  assert.ok(refused(parseStudioMethodParams('designSystem.read', { bundleFolder: '' })))
  assert.ok(refused(parseStudioMethodParams('designSystem.read', { bundleFolder: '/a\0b' })))
})

test('an attach names a library entry or a folder; an installed copy names its CLI and machine', () => {
  assert.deepEqual(
    ok(
      parseStudioMethodParams('designSystem.attach', {
        commandId: 'c',
        source: { kind: 'folder', folder: '/Users/dev/ds', extra: 1 },
        workspaceFolder: '/Users/dev/app',
      }),
    ),
    { commandId: 'c', source: { kind: 'folder', folder: '/Users/dev/ds' }, workspaceFolder: '/Users/dev/app' },
  )
  assert.ok(
    refused(
      parseStudioMethodParams('designSystem.attach', {
        commandId: 'c',
        source: { kind: 'path', path: '/x' },
        workspaceFolder: '/Users/dev/app',
      }),
    ),
  )
  assert.ok(
    refused(parseStudioMethodParams('installedSkills.list', { workspaceFolder: null, pluginId: 'c', hostId: 'ssh:x' })),
  )
  assert.deepEqual(
    ok(
      parseStudioMethodParams('installedSkills.list', {
        workspaceFolder: null,
        pluginId: 'claude-code',
        pathStyle: 'wsl',
        hostId: 'wsl:Ubuntu',
      }),
    ),
    { workspaceFolder: null, pluginId: 'claude-code', pathStyle: 'wsl', hostId: 'wsl:Ubuntu' },
  )
})

test("a card's actions are read again by the Studio; here, only their shape", () => {
  const card = {
    commandId: 'c',
    slug: 'card',
    actions: [{ verb: 'install.skill' }],
    workspaceRoot: '/Users/dev/app',
    cloneParentDir: null,
    mcpServers: [],
    mcpSyncEnabled: true,
    permissionPreset: 'auto',
  }
  assert.ok(ok(parseStudioMethodParams('cards.run', card)))
  assert.ok(refused(parseStudioMethodParams('cards.run', { ...card, actions: 'all' })))
  assert.ok(refused(parseStudioMethodParams('cards.run', { ...card, permissionPreset: 'root' })))
  assert.ok(refused(parseStudioMethodParams('cards.run', { ...card, mcpSyncEnabled: 'yes' })))
})

test('a plugin, a bundle lint and a card are an owner’s, each with its reason; the rest go by scope', () => {
  const owners = Object.keys(STUDIO_AGENT_SKILLS_METHODS)
    .filter((method) => {
      const access = STUDIO_METHOD_ACCESS[method as keyof typeof STUDIO_AGENT_SKILLS_METHODS]
      return 'permissions' in access && access.owner !== undefined
    })
    .sort()
  assert.deepEqual(owners, ['cards.run', 'designSystem.lint', 'skillPlugins.install', 'skillPlugins.uninstall'])
  for (const method of owners) {
    const access = STUDIO_METHOD_ACCESS[method as keyof typeof STUDIO_AGENT_SKILLS_METHODS]
    assert.ok('owner' in access && typeof access.owner === 'string' && access.owner.length > 20, method)
  }
})
