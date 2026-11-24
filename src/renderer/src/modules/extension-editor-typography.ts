import type { ExtensionEventPayloads } from '../../../../packages/extension-sdk/src/events'
import { followCodeFont, MONO_FONT_STACK } from '../utils/fonts'

// What Studio's file editor draws with, as an extension's surface hears it
// (`studio.on('editor.typography.changed')`): the window's own, since each
// window, paired or in a browser, keeps its own appearance. The editor
// (EditorPanel.tsx) reads its options from here, so the two never drift.

export const EDITOR_FONT_SIZE = 13
export const EDITOR_WORD_WRAP = 'off' as const
export const EDITOR_MINIMAP = false

type Typography = ExtensionEventPayloads['editor.typography.changed']

// Monaco's own line height for a size when none is set: one and a half on a
// Mac, a little less elsewhere.
function lineHeightOf(fontSize: number): number {
  const mac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
  return Math.round(fontSize * (mac ? 1.5 : 1.35))
}

/** The typography for a code font stack. */
export function editorTypographyOf(stack: string): Typography {
  const first =
    stack
      .split(',')[0]
      ?.trim()
      .replace(/^["']|["']$/g, '') ?? ''
  return {
    fontFamily: stack === MONO_FONT_STACK || first.length === 0 ? null : first,
    cssFontFamily: stack,
    fontSize: EDITOR_FONT_SIZE,
    fontWeight: 'normal',
    lineHeight: lineHeightOf(EDITOR_FONT_SIZE),
    fontLigatures: false,
    wordWrap: EDITOR_WORD_WRAP,
    minimap: EDITOR_MINIMAP,
  }
}

/** Hand `deliver` the typography now, once its face has loaded, and at each change. Returns the stop. */
export function followEditorTypography(deliver: (typography: Typography) => void): () => void {
  return followCodeFont((stack) => deliver(editorTypographyOf(stack)))
}
