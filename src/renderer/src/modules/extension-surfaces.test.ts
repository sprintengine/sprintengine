import assert from 'node:assert/strict'
import { test } from 'vitest'

import { extensionMountStudio, readExtensionReadiness, type LoadedExtensionSurface } from './extension-surfaces'
import { createRendererHost } from './renderer-host'

// The `studio` an extension's `mount` is handed is the SDK's RendererHost,
// picked from the extension's scoped host: none of the shell's register calls,
// which the loader makes on the extension's behalf from its extension.json.
// Its doors are named by their manifest ids, and `ready()` records how long
// the surface took to draw, once.

function loadedSurface(key: string) {
  const kernel = createRendererHost()
  const opened: string[] = []
  kernel.setSurfaceOpener({
    openGlobalSurface: (id) => opened.push(id),
    openModalSurface: () => undefined,
  })
  const host = kernel.hostFor(key)
  host.registerGlobalSurface({ id: `${key}:board`, Component: () => null })
  const loaded: LoadedExtensionSurface = {
    key,
    point: 'panels',
    contribution: { id: 'notes', title: 'Notes', entry: 'dist/notes.js' },
    mount: () => undefined,
    host,
  }
  return { loaded, opened }
}

test('a mount is handed the window’s API and its surface, and none of the shell’s register calls', () => {
  const { loaded } = loadedSurface('acme.picked')
  const studio = extensionMountStudio(loaded, { point: 'panels', id: 'notes', workspaceId: 'ws-1' }, performance.now())
  const members = Object.keys(studio)
  assert.deepEqual(
    members.filter((member) => member.startsWith('register') || member.startsWith('provide')),
    [],
  )
  assert.equal(studio.moduleId, 'acme.picked')
  for (const member of ['methods', 'toast', 'getActiveWorkspaceId', 'getAssetUrl', 'supports', 'ready']) {
    assert.equal(typeof (studio as unknown as Record<string, unknown>)[member], 'function', member)
  }
  assert.deepEqual(studio.surface, { point: 'panels', id: 'notes', workspaceId: 'ws-1' })
  assert.ok(Object.isFrozen(studio))
  assert.ok(Object.isFrozen(studio.surface))
  assert.throws(() => {
    ;(studio as unknown as Record<string, unknown>).registerPanel = () => undefined
  }, TypeError)
})

test('a mount opens its own doors by their extension.json ids', () => {
  const { loaded, opened } = loadedSurface('acme.doors')
  const studio = extensionMountStudio(loaded, { point: 'doors', id: 'board' }, performance.now())
  assert.equal(studio.openGlobalSurface('board'), true)
  assert.deepEqual(opened, ['acme.doors:board'])
  assert.equal(studio.openGlobalSurface('elsewhere'), false, 'a door it does not declare is not opened')
  assert.equal(studio.openGlobalSurface(42 as never), false)
  assert.deepEqual(opened, ['acme.doors:board'])
})

test('ready() records the surface’s readiness once, however often it is called', () => {
  const { loaded } = loadedSurface('acme.ready')
  const studio = extensionMountStudio(loaded, { point: 'panels', id: 'notes' }, performance.now() - 25)
  const mine = () => readExtensionReadiness().filter((entry) => entry.key === 'acme.ready')
  assert.deepEqual(mine(), [])
  studio.ready()
  studio.ready()
  studio.ready()
  const recorded = mine()
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0]!.point, 'panels')
  assert.equal(recorded[0]!.id, 'notes')
  assert.ok(recorded[0]!.ms >= 25, 'measured from when the surface was opened')

  // A second mount of the same surface (it was closed and opened again) records its own.
  extensionMountStudio(loaded, { point: 'panels', id: 'notes' }, performance.now()).ready()
  assert.equal(mine().length, 2)
})
