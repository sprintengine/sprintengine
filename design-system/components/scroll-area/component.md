# Scroll area

A region that scrolls, and marks an edge with a fade **only while content is
hidden past it**. Extracted from the shipped `ScrollArea` primitive
(`src/renderer/src/components/ui/ScrollArea.tsx`), the `useScrollEdges` hook
beside it, and the `.scroll-edge-fade` classes in the app's stylesheet.

It is what lets a header stop drawing a rule. A hairline under a title is
there whether or not anything is under it, so it says "edge" all the time. The
fade at the top of a scroll area appears the moment a row has scrolled beneath
the header and is gone once the list is back at its start: it says "edge" only
when it is true. The bottom edge works the same way, and so do the two ends of
a horizontal strip.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Region | `.ds-scroll-area` | yes — the scroll container; `overflow-y: auto`, `min-height: 0` so it can shrink inside a flex column |
| Start edge | `[data-scroll-start]` | set by script while content is hidden before the viewport |
| End edge | `[data-scroll-end]` | set by script while content is hidden after it |

The fade is a **mask**, not a gradient painted over the content: a block laid
on top would have to know the ground's colour, and scroll areas sit on panes,
raised popovers and glass. A mask takes alpha only, so its stops are
"transparent" and "opaque" and the fade has no hue of its own. Its depth is
`space.3xl` (24px), the same at every edge.

## Variants

- **Vertical (default)** — a body under a header, a list in a popover, a
  settings page.
- **`--x`** — a strip that scrolls sideways with no scrollbar: the pane's tab
  row, a row of cards. In the app, `useFadingScroll` is this variant plus a
  wheel that scrolls the strip. One mechanism for both axes, not one per
  scroller.

## States

| State | Treatment |
|---|---|
| Fits | No attribute, no mask — nothing is drawn over content that has no edge |
| At the start, more below | `data-scroll-end`: the bottom edge fades |
| In the middle | Both attributes: both edges fade |
| At the end | `data-scroll-start`: the top edge fades |

The attributes change as the scroll position crosses an edge, with one pixel of
slack each way so a sub-pixel of "overflow" on a box that fits paints nothing.
Nothing animates: the fade is there or it is not.

## Usage

**Overlays separate header and body by space; the scroll area marks the edge.**
A dialog, a popover, a drawer and the command palette draw no rule under their
title (`principles.md`, *Hairlines carry the structure*). When their body
scrolls, it is a scroll area, and the fade is the only edge it gets.

**Panes keep their one rule.** A pane's header sits on the same ground as the
body and the panes beside it, and one `border.subtle` hairline says where the
chrome stops. A pane's body may still be a scroll area for its far edge; the
header's rule stays.

**Never on a terminal, the code editor or the streaming chat timeline.** Those
surfaces repaint every frame, and a mask over them is recomposited every frame
with them. They mark their own edges (the timeline's jump-to-latest, the
editor's own scroll shadow) or none.

**Keep long lists cheap.** The edges are written as attributes, not through
component state, so scrolling a long list never re-renders it; only the mask
changes. A caller that needs the answer in render (a card row that disables its
arrows at the ends) asks for it through the hook's `onChange`.

**Rebuilding it in a framework:** what must survive is the attribute contract
(set while content is hidden at that edge, cleared at the edge), the alpha-only
mask at `space.3xl`, and the scroll padding below.

## Accessibility

- `scroll-padding` at the fade's depth on the scrolling axis, so a row walked
  into view by Tab or the arrow keys comes to rest clear of the fade rather
  than half-transparent beneath it. Keyboard focus never sits hidden inside a
  fade.
- The fade is decoration: it carries no role and no name. A region that holds
  focusable rows needs no `tabindex`; one that holds only text is given
  `tabindex="0"` and an accessible name, so a keyboard can scroll it.
- Under `prefers-reduced-motion` nothing changes — the fade does not move.
