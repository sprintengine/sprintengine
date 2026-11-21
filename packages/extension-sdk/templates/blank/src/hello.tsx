import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'

import type { ExtensionMount, ExtensionMountStudio } from '@sprintengine/extension-sdk'

const NAME = '{{displayName}}'

// The panel extension.json declares (`contributes.panels`, id "hello"). Studio
// draws it in a sandboxed frame of its own, loads the built
// extension/dist/hello.js there and calls `mount` with the frame's root
// element and a `studio` for this panel. Draw into the element, call
// `studio.ready()` once it is drawn, and return what closing the panel undoes.
// The frame carries Studio's theme as CSS variables (`--bg-surface`,
// `--text-default`, …) and its kit classes (`se-heading`, `se-button`, …).
//
// Replace it with what IDEA.md describes; the extension guide's `surfaces`
// topic says which contribution fits which idea.
export function Hello({ studio }: { studio: ExtensionMountStudio }) {
  // After the first paint: Studio measures the panel's opening up to here.
  useEffect(() => studio.ready(), [studio])
  return (
    <div style={{ padding: 16 }}>
      <h2 className="se-heading">Hello from {NAME}</h2>
      <p className="se-muted">
        Drawn as the {studio.surface.id} panel. Edit src/hello.tsx, then run npm run dev:install.
      </p>
    </div>
  )
}

export const mount: ExtensionMount = (root, studio) => {
  const view = createRoot(root)
  view.render(<Hello studio={studio} />)
  return () => view.unmount()
}
