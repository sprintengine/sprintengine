// A surface that takes the card over a chat: New chat (a scheduled agent's
// editor among its modes), a door, the pane maximised over the row.
//
// A chat's card runs to the top of the window, with its name floating on it as a
// pill (owner rulings 2026-11-08 and 2026-11-09: no top bar). A surface over it
// that still started below the 36px band the bar used to be left that band
// uncovered, and the chat showed through it: the end of the conversation, over
// the surface's own top. So the cover reaches the window's top and paints its
// ground there, and what it holds starts below the band, where the window's
// controls and a door's lifted bar stand (WorkspaceBand, which floats over it).
//
// The inner box is what the surface's own absolutely placed parts measure from,
// so they start below the band too.

import React from 'react'

/** Covers the region from the window's top and keeps what it holds below the band. */
export const CARD_COVER_CLASS = 'absolute inset-0 pt-[36px]'

type CardCoverProps = React.HTMLAttributes<HTMLDivElement> & {
  ref?: React.Ref<HTMLDivElement>
  'data-new-chat-door'?: string
}

export function CardCover({ className = '', children, ref, ...rest }: CardCoverProps) {
  return (
    <div ref={ref} {...rest} className={`${CARD_COVER_CLASS} ${className}`}>
      <div className="relative h-full">{children}</div>
    </div>
  )
}
