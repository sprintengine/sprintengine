import { useEffect, useMemo, useRef, useState, type JSX, type TransitionEvent } from 'react'
import { IconButton } from '../../ui'
import { OVERLAY_SURFACE_CLASS } from '../../ui/tokens'
import { markdownPreviewText } from '../../../utils/markdownPreviewText'
import {
  TURN_MINIMAP_MIN_TURNS,
  turnPreviewText,
  useTurnPosition,
  type TurnMark,
  type TurnNavigation,
} from './turnNavigation'

// One tick per prompt, spaced evenly rather than by where the turn sits in the
// scroll height: a virtualized list only knows the heights it has rendered, and
// a tick that drifts as rows are measured is worse than one that stays put.
// Under the pointer the strip opens out, so each turn has room to land on.
const TICK_SPACING_PX = 8
const TICK_SPACING_EXPANDED_PX = 20

// How long the open strip waits, once the pointer has left it and its step
// buttons, before it folds back to its resting size. Folding moves every tick,
// so a pointer that overshoots the last notch or drifts a little off the strip
// would otherwise come back to find the turn it was on somewhere else. The
// same pause the sidebar's hover reveal gives before it closes.
export const MINIMAP_COLLAPSE_DELAY_MS = 300

export function minimapTickTop(index: number, count: number): number {
  return count <= 1 ? 0 : (Math.max(0, Math.min(index, count - 1)) / (count - 1)) * 100
}

export function minimapIndexAtPointer(count: number, stripTop: number, stripHeight: number, pointerY: number): number {
  if (count <= 1 || stripHeight <= 0) return 0
  const ratio = Math.max(0, Math.min(1, (pointerY - stripTop) / stripHeight))
  return Math.round(ratio * (count - 1))
}

// 16-grid, 1.4 line work, currentColor — the chevron the step buttons carry.
function TurnStepGlyph({ direction }: { direction: 'up' | 'down' }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-xs" aria-hidden="true">
      <path
        d={direction === 'up' ? 'M4.5 10 8 6.5l3.5 3.5' : 'M4.5 6 8 9.5 11.5 6'}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// A tick is always 24px wide and scaled from its right edge (to 6px at rest;
// with the strip open, 12px, 16px beside the hovered one and the full 24px
// under the pointer), so the hover grows it with a transform the compositor
// animates rather than a width that lays the strip out each frame.
function tickClass(
  index: number,
  current: number,
  hovered: number | null,
  open: boolean,
  sideQuestion = false,
): string {
  const distance = hovered === null ? null : Math.abs(index - hovered)
  const scale =
    distance === null
      ? open
        ? 'scale-x-50'
        : 'scale-x-25'
      : distance === 0
        ? 'scale-x-100'
        : distance === 1
          ? 'scale-x-[0.6667]'
          : 'scale-x-50'
  // A step under the transcript's own inks at rest (2026-11-04): the margin
  // is a map of the reply, and at muted and border-strong its ticks read as
  // a second column of content beside it. The tick under the pointer keeps
  // full ink, which is the one a person is about to jump to.
  // A side question the chat kept wears the warn tone at every state, the
  // colour of its marker's glyph: it is not a turn, and reads as other.
  const ink = sideQuestion
    ? 'bg-[color:var(--tone-warn)]'
    : distance === 0
      ? 'bg-[color:var(--text-default)]'
      : index === current
        ? 'bg-[color:var(--text-subtle)]'
        : 'bg-[color:var(--border-default)]'
  return `pointer-events-none absolute right-0 h-0.5 w-6 origin-right -translate-y-1/2 rounded-full transition-[scale,background-color] duration-150 ${scale} ${ink}`
}

function MinimapPreview({
  mark,
  reply: replyText,
  index,
  count,
}: {
  mark: TurnMark
  reply: string | null
  index: number
  count: number
}): JSX.Element {
  const prompt = turnPreviewText(mark.prompt, 160) ?? 'Prompt with attachments only'
  // The reply is markdown and the preview has no room to render it, so it
  // shows the words. The prompt is what the person typed, shown as typed.
  const reply = useMemo(
    () => turnPreviewText(replyText === null ? null : markdownPreviewText(replyText), 240),
    [replyText],
  )
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute right-full mr-2 block w-72 max-w-[60vw] px-3 py-2 text-left ${OVERLAY_SURFACE_CLASS}`}
      style={{
        top: `${minimapTickTop(index, count)}%`,
        // The end previews hang inward so neither runs off the strip's ends.
        transform: `translateY(${index === 0 ? '0%' : index === count - 1 ? '-100%' : '-50%'})`,
      }}
    >
      {mark.sideQuestion ? (
        <span className="block text-micro leading-4 text-[color:var(--text-muted)]">Side question</span>
      ) : null}
      <span className="block truncate text-meta font-medium leading-5 text-[color:var(--text-strong)]">{prompt}</span>
      {reply ? (
        <span className="mt-0.5 line-clamp-3 text-meta leading-5 text-[color:var(--text-muted)]">{reply}</span>
      ) : null}
    </span>
  )
}

/**
 * The transcript's gutter minimap: a quiet tick per prompt in the right gutter,
 * a preview of the prompt and the start of its reply on hover, and a click to
 * jump there. The strip itself is pointer-only; the step buttons above and
 * below it, and the previous/next-turn shortcuts, are the keyboard's way
 * through the same turns.
 */
export function TimelineMinimap({ navigation }: { navigation: TurnNavigation }): JSX.Element | null {
  const { marks, jump, step, reply, wheel } = navigation
  const { current, hasPrevious, hasNext } = useTurnPosition(navigation)
  const [hovered, setHovered] = useState<number | null>(null)
  // Open is wider than hovered: the strip stays open while the pointer is
  // anywhere on the strip, its padding past either end, or the step buttons,
  // and for a moment after it leaves all of them. Only the preview follows
  // the pointer exactly.
  const [open, setOpen] = useState(false)
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelCollapse = () => {
    if (collapseTimerRef.current === null) return
    clearTimeout(collapseTimerRef.current)
    collapseTimerRef.current = null
  }
  const collapseNow = () => {
    cancelCollapse()
    setOpen(false)
    setHovered(null)
  }
  const scheduleCollapse = () => {
    cancelCollapse()
    collapseTimerRef.current = setTimeout(() => {
      collapseTimerRef.current = null
      setOpen(false)
      setHovered(null)
    }, MINIMAP_COLLAPSE_DELAY_MS)
  }
  useEffect(
    () => () => {
      if (collapseTimerRef.current !== null) clearTimeout(collapseTimerRef.current)
    },
    [],
  )
  // A wheel over the strip or its buttons scrolls the transcript beneath. The
  // listener is the DOM's own, not React's: React's wheel listener is passive,
  // and the forwarded wheel has to stop the browser scrolling anything else.
  const navRef = useRef<HTMLElement | null>(null)
  const shown = marks.length >= TURN_MINIMAP_MIN_TURNS
  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    nav.addEventListener('wheel', wheel, { passive: false })
    return () => nav.removeEventListener('wheel', wheel)
  }, [wheel, shown])
  // The strip opens out from under a still pointer, so the turn it rests on
  // is read again once the strip has finished growing.
  const pointerYRef = useRef<number | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  // A text selection dragged right past the end of a line reaches the strip
  // with the button still held. Taking the pointer there would open the strip
  // and its preview and pull the selection over the rest of the conversation,
  // so a press that began elsewhere passes through to the text underneath
  // until the button comes up. A press on the strip itself still scrubs.
  const pressedOnStripRef = useRef(false)
  const [passThrough, setPassThrough] = useState(false)
  useEffect(() => {
    // The button can come up outside the window, where no mouseup arrives;
    // the next move without it held ends the press all the same.
    const release = (event: MouseEvent) => {
      if (event.type === 'mousemove' && event.buttons !== 0) return
      pressedOnStripRef.current = false
      setPassThrough(false)
    }
    window.addEventListener('mouseup', release)
    window.addEventListener('mousemove', release)
    return () => {
      window.removeEventListener('mouseup', release)
      window.removeEventListener('mousemove', release)
    }
  }, [])
  // The minimap re-renders with every streamed token; its ticks only change
  // with the prompts, the reader's turn and the pointer.
  const ticks = useMemo(
    () =>
      marks.map((mark, index) => (
        <span
          key={mark.id}
          aria-hidden="true"
          data-current={index === current || undefined}
          data-side-question={mark.sideQuestion || undefined}
          className={tickClass(index, current, hovered, open, mark.sideQuestion)}
          style={{ top: `${minimapTickTop(index, marks.length)}%` }}
        />
      )),
    [marks, current, hovered, open],
  )
  if (!shown) return null
  const count = marks.length
  const hoveredMark = hovered !== null ? (marks[hovered] ?? null) : null
  // The turn is read off the track, the span from the first tick to the last;
  // the strip's padding past either end clamps to the end turn.
  const indexAt = (pointerY: number) => {
    const track = trackRef.current
    if (!track) return 0
    const rect = track.getBoundingClientRect()
    return minimapIndexAtPointer(count, rect.top, rect.height, pointerY)
  }
  const spacing = open ? TICK_SPACING_EXPANDED_PX : TICK_SPACING_PX
  const pointerEvents = passThrough ? 'pointer-events-none' : 'pointer-events-auto'
  const stepClass = `${pointerEvents} opacity-0 transition-opacity duration-150 group-hover/minimap:opacity-100 group-focus-within/minimap:opacity-100 group-data-[open]/minimap:opacity-100`
  // The step buttons are part of the strip's hover zone: on one of them the
  // strip stays open, but the preview goes, since the button names the turn.
  const onStepEnter = () => {
    if (passThrough) return
    cancelCollapse()
    pointerYRef.current = null
    setHovered(null)
  }
  return (
    // The strip and its buttons touch, with no gap between them, so the
    // pointer passing from one to the other never leaves the zone; the
    // strip's own padding is the space the gap used to make.
    <nav
      ref={navRef}
      aria-label="Conversation turns"
      data-testid="timeline-minimap"
      data-open={open || undefined}
      className="group/minimap pointer-events-none absolute inset-y-0 right-3 z-[var(--z-float)] flex flex-col items-end justify-center"
      onMouseLeave={scheduleCollapse}
    >
      <IconButton
        aria-label="Previous turn"
        size="3xs"
        tone="ink"
        className={stepClass}
        disabled={!hasPrevious}
        onMouseEnter={onStepEnter}
        onClick={() => step(-1)}
      >
        <TurnStepGlyph direction="up" />
      </IconButton>
      <div
        role="presentation"
        data-minimap-strip=""
        data-expanded={open || undefined}
        data-pass-through={passThrough || undefined}
        // The padding is the hit area past the first and last tick, so the
        // pointer can land on an end turn without having to stop on a line two
        // pixels tall; open, the strip is also wider than at rest, so a
        // pointer drifting sideways while it scrubs stays on it.
        className={`${pointerEvents} relative box-border cursor-pointer py-3 transition-[height,width] duration-150 ease-out ${open ? 'w-10' : 'w-4'}`}
        style={{ height: `calc(min(${(count - 1) * spacing}px, calc(100% - 6rem)) + 1.5rem)` }}
        onMouseDown={() => {
          pressedOnStripRef.current = true
        }}
        onMouseMove={(event) => {
          if (event.buttons !== 0 && !pressedOnStripRef.current) {
            pointerYRef.current = null
            collapseNow()
            setPassThrough(true)
            return
          }
          cancelCollapse()
          pointerYRef.current = event.clientY
          setOpen(true)
          setHovered(indexAt(event.clientY))
        }}
        onMouseLeave={() => {
          pointerYRef.current = null
          setHovered(null)
        }}
        onTransitionEnd={(event: TransitionEvent<HTMLDivElement>) => {
          if (event.target !== event.currentTarget || event.propertyName !== 'height') return
          const pointerY = pointerYRef.current
          if (pointerY !== null) setHovered(indexAt(pointerY))
        }}
        onClick={(event) => jump(indexAt(event.clientY))}
      >
        <div ref={trackRef} data-minimap-track="" className="pointer-events-none relative h-full">
          {ticks}
          {hoveredMark && hovered !== null ? (
            <MinimapPreview mark={hoveredMark} reply={reply(hovered)} index={hovered} count={count} />
          ) : null}
        </div>
      </div>
      <IconButton
        aria-label="Next turn"
        size="3xs"
        tone="ink"
        className={stepClass}
        disabled={!hasNext}
        onMouseEnter={onStepEnter}
        onClick={() => step(1)}
      >
        <TurnStepGlyph direction="down" />
      </IconButton>
    </nav>
  )
}
