import React from 'react'

// Is this subtree inside an overlay — a dialog, a popover, a drawer?
//
// Headers ask, because the two places a header lives want opposite edges
// (principles.md, "Hairlines carry the structure"). Inside an overlay, space
// separates: the shell already draws its own edge, and a rule under the title
// cuts a small surface into boxed strips. In a pane the header sits on the same
// ground as the body beside other panes, and one `border.subtle` hairline is
// what says where the chrome stops.
//
// A context rather than a prop, for the reason `useInToolbarBand` is one: the
// caller composing a popover should not have to remember to tell each header
// inside it where it is. Every overlay shell in the kit provides it.
export const OverlaySurfaceContext = React.createContext(false)

export function useInOverlaySurface(): boolean {
  return React.useContext(OverlaySurfaceContext)
}
