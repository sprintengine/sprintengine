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
import type { ExtensionEditorPort } from '../../modules/extension-editor-controller'
import {
  extensionSurfacesVersion,
  getExtensionSurface,
  recordReadiness,
  subscribeExtensionSurfaces,
} from '../../modules/extension-surfaces'
import { extensionsApi } from '../../studio/extensions'
import { followEditorTypography } from '../../modules/extension-editor-typography'
import { EmptyState } from '../ui/EmptyState'
import { useOptionalConfirmDialog } from '../ui/ConfirmDialog'
import { ComponentsPanelHost } from './components/ComponentsPanelHost'
import {
  createComponentsPanelSession,
  forgetRetainedPanel,
  retainedPanel,
  type ComponentsPanelSession,
} from './components/componentsPanelSession'

// One extension surface (a pane tab, a door, a settings section, a custom editor), drawn in a
// sandboxed frame of its own: `allow-scripts` and nothing else, so its code
// runs in an opaque origin with no reach into this window. Its document comes
// from the window's Studio (`extension.frame`); a desktop window stages it
// with its shell (`studio-ext://frame/<hash>`), a browser tab loads it inside
// Studio's wrapper document (`ext-frame-host/<hash>`), whose policy admits
// that one document and nothing else, so the frame cannot navigate anywhere. The frame's host calls go
// through the bridge (extension-frame-host.ts) to that Studio, which checks
// each as the extension and as this window's connection.

/** A custom editor's link to the window's document session (extension-editor-controller.ts). */
export type ExtensionEditorLink = {
  document: ExtensionFrameDocumentChannel
  /** The frame's document is built: the session reads, saves and reaches the frame through `port`. */
  open(port: ExtensionEditorPort): void
  /** The frame is listening for its document. */
  frameReady(): void
  /** The frame closed, or is about to be drawn again. */
  close(): void
  /** True when the frame may be drawn again now: it handed over what it held. */
  beforeRedraw(): Promise<boolean>
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

// Web addresses the person let an extension open without asking again, for this window's session.
const allowedHosts = new Map<string, Set<string>>()
const MAX_IMAGE_SIDE = 4096

/** One of the extension's own images as a `data:` URL, or null when it is not one Studio shows. */
async function readOwnImage(extensionKey: string, frame: string, src: string): Promise<string | null> {
  const answer = await extensionsApi.extensionCall({
    moduleId: extensionKey,
    frame,
    method: 'assets.image',
    params: { path: src },
  })
  const image = answer.ok ? (answer.result as { mime?: unknown; data?: unknown } | null) : null
  if (!image || typeof image.mime !== 'string' || typeof image.data !== 'string') return null
  const url = `data:${image.mime};base64,${image.data}`
  // At most 4096 pixels a side, as Studio decodes it.
  return new Promise((resolve) => {
    const probe = new Image()
    probe.onload = () =>
      resolve(probe.naturalWidth <= MAX_IMAGE_SIDE && probe.naturalHeight <= MAX_IMAGE_SIDE ? url : null)
    probe.onerror = () => resolve(null)
    probe.src = url
  })
}

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
  // A components panel: its frame runs hidden, and the window draws its tree.
  const components = point === 'panels' && loaded?.contribution.ui === 'components'
  const [session, setSession] = useState<ComponentsPanelSession | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const dialogs = useOptionalConfirmDialog()
  const dialogsRef = useRef(dialogs)
  dialogsRef.current = dialogs
  const frameHashRef = useRef('')
  const openLinkRef = useRef<(href: string) => void>(() => undefined)
  const retainKey = `${extensionKey}/${point}/${id}/${workspaceId ?? ''}`
  const retainKeyRef = useRef(retainKey)
  retainKeyRef.current = retainKey
  // The tab closed: what a development folder's saves carry over goes with it.
  useEffect(() => () => forgetRetainedPanel(retainKeyRef.current), [])

  useEffect(() => {
    if (!loaded) return
    const openedAt = now()
    let closed = false
    let readyAt: number | null = null
    let paintAt: number | null = null
    setSrc(null)
    setFailure(null)
    const extensionName = loaded.extension?.name ?? extensionKey
    // Open a URL a components panel earned with a press: a web address asks first.
    const openExternal = async (url: string): Promise<boolean> => {
      if (/^mailto:/iu.test(url)) {
        window.open(url, '_blank', 'noopener,noreferrer')
        return true
      }
      let target: URL
      try {
        target = new URL(url)
      } catch {
        return false
      }
      const allowed = allowedHosts.get(extensionKey)
      if (!allowed?.has(target.host)) {
        const dialog = dialogsRef.current
        if (!dialog) return false
        const choice = await dialog.choose({
          title: `${extensionName} wants to open ${target.host}`,
          body: url.length > 300 ? `${url.slice(0, 300)}…` : url,
          confirmLabel: 'Open',
          alternateLabel: `Always allow ${target.host}`,
          cancelLabel: 'Cancel',
        })
        if (choice === 'cancel') return false
        if (choice === 'alternate') {
          let hosts = allowedHosts.get(extensionKey)
          if (!hosts) allowedHosts.set(extensionKey, (hosts = new Set()))
          hosts.add(target.host)
        }
      }
      const opened = await host.openExternal(url)
      return opened.ok
    }
    let componentsSession: ComponentsPanelSession | null = null
    if (components) {
      componentsSession = createComponentsPanelSession({
        send: (event, payload) => bridge.sendComponents(event, payload),
        retained: retainedPanel(retainKeyRef.current),
        development: loaded.development === true,
        visible: true,
        warn: (message) => console.warn(`[extensions] ${extensionKey} panel ${id}: ${message}`),
      })
      setSession(componentsSession)
    } else setSession(null)
    const fail = (error: unknown) => {
      if (closed) return
      const message = sanitizeEntryMessage(error instanceof Error ? error.message : String(error), DRAW_FAILED)
      // A components panel keeps its last tree, inert, with the error over it.
      if (componentsSession) return componentsSession.failed(message)
      setFailure(message)
      // A custom editor stops waiting on a frame that failed: leaving it, or
      // saving, never hangs on a flush nobody will answer.
      editorRef.current?.close()
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
    const openLink = (href: string) => void openExternal(href)
    openLinkRef.current = openLink
    const call = async (method: string, params: unknown): Promise<StudioExtensionCallAnswer> => {
      const answer = await extensionsApi.extensionCall({ moduleId: extensionKey, frame: frameHash, method, params })
      if (answer.ok || answer.code !== 'frame_outdated') return answer
      // Drawn before the extension's access grew: draw it again from the
      // extension as it is now, once a custom editor handed over its edits.
      if (!closed && (!link || (await link.beforeRedraw()))) {
        if (!closed) setGeneration((value) => value + 1)
      }
      return { ok: false, code: 'unavailable', message: answer.message }
    }
    const link = editorRef.current
    const bridge = createExtensionFrameHost({
      source: surfaceWindow,
      post: (message) => surfaceWindow()?.postMessage(message, '*'),
      ...(workspaceId ? { workspaceId } : {}),
      ...(link ? { document: link.document, onFrameReady: () => link.frameReady() } : {}),
      ...(componentsSession ? { components: componentsSession } : {}),
      clientKind: window.api?.stageExtensionFrame ? 'desktop' : 'web',
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
        // The editor's typography is this window's own; the rest are its Studio's.
        followStudioEvent: (event, deliver) =>
          event === 'editor.typography.changed'
            ? followEditorTypography(deliver)
            : extensionsApi.onStudioEvents(extensionKey, event, deliver),
        openExternal,
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
        frameHashRef.current = document.hash
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
    // Whether the person can see the panel, for its `ctx.visible`.
    const seen =
      componentsSession && containerRef.current && typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            const entry = entries[entries.length - 1]
            if (entry) componentsSession?.setVisible(entry.isIntersecting)
          })
        : null
    if (seen && containerRef.current) seen.observe(containerRef.current)
    return () => {
      closed = true
      seen?.disconnect()
      link?.close()
      bridge.dispose()
      window.removeEventListener('message', receive)
      themes.disconnect()
      stopEvents()
    }
  }, [loaded, extensionKey, point, id, workspaceId, generation, components])

  if (!loaded) {
    return (
      <EmptyState
        title="This extension is not available here"
        body="It is off, not approved yet, or not installed on the Studio this window is connected to."
      />
    )
  }
  return (
    <div ref={containerRef} className={['relative h-full min-h-0 w-full', className ?? ''].join(' ')}>
      {failure ? <EmptyState title={DRAW_FAILED} body={failure} /> : null}
      {components && session && !failure ? (
        <ComponentsPanelHost
          session={session}
          extensionName={loaded.extension?.name ?? extensionKey}
          openLink={(href) => openLinkRef.current(href)}
          readImage={(source) => readOwnImage(extensionKey, frameHashRef.current, source)}
          locale={navigator.language}
        />
      ) : null}
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
          // A components panel's frame runs its module and shows nothing: Studio draws its tree.
          {...(components ? { 'aria-hidden': true, tabIndex: -1 } : {})}
          className={
            components
              ? 'pointer-events-none absolute left-0 top-0 h-px w-px border-0 opacity-0'
              : 'block h-full w-full border-0'
          }
        />
      ) : null}
    </div>
  )
}
