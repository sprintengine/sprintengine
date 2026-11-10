// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'

import { PanelHeader } from './PanelHeader'
import { OverlaySurfaceContext } from './overlaySurface'

// PanelHeader's edge (design-system/components/panel-header, Variants): in a
// pane one `border.subtle` rule; inside an overlay, space alone and no ground
// of its own. The header learns where it is from the overlay shells, so a
// caller composing a popover never has to say so.

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

function header(node: React.ReactElement): HTMLElement {
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  act(() => root!.render(node))
  return host.querySelector('header')!
}

function classes(el: HTMLElement): string[] {
  return el.className.split(/\s+/).filter(Boolean)
}

test('in a pane the header draws one subtle rule on the surface ground', () => {
  const el = header(<PanelHeader title="Files" />)
  expect(el.dataset.edge).toBe('rule')
  expect(classes(el)).toContain('border-b')
  expect(classes(el)).toContain('border-[color:var(--border-subtle)]')
  expect(classes(el)).not.toContain('border-[color:var(--border-default)]')
  expect(classes(el)).toContain('bg-[color:var(--bg-surface)]')
})

test('inside an overlay the header separates by space: no rule and no ground', () => {
  const el = header(
    <OverlaySurfaceContext.Provider value={true}>
      <PanelHeader title="Notifications" count={3} />
    </OverlaySurfaceContext.Provider>,
  )
  expect(el.dataset.edge).toBe('none')
  expect(classes(el)).not.toContain('border-b')
  expect(el.className).not.toMatch(/bg-\[color:/)
})

test('edge overrides where the header lives, both ways', () => {
  const inOverlay = header(
    <OverlaySurfaceContext.Provider value={true}>
      <PanelHeader title="Remote" edge="rule" />
    </OverlaySurfaceContext.Provider>,
  )
  expect(classes(inOverlay)).toContain('border-b')
  act(() => root!.unmount())
  host!.remove()

  const flush = header(<PanelHeader title="Reviews" edge="none" />)
  expect(classes(flush)).not.toContain('border-b')
  act(() => root!.unmount())
  host!.remove()

  const overScroll = header(<PanelHeader title="Library" edge="scroll" />)
  expect(overScroll.dataset.edge).toBe('scroll')
  expect(classes(overScroll)).not.toContain('border-b')
})

test('the published divider={false} still drops the rule', () => {
  const el = header(<PanelHeader title="Knowledge graph" divider={false} />)
  expect(el.dataset.edge).toBe('none')
  expect(classes(el)).not.toContain('border-b')
})
