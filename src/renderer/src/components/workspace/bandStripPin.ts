// A top-row strip shows only its pill at rest; the other tabs fold behind it
// and fan out while the strip is hovered (index.css, "The strip's other tabs
// fold away"). The strip centres what it holds, so tabs fanning out on the
// pill's left pushed it right, out from under the pointer that had just
// reached it: the pointer landed on the tab beside it, and the pill could not
// be pressed. While a strip is fanned out its tabs are shifted so the pill
// stands where it stood, and the others open out around it.

const STRIP = '.flexlayout__tabset_tabbar_outer'
const TABS = '.flexlayout__tabset_tabbar_inner_tab_container'
const PILL = '.flexlayout__tab_button:has([data-tab-pill])'
/** The "+" tucked under the last tab's end: it moves with the tabs. */
const PLUS = '.flexlayout__tab_toolbar_sticky_buttons_container'
/** Kept clear at the strip's ends, so a shifted tab is never cut by its edge. */
const EDGE_INSET = 4
/** How long a strip is held after the pointer leaves: its tabs folding back away. */
const SETTLE_MS = 400

export type PinMeasure = {
  /** Where the pill stood when the strip started to fan out. */
  restLeft: number
  /** Where the pill stands now, without any shift. */
  naturalLeft: number
  /** The first tab's left edge and the last tab's right edge, without any shift. */
  firstLeft: number
  lastRight: number
  stripLeft: number
  stripRight: number
}

/**
 * The shift that puts the pill back where it stood, kept to what keeps every
 * tab inside the strip: a strip too full to hold them all around the pill lets
 * the pill move rather than cutting a tab off at its edge.
 */
export function pillPinOffset(m: PinMeasure): number {
  let offset = m.restLeft - m.naturalLeft
  const room = { left: m.stripLeft + EDGE_INSET - m.firstLeft, right: m.stripRight - EDGE_INSET - m.lastRight }
  if (offset < room.left) offset = room.left
  if (offset > room.right) offset = room.right
  // Too narrow for both ends: start from the first tab, as the strip would.
  if (room.left > room.right) offset = room.left
  return Math.round(offset)
}

function fannedOut(strip: Element): boolean {
  return strip.matches(':hover, :has(:focus-visible)')
}

function shiftOf(tabs: HTMLElement): number {
  return Number.parseFloat(tabs.style.translate) || 0
}

/**
 * Pins each top-row strip's pill while its tabs are out. Attach the returned
 * handler to `pointerover` and `focusin` on an ancestor of the layout; it
 * follows a strip from the frame its tabs start to move until they have folded
 * away again, measuring in the frame before each paint so the pill never
 * shows anywhere else.
 */
export function createBandStripPin(win: Window = window): {
  track: (target: EventTarget | null) => void
  stop: () => void
} {
  const tracked = new Map<Element, { pill: Element | null; restLeft: number; leftAt: number | null; frame: number }>()

  const release = (strip: Element) => {
    const entry = tracked.get(strip)
    if (entry) win.cancelAnimationFrame(entry.frame)
    tracked.delete(strip)
    for (const shifted of strip.querySelectorAll<HTMLElement>(`${TABS}, ${PLUS}`)) shifted.style.translate = ''
  }

  const step = (strip: Element) => {
    const entry = tracked.get(strip)
    const tabs = strip.querySelector<HTMLElement>(TABS)
    const pill = strip.querySelector(PILL)
    if (!entry || !tabs || !pill || !strip.isConnected) return release(strip)
    const shift = shiftOf(tabs)
    const pillLeft = pill.getBoundingClientRect().left
    // Another tab became the pill (it was pressed): it stays where it is now.
    if (pill !== entry.pill) {
      entry.pill = pill
      entry.restLeft = pillLeft
    }
    const buttons = tabs.querySelectorAll('.flexlayout__tab_button')
    const first = buttons[0]?.getBoundingClientRect()
    const last = buttons[buttons.length - 1]?.getBoundingClientRect()
    const bounds = strip.getBoundingClientRect()
    const offset = pillPinOffset({
      restLeft: entry.restLeft,
      naturalLeft: pillLeft - shift,
      firstLeft: (first?.left ?? pillLeft) - shift,
      lastRight: (last?.right ?? pillLeft) - shift,
      stripLeft: bounds.left,
      stripRight: bounds.right,
    })
    for (const shifted of strip.querySelectorAll<HTMLElement>(`${TABS}, ${PLUS}`))
      shifted.style.translate = offset ? `${offset}px 0` : ''
    const now = win.performance.now()
    if (fannedOut(strip)) entry.leftAt = null
    else entry.leftAt ??= now
    if (entry.leftAt !== null && now - entry.leftAt > SETTLE_MS) return release(strip)
    entry.frame = win.requestAnimationFrame(() => step(strip))
  }

  return {
    track(target) {
      if (!(target instanceof Element)) return
      const strip = target.closest(STRIP)
      if (!strip?.querySelector('[data-band-strip]')) return
      const entry = tracked.get(strip)
      if (entry) {
        entry.leftAt = null
        return
      }
      const pill = strip.querySelector(PILL)
      if (!pill) return
      const tabs = strip.querySelector<HTMLElement>(TABS)
      const restLeft = pill.getBoundingClientRect().left - (tabs ? shiftOf(tabs) : 0)
      tracked.set(strip, { pill, restLeft, leftAt: null, frame: 0 })
      tracked.get(strip)!.frame = win.requestAnimationFrame(() => step(strip))
    },
    stop() {
      for (const strip of [...tracked.keys()]) release(strip)
    },
  }
}
