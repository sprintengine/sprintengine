import { useState, type JSX } from 'react'

// WorkingMark — "an agent is working right now": three dots that hop one after
// another, then rest, like a wave passing through an ellipsis. Drawn in the
// working ink (`--working-ink`, the theme's success green) by the `working-mark`
// rules in index.css.
//
// The wave is twelve drawn frames laid side by side in one SVG strip, and the
// mark slides the strip one frame at a time (`steps(12)`). That is one
// animation per mark, a transform only, where the 3×3 grid it replaced ran
// eight: the motion clock (utils/motionClock.ts) reads every loop it holds on
// each tick, so the count is what it pays for. Twelve frames over 1.5s is one
// frame per clock tick (MOTION_TICK_MS), and half the loop is a rest in which
// nothing changes.
//
// Reduced motion shows the first frame, the dots at rest: "•••" still says
// working without anything moving.

/** One drawn frame is a 14-unit square; the strip is FRAMES of them. */
const FRAME = 14
export const WORKING_MARK_FRAMES = 12
/** The loop's length. One frame per motion-clock tick. */
export const WORKING_MARK_PERIOD_MS = 1500

const DOT_X = [3.3, 7, 10.7]
const DOT_R = 1.35
const REST_Y = 8.9
const HOP = 3.4
/** Frames a dot spends in the air, and how many frames each dot lags the last. */
const HOP_FRAMES = 4
const LAG = 1

// Every frame's three dots, worked out once: a dot in the air rides a sine arc.
const DOTS = Array.from({ length: WORKING_MARK_FRAMES }, (_, frame) =>
  DOT_X.map((x, dot) => {
    const t = frame - dot * LAG
    const lift = t > 0 && t < HOP_FRAMES ? Math.sin((Math.PI * t) / HOP_FRAMES) : 0
    return { cx: Number((frame * FRAME + x).toFixed(2)), cy: Number((REST_Y - HOP * lift).toFixed(2)) }
  }),
).flat()

// Where in the loop a mark mounting now should start, so every mark on screen
// is on the same frame of the wave and a column of working chats hops
// together rather than flickering out of step.
function sharedPhase(): string | undefined {
  if (typeof document === 'undefined') return undefined
  const now = Number(document.timeline?.currentTime ?? 0)
  return `${-Math.round(now % WORKING_MARK_PERIOD_MS)}ms`
}

export function WorkingMark({
  label,
  className,
}: {
  /** Accessible name, e.g. "Agent working". */
  label: string
  className?: string
}): JSX.Element {
  const [animationDelay] = useState(sharedPhase)
  return (
    <span role="img" aria-label={label} className={`working-mark ${className ?? ''}`}>
      <svg
        aria-hidden
        className="working-mark__strip"
        viewBox={`0 0 ${FRAME * WORKING_MARK_FRAMES} ${FRAME}`}
        style={animationDelay ? { animationDelay } : undefined}
      >
        {DOTS.map(({ cx, cy }) => (
          <circle key={cx} cx={cx} cy={cy} r={DOT_R} />
        ))}
      </svg>
    </span>
  )
}
