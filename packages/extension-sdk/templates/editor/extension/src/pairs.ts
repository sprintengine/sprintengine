import type { ExtensionEditorSession, ExtensionMount } from '@sprintengine/extension-sdk'

// A custom editor for .kv files: one `key = value` a line. Studio hands the
// editor the file's text (`studio.document`) and keeps everything else: the
// unsaved state, Save (Cmd/Ctrl+S here works too), the file on disk and what
// happens when it changes there. The editor only turns the text into a form
// and its changes back into text, through `session()`.

// A string, not a CSS file: a frame cannot import one.
const STYLES = `
.pairs { padding: 12px 16px; max-width: 720px; }
.pairs__row { display: flex; gap: 8px; padding: 4px 0; }
.pairs__row .se-input { flex: 1; }
.pairs__bar { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
`

export type Pair = { key: string; value: string }

/** The pairs a .kv file holds; a line with no `=` is a key with no value. */
export function parsePairs(text: string): Pair[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const at = line.indexOf('=')
      return at === -1
        ? { key: line.trim(), value: '' }
        : { key: line.slice(0, at).trim(), value: line.slice(at + 1).trim() }
    })
}

/** The file's text for a list of pairs. */
export function formatPairs(pairs: Pair[]): string {
  return pairs.map((pair) => `${pair.key} = ${pair.value}\n`).join('')
}

/** Draw the pairs into `view`, and send each change to the session. */
function drawPairs(view: HTMLElement, session: ExtensionEditorSession<Pair[]>): void {
  const document = view.ownerDocument
  const change = (next: Pair[]) => {
    session.change(next)
    drawPairs(view, session)
  }
  const button = (label: string, onClick: () => void) => {
    const element = document.createElement('button')
    element.type = 'button'
    element.className = 'se-button'
    element.textContent = label
    element.disabled = session.readOnly
    element.addEventListener('click', onClick)
    return element
  }

  const pairs = session.value
  const rows = pairs.map((pair, index) => {
    const row = document.createElement('div')
    row.className = 'pairs__row'
    const field = (label: string, name: keyof Pair) => {
      const input = document.createElement('input')
      input.className = 'se-input'
      input.setAttribute('aria-label', label)
      input.value = pair[name]
      input.readOnly = session.readOnly
      // Typing sends the change without redrawing, so the field keeps focus.
      input.addEventListener('input', () =>
        session.change(session.value.map((each, at) => (at === index ? { ...each, [name]: input.value } : each))),
      )
      return input
    }
    row.append(
      field('Key', 'key'),
      field('Value', 'value'),
      button('Remove', () => change(session.value.filter((_, at) => at !== index))),
    )
    return row
  })

  const bar = document.createElement('div')
  bar.className = 'pairs__bar'
  const add = button('Add a pair', () => change([...session.value, { key: 'key', value: '' }]))
  add.classList.add('se-button--primary')
  const count = document.createElement('span')
  count.className = 'se-muted'
  count.textContent = session.readOnly ? 'Read only' : `${pairs.length} pairs`
  bar.append(add, count)
  view.replaceChildren(...rows, bar)
}

// The editor's frame is its own document: the stylesheet goes in its head.
export const mount: ExtensionMount = async (root, studio) => {
  const document = root.ownerDocument
  const style = document.createElement('style')
  style.textContent = STYLES
  document.head.append(style)
  const session = await studio.document!.session<Pair[]>({
    decode: (content) => parsePairs(content.kind === 'text' ? content.text : ''),
    encode: (pairs) => ({ kind: 'text', text: formatPairs(pairs) }),
  })
  const view = document.createElement('div')
  view.className = 'pairs'
  root.append(view)
  drawPairs(view, session)
  // The file changed outside the editor: on disk, or in Studio's text editor.
  const replaced = session.onReplace(() => drawPairs(view, session))
  studio.ready()
  return () => {
    replaced.dispose()
    session.dispose()
    view.remove()
    style.remove()
  }
}
