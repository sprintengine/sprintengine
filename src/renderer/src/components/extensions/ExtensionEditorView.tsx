import { useEffect, useMemo, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react'

import { copy } from '../../../../shared/copy'
import { registerEditorLeaveGuard, type MatchedExtensionEditor } from '../../modules/extension-editors'
import { createExtensionEditorController } from '../../modules/extension-editor-controller'
import type { EditorDocumentModel, EditorSessionState } from '../../modules/extension-editor-session'
import { extensionsApi } from '../../studio/extensions'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  getEditorBuffer,
  getEditorBytes,
  getEditorBytesBaseline,
  getEditorDiskBaseline,
  hasEditorBuffer,
  setEditorBuffer,
  setEditorBytes,
  setEditorBytesBaseline,
  setEditorDiskBaseline,
  subscribeEditorBuffer,
} from '../../utils/editorBuffers'
import { watchFileOnDisk } from '../../utils/fileDiskWatch'
import { detectLanguage } from '../../utils/files'
import { GhostButton, InlineNotice, OutlineButton, Spinner, useConfirmDialog } from '../ui'
import { ExtensionSurfaceMount, type ExtensionEditorLink } from './ExtensionSurfaceMount'

// A file open in an extension's custom editor: the editor's frame, and above
// it what Studio keeps for it, as the text editor does: whether it is saved,
// Save, and what the file on disk did under unsaved edits.
//
// The document session lives in a controller this view holds
// (extension-editor-controller.ts), not in the frame, so a frame drawn again
// finds the document as it was and a file that could not be opened stays an
// error. It reads and saves the file through this window's Studio as the
// extension's frame (`files.read`, `files.write`), so the extension's
// approval and this window's connection are both checked, on every client
// alike. A text file's content is the window's editor buffer, shared with the
// text editor; a binary file's is the window's byte buffer beside it. Both
// outlive the frame, and the tab shows their unsaved dot.

const t = copy.extensions.extensionEditorView

type Props = {
  workspaceId: string
  /** The file, as the editor pane names it. */
  filePath: string
  /** The same file, relative to the workspace's folder, with `/` between its parts. */
  relativePath: string
  fileName: string
  editor: MatchedExtensionEditor
  /** Open with…: the other editors the file can be shown in. */
  picker: ReactNode
  onOpenInTextEditor: () => void
}

function openFileOf(workspaceId: string, path: string) {
  return useWorkspaceStore
    .getState()
    .workspaces.find((workspace) => workspace.id === workspaceId)
    ?.editorState?.openFiles.find((file) => file.path === path)
}

const dirtyOf = (workspaceId: string, path: string) => openFileOf(workspaceId, path)?.isDirty ?? false

/** A text file's document: the buffer, unsaved flag and disk baseline the text editor uses for it. */
function sharedTextModel(workspaceId: string, path: string): EditorDocumentModel {
  const text = (content: string | Uint8Array) =>
    typeof content === 'string' ? content : new TextDecoder().decode(content)
  return {
    get: () => (hasEditorBuffer(workspaceId, path) ? getEditorBuffer(workspaceId, path) : undefined),
    set(content, origin) {
      if (origin === 'frame') useWorkspaceStore.getState().updateFileContent(workspaceId, path, text(content))
      else setEditorBuffer(workspaceId, path, text(content))
    },
    dirty: () => dirtyOf(workspaceId, path),
    markClean: () => useWorkspaceStore.getState().markFileClean(workspaceId, path),
    baseline: () => getEditorDiskBaseline(workspaceId, path),
    setBaseline: (content) => setEditorDiskBaseline(workspaceId, path, text(content)),
    subscribe: (listener) => subscribeEditorBuffer(workspaceId, path, listener),
  }
}

/** A binary file's document: the window's byte buffer for it, which outlives the frame, and the tab's unsaved flag. */
function sharedBytesModel(workspaceId: string, path: string): EditorDocumentModel {
  const bytes = (content: string | Uint8Array) =>
    typeof content === 'string' ? new TextEncoder().encode(content) : content
  return {
    get: () => getEditorBytes(workspaceId, path),
    set(content, origin) {
      setEditorBytes(workspaceId, path, bytes(content))
      if (origin === 'frame') useWorkspaceStore.getState().markFileDirty(workspaceId, path)
    },
    dirty: () => dirtyOf(workspaceId, path),
    markClean: () => useWorkspaceStore.getState().markFileClean(workspaceId, path),
    baseline: () => getEditorBytesBaseline(workspaceId, path),
    setBaseline: (content) => setEditorBytesBaseline(workspaceId, path, bytes(content)),
    subscribe: (listener) => subscribeEditorBuffer(workspaceId, path, listener),
  }
}

// Whether this window's connection may write files on its Studio: a paired
// device may not, and then a custom editor opens read only.
let canWriteFiles: Promise<boolean> | null = null
function useCanWriteFiles(): boolean | null {
  const [known, setKnown] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    canWriteFiles ??= extensionsApi.canWriteFiles().catch(() => false)
    void canWriteFiles.then((value) => {
      if (live) setKnown(value)
    })
    return () => {
      live = false
    }
  }, [])
  return known
}

export function ExtensionEditorView(props: Props): ReactElement {
  const canWrite = useCanWriteFiles()
  if (canWrite === null) return <Loading />
  return <ExtensionEditorBody {...props} canWrite={canWrite} />
}

function Loading(): ReactElement {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-meta text-[color:var(--text-muted)]">
      <Spinner />
      <span role="status">{t.loading}</span>
    </div>
  )
}

function ExtensionEditorBody({
  workspaceId,
  filePath,
  relativePath,
  fileName,
  editor,
  picker,
  onOpenInTextEditor,
  canWrite,
}: Props & { canWrite: boolean }): ReactElement {
  const contentKind = editor.contribution.contentKind ?? 'text'
  const readOnly = !canWrite || !(editor.extension?.permissions ?? []).includes('workspace-files:write')
  const { choose, confirm: confirmDialog } = useConfirmDialog()

  const controller = useMemo(
    () =>
      createExtensionEditorController({
        workspaceId,
        relativePath,
        contentKind,
        // As Studio's text editor names it, so a hook keyed on a language meets either editor's save alike.
        languageId: detectLanguage(fileName),
        readOnly,
        model:
          contentKind === 'text' ? sharedTextModel(workspaceId, filePath) : sharedBytesModel(workspaceId, filePath),
        discard: () => {
          const baseline = getEditorBytesBaseline(workspaceId, filePath)
          if (baseline) setEditorBytes(workspaceId, filePath, baseline)
          useWorkspaceStore.getState().markFileClean(workspaceId, filePath)
        },
        askUnsaved: async () => {
          const choice = await choose({
            title: t.unsavedTitle(fileName),
            body: t.unsavedBody,
            confirmLabel: t.save,
            alternateLabel: t.discard,
            cancelLabel: t.stay,
          })
          return choice === 'confirm' ? 'save' : choice === 'alternate' ? 'discard' : 'stay'
        },
        askUnsent: () =>
          confirmDialog({
            title: t.unsentTitle,
            body: t.unsentBody,
            confirmLabel: t.dropUnsent,
            cancelLabel: t.stay,
            tone: 'danger',
          }),
      }),
    // The confirm dialog is read when it asks, not a reason for a new document.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [contentKind, filePath, readOnly, relativePath, workspaceId],
  )
  useEffect(() => () => controller.dispose(), [controller])
  useEffect(
    () =>
      registerEditorLeaveGuard(workspaceId, filePath, (where, nextKind) => controller.prepareToLeave(where, nextKind)),
    [controller, filePath, workspaceId],
  )
  // The file under the editor, kept in step with disk while it is open.
  useEffect(() => watchFileOnDisk(filePath, () => void controller.session.diskChanged()), [controller, filePath])

  const link = useMemo<ExtensionEditorLink>(
    () => ({
      document: controller.document,
      open: (port) => controller.openFrame(port),
      frameReady: () => controller.frameReady(),
      close: () => controller.closeFrame(),
      beforeRedraw: () => controller.prepareToLeave('redraw'),
    }),
    [controller],
  )

  const session = controller.session
  const state = useSyncExternalStore(
    (listener) => session.subscribe(listener),
    () => session.state(),
    () => session.state(),
  )
  const title = editor.contribution.title
  const extensionName = editor.extension?.name ?? editor.key

  if (state.status === 'refused' || state.status === 'failed') {
    return (
      <div className="flex h-full items-center justify-center bg-[color:var(--bg-app)] px-4">
        <InlineNotice
          tone="error"
          title={t.couldNotOpen(title)}
          hint={state.message}
          action={
            <OutlineButton size="xs" onClick={onOpenInTextEditor}>
              {t.openInTextEditor}
            </OutlineButton>
          }
          className="w-full max-w-[46rem]"
        />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-[color:var(--bg-app)]">
      <EditorBar state={state} label={t.by(title, extensionName)} onSave={() => void session.save()} picker={picker} />
      {state.conflict ? (
        <div className="shrink-0 px-3 pb-1">
          <InlineNotice
            tone="warn"
            action={
              <>
                <GhostButton size="xs" onClick={() => void session.reload()}>
                  {t.reload}
                </GhostButton>
                {!state.readOnly ? (
                  <GhostButton size="xs" onClick={() => void session.saveOverConflict()}>
                    {t.keepMine}
                  </GhostButton>
                ) : null}
              </>
            }
          >
            {state.conflict.kind === 'changed' ? t.changedOnDisk : t.goneOnDisk}
          </InlineNotice>
        </div>
      ) : null}
      {state.saveError ? (
        <div className="shrink-0 px-3 pb-1">
          <InlineNotice tone="error" title={t.couldNotSave} hint={state.saveError} />
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        {state.status === 'loading' ? (
          <div className="absolute inset-0">
            <Loading />
          </div>
        ) : null}
        <ExtensionSurfaceMount
          extensionKey={editor.key}
          point="customEditors"
          id={editor.contribution.id}
          workspaceId={workspaceId}
          editor={link}
          title={t.frameTitle(title, fileName)}
        />
      </div>
    </div>
  )
}

function EditorBar({
  state,
  label,
  onSave,
  picker,
}: {
  state: EditorSessionState
  label: string
  onSave: () => void
  picker: ReactNode
}): ReactElement {
  const word = state.readOnly
    ? t.readOnly
    : state.saving
      ? t.saving
      : state.dirty
        ? t.unsaved
        : state.status === 'ready'
          ? t.saved
          : ''
  return (
    <div className="flex h-control-md shrink-0 items-center gap-2 px-3 text-meta text-[color:var(--text-muted)]">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span role="status">{word}</span>
      {!state.readOnly ? (
        <GhostButton size="xs" disabled={!state.dirty || state.saving} onClick={onSave}>
          {t.save}
        </GhostButton>
      ) : null}
      {picker}
    </div>
  )
}
