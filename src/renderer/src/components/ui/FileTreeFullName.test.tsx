// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { FileTreeRow } from './FileTree'
import { Tooltip } from './Tooltip'

// A row in a tree that scrolls sideways shows its whole name, and hovering the
// name shows it in the kit's tooltip only while part of it is out of view.

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const NAME = 'pairing-request-recovery-after-sleep-and-network-change.test.ts'

function mount(element: React.ReactElement): HTMLElement {
  act(() => root.render(element))
  return host.querySelector('[role="treeitem"]') as HTMLElement
}

function hover(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
  act(() => {
    vi.advanceTimersByTime(500)
  })
}

const tooltip = () => document.querySelector('[role="tooltip"]')

test('a full-name row never truncates its name', () => {
  const row = mount(<FileTreeRow name={NAME} isDir={false} depth={4} fullName />)
  const name = row.querySelector('[data-file-tree-name]') as HTMLElement
  expect(name.textContent).toBe(NAME)
  expect(name.className).not.toMatch(/\btruncate\b/)
  expect(name.className).toMatch(/\bwhitespace-nowrap\b/)
  expect(row.querySelector('.truncate')).toBeNull()
})

test('a row without it still truncates, for a column that does not scroll', () => {
  const row = mount(<FileTreeRow name={NAME} isDir={false} depth={0} />)
  expect(row.querySelector('.truncate')?.textContent).toBe(NAME)
  expect(row.querySelector('[data-file-tree-name]')).toBeNull()
})

test("the row's content is held to the view's width, less its indent and end padding", () => {
  const row = mount(<FileTreeRow name="a.ts" isDir={false} depth={2} indentSteps={1} fullName />)
  const content = row.firstElementChild as HTMLElement
  expect(content.style.minWidth).toBe('calc(var(--file-tree-span, 0px) - 58px)')
  expect(row.style.paddingLeft).toBe('50px')
})

test('hovering a name that is all in view shows no tooltip', () => {
  const row = mount(<FileTreeRow name={NAME} isDir={false} depth={0} fullName />)
  // jsdom lays nothing out: a zero box counts as not clipped.
  hover(row.querySelector('[data-file-tree-name]') as Element)
  expect(tooltip()).toBeNull()
})

test('hovering a name that runs out of view shows it whole', () => {
  const scroller = document.createElement('div')
  scroller.style.overflowX = 'auto'
  scroller.getBoundingClientRect = () =>
    ({ left: 0, right: 200, top: 0, bottom: 400, width: 200, height: 400 }) as DOMRect
  Object.defineProperty(scroller, 'clientWidth', { value: 200 })
  host.replaceWith(scroller)
  scroller.append(host)
  const row = mount(<FileTreeRow name={NAME} isDir={false} depth={4} fullName />)
  const name = row.querySelector('[data-file-tree-name]') as HTMLElement
  name.getBoundingClientRect = () => ({ left: 120, right: 520, top: 0, bottom: 20, width: 400, height: 20 }) as DOMRect
  hover(name)
  expect(tooltip()?.textContent).toBe(NAME)
  scroller.replaceWith(host)
})

test("the kit tooltip's shouldOpen is asked when the delay runs out, with the trigger", () => {
  const seen: HTMLElement[] = []
  let answer = false
  act(() =>
    root.render(
      <Tooltip
        content="Whole"
        shouldOpen={(trigger) => {
          seen.push(trigger)
          return answer
        }}
      >
        <span data-trigger="">Part</span>
      </Tooltip>,
    ),
  )
  const trigger = host.querySelector('[data-trigger]') as HTMLElement
  hover(trigger)
  expect(seen).toEqual([trigger])
  expect(tooltip()).toBeNull()

  act(() => trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
  answer = true
  hover(trigger)
  expect(tooltip()?.textContent).toBe('Whole')
})
