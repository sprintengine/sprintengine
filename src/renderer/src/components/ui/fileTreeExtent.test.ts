// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest'

import {
  FILE_TREE_NAME_OFFSET,
  FILE_TREE_ROW_END_PADDING,
  fileTreeContentWidth,
  fileTreeRowIndent,
  fileTreeScrollLeftFor,
  isClippedInView,
} from './fileTreeExtent'

// The tree's width and the sideways reveal are arithmetic over the row's own
// geometry, so a windowed tree can be as wide as its widest row without
// mounting it. These hold the arithmetic to the row.

// One character, 7px: enough to read the sums by eye.
const sevenPerCharacter = (name: string) => name.length * 7

test('the indent is the root inset plus 14px a level, one level further in under a root row', () => {
  expect(fileTreeRowIndent(0, 0)).toBe(8)
  expect(fileTreeRowIndent(0, 1)).toBe(22)
  expect(fileTreeRowIndent(3, 1)).toBe(8 + 4 * 14)
})

test('the name starts after the chevron, a gap, the 16px glyph and a gap', () => {
  expect(FILE_TREE_NAME_OFFSET).toBe(12 + 8 + 16 + 8)
})

test('the content width is the widest row: indent, leading marks, name and end padding', () => {
  const rows = [
    { name: 'src', depth: 0 },
    { name: 'conversation-lifecycle-transitions.test.ts', depth: 3 },
    { name: 'a-much-longer-name-at-the-top-level.ts', depth: 0 },
  ]
  const deep = fileTreeRowIndent(3, 1) + FILE_TREE_NAME_OFFSET + 42 * 7 + FILE_TREE_ROW_END_PADDING
  const shallow = fileTreeRowIndent(0, 1) + FILE_TREE_NAME_OFFSET + 38 * 7 + FILE_TREE_ROW_END_PADDING
  expect(deep).toBeGreaterThan(shallow)
  expect(fileTreeContentWidth(rows, 1, sevenPerCharacter)).toBe(deep)
})

test('depth wins over length when it is what makes a row wide', () => {
  const rows = [
    { name: 'abcdefghij', depth: 0 },
    { name: 'abcdef', depth: 6 },
  ]
  // 10 chars at depth 0 is 70px of name; 6 chars at depth 6 is 42px plus 84px more indent.
  expect(fileTreeContentWidth(rows, 0, sevenPerCharacter)).toBe(fileTreeRowIndent(6, 0) + 44 + 42 + 8)
})

test('the content width rounds up, so a fractional name is never cut by a pixel', () => {
  expect(fileTreeContentWidth([{ name: 'x', depth: 0 }], 0, () => 10.2)).toBe(Math.ceil(8 + 44 + 10.2 + 8))
})

test('no rows is no width', () => {
  expect(fileTreeContentWidth([], 1, sevenPerCharacter)).toBe(0)
})

test('a name already starting in view does not scroll', () => {
  expect(fileTreeScrollLeftFor({ scrollLeft: 0, clientWidth: 300, rowStart: 60, nameStart: 104 })).toBeNull()
  expect(fileTreeScrollLeftFor({ scrollLeft: 100, clientWidth: 300, rowStart: 160, nameStart: 204 })).toBeNull()
})

test('a shallow row scrolled out to the left goes back to the start of the tree', () => {
  expect(fileTreeScrollLeftFor({ scrollLeft: 140, clientWidth: 300, rowStart: 26, nameStart: 70 })).toBe(0)
})

test('a deep row whose name starts past the right edge brings its chevron to the left, one level in', () => {
  // Name at 520 in a 300px view: going back to 0 would not show it.
  expect(fileTreeScrollLeftFor({ scrollLeft: 0, clientWidth: 300, rowStart: 476, nameStart: 520 })).toBe(476 - 14)
})

test('a name starting too close to the right edge to read counts as out of view', () => {
  // 48px before the edge is the least that reads as the start of a name.
  expect(fileTreeScrollLeftFor({ scrollLeft: 0, clientWidth: 300, rowStart: 236, nameStart: 280 })).toBe(222)
})

test('a deep row scrolled out to the left comes back to its own chevron, not the start', () => {
  expect(fileTreeScrollLeftFor({ scrollLeft: 900, clientWidth: 300, rowStart: 476, nameStart: 520 })).toBe(462)
})

// jsdom has no layout, so the boxes are stated.
function boxed(element: HTMLElement, left: number, width: number, clientWidth = width): HTMLElement {
  element.getBoundingClientRect = () =>
    ({ left, right: left + width, top: 0, bottom: 20, width, height: 20, x: left, y: 0 }) as DOMRect
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: clientWidth })
  Object.defineProperty(element, 'clientLeft', { configurable: true, value: 0 })
  return element
}

afterEach(() => {
  document.body.innerHTML = ''
})

function scrolledName(nameLeft: number, nameWidth: number): HTMLElement {
  const scroller = boxed(document.createElement('div'), 100, 300)
  scroller.style.overflowX = 'auto'
  const tree = boxed(document.createElement('div'), 100 - 50, 700)
  const name = boxed(document.createElement('span'), nameLeft, nameWidth)
  tree.append(name)
  scroller.append(tree)
  document.body.append(scroller)
  return name
}

test('a name inside the view is not clipped', () => {
  expect(isClippedInView(scrolledName(150, 120))).toBe(false)
})

test('a name running past the right edge of the scrolling column is clipped', () => {
  expect(isClippedInView(scrolledName(250, 300))).toBe(true)
})

test('a name scrolled partly out to the left is clipped', () => {
  expect(isClippedInView(scrolledName(60, 120))).toBe(true)
})

test('sub-pixel overhang is not clipping', () => {
  expect(isClippedInView(scrolledName(300, 100.5))).toBe(false)
})

test('an ancestor that does not clip is not a view', () => {
  const wide = boxed(document.createElement('div'), 0, 100)
  const name = boxed(document.createElement('span'), 20, 300)
  wide.append(name)
  document.body.append(wide)
  // Only the window bounds it; jsdom's is 1024 wide.
  expect(isClippedInView(name)).toBe(false)
})
