import { useCallback, useLayoutEffect, useRef, useState } from 'react'

/**
 * Whether a vertical scroller has left its top, for a list that scrolls up
 * under chrome floating over it: the list fades its top edge only once
 * something has gone up under that chrome, and at rest it is drawn plain.
 * `onScroll` goes on the scroller; the answer only changes when the top is
 * left or reached, so scrolling in between renders nothing.
 */
export function useScrolledFromTop<E extends HTMLElement>(): {
  ref: React.RefObject<E | null>
  scrolled: boolean
  onScroll: () => void
} {
  const ref = useRef<E>(null)
  const [scrolled, setScrolled] = useState(false)
  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    // Under a pixel is the top: a fractional scroll offset after a zoom or a
    // resize is not content gone up under anything.
    setScrolled(el.scrollTop >= 1)
  }, [])
  // A scroller that mounts already scrolled (restored) says so on first paint.
  useLayoutEffect(onScroll, [onScroll])
  return { ref, scrolled, onScroll }
}
