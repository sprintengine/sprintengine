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

async function openPrompt(options: { initialValue: string; selectFileStem?: boolean }): Promise<HTMLInputElement> {
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
