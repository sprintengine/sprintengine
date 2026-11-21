import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'

import type { ExtensionMount, ExtensionMountStudio } from '@sprintengine/extension-sdk'

const NAME = '{{displayName}}'

// A door: a full-window surface with its own row in the Extensions drawer,
// declared in extension.json (`contributes.doors`, id "door"). Studio draws the
// row and the window around it, and the door in a sandboxed frame of its own:
// everything inside the element `mount` is handed is this extension's.
export function Door({ studio }: { studio: ExtensionMountStudio }) {
  useEffect(() => studio.ready(), [studio])
  return (
    <div style={{ padding: 16 }}>
      <h2 className="se-heading">Nothing here yet</h2>
      <p className="se-muted">This is {NAME}’s door. Draw what IDEA.md describes.</p>
    </div>
  )
}

export const mount: ExtensionMount = (root, studio) => {
  const view = createRoot(root)
  view.render(<Door studio={studio} />)
  return () => view.unmount()
}
