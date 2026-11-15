import React, { useCallback, useEffect, useState } from 'react'

import { pairedBoardPicture } from '../../../../studio/pairedCanvas'
import { canvasBoardId, canvasBoardName } from '../../../../../../shared/canvas/paths'
import { useResolvedColorScheme } from '../../../../hooks/useAppTheme'
import { showToast } from '../../../../store/toastStore'
import { EmptyState, GhostButton, PrimaryButton } from '../../../ui'
import { SuspenseFallback } from '../../../ui/SuspenseFallback'
import { canvasPictureUrl, continueBoardInNewChat, type CanvasBoardSource } from './canvasBoardSource'

// A board on a paired machine whose Studio cannot carry it here.
//
// A machine whose Studio serves `canvas-boards` opens its boards in the same
// editor a board here opens in (CanvasTab). Where the pane cannot (a browser
// tab, which carries no paired connection of its own), a board is shown as the
// picture that machine draws (`canvas.picture`), with the reason in words and
// the way to change the board from here, a chat on that machine.

type FarBoard = { path: string; store?: string }

type Picture = { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'error'; message: string }

export function CanvasFarBoard({
  source,
  workspaceId,
  board,
  reason,
  onSwitchBoard,
}: {
  source: Extract<CanvasBoardSource, { kind: 'paired' }>
  workspaceId: string
  board: FarBoard
  /** Why the board is a picture here, from the machine's answer. */
  reason: string | null
  onSwitchBoard: () => void
}) {
  const theme = useResolvedColorScheme()
  const [picture, setPicture] = useState<Picture>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [starting, setStarting] = useState(false)
  const name = canvasBoardName(board.path)
  const id = board.store ? canvasBoardId(board.store, board.path) : null

  useEffect(() => {
    let cancelled = false
    setPicture({ kind: 'loading' })
    // Drawn over there and asked of that machine's Studio by this window itself.
    void pairedBoardPicture(
      { id: source.connectionId, machineName: source.machineName },
      { workspaceId: source.remoteWorkspaceId, board: id ?? board.path, dark: theme === 'dark' },
    ).then(
      (answer) => {
        if (cancelled) return
        const url = answer.ok ? canvasPictureUrl(answer) : null
        if (url) setPicture({ kind: 'ready', url })
        else
          setPicture({
            kind: 'error',
            message: answer.ok ? `${source.machineName} sent no picture of this board.` : answer.message,
          })
      },
      () => {
        if (!cancelled) setPicture({ kind: 'error', message: `${source.machineName} could not be reached.` })
      },
    )
    return () => {
      cancelled = true
    }
  }, [attempt, board.path, id, source.connectionId, source.machineName, source.remoteWorkspaceId, theme])

  const continueHere = useCallback(() => {
    setStarting(true)
    void continueBoardInNewChat(source, workspaceId, {
      id,
      path: board.path,
      name,
      store: board.store ?? null,
      project: null,
      showsProject: false,
      workspaceId: null,
      elementCount: -1,
      modifiedAt: 0,
    }).then((started) => {
      setStarting(false)
      if (!started.ok) {
        showToast({
          tone: 'error',
          title: `Could not start a chat on ${source.machineName}`,
          description: started.error.message,
        })
      }
    })
  }, [board.path, board.store, id, name, source, workspaceId])

  return (
    <div className="flex h-full w-full flex-col bg-[color:var(--bg-surface)]">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[color:var(--border-subtle)] px-3 py-2">
        {/* A line of its own: a docked pane has no room for it beside the actions. */}
        <p className="w-full text-meta text-[color:var(--text-muted)]">
          {reason ?? `A picture of this board on ${source.machineName}.`} To change it from here, continue in a new chat
          there.
        </p>
        <GhostButton onClick={onSwitchBoard} className="ml-auto">
          Boards
        </GhostButton>
        <GhostButton onClick={() => setAttempt((n) => n + 1)}>Refresh</GhostButton>
        <PrimaryButton onClick={continueHere} disabled={starting}>
          Continue in a new chat
        </PrimaryButton>
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto bg-[color:var(--bg-app)]">
        {picture.kind === 'loading' ? (
          <SuspenseFallback label={`Asking ${source.machineName} for this board`} />
        ) : picture.kind === 'error' ? (
          <EmptyState
            title="This board could not be shown"
            body={picture.message}
            action={<PrimaryButton onClick={() => setAttempt((n) => n + 1)}>Try again</PrimaryButton>}
          />
        ) : (
          <img src={picture.url} alt={`The board ${name}`} className="mx-auto block max-w-full" />
        )}
      </div>
    </div>
  )
}
