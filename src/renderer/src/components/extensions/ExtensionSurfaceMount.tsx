import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'

import { THEME_TOKENS } from '../../../../../packages/extension-sdk/src/index'
import { desktopExtensionFrameUrl, EXTENSION_FRAME_PATH_PREFIX } from '../../../../shared/extension-frames'
import { extensionSurfaceId } from '../../../../shared/modules/extension-ids'
import type { ExtensionSurfacePoint } from '../../../../shared/modules/third-party-manifest'
import { sanitizeEntryMessage } from '../../../../shared/modules/entry-messages'
import { createExtensionFrameHost, readWindowFrameTheme } from '../../modules/extension-frame-host'
import {
  extensionSurfacesVersion,
  getExtensionSurface,
  recordReadiness,
  subscribeExtensionSurfaces,
} from '../../modules/extension-surfaces'
import { extensionsApi } from '../../studio/extensions'
import { EmptyState } from '../ui/EmptyState'

// One extension surface (a pane tab, a door, a settings section), drawn in a
// sandboxed frame of its own: `allow-scripts` and nothing else, so its code
// runs in an opaque origin with no reach into this window. Its document comes
// from the window's Studio (`extension.frame`); a desktop window stages it
// with its shell (`studio-ext://frame/<hash>`), a browser tab loads it from
// its Studio's own path (`ext-frame/<hash>`). The frame's host calls go
// through the bridge (extension-frame-host.ts) to that Studio, which checks
// each as the extension and as this window's connection.

type ExtensionSurfaceMountProps = {
  extensionKey: string
  point: ExtensionSurfacePoint
  id: string
  /** The workspace a panel was opened in. */
  workspaceId?: string
  className?: string
}

const DRAW_FAILED = 'The extension could not draw this.'
const LEFT_ITS_DOCUMENT = 'It tried to load another page in its place, so Studio closed it.'

const now = () => performance.timeOrigin + performance.now()

export function ExtensionSurfaceMount({
  extensionKey,
  point,
  id,
  workspaceId,
  className,
}: ExtensionSurfaceMountProps): ReactElement {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  // What the frame's `load` does: set by the effect for the frame it opened.
  const onFrameLoad = useRef<() => void>(() => undefined)
  const [src, setSrc] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // Re-read when the set changes: a surface whose extension was uninstalled
  // or lost its approval is gone, and its frame with it.
  useSyncExternalStore(subscribeExtensionSurfaces, extensionSurfacesVersion, extensionSurfacesVersion)
  const loaded = getExtensionSurface(extensionKey, point, id)

  useEffect(() => {
    if (!loaded) return
    const openedAt = now()
    let closed = false
    let readyAt: number | null = null
    let paintAt: number | null = null
    setSrc(null)
    setFailure(null)
    const fail = (error: unknown) => {
      if (!closed) setFailure(sanitizeEntryMessage(error instanceof Error ? error.message : String(error), DRAW_FAILED))
    }
    const host = loaded.host
    // A frame loads its document once. A second load is the frame leaving it
    // (`location.href`, a refresh), which the window cannot see into: the
    // page now there would inherit the bridge. Studio closes the surface.
    let loads = 0
    onFrameLoad.current = () => {
      loads += 1
      if (loads < 2 || closed) return
      bridge.dispose()
      fail(new Error(LEFT_ITS_DOCUMENT))
    }
    const bridge = createExtensionFrameHost({
      source: () => frameRef.current?.contentWindow ?? null,
      post: (message) => frameRef.current?.contentWindow?.postMessage(message, '*'),
      ...(workspaceId ? { workspaceId } : {}),
      call: (method, params) => extensionsApi.extensionCall({ moduleId: extensionKey, method, params }),
      client: {
        toast: (params) => {
          host.toast({
            tone: params.tone as never,
            message: String(params.message ?? ''),
            ...(typeof params.detail === 'string' ? { detail: params.detail } : {}),
          })
        },
        chatDraft: (params) =>
          host.openChat({
            workspaceId: String(params.workspaceId ?? ''),
            prompt: String(params.prompt ?? ''),
            ...(typeof params.name === 'string' ? { name: params.name } : {}),
          }),
        openDoor: (door) => host.openGlobalSurface(extensionSurfaceId(extensionKey, door)),
        focusTab: (input) => host.focusTab(input),
      },
      theme: () => readWindowFrameTheme(THEME_TOKENS),
      onReady: (at) => {
        if (readyAt !== null) return
        readyAt = at
        recordReadiness({
          key: extensionKey,
          point,
          id,
          ms: Math.max(0, at - openedAt),
          ...(paintAt !== null ? { paintMs: Math.max(0, paintAt - openedAt) } : {}),
        })
      },
      onPaint: (at) => {
        paintAt ??= at
      },
      onFailed: fail,
    })
    const receive = (event: MessageEvent) => bridge.receive(event)
    window.addEventListener('message', receive)
    // The window's theme moves with attributes on <html>: send the frame the new one.
    const themes = new MutationObserver(() => bridge.sendTheme())
    themes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-mode', 'class'],
    })
    const stopEvents = extensionsApi.onExtensionEvents(extensionKey, (event) => bridge.push(event.topic, event.payload))
    const theme = document.documentElement.getAttribute('data-theme') ?? undefined
    void extensionsApi
      .extensionFrame({ moduleId: extensionKey, point, id, ...(theme ? { theme } : {}) })
      .then(async (document) => {
        const stage = window.api?.stageExtensionFrame
        if (stage) {
          if (!(await stage(document.hash, document.html))) throw new Error('This window could not hold the frame.')
          return desktopExtensionFrameUrl(document.hash)
        }
        // Relative to the page, as the tab reaches its Studio (web/webLocation.ts).
        return new URL(`.${EXTENSION_FRAME_PATH_PREFIX}${document.hash}`, window.location.href).toString()
      })
      .then((url) => {
        if (!closed) setSrc(url)
      }, fail)
    return () => {
      closed = true
      bridge.dispose()
      window.removeEventListener('message', receive)
      themes.disconnect()
      stopEvents()
    }
  }, [loaded, extensionKey, point, id, workspaceId])

  if (!loaded) {
    return (
      <EmptyState
        title="This extension is not available here"
        body="It is off, not approved yet, or not installed on the Studio this window is connected to."
      />
    )
  }
  return (
    <div className={['relative h-full min-h-0 w-full', className ?? ''].join(' ')}>
      {failure ? <EmptyState title={DRAW_FAILED} body={failure} /> : null}
      {src && !failure ? (
        <iframe
          ref={frameRef}
          src={src}
          onLoad={() => onFrameLoad.current()}
          sandbox="allow-scripts"
          title={loaded.contribution.title}
          data-extension={extensionKey}
          data-extension-surface={`${point}/${id}`}
          className="block h-full w-full border-0"
        />
      ) : null}
    </div>
  )
}
