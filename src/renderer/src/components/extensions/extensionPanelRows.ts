import { getExtensionPanels } from '../../modules/extension-surfaces'
import { extensionGlyph } from '../../modules/extension-glyphs'
import type { ExtensionPanelRow } from '../workspace/pane/paneKinds'

/** Every loaded extension panel, as the pane's "+" menu offers it; enablement is the composer's to apply. */
export function extensionPanelRows(): ExtensionPanelRow[] {
  return getExtensionPanels().map((surface) => ({
    key: surface.key,
    panel: surface.contribution.id,
    title: surface.contribution.title,
    Glyph: extensionGlyph(surface.contribution.icon),
  }))
}
