import type { ExtensionMount, ModuleWorkspaceView } from '@sprintengine/extension-sdk'

// A door: a full-window surface with its own row in the Extensions drawer,
// declared in extension.json (`contributes.doors`). Studio draws the drawer
// row and the window around it, and the door in a sandboxed frame of its own:
// everything inside the element `mount` is handed is this extension's, and it
// reaches Studio only through `studio.host.call`. Another of the extension's
// surfaces opens it with `studio.host.call('doors.open', { id: 'workspaces' })`.

const STYLES = `
.workspaces { display: flex; height: 100%; }
.workspaces__list { width: 240px; border-right: 1px solid var(--border-subtle); overflow-y: auto; }
.workspaces__list .se-button { width: 100%; justify-content: flex-start; }
.workspaces__detail { flex: 1; padding: 16px; }
.workspaces__facts { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
.workspaces__facts dd { margin: 0; }
`

/** What the door says about a workspace, as label and value. */
export function workspaceFacts(workspace: ModuleWorkspaceView): Array<[string, string]> {
  return [
    ['Folder', workspace.folderPath ?? 'None (a workspace without a folder)'],
    ['Type', workspace.mode],
  ]
}

export const mount: ExtensionMount = async (root, studio) => {
  const document = root.ownerDocument
  const style = document.createElement('style')
  style.textContent = STYLES
  document.head.append(style)

  // `workspace.list` answers the open workspaces now (permission
  // `workspace:read`); the door draws as soon as they arrive.
  const workspaces = await studio.host.call('workspace.list', {}).catch(() => [])

  const view = document.createElement('div')
  view.className = 'workspaces'
  const nav = document.createElement('nav')
  nav.className = 'workspaces__list'
  nav.setAttribute('aria-label', 'Workspaces')
  const detail = document.createElement('section')
  detail.className = 'workspaces__detail'
  view.append(nav, detail)
  root.append(view)

  const muted = (text: string) => {
    const note = document.createElement('p')
    note.className = 'se-muted'
    note.textContent = text
    return note
  }

  const show = (workspace: ModuleWorkspaceView) => {
    const heading = document.createElement('h2')
    heading.className = 'se-heading'
    heading.textContent = workspace.name
    const facts = document.createElement('dl')
    facts.className = 'workspaces__facts'
    for (const [label, value] of workspaceFacts(workspace)) {
      const term = document.createElement('dt')
      term.className = 'se-muted'
      term.textContent = label
      const description = document.createElement('dd')
      description.textContent = value
      facts.append(term, description)
    }
    detail.replaceChildren(heading, facts)
    for (const button of nav.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.id === workspace.id))
    }
  }

  if (workspaces.length === 0) nav.append(muted('No workspace is open.'))
  const list = document.createElement('ul')
  list.className = 'se-list'
  for (const workspace of workspaces) {
    const row = document.createElement('li')
    row.className = 'se-list-row'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'se-button'
    button.dataset.id = workspace.id
    button.textContent = workspace.name
    button.addEventListener('click', () => show(workspace))
    row.append(button)
    list.append(row)
  }
  nav.append(list)
  detail.append(muted('Pick a workspace to see where it lives.'))

  studio.ready()
  return () => {
    view.remove()
    style.remove()
  }
}
