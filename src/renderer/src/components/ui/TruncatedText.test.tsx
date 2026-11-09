// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { TruncatedText } from './TruncatedText'

let root: Root
let host: HTMLElement

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

// In a column that centres its children, a wrapper free to grow takes the text's
// own width: the text then fits, the tooltip comes off, and the two layouts swap
// every frame. jsdom has no layout, so what is held here is the wrapper's cap.
test('the tooltip wrapper is held to the width the bare text had', () => {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200)
  act(() => root.render(<TruncatedText as="h2" text="A title longer than its column" />))
  const wrapper = host.querySelector('h2')?.parentElement
  expect(wrapper?.className).toContain('max-w-full')
})
