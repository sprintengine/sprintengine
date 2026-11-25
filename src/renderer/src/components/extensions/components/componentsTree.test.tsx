// @vitest-environment jsdom
// A Tree: items as data, the keyboard a tree takes, open items kept by Studio
// or by the panel, lazy children shown loading until they come.

import { afterEach, expect, test } from 'vitest'

import { cb, click, draw, key, n, type Drawn } from './componentsTestKit'
import { visibleTreeRows } from './componentsTree'

let drawn: Drawn | null = null
afterEach(() => {
  drawn?.unmount()
  drawn = null
})

const items = [
  {
    key: 'src',
    label: 'src',
    children: [
      { key: 'a', label: 'a.ts' },
      { key: 'b', label: 'b.ts' },
    ],
  },
  { key: 'lazy', label: 'remote', hasChildren: true },
]
const tree = (extra: Record<string, unknown> = {}) =>
  n('Tree', { label: 'Files', items, onSelect: cb('sel'), onToggle: cb('tog'), onAction: cb('act'), ...extra })
const labels = (host: HTMLElement) =>
  [...host.querySelectorAll('[role="treeitem"]')].map((each) => each.textContent?.trim())

test('open items show their children, seeded by defaultExpanded', () => {
  drawn = draw(tree({ defaultExpanded: ['src'] }))
  expect(labels(drawn.host)).toEqual(['src', 'a.ts', 'b.ts', 'remote'])
})

test('the keyboard walks, opens, selects and acts', () => {
  drawn = draw(tree())
  const root = drawn.host.querySelector('[role="tree"]')!
  key(root, 'ArrowRight')
  expect(drawn.sent.at(-1)).toEqual({ callback: 'tog', args: [{ key: 'src', expanded: true }] })
  key(root, 'ArrowRight')
  key(root, ' ')
  expect(drawn.sent.at(-1)).toEqual({ callback: 'sel', args: [{ key: 'a' }], edit: 1 })
  key(root, 'Enter')
  expect(drawn.sent.at(-1)).toEqual({ callback: 'act', args: [{ key: 'a' }] })
  key(root, 'ArrowLeft')
  key(root, 'ArrowLeft')
  expect(drawn.sent.at(-1)).toEqual({ callback: 'tog', args: [{ key: 'src', expanded: false }] })
})

test('lazy children show a loading row until a render brings them', () => {
  drawn = draw(tree({ expanded: ['lazy'] }))
  expect(drawn.host.querySelector('[aria-busy="true"]')).not.toBeNull()
  drawn.draw(
    tree({
      expanded: ['lazy'],
      items: [items[0], { key: 'lazy', label: 'remote', children: [{ key: 'x', label: 'x.md' }] }],
    }),
  )
  expect(drawn.host.querySelector('[aria-busy="true"]')).toBeNull()
  expect(labels(drawn.host)).toContain('x.md')
})

test('a click selects; the panel’s selected item is marked', () => {
  drawn = draw(tree({ defaultExpanded: ['src'], selected: 'b' }))
  const b = [...drawn.host.querySelectorAll('[role="treeitem"]')].find((each) => each.textContent?.trim() === 'b.ts')!
  expect(b.getAttribute('aria-selected')).toBe('true')
  click([...drawn.host.querySelectorAll('[role="treeitem"]')][1]!)
  expect(drawn.sent.at(-1)).toEqual({ callback: 'sel', args: [{ key: 'a' }], edit: 1 })
})

test('visible rows follow the open set', () => {
  expect(visibleTreeRows(items, new Set()).map((row) => row.item.key)).toEqual(['src', 'lazy'])
  expect(visibleTreeRows(items, new Set(['src'])).map((row) => row.depth)).toEqual([0, 1, 1, 0])
})
