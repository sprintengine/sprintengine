import React from 'react'
import { GhostButton, InlineNotice, OutlineButton } from '../../ui'
import { copy } from '../../../../../shared/copy'

/**
 * What the file on disk did under an editor tab that the person has to know
 * about: it changed while the tab had unsaved edits (holding what it changed
 * to), or it is gone. Shared by the docked editor and the pop-out editor
 * window, which say it the same way.
 */
export type EditorDiskNoticeState =
  | { kind: 'changed'; content: string }
  | { kind: 'deleted' }
  /** An extension's `editor.save.before` hook refused the save: the edits stay unsaved. */
  | { kind: 'refused'; message: string }

export function EditorDiskNotice({
  notice,
  onReload,
  onKeepMine,
}: {
  notice: EditorDiskNoticeState
  onReload: () => void
  /** Keeps the edits; for a refused save, closes the notice. */
  onKeepMine: () => void
}) {
  return (
    <div className="shrink-0 px-3 pt-2 pb-1">
      {notice.kind === 'changed' ? (
        <InlineNotice
          tone="warn"
          title={copy.panels.editor.editorDiskNotice.changedOnDisk}
          action={
            <>
              <OutlineButton size="xs" onClick={onReload}>
                {copy.panels.editor.editorDiskNotice.reload}
              </OutlineButton>
              <GhostButton size="xs" onClick={onKeepMine}>
                {copy.panels.editor.editorDiskNotice.keepMine}
              </GhostButton>
            </>
          }
        />
      ) : notice.kind === 'refused' ? (
        <InlineNotice
          tone="warn"
          title={copy.panels.editor.editorDiskNotice.notSaved}
          hint={notice.message}
          action={
            <GhostButton size="xs" onClick={onKeepMine}>
              {copy.panels.editor.editorDiskNotice.dismiss}
            </GhostButton>
          }
        />
      ) : (
        <InlineNotice
          tone="warn"
          title={copy.panels.editor.editorDiskNotice.deletedOnDisk}
          hint={copy.panels.editor.editorDiskNotice.stillOpenHereSavingWrites}
        />
      )}
    </div>
  )
}

/** The question a save asks before it writes over a version on disk the tab never showed. */
export function overwriteOnDiskConfirmation(fileName: string) {
  return {
    title: copy.panels.editor.editorDiskNotice.overwrite(fileName),
    body: copy.panels.editor.editorDiskNotice.itChangedOnDiskSince,
    confirmLabel: copy.panels.editor.editorDiskNotice.overwrite2,
    tone: 'danger' as const,
  }
}
