// @vitest-environment jsdom
// The window a components panel's shot is drawn in: it draws the tree it is
// handed with Studio's own controls, in the theme it is told, and says when
// the drawing is done.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'

import ComponentsShotApp from './ComponentsShotApp'
import { n } from './componentsTestKit'

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-mode')
})

function mount(): void {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<ComponentsShotApp />))
  // The hand-over settles only after React drew what it was handed, so it is
  // awaited outside act, the way main awaits it.
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false
}

test('the handed tree is drawn in the given theme, and the hand-over settles once it is', async () => {
  mount()
  expect(typeof window.__seComponentsShot).toBe('function')
  await window.__seComponentsShot!({
    tree: n('Stack', {}, [n('Heading', {}, ['Deploys']), n('Image', { src: 'media/missing.png', alt: 'Chart' })]),
    images: {},
    theme: 'light',
  })
  expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  expect(document.documentElement.getAttribute('data-mode')).toBe('light')
  expect(host!.querySelector('[data-components-view]')?.textContent).toContain('Deploys')
})

test('a tree the check refuses is not drawn', async () => {
  mount()
  await expect(window.__seComponentsShot!({ tree: 'not a node', images: {}, theme: 'dark' })).rejects.toThrow()
  expect(host!.querySelector('[data-components-view]')).toBeNull()
})

test('a panel that did not load shows why', async () => {
  mount()
  await window.__seComponentsShot!({ tree: null, images: {}, theme: 'dark', failure: 'panel.js:1:1 SyntaxError' })
  expect(host!.textContent).toContain('This panel could not load')
  expect(host!.textContent).toContain('panel.js:1:1 SyntaxError')
})
