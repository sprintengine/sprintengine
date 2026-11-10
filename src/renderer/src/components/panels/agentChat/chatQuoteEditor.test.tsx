import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('a quote comment reopens with the caret after what was written', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })

  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { QuoteCommentEditor } = await import('./chatQuotes')

  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  act(() =>
    root.render(
      <QuoteCommentEditor
        n={1}
        initial="Worth a second look"
        anchor={{ left: 10, bottom: 10 }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    ),
  )

  const field = dom.window.document.querySelector('textarea') as HTMLTextAreaElement
  assert.ok(field, 'the editor rendered its field')
  assert.equal(field.selectionStart, field.value.length, 'the caret sits after the comment')
  assert.equal(field.selectionEnd, field.value.length)

  // A caret the person moved stays where they put it across a re-render.
  field.setSelectionRange(3, 3)
  act(() =>
    root.render(
      <QuoteCommentEditor
        n={1}
        initial="Worth a second look"
        anchor={{ left: 12, bottom: 12 }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    ),
  )
  assert.equal(field.selectionStart, 3)

  act(() => root.unmount())
  host.remove()
})
