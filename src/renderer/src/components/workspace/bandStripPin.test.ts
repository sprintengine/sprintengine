import { expect, test } from 'vitest'

import { pillPinOffset } from './bandStripPin'

const strip = { stripLeft: 0, stripRight: 1000 }

test('tabs fanning out on the pill’s left are offset so the pill stays where it stood', () => {
  // At rest the pill stood at 450; centred, a 200px tab on its left pushed it to 550.
  expect(pillPinOffset({ ...strip, restLeft: 450, naturalLeft: 550, firstLeft: 340, lastRight: 650 })).toBe(-100)
})

test('a strip with nothing moving is left alone', () => {
  expect(pillPinOffset({ ...strip, restLeft: 450, naturalLeft: 450, firstLeft: 450, lastRight: 550 })).toBe(0)
})

test('no tab is pushed past the strip’s edge to hold the pill', () => {
  // Holding the pill would put the first tab at -60: it stops 4px inside the edge.
  expect(pillPinOffset({ ...strip, restLeft: 100, naturalLeft: 300, firstLeft: 140, lastRight: 400 })).toBe(-136)
  // And on the right.
  expect(pillPinOffset({ ...strip, restLeft: 900, naturalLeft: 700, firstLeft: 600, lastRight: 900 })).toBe(96)
})

test('a strip too narrow for its tabs starts from the first tab', () => {
  expect(pillPinOffset({ ...strip, restLeft: 450, naturalLeft: 550, firstLeft: -100, lastRight: 1200 })).toBe(104)
})
