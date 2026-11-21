import React, { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import MonacoEditor, { type OnMount } from '@monaco-editor/react'

import { useMonacoBaseTheme } from '../../../../hooks/useAppTheme'
import { configureMonacoLanguages } from '../../../../utils/patchLanguage'
import { useCodeFontFamily } from '../../../../utils/fonts'
import { detectLanguage } from '../../../../utils/files'
import { FrontTruncatedText, GhostButton, InlineNotice, TabPanel, Tabs, TabsScroller } from '../../../ui'
import { useConversationLinkContext } from '../conversationLinks'
import type { TranscriptToolEntry } from '../conversationProjection'
import { useConversationTransport, type ConversationTransport } from '../conversationTransport'
import type { ConversationKey } from '../../../../../../shared/conversation-runtime'
import { copy as appCopy } from '../../../../../../shared/copy'
import {
  FILE_VIEW_SAVE_PAUSE_MS,
  LOADING_ENTRY,
  fileViewDirty,
  fileViewFiles,
  fileViewHeightLines,
  fileViewTabLabels,
  type FileViewEntry,
  type FileViewFile,
  type FileViewSaveState,
} from './fileViewModel'

// The files an agent showed with Studio's `file.view`: a small editor of
// each, in tabs, bound to the file on the machine the chat runs on, not a
// copy of it. The path is at the top; what the person types is saved after a
// short pause, or at once with Cmd/Ctrl+S, through the chat's own Studio
// (`fileViews.write`), and the save says "Saved" when it lands. A file that
// changed on disk since it was read is never written over: the view says so
// and offers to load it again or to save over it on purpose. The lines the
// agent pointed at are marked in the agent violet, with its note beside the
// first line of each, and the editor opens scrolled to the first.
//
// The view reads and saves through the chat's transport, so a chat on a
// paired machine, an SSH machine, or in a browser tab saves on the machine
// that holds the file. A view that cannot change the chat (a read-only embed)
// shows the files read only.

const t = appCopy.panels.agentChat.fileView
const LINE_HEIGHT = 19
const EDITOR_PADDING = 8

const keyStop = (event: React.SyntheticEvent): void => event.stopPropagation()

function statusWord(save: FileViewSaveState, editable: boolean): string {
  if (!editable && save.kind !== 'loading') return t.readOnly
  switch (save.kind) {
    case 'loading':
      return t.loading
    case 'saving':
      return t.saving
    case 'unsaved':
      return t.unsaved
    case 'saved':
      return t.saved
    case 'conflict':
    case 'error':
    case 'unreadable':
      return ''
  }
}

export const FileViewCard = memo(function FileViewCard({
  tool,
  fallback,
}: {
  tool: TranscriptToolEntry
  /** Drawn instead where there is nothing to open: an answer that names no file, or a chat with no transport for it. */
  fallback: React.ReactNode
}): React.ReactNode {
  const files = useMemo(() => fileViewFiles(tool), [tool])
  const link = useConversationLinkContext()
  const transport = useConversationTransport()
  // Only where this window has the app's own Monaco (utils/monacoRuntime.ts,
  // which sets `MonacoEnvironment` as it boots): an embedded conversation
  // has none, and the editor wrapper would fetch one from a CDN.
  const monacoHere = (globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment !== undefined
  if (files.length === 0 || !link?.agentId || !transport.readFileView || !monacoHere) return fallback
  const key: ConversationKey = {
    workspaceId: link.workspaceId,
    agentId: link.agentId,
    workspaceRoot: link.workspaceRoot,
  }
  return <FileViewFrame files={files} chatKey={key} transport={transport} />
})

function FileViewFrame({
  files,
  chatKey,
  transport,
}: {
  files: FileViewFile[]
  chatKey: ConversationKey
  transport: ConversationTransport
}): React.JSX.Element {
  const editable = transport.capabilities.operate && transport.writeFileView !== undefined
  const [active, setActive] = useState(files[0]!.path)
  const [entries, setEntries] = useState<Record<string, FileViewEntry>>({})
  const entriesRef = useRef(entries)
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const idPrefix = useId()
  const labels = useMemo(() => fileViewTabLabels(files), [files])
  const { workspaceId, agentId, workspaceRoot } = chatKey
  const keyRef = useRef(chatKey)
  keyRef.current = chatKey

  // Worked out from the ref, at once: a save asked for in the same event as
  // the keystroke before it (Cmd/Ctrl+S) reads that keystroke's text.
  const patch = useCallback((path: string, change: (entry: FileViewEntry) => FileViewEntry) => {
    const next = { ...entriesRef.current, [path]: change(entriesRef.current[path] ?? LOADING_ENTRY) }
    entriesRef.current = next
    setEntries(next)
  }, [])

  const load = useCallback(
    async (path: string) => {
      const read = await transport.readFileView!({ key: keyRef.current, path })
      patch(path, () =>
        read.ok
          ? { text: read.text, savedText: read.text, hash: read.hash, save: { kind: 'saved' } }
          : { ...LOADING_ENTRY, save: { kind: 'unreadable', message: read.message } },
      )
    },
    [patch, transport],
  )

  // Each file is read once, when the view first draws; a tab keeps its text
  // and its save state while another is shown.
  useEffect(() => {
    for (const file of files) if (!entriesRef.current[file.path]) void load(file.path)
  }, [files, load, workspaceId, agentId, workspaceRoot])

  /** Save what the person typed, on the file as last read (`over`: on the hash it has now, written over on purpose). */
  const save = useCallback(
    async (path: string, over?: string | null) => {
      const pending = timers.current.get(path)
      if (pending) clearTimeout(pending)
      timers.current.delete(path)
      const entry = entriesRef.current[path]
      if (!entry || !editable || !transport.writeFileView || entry.hash === null) return
      if (over === undefined && (!fileViewDirty(entry) || entry.save.kind === 'saving')) return
      const text = entry.text
      const ifMatch = over ?? entry.hash
      if (ifMatch === null) return
      patch(path, (current) => ({ ...current, save: { kind: 'saving' } }))
      const written = await transport.writeFileView({ key: keyRef.current, path, text, ifMatch })
      patch(path, (current) => {
        if (written.ok) {
          const settled = { ...current, hash: written.hash, savedText: text }
          // Typed on while it saved: those keystrokes are the next save's.
          return { ...settled, save: current.text === text ? { kind: 'saved' } : { kind: 'unsaved' } }
        }
        if (written.conflict) return { ...current, save: { kind: 'conflict', gone: written.currentHash === null } }
        return { ...current, save: { kind: 'error', message: written.message } }
      })
      if (written.ok && entriesRef.current[path]?.text !== text) schedule(path)
    },
    [editable, patch, transport],
  )
  const saveRef = useRef(save)
  saveRef.current = save

  /** Save once the person has paused for a moment. */
  function schedule(path: string): void {
    const pending = timers.current.get(path)
    if (pending) clearTimeout(pending)
    timers.current.set(
      path,
      setTimeout(() => void saveRef.current(path), FILE_VIEW_SAVE_PAUSE_MS),
    )
  }

  // A view scrolled out of the transcript's virtual list, or a chat closed,
  // saves what is waiting rather than lose it.
  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const path of [...pending.keys()]) void save(path)
    }
  }, [save])

  const typed = useCallback(
    (path: string, text: string) => {
      patch(path, (current) =>
        current.hash === null
          ? current
          : {
              ...current,
              text,
              save:
                current.save.kind === 'conflict' || current.save.kind === 'error'
                  ? current.save
                  : text === current.savedText
                    ? { kind: 'saved' }
                    : { kind: 'unsaved' },
            },
      )
      const entry = entriesRef.current[path]
      if (entry && entry.save.kind !== 'conflict') schedule(path)
    },
    // `schedule` reads only refs.
    [patch],
  )

  /** Write over a file that changed on disk, on purpose: conditional on what is there now. */
  const keepMine = useCallback(
    async (path: string) => {
      const read = await transport.readFileView!({ key: keyRef.current, path })
      await save(path, read.ok ? read.hash : null)
    },
    [save, transport],
  )

  const file = files.find((candidate) => candidate.path === active) ?? files[0]!
  const entry = entries[file.path] ?? LOADING_ENTRY
  const status = statusWord(entry.save, editable)

  return (
    <div data-copy-exclude="" className="ds-code-block file-view mb-3" onKeyDown={keyStop} onPaste={keyStop}>
      {files.length > 1 ? (
        // The strip's own hairline sets it off from the path below.
        <TabsScroller>
          <Tabs
            ariaLabel={t.files}
            idPrefix={idPrefix}
            items={files.map((each, index) => ({ id: each.path, label: labels[index]!, ariaLabel: each.path }))}
            value={file.path}
            onChange={setActive}
          />
        </TabsScroller>
      ) : null}
      <div className="ds-code-block__header">
        <span className="ds-code-block__label">
          <FrontTruncatedText text={file.path} className="ds-code-block__filename" />
        </span>
        {status ? (
          <span role="status" className="flex-none text-[color:var(--text-subtle)]">
            {status}
          </span>
        ) : null}
      </div>
      <FileViewNotice
        save={entry.save}
        onReload={() => void load(file.path)}
        onKeepMine={() => void keepMine(file.path)}
        onRetry={() => void save(file.path, entry.hash)}
      />
      {files.map((each) => (
        <TabPanel key={each.path} idPrefix={idPrefix} tabId={each.path} active={each.path === file.path}>
          {entries[each.path] && entries[each.path]!.hash !== null ? (
            <FileViewEditor
              file={each}
              entry={entries[each.path]!}
              readOnly={!editable}
              onChange={(text) => typed(each.path, text)}
              onSave={() => void save(each.path)}
            />
          ) : null}
        </TabPanel>
      ))}
    </div>
  )
}

function FileViewNotice({
  save,
  onReload,
  onKeepMine,
  onRetry,
}: {
  save: FileViewSaveState
  onReload: () => void
  onKeepMine: () => void
  onRetry: () => void
}): React.JSX.Element | null {
  if (save.kind === 'conflict')
    return (
      <InlineNotice
        tone="warn"
        className="m-2"
        action={
          <>
            <GhostButton size="xs" onClick={onReload}>
              {t.reload}
            </GhostButton>
            {save.gone ? null : (
              <GhostButton size="xs" onClick={onKeepMine}>
                {t.keepMine}
              </GhostButton>
            )}
          </>
        }
      >
        {save.gone ? t.goneOnDisk : t.changedOnDisk}
      </InlineNotice>
    )
  if (save.kind === 'error')
    return (
      <InlineNotice
        tone="error"
        className="m-2"
        title={t.couldNotSave}
        hint={save.message}
        action={
          <GhostButton size="xs" onClick={onRetry}>
            {t.tryAgain}
          </GhostButton>
        }
      />
    )
  if (save.kind === 'unreadable')
    return (
      <InlineNotice
        tone="error"
        className="m-2"
        title={t.couldNotOpen}
        hint={save.message}
        action={
          <GhostButton size="xs" onClick={onReload}>
            {t.tryAgain}
          </GhostButton>
        }
      />
    )
  return null
}

function FileViewEditor({
  file,
  entry,
  readOnly,
  onChange,
  onSave,
}: {
  file: FileViewFile
  entry: FileViewEntry
  readOnly: boolean
  onChange: (text: string) => void
  onSave: () => void
}): React.JSX.Element {
  const theme = useMonacoBaseTheme()
  const fontFamily = useCodeFontFamily()
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  const lines = entry.text.split('\n').length
  const height = fileViewHeightLines(lines) * LINE_HEIGHT + EDITOR_PADDING * 2
  const mount: OnMount = (editor, monaco) => {
    // Cmd/Ctrl+S saves now, not after the pause.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current())
    if (file.highlights.length === 0) return
    const model = editor.getModel()
    const endOf = (line: number): number => (model && line <= model.getLineCount() ? model.getLineMaxColumn(line) : 1)
    editor.createDecorationsCollection(
      file.highlights.map((range) => ({
        range: { startLineNumber: range.from, startColumn: 1, endLineNumber: range.to, endColumn: 1 },
        options: {
          isWholeLine: true,
          className: 'file-view-highlight',
          linesDecorationsClassName: 'file-view-highlight-edge',
        },
      })),
    )
    editor.createDecorationsCollection(
      file.highlights
        .filter((range) => range.note)
        .map((range) => ({
          // At the end of the range's first line, where Monaco draws text after it.
          range: {
            startLineNumber: range.from,
            startColumn: endOf(range.from),
            endLineNumber: range.from,
            endColumn: endOf(range.from),
          },
          // An empty range is drawn only when told to be.
          options: {
            showIfCollapsed: true,
            after: { content: `  ${range.note}`, inlineClassName: 'file-view-highlight-note' },
          },
        })),
    )
    editor.revealLineNearTop(file.highlights[0]!.from)
  }

  return (
    <div className="file-view-editor" aria-label={t.file(file.path)}>
      <MonacoEditor
        height={height}
        beforeMount={configureMonacoLanguages}
        language={detectLanguage(file.name)}
        // The text as the view holds it: what the person types is already
        // there, and a file read again (a reload after a conflict) replaces it.
        value={entry.text}
        theme={theme}
        onMount={mount}
        onChange={(value) => {
          if (value !== undefined) onChange(value)
        }}
        options={{
          readOnly,
          fontSize: 12,
          lineHeight: LINE_HEIGHT,
          fontFamily,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          renderLineHighlight: 'none',
          lineNumbers: 'on',
          lineNumbersMinChars: 3,
          folding: false,
          glyphMargin: false,
          wordWrap: 'on',
          tabSize: 2,
          automaticLayout: true,
          contextmenu: false,
          padding: { top: EDITOR_PADDING, bottom: EDITOR_PADDING },
          // The chat scrolls on past the editor's ends rather than stopping there.
          scrollbar: { alwaysConsumeMouseWheel: false, verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
          overviewRulerLanes: 0,
        }}
      />
    </div>
  )
}
