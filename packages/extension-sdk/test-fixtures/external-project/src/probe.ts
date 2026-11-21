// The probe panel: 200 rows drawn with plain DOM and styled with Studio's
// `--sem-*` custom properties, then `studio.ready()`. It is the in-process
// baseline a later measurement of surfaces in their own frames compares
// against, so it stays plain: no framework, no data to wait for.

import type { ExtensionMount, ExtensionMountStudio } from '@sprintengine/extension-sdk'

export const PROBE_ROWS = 200

export const mount: ExtensionMount = (root: HTMLElement, studio: ExtensionMountStudio) => {
  const document = root.ownerDocument
  const list = document.createElement('ul')
  list.setAttribute('aria-label', 'Probe rows')
  Object.assign(list.style, {
    margin: '0',
    padding: 'var(--sem-space-sm)',
    listStyle: 'none',
    overflow: 'auto',
    height: '100%',
    boxSizing: 'border-box',
    background: 'var(--sem-color-bg-surface)',
    color: 'var(--sem-color-text-default)',
    fontFamily: 'var(--sem-font-family-ui)',
    fontSize: 'var(--sem-font-size-body)',
  })
  for (let index = 0; index < PROBE_ROWS; index += 1) {
    const row = document.createElement('li')
    Object.assign(row.style, {
      display: 'flex',
      justifyContent: 'space-between',
      padding: 'var(--sem-space-xs) var(--sem-space-sm)',
      borderBottom: '1px solid var(--sem-color-border-subtle)',
    })
    const label = document.createElement('span')
    label.textContent = `Row ${index + 1}`
    const detail = document.createElement('span')
    detail.textContent = studio.surface.workspaceId ?? 'no workspace'
    detail.style.color = 'var(--sem-color-text-muted)'
    row.append(label, detail)
    list.append(row)
  }
  root.append(list)
  studio.ready()
  return () => list.remove()
}
