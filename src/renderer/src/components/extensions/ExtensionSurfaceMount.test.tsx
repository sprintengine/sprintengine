// @vitest-environment jsdom

import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, test, vi } from 'vitest'

import { registerExtensionSurface, retireExtensionSurfaces } from '../../modules/extension-surfaces'
import { createRendererHost } from '../../modules/renderer-host'
import { extensionsDouble, resetExtensionsDouble } from '../../studio/extensions.double'
import { ExtensionSurfaceMount } from './ExtensionSurfaceMount'

vi.mock('../../studio/extensions', () => import('../../studio/extensions.double'))

// A surface's frame loads its document once. A second load is the frame
// leaving it (`location.href`, `location.replace`, a meta refresh): the window
// cannot see where it went, and the page there would inherit the bridge, so
// the surface is closed and the frame removed.

let root: Root | null = null
let container: HTMLElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  retireExtensionSurfaces('local.leaver')
  resetExtensionsDouble()
})

async function mounted() {
  const host = createRendererHost().hostFor('local.leaver')
  registerExtensionSurface({
    key: 'local.leaver',
    point: 'doors',
    contribution: { id: 'deck', title: 'Deck', entry: 'dist/deck.js' },
    host,
  })
  const calls: string[] = []
  extensionsDouble.extensionFrame = async () => ({ hash: 'a'.repeat(64), html: '<!doctype html>' })
  extensionsDouble.extensionCall = async ({ method }) => {
    calls.push(method)
    return { ok: true, result: null }
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<ExtensionSurfaceMount extensionKey="local.leaver" point="doors" id="deck" />)
  })
  await act(async () => undefined)
  return { calls, frame: () => container!.querySelector('iframe') }
}

// `location.href`, `location.replace` and a meta refresh all reach the window
// the same way, as the frame's second `load`; the desktop shell refuses them
// before that (privileged-window-navigation.test.ts).
test('a frame that loads a second document is closed and loses its bridge', async () => {
  const { calls, frame } = await mounted()
  const first = frame()
  assert.ok(first, 'the frame is drawn')
  assert.equal(first.getAttribute('sandbox'), 'allow-scripts')
  assert.match(first.getAttribute('src') ?? '', /\/ext-frame\/a{64}$/)
  await act(async () => void first.dispatchEvent(new Event('load')))
  assert.ok(frame(), 'its own document loading keeps it')

  // The page it navigated to loads, and asks for something through the bridge.
  const contentWindow = first.contentWindow
  await act(async () => void first.dispatchEvent(new Event('load')))
  assert.equal(frame(), null, 'the frame is gone')
  assert.match(container!.textContent ?? '', /tried to load another page in its place/)
  window.dispatchEvent(
    new MessageEvent('message', {
      source: contentWindow,
      data: { se: 1, kind: 'req', id: 1, method: 'workspace.list', params: {} },
    }),
  )
  await act(async () => undefined)
  assert.deepEqual(calls, [], 'nothing it asks reaches the Studio')
})
