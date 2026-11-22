import { useEffect, useMemo, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react'

import { EXTENSION_EDITOR_FLUSH_TIMEOUT_MS } from '../../../../../packages/extension-sdk/src/custom-editors'
import { copy } from '../../../../shared/copy'
import type { MatchedExtensionEditor } from '../../modules/extension-editors'
import {
  base64ToBytes,
  bytesToBase64,
  createEditorSession,
  createLocalDocumentModel,
  type EditorDocumentModel,
  type EditorRead,
  type EditorSession,
  type EditorSessionState,
  type EditorWrite,
} from '../../modules/extension-editor-session'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  getEditorBuffer,
  getEditorDiskBaseline,
  hasEditorBuffer,
  setEditorBuffer,
  setEditorDiskBaseline,
  subscribeEditorBuffer,
} from '../../utils/editorBuffers'
import { watchFileOnDisk } from '../../utils/fileDiskWatch'
import { GhostButton, InlineNotice, OutlineButton, Spinner } from '../ui'
import { ExtensionSurfaceMount, type ExtensionEditorLink, type ExtensionEditorPort } from './ExtensionSurfaceMount'

// A file open in an extension's custom editor: the editor's frame, and above
// it what Studio keeps for it, as the text editor does: whether it is saved,
// Save, and what the file on disk did under unsaved edits.
//
// The document session (extension-editor-session.ts) reads and saves the file
// through this window's Studio as the extension's frame (`files.read`,
// `files.write`), so the extension's approval and this window's connection
// are both checked, on every client alike. A text file's content is the
// window's editor buffer, shared with the text editor, so reopening the file
// there keeps unsaved edits; a binary file's bytes are the session's own.

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

/** A text file's document: the buffer, unsaved flag and disk baseline the text editor uses for it. */
function sharedTextModel(workspaceId: string, path: string): EditorDocumentModel {
  return {
    get: () => (hasEditorBuffer(workspaceId, path) ? getEditorBuffer(workspaceId, path) : undefined),
    set(content, origin) {
      const text = typeof content === 'string' ? content : new TextDecoder().decode(content)
      if (origin === 'frame') useWorkspaceStore.getState().updateFileContent(workspaceId, path, text)
      else setEditorBuffer(workspaceId, path, text)
    },
    dirty: () => openFileOf(workspaceId, path)?.isDirty ?? false,
    markClean: () => useWorkspaceStore.getState().markFileClean(workspaceId, path),
    baseline: () => getEditorDiskBaseline(workspaceId, path),
    setBaseline: (content) =>
      setEditorDiskBaseline(
        workspaceId,
        path,
        typeof content === 'string' ? content : new TextDecoder().decode(content),
      ),
    subscribe: (listener) => subscribeEditorBuffer(workspaceId, path, listener),
  }
}

// A missing file is an `action_failed` whose words say so: the containment
// answers no code of its own for it.
const MISSING = /does not exist\.$/u

export function ExtensionEditorView({
  workspaceId,
  filePath,
  relativePath,
  fileName,
  editor,
  picker,
  onOpenInTextEditor,
}: Props): ReactElement {
  const contentKind = editor.contribution.contentKind ?? 'text'
  const readOnly = !(editor.extension?.permissions ?? []).includes('workspace-files:write')
  const [session, setSession] = useState<EditorSession | null>(null)

  const link = useMemo<ExtensionEditorLink>(() => {
    let current: EditorSession | null = null
    let nextFlush = 1
    const flushes = new Map<number, (ok: boolean) => void>()
    const read = async (port: ExtensionEditorPort): Promise<EditorRead> => {
      const answer = await port.call('files.read', {
        workspaceId,
        path: relativePath,
        encoding: contentKind === 'bytes' ? 'base64' : 'utf8',
      })
      if (!answer.ok)
        return { ok: false, code: MISSING.test(answer.message) ? 'missing' : answer.code, message: answer.message }
      const result = answer.result as { content: string; sha256: string }
      return {
        ok: true,
        content: contentKind === 'bytes' ? base64ToBytes(result.content) : result.content,
        sha256: result.sha256,
      }
    }
    const write = async (port: ExtensionEditorPort, content: string | Uint8Array, expected?: string) => {
      const answer = await port.call('files.write', {
        workspaceId,
        path: relativePath,
        ...(typeof content === 'string'
          ? { content }
          : { content: bytesToBase64(content), encoding: 'base64' as const }),
        ...(expected ? { expectedSha256: expected } : {}),
      })
      return (answer.ok ? { ok: true, sha256: (answer.result as { sha256: string }).sha256 } : answer) as EditorWrite
    }
    const close = () => {
      current?.dispose()
      current = null
      for (const settle of flushes.values()) settle(false)
      flushes.clear()
      setSession(null)
    }
    return {
      document: {
        applyEdit: (params) =>
          current?.applyEdit(params) ?? { ok: false, code: 'unavailable', message: 'The document is not open.' },
        flushed: (id, ok) => flushes.get(id)?.(ok),
        save: () => void current?.save(),
      },
      open(port) {
        close()
        const next = createEditorSession({
          contentKind,
          readOnly,
          model: contentKind === 'text' ? sharedTextModel(workspaceId, filePath) : createLocalDocumentModel(),
          read: () => read(port),
          write: (content, expected) => write(port, content, expected),
          post: (document) => port.sendDocument(document),
          flushFrame: () =>
            new Promise<boolean>((resolve) => {
              const id = nextFlush++
              const timer = setTimeout(() => settle(false), EXTENSION_EDITOR_FLUSH_TIMEOUT_MS)
              const settle = (ok: boolean) => {
                clearTimeout(timer)
                flushes.delete(id)
                resolve(ok)
              }
              flushes.set(id, settle)
              port.requestFlush(id)
            }),
        })
        current = next
        setSession(next)
        void next.start()
      },
      frameReady: () => current?.attachFrame(),
      close,
    }
  }, [contentKind, filePath, readOnly, relativePath, workspaceId])

  // The file under the editor, kept in step with disk while it is open.
  useEffect(() => {
    if (!session) return
    return watchFileOnDisk(filePath, () => void session.diskChanged())
  }, [filePath, session])

  const state = useSyncExternalStore(
    (listener) => session?.subscribe(listener) ?? (() => undefined),
    () => session?.state() ?? null,
    () => null,
  )
  const title = editor.contribution.title
  const extensionName = editor.extension?.name ?? editor.key

  if (state?.status === 'refused' || state?.status === 'failed') {
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
      <EditorBar state={state} label={t.by(title, extensionName)} onSave={() => void session?.save()} picker={picker} />
      {state?.conflict ? (
        <div className="shrink-0 px-3 pb-1">
          <InlineNotice
            tone="warn"
            action={
              <>
                <GhostButton size="xs" onClick={() => void session?.reload()}>
                  {t.reload}
                </GhostButton>
                {state.conflict.kind === 'changed' && !state.readOnly ? (
                  <GhostButton size="xs" onClick={() => void session?.saveOverConflict()}>
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
      {state?.saveError ? (
        <div className="shrink-0 px-3 pb-1">
          <InlineNotice tone="error" title={t.couldNotSave} hint={state.saveError} />
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        {state === null || state.status === 'loading' ? (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-meta text-[color:var(--text-muted)]">
            <Spinner />
            <span role="status">{t.loading}</span>
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
  state: EditorSessionState | null
  label: string
  onSave: () => void
  picker: ReactNode
}): ReactElement {
  const word = !state
    ? ''
    : state.readOnly
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
      {state && !state.readOnly ? (
        <GhostButton size="xs" disabled={!state.dirty || state.saving} onClick={onSave}>
          {t.save}
        </GhostButton>
      ) : null}
      {picker}
    </div>
  )
}
