import { useEffect, useRef, useState, type DependencyList } from 'react'

import { useScrollEdges, type ScrollEdges } from './useScrollEdges'

// How far the fade at an overflowing edge reaches, in px — `space.3xl`, the
// value `--scroll-fade-size` takes in `assets/index.css`. Exported for the one
// caller that has to keep a revealed slot clear of the fade (the tab strip's
// drop marker), which does its arithmetic in pixels.
export const SCROLL_FADE_PX = 24

/**
 * What a row that scrolls sideways with no scrollbar needs: which edges have
 * content past them, the class that fades those edges, and, with `claimWheel`,
 * a plain vertical wheel that scrolls it, for a row with no page to scroll
 * beneath it. `content` is what can change its scroll width.
 *
 * The fade itself is the shared scroll-edge mechanism (`useScrollEdges` and
 * the `.scroll-edge-fade-x` class), the same one every vertical `ScrollArea`
 * uses — one fade in the product, not one per scroller.
 */
export function useFadingScroll<E extends HTMLElement>(
  content: DependencyList,
  { claimWheel = false }: { claimWheel?: boolean } = {},
): {
  ref: React.RefObject<E | null>
  edges: ScrollEdges
  className: string
} {
  const ref = useRef<E>(null)
  const [edges, setEdges] = useState<ScrollEdges>({ start: false, end: false })
  useScrollEdges(ref, { axis: 'x', content, onChange: setEdges })

  useEffect(() => {
    const el = ref.current
    if (!el || !claimWheel) return
    const onWheel = (event: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return
      // A trackpad's horizontal component is already the browser's to handle.
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY) || event.deltaY === 0) return
      event.preventDefault()
      el.scrollLeft += event.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [claimWheel])

  return { ref, edges, className: 'scroll-edge-fade-x' }
}
