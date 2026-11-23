import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { BrowserWindow, session as electronSession, type Session } from 'electron'

import type { StudioClient } from '../../../packages/client-runtime/src/public'
import type { StudioExtensionCallAnswer } from '../../../packages/studio-protocol/src/public'
import { EXTENSION_FRAME_EVENTS, EXTENSION_FRAME_PROTOCOL } from '../../shared/extension-frames'
import { isRecord } from '../../shared/modules/mcp-tools'
import { refusesFrameNavigation } from '../privileged-window-navigation'

// `visual.extension_shot`: a picture of one of an extension's surfaces (a
// panel, a door, a settings section) as Studio draws it, for its author and
// their agent to look at (`sprintengine-extension shot`, `dev watch --shot`).
//
// The surface's own frame document, the one every client draws
// (`extension.frame`), is loaded in a hidden window of this app, sealed as
// the visual preview's is: no Node, no preload, a session of its own that
// refuses every request but the document and the blobs its modules load from,
// no pop-ups, no navigation, offscreen and destroyed after the capture. Its
// host calls reach the Studio as this desktop's shell (`extension.call`), so
// it shows what the extension reads now; a call the window itself would carry
// out (a toast, a drafted chat) is answered without doing it. The capture
// waits for the surface to say it is ready (`studio.ready()`) and its calls
// to be answered, at most `settleMs`.

const PARTITION = 'extension-shot'
const MAX_DOCUMENT_BYTES = 1.5 * 1024 * 1024
const DEFAULT_SETTLE_MS = 8_000
// Requests out of the frame, and answers in: console lines carrying this mark.
const OUT = '__se_shot__'

let sealedSession: Session | null = null
function shotSession(): Session {
  if (sealedSession) return sealedSession
  const session = electronSession.fromPartition(PARTITION, { cache: false })
  session.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !/^(?:data|about|blob):/iu.test(details.url) }),
  )
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
  sealedSession = session
  return session
}

/** What stands in for the window around the frame: it says hello, carries calls out and answers back. */
function hostShim(hello: { theme: { colorScheme: 'light' | 'dark' }; workspaceId?: string }): string {
  return `(function () {
  var P = ${JSON.stringify(EXTENSION_FRAME_PROTOCOL)}
  var E = ${JSON.stringify(EXTENSION_FRAME_EVENTS)}
  window.__seShotAnswer = function (message) { message.se = P; window.postMessage(message, '*') }
  window.addEventListener('message', function (event) {
    var m = event.data
    if (!m || m.se !== P) return
    if (m.kind === 'req') console.debug(${JSON.stringify(OUT)} + JSON.stringify({ t: 'req', id: m.id, method: m.method, params: m.params }))
    else if (m.kind === 'evt' && m.event !== E.hello && m.event !== E.theme && m.event !== E.push)
      console.debug(${JSON.stringify(OUT)} + JSON.stringify({ t: 'evt', event: m.event, payload: m.payload }))
  })
  window.postMessage({ se: P, kind: 'evt', event: E.hello, payload: ${JSON.stringify(hello)} }, '*')
})()`
}

export type ExtensionShotDeps = {
  /** The desktop shell's connection to its Studio, once it has one. */
  client: () => StudioClient | null
}

import type { ExtensionShotInput, ExtensionShotResult } from '../automation/extension-shot-tool'

function commandId(): string {
  return `extension-shot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export async function shootExtensionSurface(
  deps: ExtensionShotDeps,
  input: ExtensionShotInput,
): Promise<ExtensionShotResult> {
  const client = deps.client()
  if (!client) throw new Error('This desktop is not connected to its Studio yet; try again in a moment.')
  const document = await client.request('extension.frame', {
    moduleId: input.moduleId,
    point: input.point,
    id: input.id,
    theme: input.theme,
  })
  if (Buffer.byteLength(document.html, 'utf8') > MAX_DOCUMENT_BYTES)
    throw new Error('The surface’s document is too large to picture here (over 1.5 MiB).')
  const window = new BrowserWindow({
    show: false,
    width: input.width,
    height: input.height,
    useContentSize: true,
    paintWhenInitiallyHidden: true,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      javascript: true,
      session: shotSession(),
      backgroundThrottling: false,
      spellcheck: false,
    },
  })
  const contents = window.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.on('will-frame-navigate', (details) => {
    if (refusesFrameNavigation(details)) details.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setAudioMuted(true)
  const errors: string[] = []
  let pending = 0
  let ready = false
  let settledAt = 0
  const answer = (message: Record<string, unknown>) => {
    if (window.isDestroyed()) return
    void contents.executeJavaScript(`window.__seShotAnswer(${JSON.stringify(message)})`, false).catch(() => undefined)
  }
  const call = async (id: number, method: string, params: unknown) => {
    pending += 1
    try {
      const answered: StudioExtensionCallAnswer = await client.request('extension.call', {
        moduleId: input.moduleId,
        frame: document.hash,
        method,
        params,
        commandId: commandId(),
      })
      if (method === 'log.write' && isRecord(params) && params.level !== 'info' && typeof params.message === 'string')
        errors.push(params.message)
      answer(
        answered.ok
          ? { kind: 'res', id, result: answered.result ?? null }
          : { kind: 'res', id, error: { code: answered.code, message: answered.message } },
      )
    } catch (error) {
      answer({
        kind: 'res',
        id,
        error: { code: 'unavailable', message: error instanceof Error ? error.message : String(error) },
      })
    } finally {
      pending -= 1
      settledAt = Date.now()
    }
  }
  contents.on('console-message', (event) => {
    const text = String(event.message)
    if (!text.startsWith(OUT)) return
    let message: unknown
    try {
      message = JSON.parse(text.slice(OUT.length))
    } catch {
      return
    }
    if (!isRecord(message)) return
    if (message.t === 'req' && typeof message.id === 'number' && typeof message.method === 'string')
      void call(message.id, message.method, message.params)
    else if (message.t === 'evt' && message.event === EXTENSION_FRAME_EVENTS.surfaceReady) {
      ready = true
      settledAt = Date.now()
    } else if (message.t === 'evt' && message.event === EXTENSION_FRAME_EVENTS.failed) {
      const failure = isRecord(message.payload) ? String(message.payload.message ?? '') : ''
      if (failure && !errors.includes(failure)) errors.push(failure)
      ready = true
    }
  })
  try {
    await window.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(document.html, 'utf8').toString('base64')}`)
    await contents.executeJavaScript(
      hostShim({
        theme: { colorScheme: input.theme },
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      }),
      false,
    )
    const deadline = Date.now() + (input.settleMs ?? DEFAULT_SETTLE_MS)
    // Ready, nothing waiting, and a moment of quiet for what its answers draw.
    while (Date.now() < deadline && !(ready && pending === 0 && Date.now() - settledAt > 250))
      await new Promise((resolve) => setTimeout(resolve, 50))
    const settled = ready && pending === 0
    const image = await contents.capturePage()
    if (image.isEmpty()) throw new Error('The surface drew nothing to capture.')
    const size = image.getSize()
    mkdirSync(dirname(input.out), { recursive: true })
    writeFileSync(input.out, image.toPNG())
    return {
      path: input.out,
      width: size.width,
      height: size.height,
      theme: input.theme,
      settled,
      pendingRequests: pending,
      errors,
    }
  } finally {
    if (!window.isDestroyed()) window.destroy()
  }
}
