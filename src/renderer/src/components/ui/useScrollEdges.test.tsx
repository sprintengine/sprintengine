// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'

import { ScrollArea } from './ScrollArea'
import { readScrollEdges, useScrollEdges, type ScrollEdges } from './useScrollEdges'

// The scroll-edge fade (design-system/components/scroll-area): an edge is
// marked only while content is hidden past it. jsdom does no layout, so each
// case gives the element the scroll geometry a browser would have measured.

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function geometry(el: HTMLElement, { scroll, client, position }: { scroll: number; client: number; position: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scroll })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: client })
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scroll })
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: client })
  el.scrollTop = position
  el.scrollLeft = position
}

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

function mount(node: React.ReactElement): HTMLElement {
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  act(() => root!.render(node))
  return host
}

test('readScrollEdges says nothing about a box that fits, with a pixel of slack', () => {
  const el = document.createElement('div')
  geometry(el, { scroll: 200, client: 200, position: 0 })
  expect(readScrollEdges(el, 'y')).toEqual({ start: false, end: false })
  // Sub-pixel "overflow" from fractional layout is not an edge.
  geometry(el, { scroll: 201, client: 200, position: 0 })
  expect(readScrollEdges(el, 'y')).toEqual({ start: false, end: false })
})

test('readScrollEdges reports each edge with content past it', () => {
  const el = document.createElement('div')
  geometry(el, { scroll: 600, client: 200, position: 0 })
  expect(readScrollEdges(el, 'y')).toEqual({ start: false, end: true })
  geometry(el, { scroll: 600, client: 200, position: 150 })
  expect(readScrollEdges(el, 'y')).toEqual({ start: true, end: true })
  geometry(el, { scroll: 600, client: 200, position: 400 })
  expect(readScrollEdges(el, 'y')).toEqual({ start: true, end: false })
  expect(readScrollEdges(el, 'x')).toEqual({ start: true, end: false })
})

function Probe({ onChange }: { onChange?: (edges: ScrollEdges) => void }) {
  const ref = React.useRef<HTMLDivElement>(null)
  useScrollEdges(ref, { onChange })
  return <div ref={ref} data-testid="probe" />
}

test('the hook writes the edges as attributes and follows the scroll', () => {
  const seen: ScrollEdges[] = []
  const view = mount(<Probe onChange={(edges) => seen.push(edges)} />)
  const el = view.querySelector<HTMLElement>('[data-testid="probe"]')!
  // First measure ran at mount on a box with no geometry: nothing is marked.
  expect(el.hasAttribute('data-scroll-start')).toBe(false)
  expect(el.hasAttribute('data-scroll-end')).toBe(false)

  geometry(el, { scroll: 600, client: 200, position: 0 })
  act(() => el.dispatchEvent(new Event('scroll')))
  expect(el.hasAttribute('data-scroll-start')).toBe(false)
  expect(el.hasAttribute('data-scroll-end')).toBe(true)

  geometry(el, { scroll: 600, client: 200, position: 100 })
  act(() => el.dispatchEvent(new Event('scroll')))
  expect(el.hasAttribute('data-scroll-start')).toBe(true)
  expect(el.hasAttribute('data-scroll-end')).toBe(true)

  // A scroll that crosses no edge reports nothing new: no re-render churn.
  const before = seen.length
  geometry(el, { scroll: 600, client: 200, position: 120 })
  act(() => el.dispatchEvent(new Event('scroll')))
  expect(seen.length).toBe(before)

  geometry(el, { scroll: 600, client: 200, position: 400 })
  act(() => el.dispatchEvent(new Event('scroll')))
  expect(el.hasAttribute('data-scroll-start')).toBe(true)
  expect(el.hasAttribute('data-scroll-end')).toBe(false)
  expect(seen.at(-1)).toEqual({ start: true, end: false })
})

test('the hook clears its attributes when it unmounts', () => {
  const view = mount(<Probe />)
  const el = view.querySelector<HTMLElement>('[data-testid="probe"]')!
  geometry(el, { scroll: 600, client: 200, position: 100 })
  act(() => el.dispatchEvent(new Event('scroll')))
  expect(el.hasAttribute('data-scroll-start')).toBe(true)
  act(() => root!.unmount())
  root = null
  expect(el.hasAttribute('data-scroll-start')).toBe(false)
  expect(el.hasAttribute('data-scroll-end')).toBe(false)
})

test('ScrollArea is the fade class on a scroller, and forwards its ref and props', () => {
  const ref = React.createRef<HTMLDivElement>()
  const view = mount(
    <ScrollArea ref={ref} role="listbox" aria-label="Results" className="max-h-[360px] py-1">
      <div>row</div>
    </ScrollArea>,
  )
  const el = view.querySelector<HTMLElement>('[role="listbox"]')!
  expect(ref.current).toBe(el)
  expect(el.getAttribute('aria-label')).toBe('Results')
  const classes = el.className.split(' ')
  expect(classes).toContain('scroll-edge-fade')
  expect(classes).toContain('overflow-y-auto')
  expect(classes).toContain('max-h-[360px]')

  geometry(el, { scroll: 600, client: 200, position: 0 })
  act(() => el.dispatchEvent(new Event('scroll')))
  expect(el.hasAttribute('data-scroll-end')).toBe(true)
})

test('a horizontal ScrollArea takes the horizontal fade', () => {
  const view = mount(
    <ScrollArea axis="x" data-testid="strip">
      <div>tab</div>
    </ScrollArea>,
  )
  const el = view.querySelector<HTMLElement>('[data-testid="strip"]')!
  expect(el.className.split(' ')).toContain('scroll-edge-fade-x')
  expect(el.className.split(' ')).not.toContain('scroll-edge-fade')
})
