// The transcript's breathing room above its first row and below its last,
// drawn by the virtual list itself as its header and footer.
//
// The list lays its rows out, and works out where its end is, from what it
// measures: its rows, its header and its footer, and padding only when it is
// handed one as a number. Padding a class puts on the scroller, or a margin a
// class puts between the list's own children, is none of those, so the list
// does not know it is there. The scroller used to carry `py-4`: everything sat
// one gap lower than the list believed, and the end it scrolled to, following
// a reply or jumping to the latest, stopped one gap short. The last row, which
// while a turn runs is the "Thinking" or "2 agents working" line, was sliced by
// the scroller's bottom edge, just above the composer's tray; a reader who
// scrolled the rest of the way down was pulled back up the next time that row
// changed. As the list's header and footer the gap is measured with the rest,
// so the end the list scrolls to is the real end, gap included.
//
// Nothing here depends on what the tray or the composer hold. They sit under
// the transcript in the chat's column, not over it, so the scroller already
// ends where they begin, and as they grow or shrink the list follows its own
// box: pinned to the end, it stays there (`layout` in AgentChatView's
// end-follow triggers); reading scrollback, its offset holds.

import type React from 'react'

/** Above the first row: the gap, then whatever the head holds (Load earlier). */
export function TranscriptHead({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <div data-transcript-head="" className="pt-[calc(var(--band-clearance,0px)+1rem)]">
      {children}
    </div>
  )
}

/** Below the last row: the gap, and nothing else. */
export const TRANSCRIPT_FOOT = <div aria-hidden="true" data-transcript-foot="" className="pb-4" />

/**
 * What a keyboard or a find match scrolls a row into view with: the same gap,
 * so a row brought into view at either edge does not land flush against it.
 */
export const TRANSCRIPT_SCROLL_PADDING_CLASS = 'scroll-py-4'

/**
 * Where a message the person just sent comes to rest: a sixth of the way down
 * the transcript, not flush with its top edge. At the very top it sat under
 * the window's title band, as if scrolled half out of view; a sixth down it
 * reads as the start of what comes next, with the turn's reply opening under
 * it. A share of the pane rather than a fixed distance, so a short pane does
 * not spend most of its height above the message and a tall one does not
 * leave it pinned to the edge.
 */
export const SENT_MESSAGE_REST_SHARE = 1 / 6

/** How far below the transcript's top edge a sent message rests, in pixels, for a pane this tall. */
export function sentMessageRestOffset(viewportHeight: number | undefined): number {
  if (!viewportHeight || !Number.isFinite(viewportHeight) || viewportHeight <= 0) return 0
  return Math.round(viewportHeight * SENT_MESSAGE_REST_SHARE)
}
