import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'

import { THEME_TOKENS } from '../../../../../packages/extension-sdk/src/index'
import { desktopExtensionFrameUrl, EXTENSION_FRAME_HOST_PATH_PREFIX } from '../../../../shared/extension-frames'
import { extensionSurfaceId } from '../../../../shared/modules/extension-ids'
import type { ExtensionSurfacePoint } from '../../../../shared/modules/third-party-manifest'
import { sanitizeEntryMessage } from '../../../../shared/modules/entry-messages'
import {
  createExtensionFrameHost,
  readWindowFrameTheme,
  type ExtensionFrameDocumentChannel,
} from '../../modules/extension-frame-host'
import type { StudioExtensionCallAnswer } from '../../../../../packages/studio-protocol/src/public'
import {
  extensionSurfacesVersion,
  getExtensionSurface,
  recordReadiness,
  subscribeExtensionSurfaces,
} from '../../modules/extension-surfaces'
import { extensionsApi } from '../../studio/extensions'
import { EmptyState } from '../ui/EmptyState'

// One extension surface (a pane tab, a door, a settings section, a custom editor), drawn in a
// sandboxed frame of its own: `allow-scripts` and nothing else, so its code
// runs in an opaque origin with no reach into this window. Its document comes
// from the window's Studio (`extension.frame`); a desktop window stages it
// with its shell (`studio-ext://frame/<hash>`), a browser tab loads it inside
// Studio's wrapper document (`ext-frame-host/<hash>`), whose policy admits
// that one document and nothing else, so the frame cannot navigate anywhere. The frame's host calls go
// through the bridge (extension-frame-host.ts) to that Studio, which checks
// each as the extension and as this window's connection.

/** What a custom editor's session reaches once its frame's document is built. */
export type ExtensionEditorPort = {
  /** A host call as this frame's (`extension.call`, naming its document): `files.read` and `files.write`. */
  call(method: string, params: unknown): Promise<StudioExtensionCallAnswer>
  sendDocument(document: unknown): void
  requestFlush(id: number): void
}

/** A custom editor's link to the window's document session (ExtensionEditorView). */
export type ExtensionEditorLink = {
  document: ExtensionFrameDocumentChannel
  /** The frame's document is built: the session reads, saves and reaches the frame through `port`. */
  open(port: ExtensionEditorPort): void
  /** The frame is listening for its document. */
  frameReady(): void
  /** The frame closed, or is about to be drawn again. */
  close(): void
}

type ExtensionSurfaceMountProps = {
  extensionKey: string
  point: ExtensionSurfacePoint
  id: string
  /** The workspace a panel or custom editor was opened in. */
  workspaceId?: string
  /** A custom editor's document session. */
  editor?: ExtensionEditorLink
  className?: string
  /** Drawn under the frame's title for assistive tech: a custom editor names its file. */
  title?: string
}

const DRAW_FAILED = 'The extension could not draw this.'
const LEFT_ITS_DOCUMENT = 'It tried to load another page in its place, so Studio closed it.'

const now = () => performance.timeOrigin + performance.now()

export function ExtensionSurfaceMount({
  extensionKey,
  point,
  id,
  workspaceId,
  editor,
  className,
  title,
}: ExtensionSurfaceMountProps): ReactElement {
  // Read when the frame opens, not a reason to open it again.
  const editorRef = useRef(editor)
  editorRef.current = editor
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  // What the frame's `load` does: set by the effect for the frame it opened.
  const onFrameLoad = useRef<() => void>(() => undefined)
  // `wrapped`: a browser tab's frame sits in Studio's wrapper document
  // (`/ext-frame-host/<hash>`), whose policy lets the frame load its own
  // document and nothing else. The extension's window is the wrapper's child.
  const [src, setSrc] = useState<{ url: string; wrapped: boolean } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // Bumped to draw the surface again: its document was built before the
  // extension's access grew (`frame_outdated`).
  const [generation, setGeneration] = useState(0)
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
    // A frame leaves its document only to go nowhere: the desktop shell and a
    // tab's wrapper refuse the navigation before any request leaves. Should
    // one still unload it, the bootstrap says so first (`leaving`), and a
    // second load of its document is the backstop: the page now there would
    // inherit the bridge, so Studio closes the surface.
    const left = () => {
      if (closed) return
      bridge.dispose()
      fail(new Error(LEFT_ITS_DOCUMENT))
    }
    let loads = 0
    const documentLoaded = () => {
      loads += 1
      if (loads >= 2) left()
    }
    let wrapped = false
    onFrameLoad.current = () => {
      if (!wrapped) return documentLoaded()
      // The wrapper's own load waits for the frame inside it, which has loaded once.
      const inner = frameRef.current?.contentDocument?.querySelector('iframe')
      if (!inner) return left()
      documentLoaded()
      inner.addEventListener('load', documentLoaded)
    }
    const surfaceWindow = (): Window | null => {
      const outer = frameRef.current?.contentWindow ?? null
      return wrapped ? ((outer?.frames[0] as Window | undefined) ?? null) : outer
    }
    let frameHash = ''
    const call = async (method: string, params: unknown): Promise<StudioExtensionCallAnswer> => {
      const answer = await extensionsApi.extensionCall({ moduleId: extensionKey, frame: frameHash, method, params })
      if (answer.ok || answer.code !== 'frame_outdated') return answer
      // Drawn before the extension's access grew: draw it again from the extension as it is now.
      if (!closed) setGeneration((value) => value + 1)
      return { ok: false, code: 'unavailable', message: answer.message }
    }
    const link = editorRef.current
    const bridge = createExtensionFrameHost({
      source: surfaceWindow,
      post: (message) => surfaceWindow()?.postMessage(message, '*'),
      ...(workspaceId ? { workspaceId } : {}),
      ...(link ? { document: link.document, onFrameReady: () => link.frameReady() } : {}),
      call,
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
      onLeaving: left,
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
        frameHash = document.hash
        if (!closed)
          link?.open({
            call,
            sendDocument: (next) => bridge.sendDocument(next),
            requestFlush: (flush) => bridge.requestFlush(flush),
          })
        const stage = window.api?.stageExtensionFrame
        if (stage) {
          if (!(await stage(document.hash, document.html))) throw new Error('This window could not hold the frame.')
          return { url: desktopExtensionFrameUrl(document.hash), wrapped: false }
        }
        // Relative to the page, as the tab reaches its Studio (web/webLocation.ts).
        wrapped = true
        return {
          url: new URL(`.${EXTENSION_FRAME_HOST_PATH_PREFIX}${document.hash}`, window.location.href).toString(),
          wrapped: true,
        }
      })
      .then((next) => {
        if (!closed) setSrc(next)
      }, fail)
    return () => {
      closed = true
      link?.close()
      bridge.dispose()
      window.removeEventListener('message', receive)
      themes.disconnect()
      stopEvents()
    }
  }, [loaded, extensionKey, point, id, workspaceId, generation])

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
          key={src.url}
          ref={frameRef}
          src={src.url}
          onLoad={() => onFrameLoad.current()}
          // The wrapper is Studio's own document, which runs no script (its
          // policy); the extension's frame inside it carries the sandbox.
          {...(src.wrapped ? {} : { sandbox: 'allow-scripts' })}
          title={title ?? loaded.contribution.title}
          data-extension={extensionKey}
          data-extension-surface={`${point}/${id}`}
          className="block h-full w-full border-0"
        />
      ) : null}
    </div>
  )
}
