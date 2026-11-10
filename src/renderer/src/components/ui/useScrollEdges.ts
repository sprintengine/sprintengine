import { useLayoutEffect, useRef, type DependencyList, type RefObject } from 'react'

// The scroll-edge fade, as a mechanism: which edges of a scroller have content
// hidden past them, written onto the element as `data-scroll-start` and
// `data-scroll-end`. The `.scroll-edge-fade` (vertical) and
// `.scroll-edge-fade-x` (horizontal) classes in `assets/index.css` turn those
// attributes into a mask, so the fade is drawn while content is hidden at an
// edge and gone the moment the edge is reached. Spec:
// design-system/components/scroll-area/component.md.
//
// Attributes rather than React state, on purpose. A scroll handler that set
// state would re-render the whole list it scrolls on every edge crossing, and
// the person would pay for it in the Git list and the Settings page — the two
// longest scrollers that take the fade. Writing two attributes touches only the
// mask. A caller that genuinely needs the answer in render (a card row that
// hides its arrows at the ends) passes `onChange`.

export type ScrollAxis = 'x' | 'y'

export type ScrollEdges = { start: boolean; end: boolean }

export const SCROLL_START_ATTR = 'data-scroll-start'
export const SCROLL_END_ATTR = 'data-scroll-end'

/**
 * Which edges of `el` have content past them along `axis`. One pixel of slack
 * each way: fractional layout leaves a sub-pixel of "overflow" on a box that
 * fits, which would paint a fade over nothing.
 */
export function readScrollEdges(el: HTMLElement, axis: ScrollAxis): ScrollEdges {
  const position = axis === 'y' ? el.scrollTop : el.scrollLeft
  const max = axis === 'y' ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth
  if (max <= 1) return { start: false, end: false }
  return { start: position > 1, end: position < max - 1 }
}

function writeScrollEdges(el: HTMLElement, edges: ScrollEdges): void {
  el.toggleAttribute(SCROLL_START_ATTR, edges.start)
  el.toggleAttribute(SCROLL_END_ATTR, edges.end)
}

/**
 * Keeps `data-scroll-start` / `data-scroll-end` on `ref`'s element in step with
 * its scroll position, its size and its content's size.
 *
 * `content` is what can change the scroll extent without resizing anything the
 * observers watch — pass the list's items when they arrive in one render.
 */
export function useScrollEdges<E extends HTMLElement>(
  ref: RefObject<E | null>,
  {
    axis = 'y',
    content = [],
    onChange,
  }: { axis?: ScrollAxis; content?: DependencyList; onChange?: (edges: ScrollEdges) => void } = {},
): void {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // Layout effect: the fade is part of the first paint, not a correction to it.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    let last: ScrollEdges | null = null
    const measure = () => {
      const next = readScrollEdges(el, axis)
      if (last && last.start === next.start && last.end === next.end) return
      last = next
      writeScrollEdges(el, next)
      onChangeRef.current?.(next)
    }
    measure()
    // Passive: the handler reads two numbers and never cancels the scroll, so
    // the compositor never waits on it.
    el.addEventListener('scroll', measure, { passive: true })

    // The box AND its children: content arriving changes the scroll extent
    // without changing the box. A child added later is picked up by the
    // mutation observer, which watches the direct child list only — a subtree
    // observer on a long list would wake on every row's own re-render.
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    const observeChildren = () => {
      if (!resize) return
      for (const child of Array.from(el.children)) resize.observe(child)
    }
    resize?.observe(el)
    observeChildren()
    const mutations =
      typeof MutationObserver === 'function'
        ? new MutationObserver(() => {
            observeChildren()
            measure()
          })
        : null
    mutations?.observe(el, { childList: true })

    return () => {
      el.removeEventListener('scroll', measure)
      resize?.disconnect()
      mutations?.disconnect()
      el.removeAttribute(SCROLL_START_ATTR)
      el.removeAttribute(SCROLL_END_ATTR)
    }
    // `content` is the caller's dependency list, spread on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, axis, ...content])
}
