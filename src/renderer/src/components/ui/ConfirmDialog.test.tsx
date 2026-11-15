// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, test } from 'vitest'

import { ConfirmDialogProvider, useConfirmDialog } from './ConfirmDialog'

let root: Root | null = null
let host: HTMLElement | null = null

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
})

async function openPrompt(options: {
  initialValue: string
  selectFileStem?: boolean
  typedExtensionReplaces?: boolean
}): Promise<HTMLInputElement> {
  let api: ReturnType<typeof useConfirmDialog> | null = null
  function Grab() {
    api = useConfirmDialog()
    return null
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  const created = createRoot(host)
  root = created
  await act(async () =>
    created.render(
      <ConfirmDialogProvider>
        <Grab />
      </ConfirmDialogProvider>,
    ),
  )
  await act(async () => {
    void api!.prompt({ title: 'New file', inputLabel: 'File name', ...options })
  })
  await act(async () => new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined))))
  return document.querySelector<HTMLInputElement>('input[aria-label="File name"]')!
}

test('a file name opens with its name part selected, so typing keeps the extension', async () => {
  const input = await openPrompt({ initialValue: 'untitled.ts', selectFileStem: true })
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'untitled'.length])
})

test('a dotfile or a name without an extension is selected whole', async () => {
  const input = await openPrompt({ initialValue: '.env', selectFileStem: true })
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, '.env'.length])
})

/** One edit as a keystroke leaves it: the field's new value, and the caret after it. */
async function edit(input: HTMLInputElement, value: string, caret: number): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.setSelectionRange(caret, caret)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('a name typed with its own extension keeps that one, not the offered one', async () => {
  const input = await openPrompt({ initialValue: 'untitled.ts', selectFileStem: true, typedExtensionReplaces: true })
  // Typing over the selected stem: `newfile`, then a dot of its own.
  await edit(input, 'newfile.ts', 7)
  expect(input.value).toBe('newfile.ts')
  await edit(input, 'newfile..ts', 8)
  expect(input.value).toBe('newfile.')
  expect(input.selectionStart).toBe(8)
  await edit(input, 'newfile.txt', 11)
  expect(input.value).toBe('newfile.txt')
})

test('a name typed without a dot keeps the offered extension', async () => {
  const input = await openPrompt({ initialValue: 'untitled.ts', selectFileStem: true, typedExtensionReplaces: true })
  await edit(input, 'main.ts', 4)
  expect(input.value).toBe('main.ts')
})

test('without the option the offered extension always stays', async () => {
  const input = await openPrompt({ initialValue: 'notes.md', selectFileStem: true })
  await edit(input, 'plan.txt.md', 8)
  expect(input.value).toBe('plan.txt.md')
})
