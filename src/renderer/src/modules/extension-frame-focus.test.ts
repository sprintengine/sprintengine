// @vitest-environment jsdom

import assert from 'node:assert/strict'
import { afterEach, test } from 'vitest'

import { installExtensionFrameFocusGuard } from './extension-frame-focus'

let dispose: (() => void) | null = null
afterEach(() => {
  dispose?.()
  dispose = null
  document.body.innerHTML = ''
})

function scene() {
  let time = 10_000
  const guard = installExtensionFrameFocusGuard(window, () => time)
  dispose = () => guard.dispose()
  const composer = document.createElement('textarea')
  const frame = document.createElement('iframe')
  frame.setAttribute('data-extension', 'local.board')
  const plain = document.createElement('iframe')
  document.body.append(composer, frame, plain)
  composer.focus()
  return {
    composer,
    frame,
    plain,
    advance: (ms: number) => void (time += ms),
    // As a frame's own script focusing an element inside it looks from the window.
    frameTakesFocus: async (target: HTMLIFrameElement = frame) => {
      target.tabIndex = 0
      target.focus()
      await Promise.resolve()
    },
  }
}

test('a frame that takes focus without a gesture hands it back to what the person was typing in', async () => {
  const { composer, frameTakesFocus } = scene()
  await frameTakesFocus()
  assert.equal(document.activeElement, composer)
})

test('with the pointer over the frame, focus stays in it', async () => {
  const { frame, frameTakesFocus } = scene()
  frame.dispatchEvent(new Event('pointerover', { bubbles: true }))
  await frameTakesFocus()
  assert.equal(document.activeElement, frame)
})

test('the pointer having left the frame, focus goes back again', async () => {
  const { composer, frame, frameTakesFocus } = scene()
  frame.dispatchEvent(new Event('pointerover', { bubbles: true }))
  frame.dispatchEvent(new Event('pointerout', { bubbles: true }))
  await frameTakesFocus()
  assert.equal(document.activeElement, composer)
})

test('a Tab press walks focus into the frame; long after one, it does not', async () => {
  const { composer, frame, advance, frameTakesFocus } = scene()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  advance(100)
  await frameTakesFocus()
  assert.equal(document.activeElement, frame)
  composer.focus()
  advance(2_000)
  await frameTakesFocus()
  assert.equal(document.activeElement, composer)
})

test("a frame of Studio's own is left alone", async () => {
  const { plain, frameTakesFocus } = scene()
  await frameTakesFocus(plain)
  assert.equal(document.activeElement, plain)
})

test('with nothing of the window focused before, the frame still loses focus', async () => {
  const { composer, frame, frameTakesFocus } = scene()
  composer.remove()
  await frameTakesFocus()
  assert.notEqual(document.activeElement, frame)
})
