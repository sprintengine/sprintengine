import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import type { ExtensionMount, ExtensionMountStudio } from '@sprintengine/extension-sdk'

import css from './notes.css'

const NOTES_KEY = 'notes'
const SAVE_DELAY_MS = 400

// The extension's Settings values are a key-value store Studio keeps for it
// (`settings.get`, `settings.set`, permission `settings:own`), kept across
// restarts and readable by a worker. For data per workspace, or anything
// large, use `storage.*` (permission `storage:own`).
export function NotesPanel({ studio, initial }: { studio: ExtensionMountStudio; initial: string }) {
  const [draft, setDraft] = useState(initial)
  const [saved, setSaved] = useState(initial)

  useEffect(() => studio.ready(), [studio])

  useEffect(() => {
    if (draft === saved) return
    const timer = window.setTimeout(() => {
      void studio.host.call('settings.set', { key: NOTES_KEY, value: draft }).then(() => setSaved(draft))
    }, SAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [draft, saved, studio])

  return (
    <div className="notes">
      <header className="notes__header">
        <span>Notes</span>
        <span className="notes__state">{draft === saved ? 'Saved' : 'Saving…'}</span>
      </header>
      <textarea
        aria-label="Notes"
        className="se-input notes__text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Write anything. It is kept across restarts."
      />
    </div>
  )
}

// The panel's frame is its own document: the stylesheet goes in its head.
export const mount: ExtensionMount = async (root, studio) => {
  const style = root.ownerDocument.createElement('style')
  style.textContent = css
  root.ownerDocument.head.append(style)
  const saved = await studio.host.call('settings.get', {})
  const view = createRoot(root)
  view.render(<NotesPanel studio={studio} initial={typeof saved[NOTES_KEY] === 'string' ? saved[NOTES_KEY] : ''} />)
  return () => {
    view.unmount()
    style.remove()
  }
}
