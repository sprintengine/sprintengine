import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'

import type { ExtensionMount, ExtensionMountStudio } from '@sprintengine/extension-sdk'

import css from './notes.css'

const NOTES_KEY = 'notes'
const SAVE_DELAY_MS = 400

// The extension's app state is its own key-value store in Studio's settings:
// synchronous to read, so it can be read while rendering, and kept across
// restarts. `storage` is the permission that discloses it. For data per
// workspace use getWorkspaceModuleState; for anything large, a worker and
// getModuleStorage.
export function NotesPanel({ studio }: { studio: ExtensionMountStudio }) {
  const subscribe = useCallback((onChange: () => void) => studio.watchModuleAppState(() => onChange()), [studio])
  const readSaved = useCallback(() => studio.getModuleAppState<string>(NOTES_KEY) ?? '', [studio])
  // The third argument is what a server render reads (the tests'): without it,
  // rendering the panel anywhere but a window throws.
  const saved = useSyncExternalStore(subscribe, readSaved, readSaved)
  const [draft, setDraft] = useState(saved)
  const lastSaved = useRef(saved)

  useEffect(() => studio.ready(), [studio])

  // Another window saved: take its text, unless this one has unsaved edits.
  useEffect(() => {
    setDraft((current) => (current === lastSaved.current ? saved : current))
    lastSaved.current = saved
  }, [saved])

  useEffect(() => {
    if (draft === saved) return
    const timer = window.setTimeout(() => studio.setModuleAppState(NOTES_KEY, draft), SAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [draft, saved, studio])

  return (
    <div className="ext-{{id}}-notes">
      <header className="ext-{{id}}-notes__header">
        <span>Notes</span>
        <span className="ext-{{id}}-notes__state">{draft === saved ? 'Saved' : 'Saving…'}</span>
      </header>
      <textarea
        aria-label="Notes"
        className="ext-{{id}}-notes__text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Write anything. It is kept across restarts."
      />
    </div>
  )
}

// The stylesheet goes inside the element Studio hands over, beside the React
// tree, so it applies while the panel is open and leaves with it.
export const mount: ExtensionMount = (root, studio) => {
  const style = root.ownerDocument.createElement('style')
  style.textContent = css
  const container = root.ownerDocument.createElement('div')
  container.style.height = '100%'
  root.append(style, container)
  const view = createRoot(container)
  view.render(<NotesPanel studio={studio} />)
  return () => {
    view.unmount()
    style.remove()
    container.remove()
  }
}
