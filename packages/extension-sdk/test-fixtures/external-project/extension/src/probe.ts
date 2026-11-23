// The probe panel: 200 rows drawn with plain DOM and styled with the theme's
// custom properties and Studio's kit, then `studio.ready()`. It measures how
// long a surface takes from being opened to drawn in its frame, so it stays
// plain: no framework, no data to wait for.

import type { ExtensionMount, ExtensionMountStudio } from '@sprintengine/extension-sdk'

export const PROBE_ROWS = 200

export const mount: ExtensionMount = (root: HTMLElement, studio: ExtensionMountStudio) => {
  const document = root.ownerDocument
  const list = document.createElement('ul')
  list.className = 'se-list'
  list.setAttribute('aria-label', 'Probe rows')
  for (let index = 0; index < PROBE_ROWS; index += 1) {
    const row = document.createElement('li')
    row.className = 'se-list-row'
    const label = document.createElement('span')
    label.textContent = `Row ${index + 1}`
    const detail = document.createElement('span')
    detail.className = 'se-muted'
    detail.textContent = studio.surface.workspaceId ?? 'no workspace'
    row.append(label, detail)
    list.append(row)
  }
  root.append(list)
  studio.ready()
  return () => list.remove()
}
