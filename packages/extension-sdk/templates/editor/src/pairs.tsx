import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import type { ExtensionEditorSession, ExtensionMount } from '@sprintengine/extension-sdk'

import css from './pairs.css'

// A custom editor for .kv files: one `key = value` a line. Studio hands the
// editor the file's text (`studio.document`) and keeps everything else: the
// unsaved state, Save (Cmd/Ctrl+S here works too), the file on disk and what
// happens when it changes there. The editor only turns the text into a form
// and its changes back into text, through `session()`.

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

export function PairsEditor({ session }: { session: ExtensionEditorSession<Pair[]> }) {
  const [pairs, setPairs] = useState(session.value)
  // The file changed outside the editor: on disk, or in Studio's text editor.
  useEffect(() => {
    const replaced = session.onReplace(setPairs)
    return () => replaced.dispose()
  }, [session])
  const change = (next: Pair[]) => {
    setPairs(next)
    session.change(next)
  }
  const edit = (index: number, field: keyof Pair, text: string) =>
    change(pairs.map((pair, at) => (at === index ? { ...pair, [field]: text } : pair)))
  return (
    <div className="pairs">
      {pairs.map((pair, index) => (
        <div className="pairs__row" key={index}>
          <input
            aria-label="Key"
            className="se-input"
            value={pair.key}
            readOnly={session.readOnly}
            onChange={(event) => edit(index, 'key', event.target.value)}
          />
          <input
            aria-label="Value"
            className="se-input"
            value={pair.value}
            readOnly={session.readOnly}
            onChange={(event) => edit(index, 'value', event.target.value)}
          />
          <button
            className="se-button"
            disabled={session.readOnly}
            onClick={() => change(pairs.filter((_, at) => at !== index))}
          >
            Remove
          </button>
        </div>
      ))}
      <div className="pairs__bar">
        <button
          className="se-button se-button--primary"
          disabled={session.readOnly}
          onClick={() => change([...pairs, { key: 'key', value: '' }])}
        >
          Add a pair
        </button>
        <span className="se-muted">{session.readOnly ? 'Read only' : `${pairs.length} pairs`}</span>
      </div>
    </div>
  )
}

// The editor's frame is its own document: the stylesheet goes in its head.
export const mount: ExtensionMount = async (root, studio) => {
  const style = root.ownerDocument.createElement('style')
  style.textContent = css
  root.ownerDocument.head.append(style)
  const session = await studio.document!.session<Pair[]>({
    decode: (content) => parsePairs(content.kind === 'text' ? content.text : ''),
    encode: (pairs) => ({ kind: 'text', text: formatPairs(pairs) }),
  })
  const view = createRoot(root)
  view.render(<PairsEditor session={session} />)
  studio.ready()
  return () => {
    view.unmount()
    session.dispose()
    style.remove()
  }
}
