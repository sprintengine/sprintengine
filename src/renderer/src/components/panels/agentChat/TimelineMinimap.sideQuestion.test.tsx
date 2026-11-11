// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { TimelineMinimap } from './TimelineMinimap'
import { fixedTurnPosition, type TurnMark, type TurnNavigation } from './turnNavigation'

// A side question the chat kept has a notch of its own in the rail, in the
// warn tone at rest and under the pointer, and its preview says what it is.

const marks: TurnMark[] = [
  { id: 'u0', rowIndex: 0, prompt: 'Rename the loader' },
  { id: 's0', rowIndex: 2, prompt: 'Why that name?', sideQuestion: true },
  { id: 'u1', rowIndex: 3, prompt: 'Now the tests' },
  { id: 'u2', rowIndex: 5, prompt: 'And the docs' },
]

const navigation: TurnNavigation = {
  marks,
  position: fixedTurnPosition({ current: 0, hasPrevious: false, hasNext: true }),
  jump: vi.fn(),
  step: vi.fn(),
  reply: (index) => (index === 1 ? 'It matches the module.' : `Reply ${index}`),
  wheel: vi.fn(),
}

test('a side question’s notch wears the warn tone, and a prompt’s does not', () => {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<TimelineMinimap navigation={navigation} />)
  const ticks = [...host.querySelectorAll<HTMLElement>('[data-minimap-track] > span')]
  expect(ticks).toHaveLength(4)
  expect(ticks.map((tick) => tick.dataset.sideQuestion === 'true')).toEqual([false, true, false, false])
  expect(ticks[1]!.className).toContain('bg-[color:var(--tone-warn)]')
  for (const index of [0, 2, 3]) expect(ticks[index]!.className).not.toContain('--tone-warn')
})

test('hovering a side question’s notch previews it as one, with its answer', () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(<TimelineMinimap navigation={navigation} />))
  const strip = host.querySelector<HTMLElement>('[data-minimap-strip]')!
  // The turn is read off the track, the span from the first tick to the last.
  host.querySelector<HTMLElement>('[data-minimap-track]')!.getBoundingClientRect = () =>
    ({ top: 0, height: 30, bottom: 30, left: 0, right: 16, width: 16 }) as DOMRect
  // Four marks over 30px: the second sits at y 10.
  act(() => {
    strip.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 10, buttons: 0 }))
  })
  expect(strip.textContent).toContain('Side question')
  expect(strip.textContent).toContain('Why that name?')
  expect(strip.textContent).toContain('It matches the module.')
  // The notch keeps its tone under the pointer.
  expect(strip.querySelector<HTMLElement>('[data-side-question="true"]')!.className).toContain('--tone-warn')
  act(() => {
    strip.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 20, buttons: 0 }))
  })
  expect(strip.textContent).not.toContain('Side question')
  act(() => root.unmount())
  host.remove()
})
