import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  appDocumentUrl,
  externalLinkForWindowOpen,
  guardPrivilegedWindow,
  isAppDocument,
  refusesFrameNavigation,
  type FrameNavigation,
  type GuardedContents,
} from './privileged-window-navigation'
import { SEALED_VISUAL_URL_PREFIX } from '../shared/sealed-visual'

const packaged = appDocumentUrl(
  undefined,
  '/Applications/Studio.app/Contents/Resources/app.asar/out/renderer/index.html',
)
const development = appDocumentUrl('http://localhost:5173/', '/unused')

function fakeContents() {
  let openHandler: ((details: { url: string }) => { action: 'deny' }) | null = null
  let navigate: ((event: { preventDefault(): void }, url: string) => void) | null = null
  let frameNavigate: ((details: FrameNavigation) => void) | null = null
  let redirect: ((details: FrameNavigation) => void) | null = null
  const contents = {
    setWindowOpenHandler: (handler: (details: { url: string }) => { action: 'deny' }) => {
      openHandler = handler
    },
    on: (event: string, listener: never) => {
      if (event === 'will-navigate') navigate = listener
      else if (event === 'will-redirect') redirect = listener
      else frameNavigate = listener
    },
  } as GuardedContents
  return {
    contents,
    open: (url: string) => openHandler!({ url }),
    navigate: (url: string) => {
      let prevented = false
      navigate!({ preventDefault: () => (prevented = true) }, url)
      return prevented ? 'blocked' : 'allowed'
    },
    navigateFrame: (frameUrl: string, isSameDocument = false, via: 'navigate' | 'redirect' = 'navigate') => {
      let prevented = false
      ;(via === 'redirect' ? redirect : frameNavigate)!({
        preventDefault: () => (prevented = true),
        isMainFrame: false,
        isSameDocument,
        frame: { url: frameUrl },
      })
      return prevented ? 'blocked' : 'allowed'
    },
  }
}

test("a packaged window may reload its own document but never navigate to a page that contains the text 'file://'", () => {
  const { contents, navigate } = fakeContents()
  guardPrivilegedWindow(contents, packaged, () => undefined)
  assert.equal(navigate(`${packaged.href}?windowId=w1`), 'allowed')
  assert.equal(navigate('https://example.com/p?file://'), 'blocked')
  assert.equal(navigate('file:///Users/dev/repo/evil.html'), 'blocked')
})

test('a development window may move within the dev server and nowhere else', () => {
  assert.equal(isAppDocument('http://localhost:5173/?view=diagnostics', development), true)
  assert.equal(isAppDocument('http://localhost:5174/', development), false)
  assert.equal(isAppDocument('https://example.com/', development), false)
})

test('window.open hands only web and mail links to the OS, and never opens a window', () => {
  const opened: string[] = []
  const { contents, open } = fakeContents()
  guardPrivilegedWindow(contents, packaged, (url) => {
    opened.push(url)
  })
  for (const url of [
    'https://example.com/',
    'mailto:dev@example.com',
    'file:///Users/dev/repo/tool.app',
    'smb://example.com/share',
    'vscode://file/x',
  ]) {
    assert.deepEqual(open(url), { action: 'deny' }, url)
  }
  assert.deepEqual(opened, ['https://example.com/', 'mailto:dev@example.com'])
})

test('a link that is not a URL is dropped', () => {
  assert.equal(externalLinkForWindowOpen('not a link'), null)
})

const sealed = `${SEALED_VISUAL_URL_PREFIX}${encodeURIComponent('<p>hi</p>')}`

test('a sealed visual frame may not navigate itself anywhere, its own address included', () => {
  const { contents, navigateFrame } = fakeContents()
  guardPrivilegedWindow(contents, packaged, () => undefined)
  assert.equal(navigateFrame(sealed), 'blocked')
  // A link within its own document loads nothing.
  assert.equal(navigateFrame(sealed, true), 'allowed')
  // Every other frame (a fresh one loading its first document, an artifact
  // preview, a browser pane) is not this rule's business.
  assert.equal(navigateFrame('about:blank'), 'allowed')
  assert.equal(navigateFrame('about:srcdoc'), 'allowed')
})

test('the frame rule ignores the window itself and a frame that is already gone', () => {
  assert.equal(refusesFrameNavigation({ isMainFrame: true, isSameDocument: false, frame: { url: sealed } }), false)
  assert.equal(refusesFrameNavigation({ isMainFrame: false, isSameDocument: false, frame: null }), false)
  const disposed = {
    get url(): string {
      throw new Error('Render frame was disposed')
    },
  }
  assert.equal(refusesFrameNavigation({ isMainFrame: false, isSameDocument: false, frame: disposed }), false)
})

// An extension's surface leaving its document by any means: a link, assigning
// `location.href`, `location.replace(…)` or a `<meta http-equiv="refresh">`.
// Chromium asks the window about each as the frame's navigation, and about a
// server redirect on the way as a redirect; every one is refused.
test('an extension surface may not navigate itself anywhere, nor be redirected', () => {
  const { contents, navigateFrame } = fakeContents()
  guardPrivilegedWindow(contents, packaged, () => undefined)
  const surface = `studio-ext://frame/${'a'.repeat(64)}`
  for (const via of ['navigate', 'redirect'] as const) {
    assert.equal(navigateFrame(surface, false, via), 'blocked', via)
    assert.equal(navigateFrame(`${surface}?again`, false, via), 'blocked', via)
  }
  assert.equal(navigateFrame(surface, true), 'allowed', 'a #section in its own document loads nothing')
  assert.equal(navigateFrame('about:blank'), 'allowed', 'the frame loading its document in the first place')
})
