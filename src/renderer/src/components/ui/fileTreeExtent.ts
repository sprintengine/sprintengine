// How wide a file tree is, and where a row's name sits in it.
//
// The tree never cuts a name short: every row shows its whole name and the
// tree scrolls sideways to reach the end of the longest one, the way a desktop
// IDE's project tree does. A tree that mounts every row gets that width from
// layout for free (it is as wide as its widest row). A windowed tree mounts
// only the rows in view, so its width would follow whichever rows happen to be
// mounted and jump as they recycle; it is given a floor computed from every
// row's depth and name instead, which is what this file works out.
//
// The arithmetic mirrors the row's own geometry in `FileTree.tsx`. A number
// here that moves without its class there puts the reveal off by that much.

/** Before the first level: the root row's own `px-2` inset. */
const ROW_INSET = 8
/**
 * One level of indent: the chevron's 12px flow advance (the kit's 24px `xs`
 * button pulled back by `-mx-1.5`) plus 2px, so a child's disclosure column
 * clears its parent's instead of sitting directly under it.
 */
const INDENT_STEP = 14
/**
 * From where a row's content starts to where its name starts: the chevron's
 * 12px advance (or a file's `w-3` spacer), the row's 8px `gap-2`, the 16px
 * glyph slot, and the gap again.
 */
export const FILE_TREE_NAME_OFFSET = 12 + 8 + 16 + 8
/** The row's trailing `px-2`. */
export const FILE_TREE_ROW_END_PADDING = 8

/** A row's left padding: where its chevron starts, from the row's own edge. */
export function fileTreeRowIndent(depth: number, indentSteps: 0 | 1): number {
  return ROW_INSET + (depth + indentSteps) * INDENT_STEP
}

/** What the width of a row depends on. */
export type FileTreeRowShape = { name: string; depth: number }

/**
 * The width of the widest row: its indent, the chevron and glyph before the
 * name, the name, and the row's end padding. `nameWidth` measures a name in
 * the row's type. A row's trailing marks (a status letter, a diff count) are
 * not counted; a rendered row that carries them still widens the tree.
 */
export function fileTreeContentWidth(
  rows: readonly FileTreeRowShape[],
  indentSteps: 0 | 1,
  nameWidth: (name: string) => number,
): number {
  let widest = 0
  for (const row of rows) {
    const width =
      fileTreeRowIndent(row.depth, indentSteps) +
      FILE_TREE_NAME_OFFSET +
      nameWidth(row.name) +
      FILE_TREE_ROW_END_PADDING
    if (width > widest) widest = width
  }
  return Math.ceil(widest)
}

/**
 * How much of a name has to be in view for it to count as shown: enough to
 * read its first few characters, not just its first pixel.
 */
const NAME_START_SHOWN = 48

/**
 * Where to scroll sideways so a row's name starts in view, or null to stay.
 * `rowStart` (where the chevron starts) and `nameStart` are offsets in the
 * scrolled content. When the name's start is out of view the tree goes back to
 * its left edge if that shows it, and otherwise brings the row's chevron to the
 * left edge, one indent step in so the parent's column still shows.
 */
export function fileTreeScrollLeftFor(view: {
  scrollLeft: number
  clientWidth: number
  rowStart: number
  nameStart: number
}): number | null {
  const { scrollLeft, clientWidth, rowStart, nameStart } = view
  const margin = Math.min(NAME_START_SHOWN, clientWidth / 2)
  if (nameStart >= scrollLeft && nameStart <= scrollLeft + clientWidth - margin) return null
  const target = nameStart <= clientWidth - margin ? 0 : Math.max(0, Math.floor(rowStart - INDENT_STEP))
  return target === scrollLeft ? null : target
}

/**
 * Whether any of `element` lies outside what its scrolling ancestors (and the
 * window) show. Asked on hover, so it walks the ancestors once rather than
 * listening to every scroll of every row.
 */
export function isClippedInView(element: Element): boolean {
  const view = element.ownerDocument.defaultView
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return false
  // Sub-pixel layout can put an edge a fraction past its clip.
  const slack = 1
  let left = 0
  let right = view?.innerWidth ?? Number.POSITIVE_INFINITY
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflowX = view?.getComputedStyle(node).overflowX ?? 'visible'
    if (overflowX === 'visible') continue
    const box = node.getBoundingClientRect()
    const clipLeft = box.left + node.clientLeft
    left = Math.max(left, clipLeft)
    right = Math.min(right, clipLeft + node.clientWidth)
  }
  return rect.left < left - slack || rect.right > right + slack
}

/**
 * Measures names in a given CSS font, remembering each, for the windowed
 * tree's width. Null where there is no canvas to measure with (a test DOM),
 * and then the tree is as wide as the rows it has mounted.
 */
export function createNameMeasurer(font: string, letterSpacing = '0px'): ((name: string) => number) | null {
  if (typeof OffscreenCanvas !== 'function') return null
  const context = new OffscreenCanvas(1, 1).getContext('2d')
  if (!context) return null
  context.font = font
  if ('letterSpacing' in context) context.letterSpacing = letterSpacing
  const widths = new Map<string, number>()
  return (name) => {
    let width = widths.get(name)
    if (width === undefined) {
      width = context.measureText(name).width
      widths.set(name, width)
    }
    return width
  }
}
