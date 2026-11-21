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

const staged: Array<[string, string]> = []
afterEach(() => {
  delete (window as { api?: unknown }).api
  staged.length = 0
})
/** A desktop window: its shell stages the document and serves it from `studio-ext:`. */
function onDesktop() {
  ;(window as { api?: unknown }).api = {
    stageExtensionFrame: async (hash: string, html: string) => (staged.push([hash, html]), true),
  }
}

const ask = (source: Window | null, id: number, method = 'workspace.list') =>
  window.dispatchEvent(new MessageEvent('message', { source, data: { se: 1, kind: 'req', id, method, params: {} } }))

// The desktop shell refuses a frame's navigation before it starts
// (privileged-window-navigation.test.ts), and a browser tab's wrapper refuses
// it by its policy. Should a frame still leave its document, the window drops
// the bridge as it unloads (`leaving`), and at its second load at the latest.
test('a desktop frame that loads a second document is closed and loses its bridge', async () => {
  onDesktop()
  const { calls, frame } = await mounted()
  const first = frame()
  assert.ok(first, 'the frame is drawn')
  assert.equal(first.getAttribute('sandbox'), 'allow-scripts')
  assert.equal(first.getAttribute('src'), `studio-ext://frame/${'a'.repeat(64)}`)
  assert.equal(staged[0]?.[0], 'a'.repeat(64))
  await act(async () => void first.dispatchEvent(new Event('load')))
  assert.ok(frame(), 'its own document loading keeps it')

  // The page it navigated to loads, and asks for something through the bridge.
  const contentWindow = first.contentWindow
  await act(async () => void first.dispatchEvent(new Event('load')))
  assert.equal(frame(), null, 'the frame is gone')
  assert.match(container!.textContent ?? '', /tried to load another page in its place/)
  ask(contentWindow, 1)
  await act(async () => undefined)
  assert.deepEqual(calls, [], 'nothing it asks reaches the Studio')
})

test('a browser tab draws the frame inside Studio’s wrapper, and drops it once it unloads', async () => {
  const { calls, frame } = await mounted()
  const outer = frame()!
  assert.match(outer.getAttribute('src') ?? '', /\/ext-frame-host\/a{64}$/)
  assert.equal(outer.getAttribute('sandbox'), null, 'the wrapper runs no script; the frame inside carries the sandbox')
  // The wrapper loads with the extension's frame inside it.
  const wrapper = outer.contentDocument!
  if (!wrapper.documentElement) wrapper.append(wrapper.createElement('html'))
  wrapper.documentElement.append(wrapper.createElement('iframe'))
  await act(async () => void outer.dispatchEvent(new Event('load')))
  const surface = outer.contentWindow!.frames[0] as Window
  ask(surface, 1)
  await act(async () => undefined)
  assert.deepEqual(calls, ['workspace.list'], 'the frame inside the wrapper is the one heard')
  ask(outer.contentWindow, 2)
  await act(async () => undefined)
  assert.deepEqual(calls, ['workspace.list'], 'the wrapper itself is not')

  // The bootstrap says its document is unloading: the bridge goes at once.
  window.dispatchEvent(new MessageEvent('message', { source: surface, data: { se: 1, kind: 'evt', event: 'leaving' } }))
  await act(async () => undefined)
  ask(surface, 3)
  await act(async () => undefined)
  assert.deepEqual(calls, ['workspace.list'])
  assert.equal(frame(), null)
  assert.match(container!.textContent ?? '', /tried to load another page in its place/)
})

test('a frame drawn before its extension’s access grew is drawn again', async () => {
  onDesktop()
  const { frame } = await mounted()
  let built = 0
  extensionsDouble.extensionFrame = async () => ({ hash: (built++ ? 'c' : 'b').repeat(64), html: '<!doctype html>' })
  extensionsDouble.extensionCall = async () => ({
    ok: false,
    code: 'frame_outdated',
    message: 'drawn before it changed',
  })
  const first = frame()!
  ask(first.contentWindow, 1)
  await act(async () => undefined)
  await act(async () => undefined)
  assert.match(frame()?.getAttribute('src') ?? '', /studio-ext:\/\/frame\/b{64}$/, 'its document was built again')
})
