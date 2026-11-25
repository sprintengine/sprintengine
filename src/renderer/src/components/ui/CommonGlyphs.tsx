import React from 'react'

// Everyday marks on the 16-grid at the ui/ primitives' stroke (1.4), in
// `currentColor`: find, dismiss, the two notices (info, error), download,
// filter, link, launch and data. An extension's panel names them through its
// `icon` props, and the app's own surfaces take them from here rather than
// drawing their own copies (design-system/glyphs/search.svg, close.svg,
// info.svg, error.svg, download.svg, filter.svg, link.svg, rocket.svg and
// database.svg are the framework-neutral samples).

type GlyphProps = { className?: string }

const STROKE = {
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

/** Find: a lens and its handle. */
export function SearchGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="7" cy="7" r="4.25" {...STROKE} />
      <path d="M10.25 10.25 13.25 13.25" {...STROKE} />
    </svg>
  )
}

/**
 * Dismiss: the × that `CloseIconButton` wears, on its own 14-grid. A close mark
 * is only ever a button; an unpadded one is below the hit-target floor.
 */
export function CloseGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 14 14" fill="none" className={className} aria-hidden="true">
      <path d="M3.25 3.25L10.75 10.75M10.75 3.25L3.25 10.75" {...STROKE} />
    </svg>
  )
}

/** Information: a lower-case i in a circle. */
export function InfoGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="8" cy="8" r="5.75" {...STROKE} />
      <path d="M8 7.5v3.25" {...STROKE} />
      <circle cx="8" cy="5.25" r="0.8" fill="currentColor" />
    </svg>
  )
}

/**
 * An error: an exclamation mark in a circle. Distinct from `WarningIcon`'s
 * triangle, so a failure and a caution never read alike in grayscale.
 */
export function ErrorGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="8" cy="8" r="5.75" {...STROKE} />
      <path d="M8 4.75v3.75" {...STROKE} />
      <circle cx="8" cy="10.85" r="0.8" fill="currentColor" />
    </svg>
  )
}

/** Download: an arrow coming down into a tray. */
export function DownloadGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M8 2.5v7.5M5 7l3 3 3-3M2.75 10.5v1.75c0 .69.56 1.25 1.25 1.25h8c.69 0 1.25-.56 1.25-1.25V10.5"
        {...STROKE}
      />
    </svg>
  )
}

/** Filter: three lines narrowing, the drawing the filter menu's trigger wears. */
export function FilterGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** A link: two chain links joined on the diagonal. Not the open-external arrow, which leaves. */
export function LinkGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M6.5 9.5l3-3M7.25 4.75l1.25-1.25a2.5 2.5 0 0 1 3.54 3.54L10.75 8.25M8.75 11.25 7.5 12.5a2.5 2.5 0 0 1-3.54-3.54L5.25 7.75"
        {...STROKE}
      />
    </svg>
  )
}

/** Launch: a rocket climbing to the top right, its two fins and a short flame. */
export function RocketGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M13.25 2.75c-3.25 0-5.75 1.75-7.5 4.75l2.75 2.75c3-1.75 4.75-4.25 4.75-7.5ZM5.75 7.5H3.25l1.75-2.25h2.5M8.5 10.25v2.5l2.25-1.75v-2.5M4.5 10.5c-.85.5-1.4 1.6-1.5 2.5.9-.1 2-.65 2.5-1.5"
        {...STROKE}
      />
      <circle cx="10.25" cy="5.75" r="0.9" fill="currentColor" />
    </svg>
  )
}

/** Data: a stack of three disks, a database's drum. */
export function DatabaseGlyph({ className }: GlyphProps): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <ellipse cx="8" cy="4" rx="4.75" ry="1.75" {...STROKE} />
      <path
        d="M3.25 4v8c0 .97 2.13 1.75 4.75 1.75s4.75-.78 4.75-1.75V4M3.25 8c0 .97 2.13 1.75 4.75 1.75S12.75 8.97 12.75 8"
        {...STROKE}
      />
    </svg>
  )
}
