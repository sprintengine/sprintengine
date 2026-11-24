// The door: a full-window surface in its frame that reads the open
// workspaces, asks the worker for the outlook, and hears it change. Plain DOM,
// as an author who brings no framework writes it.

import type { ExtensionMount } from '@sprintengine/extension-sdk'

import type { WeatherMethods } from './methods'

export const mount: ExtensionMount = async (root, studio) => {
  const heading = root.ownerDocument.createElement('h1')
  const outlook = root.ownerDocument.createElement('p')
  const places = root.ownerDocument.createElement('ul')
  heading.className = 'se-heading'
  heading.textContent = 'Weather Deck'
  places.className = 'se-list'
  root.append(heading, outlook, places)

  const methods = studio.methods<WeatherMethods>()
  const current = await methods.read('readOutlook', {})
  outlook.textContent = current.ok ? current.result.summary : current.message

  const workspaces = await studio.host.call('workspace.list', {})
  places.replaceChildren(
    ...workspaces.map((workspace) => {
      const item = root.ownerDocument.createElement('li')
      item.className = 'se-list-row'
      item.textContent = `${workspace.name}: ${workspace.folderPath ?? 'no folder'}`
      return item
    }),
  )
  // Events are signals, not state: read again when one says so.
  const heard = studio.on('push', (push) => {
    if (push.topic !== 'outlook-refreshed') return
    void methods.read('readOutlook', {}).then((next) => {
      if (next.ok) outlook.textContent = next.result.summary
    })
  })
  studio.ready()
  return () => {
    heard.dispose()
    root.replaceChildren()
  }
}
