import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { CanvasPresence, CanvasRemoteAccess, CanvasRemoteLink } from '../../../../../../shared/canvas/types'
import { canvasBoardName } from '../../../../../../shared/canvas/paths'
import { useResolvedColorScheme } from '../../../../hooks/useAppTheme'
import { useWorkspaceStore } from '../../../../store/workspaceStore'
import { showToast } from '../../../../store/toastStore'
import type { WorkspacePaneTab } from '../../../../types/workspace'
import { EmptyState, PrimaryButton } from '../../../ui'
import { SuspenseFallback } from '../../../ui/SuspenseFallback'
import { CanvasBoardPicker } from './CanvasBoardPicker'
import { CanvasFarBoard } from './CanvasFarBoard'
import { CanvasExportDialog } from './CanvasExportDialog'
import { canvasExportedToast, type CanvasBoardExporter, type CanvasExportFormats } from './canvasExport'
import {
  canvasBoardClient,
  canvasBoardSourceOf,
  continueBoardInNewChat,
  readCanvasBoardAccess,
  type CanvasOpenedBoard,
} from './canvasBoardSource'
import { canvasPushMatchesBoard, shouldApplyCanvasPush } from './canvasSync'
import { StudioSkillSuggestion } from '../../../studioSkills/StudioSkillSuggestion'

// The Canvas tab: the board's lifecycle, the board actions, and the picker a
// tab with no board yet shows.
//
// It draws NO chrome of its own. The editor fills the tab body from directly
// under the pane's tab strip — that strip already names the board, and a second
// copy of the name under a hairline cost a strip of drawing surface to say
// nothing new. The actions the band used to hold are handed to the editor as
// callbacks and drawn in its own menu; the Agent badge is drawn in its own
// top-right row.
//
// Deliberately free of the editor. `CanvasEditor` is the only file that imports
// `@excalidraw/excalidraw`, and it is reached from here through `React.lazy`
// alone — so a tab sitting on the picker never fetches a megabyte of editor,
// and the boot chunk never sees it at all.
const CanvasEditor = React.lazy(() => import('./CanvasEditor'))
const CanvasMiniature = React.lazy(() =>
  import('./CanvasEditor').then((module) => ({ default: module.CanvasMiniature })),
)

type CanvasTabProps = {
  workspaceId: string
  tab: WorkspacePaneTab
  active: boolean
}

type BoardState = { kind: 'loading' } | { kind: 'ready'; board: CanvasOpenedBoard } | { kind: 'error'; message: string }

type AccessState = { kind: 'loading' } | CanvasRemoteAccess

export function CanvasTab({ workspaceId, tab, active }: CanvasTabProps) {
  const path = tab.canvas?.path ?? null
  // Another project's store, for a board reached from the list of every board.
  const store = tab.canvas?.store
  const updatePaneTab = useWorkspaceStore((s) => s.updatePaneTab)
  const setPaneTabBoard = useWorkspaceStore((s) => s.setPaneTabBoard)
  // The boards this pane's OTHER tabs hold, so the picker can say which of its
  // rows would move the person rather than open something new. Selected as one
  // string and split below: a selector that built a fresh array every time
  // would re-render this tab on every store change. The separator is the one
  // character a board path may never contain, and a store never does.
  const openBoardPaths = useWorkspaceStore((s) => {
    const tabs = s.workspaces.find((w) => w.id === workspaceId)?.paneState?.tabs ?? []
    return tabs
      .filter((candidate) => candidate.kind === 'canvas' && candidate.id !== tab.id && candidate.canvas)
      .flatMap((candidate) => [candidate.canvas!.store ?? '', candidate.canvas!.path])
      .join('\u0000')
  })
  const openBoards = useMemo(() => {
    const parts = openBoardPaths ? openBoardPaths.split('\u0000') : []
    return parts.flatMap((part, index) => (index % 2 === 1 ? [{ store: parts[index - 1] || null, path: part }] : []))
  }, [openBoardPaths])
  const workspaceRoot = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null)
  // Selected as its three strings: the source is rebuilt from them, so a store
  // change elsewhere does not read as a new source and list the boards again.
  const originKey = useWorkspaceStore((s) => {
    const origin = s.workspaces.find((w) => w.id === workspaceId)?.remoteOrigin
    return origin ? JSON.stringify([origin.connectionId, origin.machineName, origin.workspaceId, origin.sessionId]) : ''
  })
  const source = useMemo(() => {
    if (!originKey) return canvasBoardSourceOf(null)
    const [connectionId, machineName, remoteWorkspaceId, sessionId] = JSON.parse(originKey) as string[]
    return canvasBoardSourceOf({
      remoteOrigin: {
        connectionId,
        machineName,
        workspaceId: remoteWorkspaceId,
        workspaceName: '',
        workspaceRoot: null,
        ...(sessionId ? { sessionId } : {}),
      },
    })
  }, [originKey])
  const far = source.kind === 'paired'
  // The calls this tab and its editor make, to this machine's canvas or to the
  // one a paired chat runs on: one code path for both (canvasBoardSource.ts).
  const client = useMemo(() => canvasBoardClient(source), [source])
  // Whether the paired machine's boards open in the editor here: a machine
  // whose Studio does not serve `canvas-boards` shows them as pictures, and says so.
  const [access, setAccess] = useState<AccessState>(() =>
    far ? { kind: 'loading' } : { ok: true, live: true, canEdit: true },
  )
  const [accessAttempt, setAccessAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    if (!far) {
      setAccess({ ok: true, live: true, canEdit: true })
      return
    }
    setAccess({ kind: 'loading' })
    void readCanvasBoardAccess(source).then((answer) => {
      if (!cancelled) setAccess(answer)
    })
    return () => {
      cancelled = true
    }
  }, [accessAttempt, far, source])
  const known: CanvasRemoteAccess | null = 'kind' in access ? null : access
  const pictures = known?.ok === true && !known.live
  const editorReady = known?.ok === true && known.live
  // A paired board's link, as main last said it: out of reach, back, read-only.
  const [link, setLink] = useState<CanvasRemoteLink | null>(null)
  const theme = useResolvedColorScheme()
  // The ref every call names this board by. Memoised on its strings, so an
  // effect that depends on it runs when the board changes and only then.
  const board = useMemo(
    () => ({ workspaceId, path: path ?? '', ...(store ? { store } : {}) }),
    [path, store, workspaceId],
  )
  const [state, setState] = useState<BoardState>({ kind: 'loading' })
  const [presence, setPresence] = useState<CanvasPresence | null>(null)
  const [attempt, setAttempt] = useState(0)
  const hostRef = useRef<HTMLDivElement | null>(null)
  // The editor is not rendered until its container has had a size. A retained
  // hidden layer keeps its layout box (it is `invisible`, not `display:none`),
  // but a CLOSED pane is a zero-width column — and an editor constructed at
  // 0x0 measures itself into the library's phone layout and lays the scene out
  // against a viewport that does not exist. Once it has been sized it STAYS
  // mounted: the pane closing again must not throw the board away.
  const [sized, setSized] = useState(false)
  // Floating, the tab is a picture of the board (CanvasMiniature) laid over
  // whatever editor it already has. A board that floats before it was ever
  // opened in the pane builds no editor for the card's 320px: it is built when
  // the pane opens on it.
  const miniature = tab.floating === true

  useLayoutEffect(() => {
    if (sized || !path || miniature || !editorReady) return
    const host = hostRef.current
    if (!host) return
    const measure = (): boolean => {
      const rect = host.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      setSized(true)
      return true
    }
    if (measure()) return
    const observer = new ResizeObserver(() => {
      if (measure()) observer.disconnect()
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [editorReady, miniature, path, sized])

  // Open the board and subscribe this window to it; close it on the way out, so
  // main stops pushing scenes to a tab that is gone. Re-runs on `attempt` for
  // the retry, and on `path` when the person switches board.
  //
  // Only this project's own board is ever made here. A board of another project
  // that is not there is an error the person is shown, never a new empty one.
  useEffect(() => {
    if (!path || !editorReady) return
    let cancelled = false
    setState({ kind: 'loading' })
    setPresence(null)
    setLink(null)
    void (async () => {
      try {
        const result = await client.open({ ...board, create: !store })
        if (cancelled) return
        setState(result.ok ? { kind: 'ready', board: result.value } : { kind: 'error', message: result.error.message })
      } catch {
        if (!cancelled) setState({ kind: 'error', message: 'This board could not be opened.' })
      }
    })()
    return () => {
      cancelled = true
      // Unconditional: closing a board that never opened is a no-op on the main
      // side, and skipping it after a failed open would leak the subscription
      // that a partially-successful open left behind.
      try {
        client.close(board)
      } catch {
        // Main is already gone (the window is closing). Nothing to release.
      }
    }
  }, [attempt, board, client, editorReady, path, store])

  useEffect(() => {
    if (!path || !editorReady) return
    return client.onLink(board, setLink)
  }, [board, client, editorReady, path])

  // Scenes from main are folded into the board this tab holds, whether or not
  // the editor is mounted yet. A push is the WHOLE board, so the newest one is
  // the whole answer — which makes this record the right `initialData` for an
  // editor that mounts later (a pane that was closed when an agent drew).
  // The mounted editor applies the same pushes itself, with reconciliation.
  useEffect(() => {
    if (!path) return
    return window.api.onCanvasScene((push) => {
      if (!canvasPushMatchesBoard(push, board)) return
      setState((previous) => {
        if (previous.kind !== 'ready') return previous
        if (!shouldApplyCanvasPush(push.revision, previous.board.revision)) return previous
        return {
          kind: 'ready',
          board: {
            ...previous.board,
            revision: push.revision,
            elements: push.elements,
            files: push.files,
          },
        }
      })
    })
  }, [board, path])

  useEffect(() => {
    if (!path) return
    return window.api.onCanvasPresence((incoming) => {
      if (!canvasPushMatchesBoard(incoming, board)) return
      setPresence({
        controller: incoming.controller,
        agentName: incoming.agentName,
        pointer: incoming.pointer,
        selectedElementIds: incoming.selectedElementIds,
      })
    })
  }, [board, path])

  const pickBoard = useCallback(
    (next: string, nextStore?: string) => {
      // Through the slice, not `updatePaneTab`: a board another tab already
      // holds brings that tab forward and closes this picker, and the tab's
      // title follows its board either way.
      setPaneTabBoard(workspaceId, tab.id, next, nextStore)
    },
    [setPaneTabBoard, tab.id, workspaceId],
  )

  const switchBoard = useCallback(() => {
    updatePaneTab(workspaceId, tab.id, { canvas: undefined })
  }, [tab.id, updatePaneTab, workspaceId])

  // The board actions, handed to the editor to put in its own menu. They
  // are defined here, where the tab record and the workspace root live, and the
  // editor only calls them — which is what keeps `CanvasTab` free of the
  // package. `revealFile` is null rather than disabled when the workspace has
  // no folder: an item that cannot do anything is better left out than shown
  // greyed with no explanation.
  //
  // Main finds the file: a board in the app's store lives in the app's data
  // folder, outside the project, where no join against the workspace root
  // would find it.
  const revealFile = useCallback(() => {
    if (!workspaceRoot || !path) return
    void window.api.canvasRevealBoard(board).catch(() => {})
  }, [board, path, workspaceRoot])

  const copyPath = useCallback(() => {
    if (!path) return
    // The board's id where it has one: a bare name means another board in any
    // other project, and an id is what a new chat anywhere on this machine can
    // be handed. The path is what is left where the service knows no store.
    const copied = (state.kind === 'ready' ? state.board.id : undefined) ?? path
    void window.api.clipboardWriteText(copied)
    showToast({ tone: 'good', title: 'Board path copied', description: copied })
  }, [path, state])

  // Export: the editor hands up its half (flush, then render the pictures), the
  // dialog asks which files, and main shows the folder picker and writes them.
  // The editor's half is kept in a ref rather than state: it is a function the
  // dialog calls once, not something this tab renders from.
  const exporterRef = useRef<CanvasBoardExporter | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportPending, setExportPending] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const openExport = useCallback((exporter: CanvasBoardExporter) => {
    exporterRef.current = exporter
    setExportError(null)
    setExportOpen(true)
  }, [])

  const cancelExport = useCallback(() => {
    setExportOpen(false)
    setExportError(null)
  }, [])

  const runExport = useCallback(
    async (formats: CanvasExportFormats) => {
      const exporter = exporterRef.current
      if (!path || !exporter) return
      setExportPending(true)
      setExportError(null)
      try {
        const images = await exporter(formats)
        const result = await client.exportBoard({
          ...board,
          ...(workspaceRoot ? { defaultDirectory: workspaceRoot } : {}),
          images,
        })
        if (!result.ok) {
          setExportError(result.error.message)
          return
        }
        // Dismissing the folder picker is a change of mind, not a failure: the
        // dialog stays open on the same choice so a second press tries again.
        if (result.value.cancelled) return
        setExportOpen(false)
        showToast({ tone: 'good', ...canvasExportedToast(result.value) })
      } catch (error) {
        setExportError(error instanceof Error ? error.message : 'The board could not be exported.')
      } finally {
        setExportPending(false)
      }
    },
    [board, client, path, workspaceRoot],
  )

  // Carry on with this board in a chat of its own, on the machine the board is
  // on: the row action of the picker, from the board's own menu.
  const boardId = state.kind === 'ready' ? (state.board.id ?? null) : null
  const continueInNewChat = useCallback(() => {
    if (!path) return
    void continueBoardInNewChat(source, workspaceId, {
      id: boardId,
      path,
      name: canvasBoardName(path),
      store: store ?? null,
      project: null,
      showsProject: false,
      workspaceId: null,
      elementCount: -1,
      modifiedAt: 0,
    }).then((started) => {
      if (!started.ok)
        showToast({ tone: 'error', title: 'Could not start the chat', description: started.error.message })
    })
  }, [boardId, path, source, store, workspaceId])

  if (!known)
    return (
      <SuspenseFallback
        label={`Asking ${source.kind === 'paired' ? source.machineName : 'this machine'} about its boards`}
      />
    )
  if (!known.ok) {
    return (
      <EmptyState
        title="The boards could not be reached"
        body={known.message}
        action={<PrimaryButton onClick={() => setAccessAttempt((n) => n + 1)}>Try again</PrimaryButton>}
      />
    )
  }
  const canEditHere = known.live && known.canEdit

  if (!path) {
    return (
      <CanvasBoardPicker
        workspaceId={workspaceId}
        source={source}
        // A chat with no folder here has no project of its own to list.
        initialScope={far || workspaceRoot ? 'project' : 'all'}
        onPick={pickBoard}
        openBoards={openBoards}
        canCreate={canEditHere}
        {...(far
          ? {
              note: !known.live
                ? (known.reason ?? null)
                : known.canEdit
                  ? null
                  : `This pairing can look at boards on ${source.machineName} but not add or change them.`,
            }
          : {})}
      />
    )
  }

  // A paired machine whose Studio cannot carry its boards here: the picture it
  // draws of one, and the reason in words.
  if (source.kind === 'paired' && pictures) {
    return (
      <CanvasFarBoard
        source={source}
        workspaceId={workspaceId}
        board={{ path, ...(store ? { store } : {}) }}
        reason={known.reason ?? null}
        onSwitchBoard={switchBoard}
      />
    )
  }

  const name = canvasBoardName(path)
  // Read-only where this pairing may only look, and while a lost board cannot be saved.
  const readOnly = (state.kind === 'ready' && !state.board.canEdit) || link?.canEdit === false || link?.state === 'gone'
  const linkNote =
    link?.message ??
    (state.kind === 'ready' && !state.board.canEdit && far
      ? `This pairing can look at boards on ${source.machineName} but not change them.`
      : null)

  // No band of chrome above the editor. The pane's tab strip already carries
  // the board's name, and a second copy of it under a hairline was a strip of
  // the drawing surface spent saying nothing new — so the editor starts
  // directly under the strip and fills the tab. What the band held moved into
  // the space the editor already spends: the board actions are items at
  // the top of its own menu, and an agent's presence is a badge in its
  // top-right corner.
  //
  // The one line allowed above it is the Canvas skill's offer, shown until the
  // person answers it once (StudioSkillSuggestion); the host is measured, so the
  // editor takes the height back when it goes.
  return (
    <div className="relative flex h-full w-full flex-col">
      {/* The skill is installed for the agents on the machine the chat runs
          on, and only its own Studio offers it. Neither notice draws a rule:
          they stand on the surface and the board on the app ground, and the
          change of ground is the edge. */}
      {far ? null : (
        <StudioSkillSuggestion skillId="studio-canvas" className="shrink-0 bg-[color:var(--bg-surface)] px-3 py-2" />
      )}
      {linkNote ? (
        <p
          role="status"
          className="shrink-0 bg-[color:var(--bg-surface)] px-3 py-2 text-meta text-[color:var(--text-muted)]"
        >
          {linkNote}
        </p>
      ) : null}
      <div
        ref={hostRef}
        className={`relative min-h-0 w-full flex-1 bg-[color:var(--bg-app)]${miniature ? ' isolate' : ''}`}
      >
        {state.kind === 'error' ? (
          <EmptyState
            title="This board could not be opened"
            body={state.message}
            action={<PrimaryButton onClick={() => setAttempt((n) => n + 1)}>Try again</PrimaryButton>}
          />
        ) : state.kind === 'loading' || !sized ? (
          <SuspenseFallback label="Opening the board" />
        ) : (
          // `se-canvas` is the wrapper canvasTheme.css maps the editor's own
          // variables onto our tokens under. Keyed on the board so switching to
          // another one builds a new editor rather than re-pointing this one:
          // the scene, the undo stack and the viewport all belong to a board.
          <div className="se-canvas absolute inset-0">
            <React.Suspense fallback={<SuspenseFallback label="Loading the canvas" />}>
              <CanvasEditor
                key={`${store ?? ''}/${path}`}
                workspaceId={workspaceId}
                path={path}
                {...(store ? { store } : {})}
                initial={state.board}
                client={client}
                readOnly={readOnly}
                name={name}
                theme={theme}
                active={active}
                presence={presence}
                onSwitchBoard={switchBoard}
                onContinueInNewChat={far || boardId ? continueInNewChat : null}
                onRevealFile={workspaceRoot ? revealFile : null}
                onCopyPath={copyPath}
                onExport={openExport}
              />
            </React.Suspense>
          </div>
        )}
        <CanvasExportDialog
          open={exportOpen}
          boardName={name}
          pending={exportPending}
          error={exportError}
          onCancel={cancelExport}
          onExport={(formats) => void runExport(formats)}
        />
      </div>
      {/* Over the editor and the skill's offer, under the player's own
          chrome (FloatingPlayerChrome, at `--z-float` in the same stacking
          context). No tier of its own: it is the last positioned layer in
          the tab, and the editor's host is isolated while it is up, so none
          of the library's own stacking climbs over the picture. */}
      {miniature && state.kind === 'ready' ? (
        <div className="absolute inset-0">
          <React.Suspense fallback={null}>
            <CanvasMiniature board={state.board} theme={theme} />
          </React.Suspense>
        </div>
      ) : null}
    </div>
  )
}
