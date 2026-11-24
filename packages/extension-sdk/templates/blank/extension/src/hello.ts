import type { ExtensionMount, ExtensionMountStudio } from '@sprintengine/extension-sdk'

const NAME = '{{displayName}}'

// The panel extension.json declares (`contributes.panels`, id "hello"). Studio
// draws it in a sandboxed frame of its own, loads this file there as written
// and calls `mount` with the frame's root element and a `studio` for this
// panel. Draw into the element, call `studio.ready()` once it is drawn, and
// return what closing the panel undoes. The frame carries Studio's theme as
// CSS variables (`--bg-surface`, `--text-default`, …) and its kit classes
// (`se-heading`, `se-button`, …).
//
// Replace it with what IDEA.md describes; the extension guide's `surfaces`
// topic says which contribution fits which idea.

/** What the panel says: kept apart from the drawing so a test can read it. */
export function greeting(studio: ExtensionMountStudio): { heading: string; detail: string } {
  return {
    heading: `Hello from ${NAME}`,
    detail: `Drawn as the ${studio.surface.id} panel. Edit extension/src/hello.ts and save: npm run dev reloads it.`,
  }
}

export const mount: ExtensionMount = (root, studio) => {
  const document = root.ownerDocument
  const { heading, detail } = greeting(studio)
  const view = document.createElement('div')
  view.style.padding = '16px'
  const title = document.createElement('h2')
  title.className = 'se-heading'
  title.textContent = heading
  const text = document.createElement('p')
  text.className = 'se-muted'
  text.textContent = detail
  view.append(title, text)
  root.append(view)
  // Once it is drawn: Studio measures the panel's opening up to here.
  studio.ready()
  return () => view.remove()
}
