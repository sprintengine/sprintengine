// What the window's drawing of a components panel's tree (ComponentsView)
// needs from the panel's host (ComponentsPanelHost): the checked tree, where
// a press or an edit goes, and the window's own services for the few things
// a panel cannot do itself (opening a link, reading one of its images).

import type { ComponentNode, UnsupportedNode } from '../../../../../../packages/extension-sdk/src/components/tree'

export type ComponentsTree = ComponentNode | UnsupportedNode | null

export type ComponentsDispatch = (
  callback: string,
  args: unknown[],
  /** A value control's edit number: the window owns typed text until the panel has seen it (the edit protocol). */
  options?: { edit?: number },
) => void

export type ComponentsViewProps = {
  tree: ComponentsTree
  /** Bumped with every accepted tree; a press names the revision it saw (the host adds it). */
  revision: number
  dispatch: ComponentsDispatch
  /**
   * A press on a Button, IconButton, ListItem or Link that had stood still
   * for 500 ms (the stationary rule): the host grants the panel one
   * gesture-gated call within a second.
   */
  grantGesture(stood: boolean): void
  /** Open an `https:`, `http:` or `mailto:` URL from a Link's `href` or a Markdown link; only after the stationary rule. */
  openLink(href: string): void
  /** One of the extension's images as a `data:` URL, or null when it cannot be shown. */
  readImage(src: string): Promise<string | null>
  /** The last tree that loaded, kept after a save that did not: it answers no press until the next one loads. */
  inert: boolean
  /** Studio's language, for relative times and numbers. */
  locale: string
  /**
   * The run that drew the tree (its guest's document id). A new run counts
   * its edits from nothing, so the window's count of what it sent starts
   * over with it; what was typed carries over only in the panel's atoms.
   */
  run?: string
}
