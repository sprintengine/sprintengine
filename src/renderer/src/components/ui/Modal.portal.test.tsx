// @vitest-environment jsdom
//
// A window-wide dialog is drawn on <body>, never inside the tree that declared
// it: an ancestor's mask, transform or overflow would otherwise clip it (a
// scrolled ScrollArea's edge fade cut the left side off "Pair a device" in
// Settings). The contained variant stays where it was declared, bounded by
// its panel on purpose.
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test } from 'vitest'

import { Modal } from './Modal'

let root: Root | null = null
let host: HTMLElement | null = null

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
  document.body.innerHTML = ''
})

async function render(node: React.ReactNode): Promise<HTMLElement> {
  host = document.createElement('div')
  host.className = 'clipping-ancestor'
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(node))
  return host
}

test('a window-wide dialog is drawn on <body>, outside the tree that declared it', async () => {
  let clicked = 0
  const declaring = await render(
    <div onClick={() => (clicked += 1)}>
      <Modal open onClose={() => undefined} label="Pair a device">
        <button type="button">Inside</button>
      </Modal>
    </div>,
  )
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  expect(dialog).not.toBe(null)
  expect(declaring.contains(dialog)).toBe(false)
  expect(dialog.closest('.overlay-scrim')?.parentElement).toBe(document.body)
  // React's events still reach the tree that declared it.
  await act(async () => dialog.querySelector('button')!.click())
  expect(clicked).toBe(1)
})

test('a contained dialog stays inside the panel it was declared in', async () => {
  const declaring = await render(
    <Modal open contained onClose={() => undefined} label="Confirm">
      <p>Body</p>
    </Modal>,
  )
  expect(declaring.querySelector('[role="dialog"]')).not.toBe(null)
})
