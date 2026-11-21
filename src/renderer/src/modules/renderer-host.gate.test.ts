import assert from 'node:assert/strict'
import { test } from 'vitest'

import { EXTENSION_RENDERER_METHODS } from '../../../../packages/extension-sdk/src/services'
import { createFakeRendererHost } from '../../../../packages/extension-sdk/src/testing'
import type { CapabilityManifest } from '../../../shared/modules/manifest'
import { createRendererHost } from './renderer-host'

// The window's host holds an extension's surface to what its approval
// covers (EXTENSION_RENDERER_METHODS), and refuses what the SDK's fake host
// refuses, from the same table.

function manifest(permissions: string[], source: CapabilityManifest['source'] = 'third-party'): CapabilityManifest {
  return { id: 'local.board', displayName: 'Board', version: 1, defaultEnabled: true, source, permissions }
}

test('an approved ui extension with no permissions is refused the workspace, its state and its settings', async () => {
  const host = createRendererHost().hostFor('local.board', manifest([]))
  await assert.rejects(host.getWorkspace('ws-1'), /not approved for "workspace:read", which "getWorkspace" needs/)
  await assert.rejects(host.listWorkspaces(), /"workspace:read"/)
  await assert.rejects(host.getWorkingRoot('ws-1'), /"workspace:read"/)
  assert.throws(() => host.watchWorkspaces(() => {}), /"workspace:read"/)
  // An async method refuses with a rejected promise, never a throw.
  const watched = host.watchWorkspaceFile('ws-1', 'notes.md', () => {})
  assert.ok(watched instanceof Promise)
  await assert.rejects(watched, /"workspace:read"/)
  assert.throws(() => host.getWorkspaceModuleState('ws-1'), /"storage:own"/)
  assert.throws(() => host.setWorkspaceModuleState('ws-1', {}), /"storage:own"/)
  assert.throws(() => host.getModuleAppState('key'), /"settings:own"/)
  assert.throws(() => host.setModuleAppState('key', 1), /"settings:own"/)
  assert.throws(() => host.watchModuleAppState(() => {}), /"settings:own"/)
  const git = await host.getWorkspaceGitInfo('ws-1')
  assert.equal(!git.ok && git.code, 'not_permitted')
})

test('what the approval covers goes through, and the app’s own modules are not held to it', async () => {
  const approved = createRendererHost().hostFor('local.board', manifest(['workspace:read', 'settings:own']))
  assert.deepEqual(await approved.listWorkspaces(), [])
  assert.equal(approved.getModuleAppState('key'), undefined)
  const bundled = createRendererHost().hostFor('board', manifest([], 'bundled'))
  assert.deepEqual(await bundled.listWorkspaces(), [])
})

test('the window and the fake host refuse the same calls', async () => {
  const real = createRendererHost().hostFor('local.board', manifest([])) as unknown as Record<string, unknown>
  const fake = createFakeRendererHost({ moduleId: 'local.board', permissions: [] }).host as unknown as Record<
    string,
    unknown
  >
  const refusal = async (host: Record<string, unknown>, method: string): Promise<string> => {
    try {
      const answer = await (host[method] as (...args: unknown[]) => unknown)('ws-1', 'x', () => {})
      return (answer as { ok?: boolean; code?: string } | undefined)?.code ?? 'went through'
    } catch {
      return 'refused'
    }
  }
  for (const method of Object.keys(EXTENSION_RENDERER_METHODS)) {
    if (method === 'openChat') continue
    const [byWindow, byFake] = [await refusal(real, method), await refusal(fake, method)]
    assert.equal(byWindow, byFake, method)
    assert.notEqual(byWindow, 'went through', method)
  }
})
