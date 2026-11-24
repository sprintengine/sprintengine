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
// - reports when the surface said it was ready, and its first paint.
//
// The frame is told apart by its window object alone, never by anything it
// says about itself.

import { extensionFrameMethod } from '../../../../packages/extension-sdk/src/services'
import type { StudioExtensionCallAnswer } from '../../../../packages/studio-protocol/src/public'
import { EXTENSION_EDITOR_TEXT_MAX_BYTES } from '../../../../packages/extension-sdk/src/custom-editors'
import {
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
  sendTheme(): void
  push(topic: string, payload?: unknown): void
  dispose(): void
}

const RETRYABLE = new Set(['rate_limited', 'unavailable', 'timeout'])

type Envelope = { kind?: unknown; id?: unknown; method?: unknown; params?: unknown; event?: unknown; payload?: unknown }

export function createExtensionFrameHost(options: ExtensionFrameHostOptions): ExtensionFrameHost {
  const budget = createExtensionFrameBudget()
  // A custom editor's edits are whole documents: up to the document's size,
  // on a budget of their own so typing never starves the frame's calls.
  const editBudget = createExtensionFrameBudget({ maxBytes: EXTENSION_EDITOR_TEXT_MAX_BYTES + 4096 })
  const now = options.now ?? Date.now
  // The calls waiting for the Studio, and those of them the frame gave up on:
  // a cancel counts only for a call still waiting, and both forget an id once
  // it is answered.
  const waiting = new Set<number>()
  const cancelled = new Set<number>()
  let alive = true

  const post = (message: Record<string, unknown>) => {
    if (alive) options.post({ se: EXTENSION_FRAME_PROTOCOL, ...message })
  }
  const answer = (id: number, outcome: { result: unknown } | { code: string; message: string; document?: unknown }) => {
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
    const answered = await options.call(method, params)
    if (!answered.ok) return answer(id, { code: answered.code, message: answered.message })
    if (extensionFrameMethod(method)?.runs !== 'client') return answer(id, { result: answered.result })
    try {
      answer(id, { result: await carryOut(method, params) })
    } catch (error) {
      answer(id, { code: 'invalid_params', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const epoch = (payload: unknown): number | null => {
    const at = (payload as { at?: unknown } | null)?.at
    return typeof at === 'number' && Number.isFinite(at) ? at : null
  }

  return {
    receive(event) {
      if (!alive || event.source === null || event.source !== options.source()) return
      const message = event.data as Envelope & { se?: unknown }
      if (!message || typeof message !== 'object' || message.se !== EXTENSION_FRAME_PROTOCOL) return
      const id = Number.isSafeInteger(message.id) ? (message.id as number) : null
      const edit = message.kind === 'req' && message.method === EXTENSION_EDITOR_APPLY_EDIT
      const refused = edit
        ? editBudget.admit(now(), extensionFrameMessageBytes(message, EXTENSION_EDITOR_TEXT_MAX_BYTES + 4096))
        : budget.admit(now(), extensionFrameMessageBytes(message))
      if (refused) {
        if (message.kind === 'req' && id !== null)
          answer(id, {
            code: refused,
            message:
              refused === 'too_large'
                ? edit
                  ? 'A document is at most 1 MiB of text or 768 KiB of bytes.'
                  : 'A message from a frame is at most 64 KiB.'
                : 'This frame sent too many messages; try again shortly.',
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
            payload: { theme: options.theme(), ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}) },
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
      for (const stop of followed.values()) stop()
      followed.clear()
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
