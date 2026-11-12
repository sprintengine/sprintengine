import type { TerminalOutputEvent } from '../../../packages/studio-protocol/src/public'

// Who a terminal session's output goes to: one pane at a time, the last to
// open or show it. A viewer is a pane's `terminal.output` subscription on a
// Studio connection (`studio-terminals.ts`); a session
// nobody has opened yet, such as an agent the launch service started, has the
// headless viewer, which takes nothing, so its pty runs and buffers until a
// pane adopts it and is replayed to.
//
// Nothing here knows what a window is: the runtime streams to whatever it is
// handed, and a viewer that has gone (its connection closed, or it
// unsubscribed) is one any pane may take the session over from.

export type TerminalViewer = {
  /** The pane is gone: nothing it is handed reaches anyone, and another pane may adopt the session. */
  isGone(): boolean
  deliver(event: TerminalOutputEvent): void
}

const HEADLESS: TerminalViewer = Object.freeze({
  isGone: () => true,
  deliver: () => undefined,
})

/** The viewer of a session no pane has opened: it is always gone, so the first pane to open the session takes it. */
export function headlessTerminalViewer(): TerminalViewer {
  return HEADLESS
}

/** Hand a viewer one event, unless it has gone. */
export function deliverTerminalEvent(viewer: TerminalViewer, event: TerminalOutputEvent): void {
  if (!viewer.isGone()) viewer.deliver(event)
}
