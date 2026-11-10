// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'

import { useScrolledFromTop } from './useScrolledFromTop'

function Scroller() {
  const { ref, scrolled, onScroll } = useScrolledFromTop<HTMLDivElement>()
  return <div ref={ref} onScroll={onScroll} data-testid="scroller" {...(scrolled ? { 'data-scrolled': '' } : {})} />
}

test('a scroller says it has left its top only while it has', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<Scroller />))
  const el = host.querySelector<HTMLElement>('[data-testid="scroller"]')!
  expect(el.hasAttribute('data-scrolled')).toBe(false)

  const scrollTo = async (top: number) => {
    el.scrollTop = top
    await act(async () => {
      el.dispatchEvent(new Event('scroll'))
    })
  }
  await scrollTo(40)
  expect(el.hasAttribute('data-scrolled')).toBe(true)
  await scrollTo(0.5)
  expect(el.hasAttribute('data-scrolled'), 'under a pixel is the top').toBe(false)
  await scrollTo(0)
  expect(el.hasAttribute('data-scrolled')).toBe(false)

  await act(async () => root.unmount())
  host.remove()
})
