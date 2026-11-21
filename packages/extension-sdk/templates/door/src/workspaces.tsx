import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import type { ExtensionMount, ExtensionMountStudio, ModuleWorkspaceView } from '@sprintengine/extension-sdk'

// A door: a full-window surface with its own row in the Extensions drawer,
// declared in extension.json (`contributes.doors`). Studio draws the drawer
// row and the window around it, and the door in a sandboxed frame of its own:
// everything inside the element `mount` is handed is this extension's, and it
// reaches Studio only through `studio.host.call`. Another of the extension's
// surfaces opens it with `studio.host.call('doors.open', { id: 'workspaces' })`.

export type WorkspacesViewProps = {
  workspaces: readonly ModuleWorkspaceView[]
  selectedId: string | null
  onSelect: (id: string) => void
}

/** The list on the left, and the picked workspace's details beside it. */
export function WorkspacesView({ workspaces, selectedId, onSelect }: WorkspacesViewProps) {
  const selected = workspaces.find((workspace) => workspace.id === selectedId) ?? null
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <nav
        aria-label="Workspaces"
        style={{ width: 240, borderRight: '1px solid var(--border-subtle)', overflowY: 'auto' }}
      >
        {workspaces.length === 0 ? (
          <p className="se-muted" style={{ padding: 12 }}>
            No workspace is open.
          </p>
        ) : null}
        <ul className="se-list">
          {workspaces.map((workspace) => (
            <li key={workspace.id} className="se-list-row">
              <button
                type="button"
                className="se-button"
                aria-pressed={workspace.id === selectedId}
                onClick={() => onSelect(workspace.id)}
                style={{ width: '100%', justifyContent: 'flex-start' }}
              >
                {workspace.name}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <section style={{ flex: 1, padding: 16 }}>
        {selected === null ? (
          <p className="se-muted">Pick a workspace to see where it lives.</p>
        ) : (
          <>
            <h2 className="se-heading">{selected.name}</h2>
            <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', margin: 0 }}>
              <dt className="se-muted">Folder</dt>
              <dd style={{ margin: 0, fontFamily: 'ui-monospace, monospace' }}>
                {selected.folderPath ?? 'None (a workspace without a folder)'}
              </dd>
              <dt className="se-muted">Type</dt>
              <dd style={{ margin: 0 }}>{selected.mode}</dd>
            </dl>
          </>
        )}
      </section>
    </div>
  )
}

// `workspace.list` answers the open workspaces now (permission
// `workspace:read`); the door draws as soon as they arrive.
export function WorkspacesDoor({ studio }: { studio: ExtensionMountStudio }) {
  const [workspaces, setWorkspaces] = useState<ModuleWorkspaceView[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    void studio.host.call('workspace.list', {}).then(setWorkspaces, () => setWorkspaces([]))
  }, [studio])
  useEffect(() => {
    if (workspaces !== null) studio.ready()
  }, [workspaces, studio])

  if (workspaces === null)
    return (
      <p className="se-muted" style={{ padding: 16 }}>
        Reading workspaces…
      </p>
    )
  return <WorkspacesView workspaces={workspaces} selectedId={selectedId} onSelect={setSelectedId} />
}

export const mount: ExtensionMount = (root, studio) => {
  const view = createRoot(root)
  view.render(<WorkspacesDoor studio={studio} />)
  return () => view.unmount()
}
