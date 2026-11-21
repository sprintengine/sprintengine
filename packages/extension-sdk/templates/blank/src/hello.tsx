import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'

import type { ExtensionMount, ExtensionMountStudio } from '@sprintengine/extension-sdk'

const NAME = '{{displayName}}'

// The panel extension.json declares (`contributes.panels`, id "hello"). Studio
// imports the built extension/dist/hello.js and calls `mount` with an element
// the panel owns and a `studio` for this extension and this panel. Draw into
// the element, call `studio.ready()` once it is drawn, and return what closing
// the panel undoes.
//
// Replace it with what IDEA.md describes; the extension guide's `surfaces`
// topic says which contribution fits which idea.
export function Hello({ studio }: { studio: ExtensionMountStudio }) {
  // After the first paint: Studio measures the panel's opening up to here.
  useEffect(() => studio.ready(), [studio])
  return (
    <div
      style={{
        padding: 'var(--sem-space-lg)',
        fontFamily: 'var(--sem-font-family-ui)',
        fontSize: 'var(--sem-font-size-body)',
        color: 'var(--sem-color-text-default)',
      }}
    >
      <h2 style={{ margin: 0, color: 'var(--sem-color-text-primary)' }}>Hello from {NAME}</h2>
      <p style={{ color: 'var(--sem-color-text-muted)' }}>
        Running as {studio.moduleId}. Edit src/hello.tsx, then run npm run dev:install.
      </p>
    </div>
  )
}

export const mount: ExtensionMount = (root, studio) => {
  const view = createRoot(root)
  view.render(<Hello studio={studio} />)
  return () => view.unmount()
}
