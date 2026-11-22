import { useRef, useState, type ReactElement } from 'react'

import { copy } from '../../../../shared/copy'
import {
  TEXT_EDITOR_VIEW,
  chooseEditorView,
  extensionEditorViewId,
  leaveExtensionEditor,
  type MatchedExtensionEditor,
} from '../../modules/extension-editors'
import { ContextMenu, GhostButton, MenuItem } from '../ui'

// Open with…: the editors a file can be shown in, Studio's text editor first,
// then each extension editor that takes files of its type. Shown on every file
// some extension editor matches, so a file is never stuck in one of them.
// Leaving an extension's editor waits for it to hand over its edits.

const t = copy.extensions.editorViewPicker

export function EditorViewPicker({
  workspaceId,
  path,
  fileName,
  matches,
  current,
}: {
  workspaceId: string
  path: string
  fileName: string
  matches: readonly MatchedExtensionEditor[]
  /** The view the file is shown in now. */
  current: string
}): ReactElement {
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const options = [
    { id: TEXT_EDITOR_VIEW, label: t.textEditor },
    ...matches.map((editor) => ({
      id: extensionEditorViewId(editor),
      label: t.fromExtension(editor.contribution.title, editor.extension?.name ?? editor.key),
    })),
  ]
  return (
    <>
      <GhostButton
        ref={buttonRef}
        size="xs"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={() => {
          const rect = buttonRef.current?.getBoundingClientRect()
          setMenu(rect ? { x: rect.left, y: rect.bottom } : { x: 0, y: 0 })
        }}
      >
        {t.openWith}
      </GhostButton>
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} ariaLabel={t.openWithFor(fileName)} onClose={() => setMenu(null)}>
          {options.map((option) => (
            <MenuItem
              key={option.id}
              checked={option.id === current}
              selection="one-of"
              hint={option.id === current ? t.current : undefined}
              onClick={() => {
                setMenu(null)
                if (option.id === current) return
                // The editor shown now hands over what it holds first, and
                // asks about edits the next view cannot show; it stays when
                // either fails, and says why.
                void leaveExtensionEditor(
                  workspaceId,
                  path,
                  option.id === TEXT_EDITOR_VIEW ? 'text-editor' : 'other-editor',
                ).then((ok) => {
                  if (ok) chooseEditorView(workspaceId, path, option.id)
                })
              }}
            >
              {option.label}
            </MenuItem>
          ))}
        </ContextMenu>
      ) : null}
    </>
  )
}
