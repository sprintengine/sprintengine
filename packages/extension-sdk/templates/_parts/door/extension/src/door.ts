import type { ExtensionMount } from '@sprintengine/extension-sdk'

const NAME = '{{displayName}}'

// A door: a full-window surface with its own row in the Extensions drawer,
// declared in extension.json (`contributes.doors`, id "door"). Studio draws the
// row and the window around it, and the door in a sandboxed frame of its own:
// everything inside the element `mount` is handed is this extension's.

/** What the empty door says, kept apart from the drawing so a test can read it. */
export const DOOR_TEXT = { heading: 'Nothing here yet', detail: `This is ${NAME}’s door. Draw what IDEA.md describes.` }

export const mount: ExtensionMount = (root, studio) => {
  const document = root.ownerDocument
  const view = document.createElement('div')
  view.style.padding = '16px'
  const heading = document.createElement('h2')
  heading.className = 'se-heading'
  heading.textContent = DOOR_TEXT.heading
  const detail = document.createElement('p')
  detail.className = 'se-muted'
  detail.textContent = DOOR_TEXT.detail
  view.append(heading, detail)
  root.append(view)
  studio.ready()
  return () => view.remove()
}
