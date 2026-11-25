// @vitest-environment jsdom

import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, test, vi } from 'vitest'

import type { ExtensionContributionsResult } from '../../../../shared/modules/manifest'
import type { StudioExtensionCall } from '../../../../../packages/studio-protocol/src/public'
import { loadExtensionContributions, reconcileExtensionContributions } from '../../modules/extension-contributions'
import { getExtensionSurface, retireExtensionSurfaces } from '../../modules/extension-surfaces'
import { createRendererHost } from '../../modules/renderer-host'
import { extensionsDouble, resetExtensionsDouble } from '../../studio/extensions.double'
import type { ComponentsPanelSession } from './components/componentsPanelSession'
import { n } from './components/componentsTestKit'
import { ExtensionSurfaceMount } from './ExtensionSurfaceMount'

vi.mock('../../studio/extensions', () => import('../../studio/extensions.double'))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Every components panel session the mount starts, with how many listeners
// each still has: the drawing's subscription is what keeps a run on screen.
const runs = vi.hoisted(() => [] as Array<{ session: ComponentsPanelSession; listeners: () => number }>)
vi.mock('./components/componentsPanelSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./components/componentsPanelSession')>()
  return {
    ...actual,
    createComponentsPanelSession: (options: Parameters<typeof actual.createComponentsPanelSession>[0]) => {
      const session = actual.createComponentsPanelSession(options)
      let listeners = 0
      const counted = {
        ...session,
        subscribe(listener: () => void) {
          listeners += 1
          const stop = session.subscribe(listener)
          return () => {
            listeners -= 1
            return stop()
          }
        },
      }
      runs.push({ session: counted, listeners: () => listeners })
      return counted
    },
  }
})

// A components panel runs its module hidden, in the same frame an html panel
// draws itself in, so it ends the same ways: when its extension is killed or
// loses its approval the Studio stops serving it and its surface is retired,
// and when it is switched off the pane stops drawing the panel. Either way the
// frame goes, its bridge stops hearing the run, and the window draws none of
// its tree. A fresh approval starts a new run with a new frame, from nothing.

let root: Root | null = null
let container: HTMLElement | null = null
const keys: string[] = []
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  for (const key of keys.splice(0)) retireExtensionSurfaces(key)
  resetExtensionsDouble()
  runs.length = 0
  delete (window as { api?: unknown }).api
  vi.unstubAllGlobals()
})

/** What the Studio serves: one extension with one components panel. */
function served(key: string): ExtensionContributionsResult {
  const id = key.slice(key.indexOf('.') + 1)
  // The served extension carries its extension.json as it is, `ui` included,
  // though the wire's view of a surface does not name it.
  const panel = { id: 'board', title: 'Board', entry: 'src/board.tsx', ui: 'components' }
  return {
    extensions: [
      {
        id: key,
        manifest: { id: key, displayName: id, version: '1.0.0', defaultEnabled: true, source: 'third-party' },
        extension: {
          manifestVersion: 1,
          id,
          version: '1.0.0',
          engines: { studio: '>=0.13.0' },
          tier: 'ui',
          name: 'Board',
          permissions: [],
          contributes: {
            commands: [],
            menus: [],
            topBarItems: [],
            panels: [panel],
            doors: [],
            settingsSections: [],
            mcpTools: [],
            hooks: [],
            events: [],
            syntaxes: [],
            customEditors: [],
            keybindings: [],
            statusBarItems: [],
            settings: [],
            skills: [],
            mcpServers: [],
            providers: [],
          },
        },
      },
    ],
    failures: {},
  }
}

/** A components panel, served and drawn in a desktop window. */
async function panelDrawn(key: string) {
  keys.push(key)
  const shipped = served(key)
  const loaded = loadExtensionContributions(createRendererHost(), shipped, true)
  assert.ok(getExtensionSurface(key, 'panels', 'board'))
  // Each frame document the Studio builds has a hash of its own.
  const built: string[] = []
  extensionsDouble.extensionFrame = async () => {
    const hash = String.fromCharCode(97 + built.length).repeat(64)
    built.push(hash)
    return { hash, html: '<!doctype html>' }
  }
  const calls: StudioExtensionCall[] = []
  extensionsDouble.extensionCall = async (call) => {
    calls.push(call)
    return { ok: true, result: null }
  }
  // Studio's push events for the extension: whether the window still follows them.
  const following = { count: 0 }
  extensionsDouble.onExtensionEvents = () => {
    following.count += 1
    return () => void (following.count -= 1)
  }
  ;(window as { api?: unknown }).api = { stageExtensionFrame: async () => true }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<ExtensionSurfaceMount extensionKey={key} point="panels" id="board" workspaceId="ws" />)
  })
  await act(async () => undefined)
  const frame = () => container!.querySelector('iframe')
  return { shipped, loaded, built, calls, following, frame }
}

/** The hidden guest's runtime in a frame: what it sends the window, and what the window sends it. */
function guestIn(frame: HTMLIFrameElement) {
  const window_ = frame.contentWindow!
  const received: Array<{ event?: string; payload?: unknown }> = []
  window_.postMessage = ((message: { event?: string; payload?: unknown }) =>
    void received.push(message)) as typeof window_.postMessage
  const send = async (event: string, payload: unknown) => {
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', { source: window_, data: { se: 1, kind: 'evt', event, payload } }),
      )
    })
  }
  return {
    received,
    ready: (document: string) => send('ui.ready', { document }),
    render: (document: string, revision: number, tree: unknown) => send('ui.render', { document, revision, tree }),
  }
}

const text = () => container?.textContent ?? ''

test('a components panel runs hidden in its frame, and the window draws the tree it renders', async () => {
  const { frame, built } = await panelDrawn('local.cards')
  const hidden = frame()!
  assert.equal(hidden.getAttribute('src'), `studio-ext://frame/${built[0]}`)
  assert.equal(hidden.getAttribute('sandbox'), 'allow-scripts')
  assert.equal(hidden.getAttribute('aria-hidden'), 'true')
  assert.equal(hidden.getAttribute('tabindex'), '-1')
  assert.match(hidden.className, /\bh-px\b/)
  assert.match(hidden.className, /\bw-px\b/)
  assert.match(hidden.className, /\bopacity-0\b/)

  const guest = guestIn(hidden)
  await guest.ready('run-1')
  assert.deepEqual(
    guest.received.map((message) => message.event),
    ['ui.hydrate'],
  )
  await guest.render('run-1', 1, n('Text', {}, ['First run']))
  assert.match(text(), /First run/)
})

test('killed, or no longer approved: the frame goes, the run is heard no more, and a fresh approval starts a new run', async () => {
  const { shipped, loaded, built, following, frame } = await panelDrawn('local.revoked-board')
  const first = frame()!
  const guest = guestIn(first)
  await guest.ready('run-1')
  await guest.render('run-1', 1, n('Text', {}, ['Before the revocation']))
  assert.match(text(), /Before the revocation/)
  assert.equal(following.count, 1)
  assert.equal(runs.length, 1)
  assert.equal(runs[0]!.listeners(), 1, 'the window draws the run')

  // The kill list names its version, or its approval is withdrawn: either
  // way the Studio no longer serves it, and the window retires its surfaces.
  let kept: ReturnType<typeof reconcileExtensionContributions> = []
  await act(async () => {
    kept = reconcileExtensionContributions(loaded, { extensions: [], failures: {} })
  })
  assert.deepEqual(kept, [])
  assert.equal(frame(), null, 'the frame is gone')
  assert.doesNotMatch(text(), /Before the revocation/, 'none of its tree is drawn')
  assert.match(text(), /not available here/)
  assert.equal(runs[0]!.listeners(), 0, 'nothing draws the run any more')
  assert.equal(following.count, 0, 'Studio’s events for it are no longer followed')

  // The run it had, still going in a frame the window let go, is heard no more.
  const answered = guest.received.length
  await guest.render('run-1', 2, n('Text', {}, ['After the revocation']))
  await guest.ready('run-1b')
  assert.equal(guest.received.length, answered, 'nothing is sent to it')
  assert.equal(runs[0]!.session.state().revision, 1, 'its session took no new tree')

  // Approved again exactly as it was: a new frame document and a new run.
  await act(async () => {
    kept = reconcileExtensionContributions(kept, shipped)
  })
  await act(async () => undefined)
  assert.equal(kept.length, 1)
  assert.equal(built.length, 2, 'its frame document is built again')
  const second = frame()!
  assert.notEqual(second, first)
  assert.equal(second.getAttribute('src'), `studio-ext://frame/${built[1]}`)
  assert.equal(runs.length, 2)
  assert.equal(runs[1]!.session.state().tree, null, 'the new run starts from nothing: the old tree is not revived')
  assert.doesNotMatch(text(), /Before the revocation/)
  assert.doesNotMatch(text(), /After the revocation/)

  // The old run's messages still reach nothing; the new run's tree is drawn.
  await guest.render('run-1', 3, n('Text', {}, ['A stale run']))
  const fresh = guestIn(second)
  await fresh.ready('run-2')
  await fresh.render('run-2', 1, n('Text', {}, ['After approval']))
  assert.match(text(), /After approval/)
  assert.doesNotMatch(text(), /A stale run|Before the revocation|Reloaded/)
})

// The pane draws an extension's tab only while the extension is switched on
// (WorkspacePaneBody): switching it off takes the mount away.
test('switched off: the frame goes with the panel, and switching it on again starts a new run', async () => {
  const { built, following, frame } = await panelDrawn('local.switched-board')
  const guest = guestIn(frame()!)
  await guest.ready('run-1')
  await guest.render('run-1', 1, n('Text', {}, ['While it was on']))
  assert.match(text(), /While it was on/)

  await act(async () => root!.render(<p>This panel is not available.</p>))
  assert.equal(frame(), null)
  assert.doesNotMatch(text(), /While it was on/)
  assert.equal(runs[0]!.listeners(), 0)
  assert.equal(following.count, 0)
  const answered = guest.received.length
  await guest.render('run-1', 2, n('Text', {}, ['After it was off']))
  await guest.ready('run-1b')
  assert.equal(guest.received.length, answered)

  await act(async () => {
    root!.render(
      <ExtensionSurfaceMount extensionKey="local.switched-board" point="panels" id="board" workspaceId="ws" />,
    )
  })
  await act(async () => undefined)
  assert.equal(built.length, 2)
  assert.equal(frame()!.getAttribute('src'), `studio-ext://frame/${built[1]}`)
  assert.equal(runs.at(-1)!.session.state().tree, null)
  assert.doesNotMatch(text(), /While it was on|After it was off/)
})

/** An image the window decodes at the given size, as a browser would. */
function decodesAt(width: number, height: number) {
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = width
      naturalHeight = height
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_url: string) {
        queueMicrotask(() => this.onload?.())
      }
    },
  )
}

const PNG_DATA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg=='

test('an Image in a components tree is drawn from assets.image, asked as the panel’s own frame', async () => {
  decodesAt(1, 1)
  const { calls, built, frame } = await panelDrawn('local.pictures')
  extensionsDouble.extensionCall = async (call) => {
    calls.push(call)
    const path = (call.params as { path?: string }).path
    return path === 'assets/logo.png'
      ? { ok: true, result: { mime: 'image/png', data: PNG_DATA } }
      : { ok: true, result: null }
  }
  const guest = guestIn(frame()!)
  await guest.ready('run-1')
  await guest.render(
    'run-1',
    1,
    n('Stack', {}, [
      n('Image', { src: 'assets/logo.png', alt: 'Logo' }, [], 'a'),
      n('Image', { src: 'assets/gone.png', alt: 'Gone' }, [], 'b'),
    ]),
  )
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  const images = calls.filter((call) => call.method === 'assets.image')
  assert.deepEqual(
    images.map((call) => [call.moduleId, call.frame, call.params]),
    [
      ['local.pictures', built[0], { path: 'assets/logo.png' }],
      ['local.pictures', built[0], { path: 'assets/gone.png' }],
    ],
  )
  const img = container!.querySelector('img')!
  assert.equal(img.getAttribute('src'), `data:image/png;base64,${PNG_DATA}`)
  assert.equal(img.getAttribute('alt'), 'Logo')
  assert.equal(container!.querySelector('[data-image-placeholder]')!.getAttribute('aria-label'), 'Gone')
})

test('an image larger than 4096 pixels a side is not drawn', async () => {
  decodesAt(4097, 16)
  const { frame } = await panelDrawn('local.huge-picture')
  extensionsDouble.extensionCall = async () => ({ ok: true, result: { mime: 'image/png', data: PNG_DATA } })
  const guest = guestIn(frame()!)
  await guest.ready('run-1')
  await guest.render('run-1', 1, n('Image', { src: 'assets/huge.png', alt: 'Huge' }))
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  assert.equal(container!.querySelector('img'), null)
  assert.equal(container!.querySelector('[data-image-placeholder]')!.getAttribute('aria-label'), 'Huge')
})
