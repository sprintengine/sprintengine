import React from 'react'

// SidePane — pure chrome primitive for the side columns that sit alongside
// a board or list. Owns the width preset, the single hairline divider, and
// the flex column. Does NOT own the header (callers compose PanelHeader,
// which draws one `border.subtle` rule in a pane) or the scroll body (kept
// caller-owned because
// keyboard handlers and list semantics vary per surface).
//
// Renders as <aside> by default (secondary content). Use `as="section"` for
// primary content columns,
// where the column carries the panel's main flow.
//
// Width presets match the documented sister-aside widths:
//   sm — 38 % / 320–520. Quieter right-side asides (running agents,
//        active review).
//   md — 42 % / 320–560. Detail asides anchored to the right.
//   lg — 44 % / 320–560. Primary content columns (inbox columns).

type WidthPreset = 'sm' | 'md' | 'lg'

const WIDTH_PRESETS: Record<WidthPreset, string> = {
  sm: 'w-[38%] min-w-[320px] max-w-[520px]',
  md: 'w-[42%] min-w-[320px] max-w-[560px]',
  lg: 'w-[44%] min-w-[320px] max-w-[560px]',
}

type SidePaneProps = {
  /** `aside` (default) marks secondary content; `section` marks a primary
   *  content column anchored on one side of the panel. */
  as?: 'aside' | 'section'
  /** Which edge carries the hairline divider. */
  side: 'left' | 'right'
  /** Width preset; see comment header for the per-token mapping. */
  width?: WidthPreset
  /** When true, the pane fills the available flex row (caller is responsible
   *  for hiding the adjacent content). The side divider is dropped since
   *  there is no neighbouring surface to separate from. */
  expanded?: boolean
  /** Render the pane with `--bg-app` instead of inheriting the panel's
   *  surface. Used for "sunken" secondary asides (running agents, active
   *  review) that benefit from a quiet shade contrast against the lane. */
  tone?: 'default' | 'sunken'
  ariaLabel?: string
  ariaLabelledBy?: string
  className?: string
  children: React.ReactNode
}

export function SidePane({
  as = 'aside',
  side,
  width = 'md',
  expanded = false,
  tone = 'default',
  ariaLabel,
  ariaLabelledBy,
  className,
  children,
}: SidePaneProps) {
  const classes = [
    'flex flex-col',
    expanded ? 'min-w-0 w-full max-w-none flex-1' : WIDTH_PRESETS[width],
    expanded
      ? ''
      : side === 'left'
        ? 'border-r border-[color:var(--border-default)]'
        : 'border-l border-[color:var(--border-default)]',
    tone === 'sunken' ? 'bg-[color:var(--bg-app)]' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  if (as === 'section') {
    return (
      <section className={classes} aria-label={ariaLabel} aria-labelledby={ariaLabelledBy}>
        {children}
      </section>
    )
  }
  return (
    <aside className={classes} aria-label={ariaLabel} aria-labelledby={ariaLabelledBy}>
      {children}
    </aside>
  )
}
