// ScrollArea — a region that scrolls, and marks an edge with a fade only while
// content is hidden past it.
//
// Spec: design-system/components/scroll-area/component.md.
//
// This is what lets a header stop drawing a rule. A hairline under a title is
// there whether or not anything is under it; the fade at the top of the body
// appears the moment a row has scrolled beneath the header and goes when the
// list is back at its start. Overlays (dialogs, popovers, drawers) separate
// header and body by space and let this mark the edge; panes keep their one
// `border.subtle` rule and may use this for the body's far edge.
//
// Not for a terminal, the code editor or the streaming chat timeline: those
// repaint every frame, and a mask over them is redone every frame with them.

import React, { useImperativeHandle, useRef } from 'react'

import { useScrollEdges, type ScrollAxis } from './useScrollEdges'

export type ScrollAreaProps = React.HTMLAttributes<HTMLDivElement> & {
  /** The axis that scrolls. `y` (default) for a body; `x` for a strip. */
  axis?: ScrollAxis
  /** What can change the scroll extent in one render without resizing a child
   *  the observers already watch — the list's items, usually. */
  content?: React.DependencyList
}

export const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  { axis = 'y', content, className, children, ...rest },
  forwardedRef,
) {
  const ref = useRef<HTMLDivElement>(null)
  useImperativeHandle(forwardedRef, () => ref.current as HTMLDivElement)
  useScrollEdges(ref, { axis, content })
  return (
    <div
      ref={ref}
      {...rest}
      className={[
        axis === 'y' ? 'min-h-0 overflow-y-auto scroll-edge-fade' : 'min-w-0 overflow-x-auto scroll-edge-fade-x',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  )
})
