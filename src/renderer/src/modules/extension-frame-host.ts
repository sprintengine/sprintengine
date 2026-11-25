// The window's side of one extension frame's bridge. The frame speaks the
// envelope (`{ se: 1, kind, … }`, shared/extension-frames.ts) over
// postMessage; this hears only the frame's own window, holds every message to
// the frame's budget, and:
//
// - answers `ready` with `hello`: the theme and the workspace a panel was
//   opened in, after which the bootstrap mounts the extension's entry;
// - passes each host call to the window's Studio (`extension.call`), where the
//   host's gate checks it as the extension and as this window's connection;
//   a client method the Studio admitted (a toast, a drafted chat, opening a
//   door) is then carried out here;
// - sends the theme again when the window's changes, and the extension's
//   worker events as `push`;
// - reports when the surface said it was ready, and its first paint;
// - keeps a components panel's timers (`timer`, answered with `wake`): its
//   frame is not drawn, and the browser runs an undrawn frame's own timers
//   about once a second;
// - gives a components panel's persisted writes (`atoms.write`) a lane of
//   their own, bigger than a call's.
//
// The frame is told apart by its window object alone, never by anything it
// says about itself.

import { extensionFrameMethod } from '../../../../packages/extension-sdk/src/services'
import type { StudioExtensionCallAnswer } from '../../../../packages/studio-protocol/src/public'
import { EXTENSION_EDITOR_TEXT_MAX_BYTES } from '../../../../packages/extension-sdk/src/custom-editors'
import {
  COMPONENT_ATOMS_LANE,
  COMPONENT_LANE_RETRY_MS,
  COMPONENT_MESSAGES,
  COMPONENT_RENDER_LANE,
} from '../../../../packages/extension-sdk/src/components/messages'
import {
  COMPONENT_FRAME_MAX_TIMERS,
  EXTENSION_EDITOR_APPLY_EDIT,
  EXTENSION_FRAME_EVENTS,
  EXTENSION_FRAME_PROTOCOL,
  createExtensionFrameBudget,
  extensionFrameMessageBytes,
  type ExtensionFrameTheme,
} from '../../../shared/extension-frames'

/** What a client method does in this window, once the Studio admitted it. */
export type ExtensionFrameClient = {
  toast(params: Record<string, unknown>): void
  chatDraft(params: Record<string, unknown>): Promise<unknown>
  openDoor(id: string): boolean
  focusTab(input: { workspaceId: string; kind: 'chat' | 'file'; id: string }): boolean
  /**
   * Follow one of Studio's events for the frame, once the Studio admitted it:
   * its Studio's stream, held there to the extension and this window's grant,
   * or the window's own (the editor's typography). Returns the stop.
   */
  followStudioEvent(event: string, deliver: (payload: unknown) => void): () => void
  /**
   * Open a URL in this machine's system browser, asking the person first for
   * a web address; resolves whether it opened. Reached only by a components
   * panel's gesture (`shell.openExternal`).
   */
  openExternal(url: string): Promise<boolean>
}

/**
 * A components panel's side of the bridge: its runtime's `ui.*` events, and
 * the gestures a press on one of Studio's own controls grants it.
 */
export type ExtensionFrameComponentsChannel = {
  /**
   * One `ui.*` event from the guest. `refused` says the render lane refused
   * it (too large, or too many), so the host answers that render as refused.
   */
  receive(event: string, payload: unknown, refused?: 'too_large' | 'rate_limited'): void
  /** Spend the one gesture a recent press on a still control granted; false when there is none. */
  takeGesture(): boolean
}

/**
 * A custom editor's document, kept by the window (extension-editor-session.ts):
 * the frame's edits are answered here and never reach the Studio.
 */
export type ExtensionFrameDocumentChannel = {
  applyEdit(params: unknown): { ok: true } | { ok: false; code: string; message: string; document?: unknown }
  /** The frame answered a flush. */
  flushed(id: number, ok: boolean): void
  /** The person pressed Cmd/Ctrl+S inside the frame. */
  save(): void
}

export type ExtensionFrameHostOptions = {
  /** The frame's window: a message from any other source is not the frame's. */
  source: () => MessageEventSource | null
  /** Post to the frame. */
  post: (message: unknown) => void
  /** The workspace a panel or custom editor was opened in. */
  workspaceId?: string
  /** A custom editor's document; absent for every other surface. */
  document?: ExtensionFrameDocumentChannel
  /** A components panel's runtime; absent for every surface that draws itself. */
  components?: ExtensionFrameComponentsChannel
  /** Studio's language, handed to the frame with `hello`. Default: the window's. */
  locale?: () => string
  /** Which client this window is: a desktop window (local or paired) or the web client. */
  clientKind?: 'desktop' | 'web'
  /** The frame's bootstrap is listening and was sent `hello`: a custom editor is handed its document now. */
  onFrameReady?: () => void
  call: (method: string, params: unknown) => Promise<StudioExtensionCallAnswer>
  client: ExtensionFrameClient
  theme: () => ExtensionFrameTheme
  onReady: (atEpochMs: number) => void
  onPaint: (atEpochMs: number) => void
  onFailed: (message: string) => void
  /** The frame's document is unloading: whatever loads next must not inherit the bridge. */
  onLeaving?: () => void
  now?: () => number
}

export type ExtensionFrameHost = {
  receive(event: MessageEvent): void
  /** Hand a custom editor its document. */
  sendDocument(document: unknown): void
  /** Ask a custom editor to hand over what it holds back before a save. */
  requestFlush(id: number): void
  /** Send a components panel's runtime one of its `ui.*` events. */
  sendComponents(event: string, payload: unknown): void
  sendTheme(): void
  push(topic: string, payload?: unknown): void
  dispose(): void
  /**
   * The surface closed: stop at once, but for up to `graceMs` still pass on
   * the writes (`atoms.write`, `storage.set`, `ui.retain`) its unloading
   * document sends, until it says it is leaving. Resolves once it stopped
   * listening for good.
   */
  close(graceMs: number): Promise<void>
}

/** The calls a closed surface's unloading document may still make: its last writes. */
const CLOSING_METHODS = new Set(['atoms.write', 'storage.set'])

const RETRYABLE = new Set(['rate_limited', 'unavailable', 'timeout'])

type Envelope = {
  kind?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
  event?: unknown
  payload?: unknown
  ms?: unknown
}

export function createExtensionFrameHost(options: ExtensionFrameHostOptions): ExtensionFrameHost {
  const budget = createExtensionFrameBudget()
  // A custom editor's edits are whole documents: up to the document's size,
  // on a budget of their own so typing never starves the frame's calls.
  const editBudget = createExtensionFrameBudget({ maxBytes: EXTENSION_EDITOR_TEXT_MAX_BYTES + 4096 })
  // A components panel's trees ride a lane of their own, bigger than a call and
  // apart from it, so a busy panel never starves its own host calls.
  const renderBudget = createExtensionFrameBudget(COMPONENT_RENDER_LANE)
  // Its persisted writes ride their own, so a large atom is stored and never starves the calls.
  const atomsBudget = createExtensionFrameBudget(COMPONENT_ATOMS_LANE)
  const now = options.now ?? Date.now
  // The calls waiting for the Studio, and those of them the frame gave up on:
  // a cancel counts only for a call still waiting, and both forget an id once
  // it is answered.
  const waiting = new Set<number>()
  const cancelled = new Set<number>()
  let alive = true
  // Closed, and waiting a moment for the unloading document's last writes.
  let closing: { finish: () => void } | null = null
  // The frame's window as last heard: a closed surface's frame is no longer in the page.
  let lastSource: MessageEventSource | null = null
  // A components panel's clock: the timers its undrawn frame asked the window to keep.
  const timers = new Set<ReturnType<typeof setTimeout>>()

  const post = (message: Record<string, unknown>) => {
    if (alive) options.post({ se: EXTENSION_FRAME_PROTOCOL, ...message })
  }
  const answer = (
    id: number,
    outcome: { result: unknown } | { code: string; message: string; document?: unknown; retryAfterMs?: number },
  ) => {
    waiting.delete(id)
    if (cancelled.delete(id)) return
    if ('result' in outcome) post({ kind: 'res', id, result: outcome.result })
    else
      post({
        kind: 'res',
        id,
        error: {
          code: outcome.code,
          message: outcome.message.slice(0, 8192),
          retryable: RETRYABLE.has(outcome.code),
          ...(outcome.document === undefined ? {} : { document: outcome.document }),
          ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
        },
      })
  }

  // Studio's events the frame follows, each with its stop.
  const followed = new Map<string, () => void>()

  async function carryOut(method: string, params: unknown): Promise<unknown> {
    const given = (params ?? {}) as Record<string, unknown>
    if (method === 'toast') {
      options.client.toast(given)
      return { ok: true }
    }
    if (method === 'chat.draft') return options.client.chatDraft(given)
    if (method === 'doors.open') return { opened: typeof given.id === 'string' && options.client.openDoor(given.id) }
    if (method === 'shell.openExternal') {
      const url = typeof given.url === 'string' ? given.url : ''
      if (url.length > 2048 || !/^(https?:\/\/|mailto:)/iu.test(url))
        throw new Error('"shell.openExternal" opens an https:, http: or mailto: URL of at most 2048 characters.')
      return { opened: await options.client.openExternal(url) }
    }
    if (method === 'events.subscribe') {
      const event = given.event
      if (typeof event !== 'string') throw new Error('"events.subscribe" takes an event.')
      // Once per event: more listeners in the frame share it.
      if (!followed.has(event))
        followed.set(
          event,
          options.client.followStudioEvent(event, (payload) =>
            post({ kind: 'evt', event: EXTENSION_FRAME_EVENTS.studio, payload: { event, payload } }),
          ),
        )
      return { ok: true }
    }
    if (method === 'tabs.focus') {
      const { workspaceId, kind, id } = given
      if (typeof workspaceId !== 'string' || (kind !== 'chat' && kind !== 'file') || typeof id !== 'string')
        throw new Error('"tabs.focus" takes a workspaceId, a kind (chat or file) and an id.')
      return { focused: options.client.focusTab({ workspaceId, kind, id }) }
    }
    throw new Error(`"${method}" is not carried out in a window.`)
  }

  async function request(id: number, method: string, params: unknown): Promise<void> {
    // Only a press on one of Studio's own controls that stood still grants
    // this, and only a components panel has such presses: a frame drawing
    // itself shares the window's activation, which any keystroke sets.
    if (method === 'shell.openExternal' && !options.components?.takeGesture())
      return answer(id, {
        code: 'not_permitted',
        message: 'Opening a URL needs a press on one of Studio’s controls, in a components panel.',
      })
    const answered = await options.call(method, params)
    if (!answered.ok) return answer(id, { code: answered.code, message: answered.message })
    if (extensionFrameMethod(method)?.runs !== 'client') return answer(id, { result: answered.result })
    try {
      answer(id, { result: await carryOut(method, params) })
    } catch (error) {
      answer(id, { code: 'invalid_params', message: error instanceof Error ? error.message : String(error) })
    }
  }

  // Timers and followed events end with the surface; calls still waiting are answered into nothing.
  function stop(): void {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const unfollow of followed.values()) unfollow()
    followed.clear()
  }

  const epoch = (payload: unknown): number | null => {
    const at = (payload as { at?: unknown } | null)?.at
    return typeof at === 'number' && Number.isFinite(at) ? at : null
  }

  return {
    receive(event) {
      if (!alive || event.source === null) return
      const source = options.source() ?? (closing ? lastSource : null)
      if (event.source !== source) return
      lastSource = source
      const message = event.data as Envelope & { se?: unknown }
      if (!message || typeof message !== 'object' || message.se !== EXTENSION_FRAME_PROTOCOL) return
      const id = Number.isSafeInteger(message.id) ? (message.id as number) : null
      if (closing) {
        const write =
          message.kind === 'req' && typeof message.method === 'string' && CLOSING_METHODS.has(message.method)
        const retained = message.kind === 'evt' && message.event === COMPONENT_MESSAGES.retain
        const leaving = message.kind === 'evt' && message.event === EXTENSION_FRAME_EVENTS.leaving
        if (leaving) return closing.finish()
        if (!write && !retained) return
      }
      const edit = message.kind === 'req' && message.method === EXTENSION_EDITOR_APPLY_EDIT
      if (
        options.components &&
        message.kind === 'evt' &&
        typeof message.event === 'string' &&
        message.event.startsWith('ui.')
      ) {
        const lane = renderBudget.admit(
          now(),
          extensionFrameMessageBytes(message, COMPONENT_RENDER_LANE.maxBytes, COMPONENT_RENDER_LANE),
        )
        options.components.receive(message.event, message.payload, lane ?? undefined)
        return
      }
      if (options.components && message.kind === 'timer') {
        const ms = message.ms
        if (id === null || id % 2 !== 1 || typeof ms !== 'number' || !(ms >= 0 && ms < 2 ** 31)) return
        if (timers.size >= COMPONENT_FRAME_MAX_TIMERS) return
        const timer = setTimeout(() => {
          timers.delete(timer)
          post({ kind: 'wake', id })
        }, ms)
        timers.add(timer)
        return
      }
      const atoms = Boolean(options.components) && message.kind === 'req' && message.method === 'atoms.write'
      const refused = edit
        ? editBudget.admit(now(), extensionFrameMessageBytes(message, EXTENSION_EDITOR_TEXT_MAX_BYTES + 4096))
        : atoms
          ? atomsBudget.admit(
              now(),
              extensionFrameMessageBytes(message, COMPONENT_ATOMS_LANE.maxBytes, COMPONENT_ATOMS_LANE),
            )
          : budget.admit(now(), extensionFrameMessageBytes(message))
      if (refused) {
        if (message.kind === 'req' && id !== null)
          answer(id, {
            code: refused,
            message:
              refused === 'too_large'
                ? edit
                  ? 'A document is at most 1 MiB of text or 768 KiB of bytes.'
                  : atoms
                    ? `A persisted write is at most ${COMPONENT_ATOMS_LANE.maxBytes / 1024} KiB.`
                    : 'A message from a frame is at most 64 KiB.'
                : 'This frame sent too many messages; try again shortly.',
            ...(refused === 'rate_limited' && atoms ? { retryAfterMs: COMPONENT_LANE_RETRY_MS } : {}),
          })
        return
      }
      if (edit && id !== null) {
        // Answered by the window's document session alone, at once.
        const answered = options.document
          ? options.document.applyEdit(message.params)
          : { ok: false as const, code: 'unknown_method', message: 'Only a custom editor has a document.' }
        answer(id, answered.ok ? { result: null } : answered)
      } else if (message.kind === 'req' && id !== null && typeof message.method === 'string') {
        waiting.add(id)
        void request(id, message.method, message.params).catch((error: unknown) =>
          answer(id, { code: 'unavailable', message: error instanceof Error ? error.message : String(error) }),
        )
      } else if (message.kind === 'cancel' && id !== null) {
        if (waiting.has(id)) cancelled.add(id)
      } else if (message.kind === 'evt') {
        if (message.event === EXTENSION_FRAME_EVENTS.ready) {
          post({
            kind: 'evt',
            event: EXTENSION_FRAME_EVENTS.hello,
            payload: {
              theme: options.theme(),
              locale: options.locale?.() ?? navigator.language,
              client: options.clientKind ?? 'desktop',
              ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
            },
          })
          options.onFrameReady?.()
        } else if (message.event === EXTENSION_FRAME_EVENTS.surfaceReady) {
          const at = epoch(message.payload)
          if (at !== null) options.onReady(at)
        } else if (message.event === EXTENSION_FRAME_EVENTS.paint) {
          const at = epoch(message.payload)
          if (at !== null) options.onPaint(at)
        } else if (message.event === EXTENSION_FRAME_EVENTS.documentFlushed) {
          const flushed = message.payload as { id?: unknown; ok?: unknown } | null
          if (typeof flushed?.id === 'number') options.document?.flushed(flushed.id, flushed.ok === true)
        } else if (message.event === EXTENSION_FRAME_EVENTS.documentSave) {
          options.document?.save()
        } else if (message.event === EXTENSION_FRAME_EVENTS.leaving) {
          alive = false
          for (const timer of timers) clearTimeout(timer)
          timers.clear()
          options.onLeaving?.()
        } else if (message.event === EXTENSION_FRAME_EVENTS.failed) {
          const words = (message.payload as { message?: unknown } | null)?.message
          options.onFailed(typeof words === 'string' ? words.slice(0, 500) : 'The extension could not draw this.')
        }
      }
    },
    sendDocument(document) {
      post({ kind: 'evt', event: EXTENSION_FRAME_EVENTS.document, payload: document })
    },
    requestFlush(id) {
      post({ kind: 'evt', event: EXTENSION_FRAME_EVENTS.documentFlush, payload: { id } })
    },
    sendComponents(event, payload) {
      post({ kind: 'evt', event, payload })
    },
    sendTheme() {
      post({ kind: 'evt', event: EXTENSION_FRAME_EVENTS.theme, payload: options.theme() })
    },
    push(topic, payload) {
      post({
        kind: 'evt',
        event: EXTENSION_FRAME_EVENTS.push,
        payload: payload === undefined ? { topic } : { topic, payload },
      })
    },
    dispose() {
      alive = false
      closing?.finish()
      stop()
    },
    close(graceMs) {
      if (!alive || closing) return Promise.resolve()
      stop()
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => closing?.finish(), Math.max(0, graceMs))
        closing = {
          finish: () => {
            clearTimeout(timer)
            closing = null
            alive = false
            resolve()
          },
        }
      })
    },
  }
}

/** The window's theme as a frame is drawn in it: light or dark, and each token's value now. */
export function readWindowFrameTheme(
  tokens: readonly string[],
  root: HTMLElement = document.documentElement,
): ExtensionFrameTheme {
  const style = getComputedStyle(root)
  const values: Record<string, string> = {}
  for (const token of tokens) {
    const value = style.getPropertyValue(token).trim()
    if (value) values[token] = value
  }
  return { colorScheme: root.getAttribute('data-mode') === 'light' ? 'light' : 'dark', tokens: values }
}
