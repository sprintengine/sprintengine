// @vitest-environment jsdom
// The stationary rule: a press grants a gesture only on a control that has
// stood still for 500 ms, in the tree and on screen.

import { expect, test } from 'vitest'

import {
  COMPONENT_SETTLE_MS,
  componentGestureId,
  createComponentGestureGeometry,
  createComponentGestureStability,
} from './componentGestures'
import { checked, cb, n } from './componentsTestKit'

const button = (label: string, key = 'go') => n('Button', { onPress: cb('c1') }, [label], key)
const id = componentGestureId.callback('c1')

test('a control in the same place, with the same label, settles after 500 ms', () => {
  const stability = createComponentGestureStability()
  stability.observe(checked(n('Stack', {}, [button('Save')])), 0)
  expect(stability.isSettled(id, COMPONENT_SETTLE_MS - 1)).toBe(false)
  // A render that changes nothing keeps the wait it had.
  stability.observe(checked(n('Stack', {}, [button('Save')])), 300)
  expect(stability.isSettled(id, COMPONENT_SETTLE_MS)).toBe(true)
})

test('a changed label, or a move in the tree, starts the wait again', () => {
  const stability = createComponentGestureStability()
  stability.observe(checked(n('Stack', {}, [button('Save')])), 0)
  stability.observe(checked(n('Stack', {}, [button('Delete')])), 600)
  expect(stability.isSettled(id, 700)).toBe(false)
  expect(stability.isSettled(id, 1100)).toBe(true)
  // A sibling put before it moves its place in the tree.
  stability.observe(
    checked(n('Stack', {}, [n('Text', {}, ['new'], 'a'), n('Stack', {}, [button('Delete')], 'b')])),
    1200,
  )
  expect(stability.isSettled(id, 1300)).toBe(false)
})

test('a control that is not there, or never grants, is never settled', () => {
  const stability = createComponentGestureStability()
  stability.observe(checked(n('Stack', {}, [n('Checkbox', { label: 'x', onChange: cb('c1') }, [], 'k')])), 0)
  expect(stability.isSettled(id, 10_000)).toBe(false)
})

function boxed(rect: { left: number; top: number; width: number; height: number }) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  element.getBoundingClientRect = () =>
    ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top }) as DOMRect
  return element
}

test('on screen: a control that moved starts its wait again, and scrolling the panel is not a move', () => {
  let now = 0
  const geometry = createComponentGestureGeometry(() => now)
  const container = boxed({ left: 0, top: 0, width: 300, height: 300 })
  geometry.setContainer(container)
  let top = 100
  const control = boxed({ left: 10, top, width: 80, height: 24 })
  control.getBoundingClientRect = () => ({ left: 10, top, width: 80, height: 24 }) as DOMRect
  geometry.refFor(id)(control)
  now = 600
  geometry.sample()
  expect(geometry.isSettled(id, now)).toBe(true)
  // A sibling grew above it: it moved.
  top = 140
  geometry.sample()
  expect(geometry.isSettled(id, now)).toBe(false)
  now = 1200
  geometry.sample()
  expect(geometry.isSettled(id, now)).toBe(true)
  // The panel scrolled by 40: the control is 40 higher on screen, and in the same place in the content.
  Object.defineProperty(container, 'scrollTop', { value: 40, configurable: true })
  top = 100
  geometry.sample()
  expect(geometry.isSettled(id, now)).toBe(true)
})

test('a nested label that changes starts the wait again: the whole visible content is the signature', () => {
  const stability = createComponentGestureStability()
  const row = (label: string) =>
    n('ListItem', { onPress: cb('c1') }, [n('Text', {}, [label], 't'), n('Badge', {}, ['new'], 'b')], 'row')
  stability.observe(checked(n('List', {}, [row('Keep')])), 0)
  expect(stability.isSettled(id, 600)).toBe(true)
  stability.observe(checked(n('List', {}, [row('Delete everything')])), 600)
  expect(stability.isSettled(id, 700)).toBe(false)
  expect(stability.isSettled(id, 1100)).toBe(true)
  // A nested Badge's words count too.
  stability.observe(
    checked(
      n('List', {}, [
        n(
          'ListItem',
          { onPress: cb('c1') },
          [n('Text', {}, ['Delete everything'], 't'), n('Badge', {}, ['old'], 'b')],
          'row',
        ),
      ]),
    ),
    1100,
  )
  expect(stability.isSettled(id, 1200)).toBe(false)
})

test('the whole panel moving down 100 px under the pointer is a move, though the control kept its place in the panel', () => {
  let now = 0
  const geometry = createComponentGestureGeometry(() => now)
  let shift = 0
  const container = boxed({ left: 0, top: 0, width: 300, height: 300 })
  container.getBoundingClientRect = () => ({ left: 0, top: shift, width: 300, height: 300 }) as DOMRect
  geometry.setContainer(container)
  const control = boxed({ left: 10, top: 100, width: 80, height: 24 })
  control.getBoundingClientRect = () => ({ left: 10, top: 100 + shift, width: 80, height: 24 }) as DOMRect
  geometry.refFor(id)(control)
  now = 600
  geometry.sample()
  expect(geometry.isSettled(id, now)).toBe(true)
  // An error banner appeared above the tree: the panel and the control move down together.
  shift = 100
  geometry.sample()
  expect(geometry.isSettled(id, now)).toBe(false)
  now = 1100
  geometry.sample()
  expect(geometry.isSettled(id, now)).toBe(true)
})

// Two labels whose 32-bit FNV-1a hashes collide, found by a reviewer: the content is compared whole, not by a short id.
test('two labels a panel picked to collide still start the wait again', () => {
  const stability = createComponentGestureStability()
  const row = (label: string) => n('ListItem', { onPress: cb('c1') }, [n('Text', {}, [label], 't')], 'row')
  stability.observe(checked(n('List', {}, [row('Keep safe 07c0375f')])), 0)
  expect(stability.isSettled(id, 600)).toBe(true)
  stability.observe(checked(n('List', {}, [row('Send data 4676cbf5')])), 600)
  expect(stability.isSettled(id, 601)).toBe(false)
  expect(stability.isSettled(id, 1099)).toBe(false)
  expect(stability.isSettled(id, 1100)).toBe(true)
})

test('a child image whose source changes, or any other drawn prop, starts the wait again', () => {
  const stability = createComponentGestureStability()
  const row = (image: Record<string, unknown>, badge: Record<string, unknown> = {}) =>
    n(
      'ListItem',
      { onPress: cb('c1'), title: 'Open' },
      [n('Image', { alt: 'mark', ...image }, [], 'i'), n('Badge', badge, ['tag'], 'b')],
      'row',
    )
  stability.observe(checked(n('List', {}, [row({ src: 'assets/safe.png' })])), 0)
  expect(stability.isSettled(id, 600)).toBe(true)
  stability.observe(checked(n('List', {}, [row({ src: 'assets/danger.png' })])), 600)
  expect(stability.isSettled(id, 601)).toBe(false)
  expect(stability.isSettled(id, 1100)).toBe(true)
  // Its fit, and a nested Badge's tone, are drawn too.
  stability.observe(checked(n('List', {}, [row({ src: 'assets/danger.png', fit: 'cover' })])), 1100)
  expect(stability.isSettled(id, 1101)).toBe(false)
  stability.observe(checked(n('List', {}, [row({ src: 'assets/danger.png', fit: 'cover' }, { tone: 'danger' })])), 1700)
  expect(stability.isSettled(id, 1701)).toBe(false)
  // The same content again keeps its wait.
  stability.observe(checked(n('List', {}, [row({ src: 'assets/danger.png', fit: 'cover' }, { tone: 'danger' })])), 2000)
  expect(stability.isSettled(id, 2200)).toBe(true)
})

test('a control too large to keep starts the wait again on every render', () => {
  const stability = createComponentGestureStability()
  // Each Text is under its own cap; together they are over the signature's.
  const texts = Array.from({ length: 12 }, (_, index) => n('Text', {}, ['x'.repeat(15_000)], `t${index}`))
  const big = () => n('List', {}, [n('ListItem', { onPress: cb('c1') }, texts, 'row')])
  stability.observe(checked(big()), 0)
  expect(stability.isSettled(id, 600)).toBe(true)
  stability.observe(checked(big()), 600)
  expect(stability.isSettled(id, 601)).toBe(false)
  expect(stability.isSettled(id, 1100)).toBe(true)
})
