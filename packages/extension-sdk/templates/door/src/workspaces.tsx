import { useEffect, useState, type CSSProperties } from 'react'
import { createRoot } from 'react-dom/client'

import type { ExtensionMount, ExtensionMountStudio, ModuleWorkspaceView } from '@sprintengine/extension-sdk'

// A door: a full-window surface with its own row in the Extensions drawer,
// declared in extension.json (`contributes.doors`). Studio draws the drawer
// row and the window around it; everything inside the element `mount` is
// handed is this extension's. `studio.openGlobalSurface('workspaces')` opens
// it from another of the extension's surfaces.

const text: CSSProperties = {
  fontFamily: 'var(--sem-font-family-ui)',
  fontSize: 'var(--sem-font-size-body)',
  color: 'var(--sem-color-text-default)',
}
const muted: CSSProperties = { color: 'var(--sem-color-text-muted)' }

export type WorkspacesViewProps = {
  workspaces: readonly ModuleWorkspaceView[]
  selectedId: string | null
  onSelect: (id: string) => void
}

/** The list on the left, and the picked workspace's details beside it. */
export function WorkspacesView({ workspaces, selectedId, onSelect }: WorkspacesViewProps) {
  const selected = workspaces.find((workspace) => workspace.id === selectedId) ?? null
  return (
    <div style={{ ...text, display: 'flex', height: '100%', background: 'var(--sem-color-bg-surface)' }}>
      <nav
        aria-label="Workspaces"
        style={{
          width: 240,
          padding: 'var(--sem-space-sm)',
          borderRight: '1px solid var(--sem-color-border-subtle)',
          overflowY: 'auto',
        }}
      >
        {workspaces.length === 0 ? <p style={muted}>No workspace is open.</p> : null}
        {workspaces.map((workspace) => (
          <button
            key={workspace.id}
            type="button"
            aria-pressed={workspace.id === selectedId}
            onClick={() => onSelect(workspace.id)}
            style={{
              ...text,
              display: 'block',
              width: '100%',
              padding: 'var(--sem-space-xs) var(--sem-space-sm)',
              border: 'none',
              borderRadius: 'var(--sem-radius-control)',
              textAlign: 'left',
              cursor: 'pointer',
              background: workspace.id === selectedId ? 'var(--sem-color-bg-selected)' : 'transparent',
            }}
          >
            {workspace.name}
          </button>
        ))}
      </nav>
      <section style={{ flex: 1, padding: 'var(--sem-space-lg)' }}>
        {selected === null ? (
          <p style={muted}>Pick a workspace to see where it lives.</p>
        ) : (
          <>
            <h2 style={{ marginTop: 0, color: 'var(--sem-color-text-primary)' }}>{selected.name}</h2>
            <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', margin: 0 }}>
              <dt style={muted}>Folder</dt>
              <dd style={{ margin: 0, fontFamily: 'var(--sem-font-family-mono)' }}>
                {selected.folderPath ?? 'None (a workspace without a folder)'}
              </dd>
              <dt style={muted}>Type</dt>
              <dd style={{ margin: 0 }}>{selected.mode}</dd>
            </dl>
          </>
        )}
      </section>
    </div>
  )
}

// `watchWorkspaces` calls back with the current list at once, then on every
// change, so the door is drawn as soon as the first list arrives.
export function WorkspacesDoor({ studio }: { studio: ExtensionMountStudio }) {
  const [workspaces, setWorkspaces] = useState<ModuleWorkspaceView[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => studio.watchWorkspaces(setWorkspaces), [studio])
  useEffect(() => {
    if (workspaces !== null) studio.ready()
  }, [workspaces, studio])

  if (workspaces === null)
    return <p style={{ ...text, ...muted, padding: 'var(--sem-space-lg)' }}>Reading workspaces…</p>
  return <WorkspacesView workspaces={workspaces} selectedId={selectedId} onSelect={setSelectedId} />
}

export const mount: ExtensionMount = (root, studio) => {
  const view = createRoot(root)
  view.render(<WorkspacesDoor studio={studio} />)
  return () => view.unmount()
}
