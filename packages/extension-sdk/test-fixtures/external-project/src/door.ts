// The door: a full-window surface that reads the open workspaces, asks the
// worker for the outlook, and hears it change. Plain DOM, as an author who
// brings no framework writes it.

import type { ExtensionMount, ModuleWorkspaceView } from '@sprintengine/extension-sdk'

import type { WeatherMethods } from './methods'

export const mount: ExtensionMount = async (root, studio) => {
  const heading = root.ownerDocument.createElement('h1')
  const outlook = root.ownerDocument.createElement('p')
  const places = root.ownerDocument.createElement('ul')
  heading.textContent = 'Weather Deck'
  root.append(heading, outlook, places)

  const methods = studio.methods<WeatherMethods>()
  const current = await methods.read('readOutlook', {})
  outlook.textContent = current.ok ? current.result.summary : current.message

  const offWorkspaces = studio.watchWorkspaces((workspaces: ModuleWorkspaceView[]) => {
    places.replaceChildren(
      ...workspaces.map((workspace) => {
        const item = root.ownerDocument.createElement('li')
        item.textContent = `${workspace.name}: ${workspace.folderPath ?? 'no folder'}`
        return item
      }),
    )
  })
  // Events are signals, not state: read again when one says so.
  const offOutlook = studio.subscribe('outlook-refreshed', () => {
    void methods.read('readOutlook', {}).then((next) => {
      if (next.ok) outlook.textContent = next.result.summary
    })
  })
  studio.ready()
  return () => {
    offWorkspaces()
    offOutlook()
    root.replaceChildren()
  }
}
