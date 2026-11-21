import { useEffect, useRef, useState, type ReactElement } from 'react'

import type { ExtensionSurfacePoint } from '../../../../shared/modules/third-party-manifest'
import { sanitizeEntryMessage } from '../../../../shared/modules/entry-messages'
import { extensionMountStudio, getExtensionSurface } from '../../modules/extension-surfaces'
import { EmptyState } from '../ui/EmptyState'

// One extension surface — a pane tab, a door, a settings section — drawn by
// the extension's own `mount` into a root this component owns. The mount runs
// once per open and its cleanup when the surface closes; a mount that throws
// shows why in place of the surface, and never takes the window down.

type ExtensionSurfaceMountProps = {
  extensionKey: string
  point: ExtensionSurfacePoint
  id: string
  /** The workspace a panel was opened in. */
  workspaceId?: string
  className?: string
}

const MOUNT_FAILED = 'The extension could not draw this.'

export function ExtensionSurfaceMount({
  extensionKey,
  point,
  id,
  workspaceId,
  className,
}: ExtensionSurfaceMountProps): ReactElement {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const loaded = getExtensionSurface(extensionKey, point, id)

  useEffect(() => {
    const root = rootRef.current
    if (!loaded || !root) return
    const openedAt = performance.now()
    let cleanup: (() => void) | undefined
    let closed = false
    setFailure(null)
    const fail = (error: unknown) => {
      if (closed) return
      setFailure(sanitizeEntryMessage(error instanceof Error ? error.message : String(error), MOUNT_FAILED))
    }
    const runCleanup = (fn: unknown) => {
      if (typeof fn !== 'function') return
      try {
        ;(fn as () => void)()
      } catch (error) {
        console.error(`[extensions] ${extensionKey} ${point}/${id} failed to clean up:`, error)
      }
    }
    try {
      const studio = extensionMountStudio(loaded, { point, id, ...(workspaceId ? { workspaceId } : {}) }, openedAt)
      Promise.resolve(loaded.mount(root, studio)).then((result) => {
        // Closed before an async mount finished: clean up at once.
        if (closed) runCleanup(result)
        else if (typeof result === 'function') cleanup = result
      }, fail)
    } catch (error) {
      fail(error)
    }
    return () => {
      closed = true
      runCleanup(cleanup)
      root.replaceChildren()
    }
  }, [loaded, extensionKey, point, id, workspaceId])

  if (!loaded) {
    return (
      <EmptyState
        title="This extension is not available here"
        body="It is off, not trusted yet, or not installed on the Studio this window is connected to."
      />
    )
  }
  return (
    <div className={['relative h-full min-h-0 w-full overflow-auto', className ?? ''].join(' ')}>
      {failure ? <EmptyState title={MOUNT_FAILED} body={failure} /> : null}
      <div ref={rootRef} data-extension={extensionKey} data-extension-surface={`${point}/${id}`} className="h-full" />
    </div>
  )
}
