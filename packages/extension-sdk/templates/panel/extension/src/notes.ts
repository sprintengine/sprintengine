import type { ExtensionMount, ExtensionMountStudio } from '@sprintengine/extension-sdk'

const NOTES_KEY = 'notes'
const SAVE_DELAY_MS = 400

// The panel's own stylesheet, as a string: a frame cannot import a CSS file.
// The panel runs in a frame of its own, so these rules reach nothing of
// Studio's. Colours come from the theme's custom properties Studio puts in the
// frame (--bg-surface, --text-default, --border-subtle, …), which follow the
// person's theme.
const STYLES = `
.notes { display: flex; flex-direction: column; box-sizing: border-box; height: 100%; }
.notes__header {
  display: flex; align-items: baseline; justify-content: space-between;
  padding: 8px 12px; border-bottom: 1px solid var(--border-subtle);
}
.notes__state { color: var(--text-muted); font-size: 12px; }
.notes__text { flex: 1; min-height: 0; margin: 12px; resize: none; }
`

// The extension's Settings values are a key-value store Studio keeps for it
// (`settings.get`, `settings.set`, permission `settings:own`), kept across
// restarts and readable by a worker. For data per workspace, or anything
// large, use `storage.*` (permission `storage:own`).
export async function loadNotes(studio: ExtensionMountStudio): Promise<string> {
  const saved = await studio.host.call('settings.get', {})
  return typeof saved[NOTES_KEY] === 'string' ? saved[NOTES_KEY] : ''
}

export async function saveNotes(studio: ExtensionMountStudio, text: string): Promise<void> {
  await studio.host.call('settings.set', { key: NOTES_KEY, value: text })
}

// The panel's frame is its own document: the stylesheet goes in its head.
export const mount: ExtensionMount = async (root, studio) => {
  const document = root.ownerDocument
  const style = document.createElement('style')
  style.textContent = STYLES
  document.head.append(style)

  const view = document.createElement('div')
  view.className = 'notes'
  const header = document.createElement('header')
  header.className = 'notes__header'
  const title = document.createElement('span')
  title.textContent = 'Notes'
  const state = document.createElement('span')
  state.className = 'notes__state'
  state.textContent = 'Saved'
  header.append(title, state)
  const text = document.createElement('textarea')
  text.className = 'se-input notes__text'
  text.setAttribute('aria-label', 'Notes')
  text.placeholder = 'Write anything. It is kept across restarts.'
  text.value = await loadNotes(studio)
  view.append(header, text)
  root.append(view)

  // Saved a moment after the last keystroke, not on every one.
  let timer: number | undefined
  text.addEventListener('input', () => {
    state.textContent = 'Saving…'
    window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      const value = text.value
      void saveNotes(studio, value).then(() => {
        if (text.value === value) state.textContent = 'Saved'
      })
    }, SAVE_DELAY_MS)
  })

  studio.ready()
  return () => {
    window.clearTimeout(timer)
    view.remove()
    style.remove()
  }
}
