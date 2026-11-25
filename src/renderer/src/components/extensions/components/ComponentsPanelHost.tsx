import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'

import { Badge } from '../../ui/Badge'
import { Banner } from '../../ui/Banner'
import { EmptyState } from '../../ui/EmptyState'
import { GhostButton } from '../../ui/Buttons'
import { InlineNotice } from '../../ui/InlineNotice'
import { Spinner } from '../../ui/Spinner'
import { ComponentsView } from './ComponentsView'
import type { ComponentsPanelSession } from './componentsPanelSession'

// A components panel as the window draws it: the tree its hidden run
// rendered, in Studio's own controls (ComponentsView), and around it what
// Studio says about the run: what the panel threw (a banner naming the
// extension), a view it refused to draw, a save that did not load (inline, at
// its file, line and column, over the last tree, which then answers nothing),
// and a brief Reloaded mark after a development folder's save.

const RELOADED_MS = 1600
// A panel quicker than this shows no spinner at all.
const LOADING_GRACE_MS = 300

export function ComponentsPanelHost({
  session,
  extensionName,
  openLink,
  readImage,
  locale,
}: {
  session: ComponentsPanelSession
  extensionName: string
  openLink(href: string): void
  readImage(src: string): Promise<string | null>
  locale: string
}): ReactElement {
  const state = useSyncExternalStore(session.subscribe, session.state, session.state)
  const [reloadedShown, setReloadedShown] = useState(false)
  const [waited, setWaited] = useState(false)

  useEffect(() => {
    if (state.reloadedAt === null) return
    setReloadedShown(true)
    const timer = setTimeout(() => setReloadedShown(false), RELOADED_MS)
    return () => clearTimeout(timer)
  }, [state.reloadedAt])

  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), LOADING_GRACE_MS)
    return () => clearTimeout(timer)
  }, [])

  if (!state.tree && state.loadError) {
    return <EmptyState title="This panel could not load" body={state.loadError} />
  }
  // Waiting for the first tree, unless the panel already threw or drew what Studio refused.
  if (!state.tree && !state.drawn && state.errors.length === 0 && !state.refused) {
    return (
      <div className="flex h-full items-center justify-center" aria-busy="true">
        {waited ? <Spinner label="Loading the panel" /> : null}
      </div>
    )
  }

  const inert = state.loadError !== null || !state.drawn
  const loadErrorLines = state.loadError ? state.loadError.split('\n').filter((line) => line.trim()) : null
  return (
    <div className="relative flex h-full min-h-0 flex-col" data-components-panel="">
      {state.errors.length > 0 ? (
        <Banner
          tone="error"
          message={`${extensionName}: ${state.errors[state.errors.length - 1]}`}
          action={
            <GhostButton size="sm" onClick={() => session.dismissError()}>
              Dismiss
            </GhostButton>
          }
        />
      ) : null}
      {loadErrorLines ? (
        // The first line names the file, line and column, so it is shown; the rest (a stack) waits behind details.
        <InlineNotice
          tone="error"
          title={
            session.development
              ? 'This save did not load; the last version that did is shown'
              : 'This panel stopped; the last view it drew is shown'
          }
          hint={loadErrorLines[0]}
          {...(loadErrorLines.length > 1 ? { detail: state.loadError ?? '' } : {})}
          className="m-[var(--sem-space-sm)]"
        />
      ) : null}
      {state.refused ? <InlineNotice tone="warn" title={state.refused} className="m-[var(--sem-space-sm)]" /> : null}
      <div className="min-h-0 flex-1 overflow-auto p-[var(--sem-space-lg)]" data-components-scroll="">
        <ComponentsView
          tree={state.tree}
          revision={state.revision}
          dispatch={session.dispatch}
          grantGesture={session.grantGesture}
          openLink={openLink}
          readImage={readImage}
          inert={inert}
          locale={locale}
          run={state.run}
        />
      </div>
      {reloadedShown ? (
        <div className="pointer-events-none absolute right-[var(--sem-space-sm)] top-[var(--sem-space-sm)]">
          <Badge tone="accent">Reloaded</Badge>
        </div>
      ) : null}
    </div>
  )
}
