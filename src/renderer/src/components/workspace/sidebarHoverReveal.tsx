// The collapsed sidebar, shown at the window's left edge (Settings ▸ Appearance,
// "Show sidebar at the edge"). Collapsing the sidebar buys the workspace its
// width; resting the pointer at the left edge borrows the sidebar back for a
// moment, floating over the workspace rather than pushing it aside, and moving
// away hands it back. Nothing here writes `sidebarCollapsed`: the person
// collapsed the sidebar, and a glance at it is not a change of mind. The
// toggle and its shortcut still dock it, and docking it ends the reveal.
//
// Two thin strips call it: the window's own edge, over the outer margin of the
// app rail, which is where a pointer flung to the left of a window at the
// screen's edge comes to rest; and the rail's inner edge, where the sidebar
// would stand. Both start under the 36px band, so the traffic lights and the
// band's launcher are never under a strip. Once it is out, the rail and the
// sidebar together are one region: moving between them keeps it out, leaving
// both puts it away.
//
// Only where the pointer hovers. A touch screen has no edge to rest on, and a
// phone-width window already shows the sidebar and the workspace in turns.

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { MODAL_SURFACE_SELECTOR } from '../ui/Modal'
import { APP_RAIL_WIDTH } from './AppRail'
import { TITLE_BAR_HEIGHT_PX } from './AppTitleBar'

export type SidebarRevealPhase = 'closed' | 'entering' | 'open' | 'closing'

// How long the pointer has to rest at the edge before the sidebar comes out.
// Long enough that a sweep past the edge — to a window control, a scrollbar,
// another app — passes through a strip without calling it; short enough that
// reaching for it does not feel like waiting.
export const SIDEBAR_REVEAL_OPEN_DELAY_MS = 200
// How long the pointer can be outside the rail and the sidebar before it goes.
// It covers crossing the gap between a strip and the sidebar, and an overshoot
// past the sidebar's edge that comes straight back.
export const SIDEBAR_REVEAL_CLOSE_DELAY_MS = 300
// A pointer travelling along the edge rather than resting on it: this much
// vertical travel inside a strip restarts the open delay, so running the edge
// up to the traffic lights does not open it on the way.
export const SIDEBAR_REVEAL_SWEEP_PX = 24
// The slide's own end is what puts it away; this only covers a transition
// that never reports, as the Drawer primitive does.
const EXIT_FALLBACK_MS = 320

// A pointer that hovers, finely: a mouse or a trackpad, not a finger.
export const FINE_HOVER_QUERY = '(hover: hover) and (pointer: fine)'

function fineHoverQuery(): MediaQueryList | null {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    ? null
    : window.matchMedia(FINE_HOVER_QUERY)
}

function subscribeFineHover(onChange: () => void): () => void {
  const list = fineHoverQuery()
  if (!list) return () => undefined
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

const readFineHover = () => fineHoverQuery()?.matches === true

export function useFineHover(): boolean {
  return useSyncExternalStore(subscribeFineHover, readFineHover, () => false)
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Whether the sidebar is mid-use and has to stay out though the pointer left:
 * a field or a control in it holds focus a keyboard put there (a rename being
 * typed, a row reached with Tab), a menu or popover opened from it is still
 * up, a context menu is open anywhere, or a dialog is. Each of those is the
 * person still working with what the sidebar showed them, and yanking it
 * would take the thing they were pointing at out from under the menu.
 */
export function sidebarRevealHeld(frame: HTMLElement | null): boolean {
  if (typeof document === 'undefined') return false
  if (popupAbove(frame)) return true
  const active = document.activeElement
  if (frame && active instanceof HTMLElement && frame.contains(active)) {
    let keyboardFocus = false
    try {
      keyboardFocus = active.matches(':focus-visible')
    } catch {
      keyboardFocus = false
    }
    if (keyboardFocus || active.isContentEditable || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') {
      return true
    }
  }
  return false
}

// A surface standing over the shown sidebar: a menu or popover opened from it,
// a context menu anywhere, a dialog. Each closes on its own Escape.
function popupAbove(frame: HTMLElement | null): boolean {
  // A popover's trigger says it is open; a tree's folders say aria-expanded
  // too, which is why the trigger has to be one that has a popup.
  if (frame?.querySelector('[aria-haspopup][aria-expanded="true"]')) return true
  return document.querySelector(`[role="menu"], ${MODAL_SURFACE_SELECTOR}`) !== null
}

type PointerLike = Pick<React.PointerEvent, 'pointerType' | 'buttons' | 'clientY'>

// A finger has no hover, and a pointer with a button down is dragging —
// selecting text from the left of a chat, moving a splitter — not reaching.
function reaches(event: PointerLike): boolean {
  return event.pointerType !== 'touch' && event.buttons === 0
}

export interface SidebarHoverReveal {
  /** Whether the edge can call the sidebar at all right now. */
  enabled: boolean
  phase: SidebarRevealPhase
  /** The sidebar is out, or on its way in or out. */
  shown: boolean
  /** On each edge strip. */
  zoneProps: {
    onPointerEnter: (event: React.PointerEvent) => void
    onPointerMove: (event: React.PointerEvent) => void
    onPointerLeave: () => void
  }
  /** On the element holding the rail and the sidebar. */
  regionProps: {
    onPointerEnter: () => void
    onPointerLeave: () => void
  }
  frameRef: React.RefObject<HTMLDivElement | null>
  onTransitionEnd: (event: React.TransitionEvent<HTMLDivElement>) => void
  /** Put it away now. */
  hide: () => void
}

export function useSidebarHoverReveal({
  enabled,
  dismissKey,
}: {
  /** Collapsed, the setting on, a hovering pointer, and a desktop-width window. */
  enabled: boolean
  /** Changes when the person goes somewhere — another chat, a door, New chat —
   *  which is what picking from the sidebar is for, so it goes away. */
  dismissKey: string
}): SidebarHoverReveal {
  const [phase, setPhaseState] = useState<SidebarRevealPhase>('closed')
  const phaseRef = useRef<SidebarRevealPhase>('closed')
  const frameRef = useRef<HTMLDivElement | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const enterFrame = useRef<number | null>(null)
  const anchorY = useRef(0)

  const setPhase = useCallback((next: SidebarRevealPhase) => {
    phaseRef.current = next
    setPhaseState(next)
  }, [])

  const clearOpen = useCallback(() => {
    if (openTimer.current !== null) clearTimeout(openTimer.current)
    openTimer.current = null
  }, [])
  const clearClose = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }, [])
  const clearMotion = useCallback(() => {
    if (exitTimer.current !== null) clearTimeout(exitTimer.current)
    exitTimer.current = null
    if (enterFrame.current !== null) cancelAnimationFrame(enterFrame.current)
    enterFrame.current = null
  }, [])

  const show = useCallback(() => {
    clearClose()
    clearMotion()
    if (phaseRef.current === 'open' || phaseRef.current === 'entering') return
    if (phaseRef.current === 'closing') {
      setPhase('open')
      return
    }
    // One frame at the start of the slide, so the browser has a place to
    // slide from: mounting straight into `open` would draw it already out.
    setPhase('entering')
    enterFrame.current = requestAnimationFrame(() => {
      enterFrame.current = requestAnimationFrame(() => {
        enterFrame.current = null
        if (phaseRef.current === 'entering') setPhase('open')
      })
    })
  }, [clearClose, clearMotion, setPhase])

  const hide = useCallback(() => {
    clearOpen()
    clearClose()
    clearMotion()
    if (phaseRef.current === 'closed' || phaseRef.current === 'closing') return
    // Focus in a sidebar about to be hidden would fall to nothing; letting go
    // of it here leaves it on the document rather than on a hidden row.
    const active = typeof document === 'undefined' ? null : document.activeElement
    if (active instanceof HTMLElement && frameRef.current?.contains(active)) active.blur()
    if (prefersReducedMotion()) {
      setPhase('closed')
      return
    }
    setPhase('closing')
    exitTimer.current = setTimeout(() => {
      exitTimer.current = null
      if (phaseRef.current === 'closing') setPhase('closed')
    }, EXIT_FALLBACK_MS)
  }, [clearClose, clearMotion, clearOpen, setPhase])

  const scheduleClose = useCallback(() => {
    clearClose()
    closeTimer.current = setTimeout(function check() {
      // Still in use: look again after another delay rather than giving up,
      // so it goes once the menu closes if the pointer is elsewhere by then.
      if (sidebarRevealHeld(frameRef.current)) {
        closeTimer.current = setTimeout(check, SIDEBAR_REVEAL_CLOSE_DELAY_MS)
        return
      }
      closeTimer.current = null
      hide()
    }, SIDEBAR_REVEAL_CLOSE_DELAY_MS)
  }, [clearClose, hide])

  const armOpen = useCallback(() => {
    clearOpen()
    openTimer.current = setTimeout(() => {
      openTimer.current = null
      show()
    }, SIDEBAR_REVEAL_OPEN_DELAY_MS)
  }, [clearOpen, show])

  // Off — expanded, the setting turned off, the window narrowed to a phone's
  // width — ends it at once. Docking the sidebar must not leave a second copy
  // sliding away over the one that just docked.
  useEffect(() => {
    if (enabled) return
    clearOpen()
    clearClose()
    clearMotion()
    if (phaseRef.current !== 'closed') setPhase('closed')
  }, [enabled, clearClose, clearMotion, clearOpen, setPhase])

  // Somewhere new: the pick was made, and what was picked is what to see.
  const lastDismissKey = useRef(dismissKey)
  useEffect(() => {
    if (lastDismissKey.current === dismissKey) return
    lastDismissKey.current = dismissKey
    hide()
  }, [dismissKey, hide])

  // Escape puts it away, and only it: the shown sidebar is the topmost thing
  // on the screen, so the key is its and goes no further — without that, the
  // same press also closed New chat underneath it. Captured, because the
  // surfaces under it listen on the way up. A menu, popover or dialog standing
  // over it is the topmost thing instead, and the key is left for it.
  const shown = phase !== 'closed'
  useEffect(() => {
    if (!shown || typeof window === 'undefined') return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (phaseRef.current === 'closing' || popupAbove(frameRef.current)) return
      event.preventDefault()
      event.stopPropagation()
      hide()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [shown, hide])

  useEffect(
    () => () => {
      clearOpen()
      clearClose()
      clearMotion()
    },
    [clearClose, clearMotion, clearOpen],
  )

  const zoneProps = useMemo(
    () => ({
      onPointerEnter: (event: React.PointerEvent) => {
        if (!enabled || !reaches(event)) return
        clearClose()
        if (phaseRef.current === 'open' || phaseRef.current === 'entering') return
        anchorY.current = event.clientY
        armOpen()
      },
      onPointerMove: (event: React.PointerEvent) => {
        if (!enabled) return
        if (!reaches(event)) {
          clearOpen()
          return
        }
        if (phaseRef.current === 'open' || phaseRef.current === 'entering') return
        if (openTimer.current === null) {
          // A button let go inside the strip, or a pointer that arrived
          // dragging: it is resting now, so it counts from here.
          anchorY.current = event.clientY
          armOpen()
          return
        }
        if (Math.abs(event.clientY - anchorY.current) > SIDEBAR_REVEAL_SWEEP_PX) {
          anchorY.current = event.clientY
          armOpen()
        }
      },
      onPointerLeave: () => clearOpen(),
    }),
    [enabled, armOpen, clearClose, clearOpen],
  )

  const regionProps = useMemo(
    () => ({
      onPointerEnter: () => {
        if (phaseRef.current !== 'closed') clearClose()
      },
      onPointerLeave: () => {
        clearOpen()
        if (phaseRef.current === 'open' || phaseRef.current === 'entering') scheduleClose()
      },
    }),
    [clearClose, clearOpen, scheduleClose],
  )

  const onTransitionEnd = useCallback(
    (event: React.TransitionEvent<HTMLDivElement>) => {
      // The slide is the panel's own transform; a row's colour fading inside
      // it bubbles here too and says nothing about the slide.
      if (event.target !== event.currentTarget || event.propertyName !== 'transform') return
      if (phaseRef.current !== 'closing') return
      clearMotion()
      setPhase('closed')
    },
    [clearMotion, setPhase],
  )

  return { enabled, phase, shown, zoneProps, regionProps, frameRef, onTransitionEnd, hide }
}

/**
 * The two strips at the left edge that call the sidebar. Rendered before the
 * sidebar's frame, so once it is out it covers the inner strip and that strip
 * takes no clicks meant for it.
 */
export function SidebarRevealZones({
  reveal,
  railWidth = APP_RAIL_WIDTH,
}: {
  reveal: SidebarHoverReveal
  /** How wide the rail stands (appRailWidth): the inner strip runs along its edge. */
  railWidth?: number
}) {
  if (!reveal.enabled) return null
  // `app-no-drag`: the rail is a window drag region, and a drag region gets
  // no pointer events, so a strip over it has to opt out to hear the pointer.
  const strip = 'app-no-drag absolute bottom-0 z-[var(--z-drawer)] w-1'
  return (
    <>
      <div
        aria-hidden="true"
        data-sidebar-reveal-zone="edge"
        className={`${strip} left-0`}
        style={{ top: TITLE_BAR_HEIGHT_PX }}
        {...reveal.zoneProps}
      />
      <div
        aria-hidden="true"
        data-sidebar-reveal-zone="rail"
        className={strip}
        style={{ top: TITLE_BAR_HEIGHT_PX, left: railWidth }}
        {...reveal.zoneProps}
      />
    </>
  )
}

/**
 * Where the shown sidebar floats. At rest both layers are `display: contents`,
 * so the sidebar sits in the shell's row exactly as before and nothing above it
 * remounts when it comes out. Shown, the outer layer is the area right of the
 * rail, clipping the slide so the sidebar comes out from behind the rail
 * rather than across it, and the inner one is the panel that slides
 * (`.sidebar-reveal`, assets/index.css: the drawer elevation and motion).
 */
export function SidebarRevealFrame({
  reveal,
  railWidth = APP_RAIL_WIDTH,
  children,
}: {
  reveal: SidebarHoverReveal
  /** How wide the rail stands (appRailWidth): the sidebar comes out from behind it. */
  railWidth?: number
  children: React.ReactNode
}) {
  const { shown, phase } = reveal
  return (
    <div
      ref={reveal.frameRef}
      className={
        shown ? 'pointer-events-none absolute inset-y-0 right-0 z-[var(--z-drawer)] flex overflow-hidden' : 'contents'
      }
      style={shown ? { left: railWidth } : undefined}
    >
      <div
        data-reveal={shown ? phase : undefined}
        className={shown ? 'sidebar-reveal pointer-events-auto flex' : 'contents'}
        onTransitionEnd={reveal.onTransitionEnd}
      >
        {children}
      </div>
    </div>
  )
}
