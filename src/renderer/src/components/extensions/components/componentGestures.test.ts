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
