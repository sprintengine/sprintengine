// What a surface's code sees inside its frame.
//
// A panel, door, settings section or custom editor runs in a sandboxed frame of its own, on
// every client: no Node, no network, no reach into the app's window. Its
// `mount(root, studio)` is handed the `studio` below, and that object is the
// only way out of the frame: `studio.host.call(method, params)` asks Studio to
// do one thing on the extension's behalf. Studio checks each call twice, at
// the server: against what the person approved for the extension, and against
// what the person, device or browser that opened the surface may do
// themselves (`EXTENSION_FRAME_METHODS`). A refused call rejects with an
// `ExtensionFrameError` whose `code` says why.
//
// Types only: the frame's own bootstrap builds the object, before the
// extension's code runs.

import type { ModuleBacklogCreated, ModuleBacklogCreateInput, ModuleBacklogLinkInput } from './backlog.js'
import type { ModuleBacklogLocation, ModuleBacklogResult, ModuleBacklogTriageInput } from './backlog.js'
import type { UsageQuery, UsageQueryResult } from './activity.js'
import type {
  BacklogItemStatus,
  BacklogItemView,
  ModuleNotifyInput,
  ModuleStorageResult,
  ModuleToastTone,
  ModuleWorkspaceView,
} from './index.js'
import type { ModuleMethodAnswer, ModuleMethodContract, ModuleMethodContracts, ModuleMethodsClient } from './methods.js'
import type { ExtensionEventPayloads, ExtensionFrameEventName } from './events.js'

/** A path inside a workspace's folder, relative to it, with `/` between its parts. */
export type ExtensionFilePath = string

/** How `files.read` and `files.write` carry a file's content: as text, or its bytes in base64. */
export type ExtensionFileEncoding = 'utf8' | 'base64'

/** Every host method a frame may call, with what it takes and answers. */
export type ExtensionFrameMethods = {
  // ── Workspaces ──
  'workspace.list': { params: Record<string, never>; result: ModuleWorkspaceView[] }
  'workspace.get': { params: { workspaceId: string }; result: ModuleWorkspaceView | null }
  // ── The Backlog ──
  'backlog.list': { params: { workspaceId: string }; result: ModuleBacklogResult<{ items: BacklogItemView[] }> }
  'backlog.location': {
    params: { workspaceId: string }
    result: ModuleBacklogResult<{ location: ModuleBacklogLocation }>
  }
  'backlog.create': {
    params: { workspaceId: string; input: ModuleBacklogCreateInput }
    result: ModuleBacklogResult<ModuleBacklogCreated>
  }
  'backlog.updateStatus': {
    params: { workspaceId: string; itemId: string; status: BacklogItemStatus }
    result: ModuleBacklogResult
  }
  'backlog.updateTriage': {
    params: { workspaceId: string; itemId: string; triage: ModuleBacklogTriageInput }
    result: ModuleBacklogResult
  }
  'backlog.addLink': {
    params: { workspaceId: string; itemId: string; link: ModuleBacklogLinkInput }
    result: ModuleBacklogResult
  }
  'backlog.updateModuleMetadata': {
    params: { workspaceId: string; itemId: string; value: unknown }
    result: ModuleBacklogResult
  }
  // ── Usage ──
  'usage.query': { params: { query: UsageQuery }; result: UsageQueryResult }
  // ── The extension's own data, kept by Studio ──
  /** A key of its storage: the app-wide one, or one workspace's (`workspaceId`). */
  'storage.get': {
    params: { key: string; workspaceId?: string }
    result: ModuleStorageResult<{ value: unknown; found: boolean }>
  }
  'storage.set': { params: { key: string; value: unknown; workspaceId?: string }; result: ModuleStorageResult<object> }
  'storage.delete': {
    params: { key: string; workspaceId?: string }
    result: ModuleStorageResult<{ deleted: boolean }>
  }
  'storage.list': {
    params: { prefix?: string; workspaceId?: string }
    result: ModuleStorageResult<{ keys: string[] }>
  }
  /** The values of its Settings section, which its worker reads with `getModuleAppState`. */
  'settings.get': { params: Record<string, never>; result: Record<string, unknown> }
  /** Set one value of its Settings section; `null` removes it. */
  'settings.set': { params: { key: string; value: unknown }; result: { ok: true } }
  // ── Files in a workspace's folder ──
  /**
   * A file's content, up to 4 MiB: UTF-8 text, or with `encoding: 'base64'`
   * its raw bytes in base64. `sha256` is of its bytes, for a later
   * `files.write`'s `expectedSha256`.
   */
  'files.read': {
    params: { workspaceId: string; path: ExtensionFilePath; encoding?: ExtensionFileEncoding }
    result: { content: string; size: number; sha256: string }
  }
  'files.stat': {
    params: { workspaceId: string; path: ExtensionFilePath }
    result: { type: 'file' | 'directory' | 'other'; size: number; modifiedAt: number }
  }
  /** Files and folders whose name holds `query`, case aside; links are not followed. */
  'files.search': {
    params: { workspaceId: string; query: string; limit?: number }
    result: { paths: ExtensionFilePath[]; truncated: boolean }
  }
  /**
   * Write a file: `content` is UTF-8 text, or with `encoding: 'base64'` its
   * bytes in base64. `create: true` makes a new one and refuses one that
   * exists with `conflict`. With `expectedSha256` it writes only over a file whose bytes
   * still hash to it, and refuses with `conflict` otherwise (one gone too),
   * so nothing changed meanwhile is written over unseen. `save` marks UTF-8
   * text as the person's save (a custom text editor's, which Studio sends):
   * it meets the extensions' `editor.save.before` hooks first, which may
   * refuse it (`refused_by_extension`) or change it, and `text` answers what
   * was written when a hook changed it.
   */
  'files.write': {
    params: {
      workspaceId: string
      path: ExtensionFilePath
      content: string
      create?: boolean
      encoding?: ExtensionFileEncoding
      expectedSha256?: string
      save?: { languageId?: string }
    }
    result: { size: number; created: boolean; sha256: string; text?: string }
  }
  // ── Telling the person ──
  notify: { params: ModuleNotifyInput; result: { ok: true } }
  /** A toast in the window that opened the surface. */
  toast: { params: { tone: ModuleToastTone; message: string; detail?: string }; result: { ok: true } }
  /** Open a chat in the window that opened the surface, with a message drafted for the person to send. */
  'chat.draft': {
    params: { workspaceId: string; prompt: string; name?: string }
    result: { ok: true } | { ok: false; code: string; message: string }
  }
  /** Bring a chat (by its agent id) or a file (by its path in the workspace) to the front in the window that opened the surface. */
  'tabs.focus': { params: { workspaceId: string; kind: 'chat' | 'file'; id: string }; result: { focused: boolean } }
  /** Open one of the extension's doors (`contributes.doors`) in the window that opened the surface. */
  'doors.open': { params: { id: string }; result: { opened: boolean } }
  // ── Its worker ──
  /** One of the methods its worker declared `read` (`registerMethods`). */
  'worker.read': { params: { method: string; params?: unknown }; result: ModuleMethodAnswer<ModuleMethodContract> }
  /** One of the methods its worker declared `operate`. */
  'worker.operate': {
    params: { method: string; params?: unknown }
    result: ModuleMethodAnswer<ModuleMethodContract>
  }
  // ── Studio's events ──
  /**
   * Hear one of Studio's events in this frame. `studio.on(event, …)` calls it
   * for you; it refuses an event whose permission the extension's approval,
   * or whoever opened the surface, does not hold (the guide's events topic).
   */
  'events.subscribe': { params: { event: ExtensionFrameEventName }; result: { ok: true } }
  // ── Its log ──
  /**
   * A line in the extension's log, as `[frame]`: what `sprintengine-extension
   * dev watch` and `logs` print. The frame's own `console.error` and
   * `console.warn`, and what it throws, arrive here already, at their file
   * and line; at most 20 lines every 10 seconds are kept.
   */
  'log.write': { params: { level?: 'info' | 'warn' | 'error'; message: string }; result: { ok: true } }
  // ── A components panel ──
  /**
   * Its persisted atoms (`atom(key, initial, { persist: 'plugin' | 'workspace' })`):
   * the components runtime reads them before the first render. Each is
   * `{ version, value }` by key.
   */
  'atoms.read': {
    params: { workspaceId?: string }
    result: {
      plugin: Record<string, { version: number; value: unknown }>
      workspace: Record<string, { version: number; value: unknown }>
    }
  }
  /** Store changed persisted atoms; the runtime calls it a moment after they change. */
  'atoms.write': {
    params: {
      workspaceId?: string
      entries: Array<{ scope: 'plugin' | 'workspace'; key: string; version: number; value: unknown }>
    }
    result: { ok: true }
  }
  /**
   * One of its own image files (PNG, JPEG or WebP, at most 8 MiB), base64:
   * what a components panel's `Image` and Markdown show. Null when it is not
   * one of its files, or not such an image.
   */
  'assets.image': { params: { path: string }; result: { mime: string; data: string } | null }
  /**
   * Open an `https:`, `http:` or `mailto:` URL in the system browser of the
   * window's machine. Only a components panel can: a press on one of
   * Studio's own controls that stood still for 500 ms grants it once, and the
   * person is asked before a web address opens. Anything else is `not_permitted`.
   */
  'shell.openExternal': { params: { url: string }; result: { opened: boolean } }
  // ── Its secrets ──
  /** Whether a secret is set; its value never comes back. */
  'secrets.has': { params: { key: string }; result: { has: boolean } }
  /** Store a secret and the https origins its worker may send it to (`fetchWithSecret`). */
  'secrets.set': {
    params: { key: string; value: string; allowedOrigins: string[] }
    result: { ok: true } | { ok: false; code: string; message: string }
  }
  'secrets.delete': { params: { key: string }; result: { ok: true } | { ok: false; code: string; message: string } }
}

export type ExtensionFrameMethod = keyof ExtensionFrameMethods

/** Why a host call failed: a refusal, a limit, or the call not reaching Studio. */
export type ExtensionFrameErrorCode =
  | 'not_permitted'
  | 'approval_required'
  | 'unknown_method'
  | 'invalid_params'
  | 'rate_limited'
  | 'too_large'
  | 'unavailable'
  | 'timeout'
  | 'cancelled'
  | 'action_failed'
  /** A document edit or a conditional write was made against a version that is no longer the current one. */
  | 'conflict'
  /** The file or folder named is not there. */
  | 'missing'

/** What a rejected `host.call` rejects with. */
export type ExtensionFrameError = Error & { code: ExtensionFrameErrorCode; retryable: boolean }

/** Which contribution a `mount` draws, and where. */
export type ExtensionSurface = {
  point: 'panels' | 'doors' | 'settingsSections' | 'customEditors'
  /** The contribution's id in extension.json. */
  id: string
  /** The workspace a panel or custom editor was opened in; absent for doors and settings sections. */
  workspaceId?: string
}

// ── Custom editors ──────────────────────────────────────────────────────────

/** A custom editor's document: the file's text, or its raw bytes (`contentKind: "bytes"`). */
export type ExtensionEditorContent = { kind: 'text'; text: string } | { kind: 'bytes'; bytes: ArrayBuffer }

/**
 * The file a custom editor is open on, as Studio holds it now. Studio keeps
 * the unsaved state, saves the file and watches it on disk; the editor only
 * ever sees this, never a path.
 */
export type ExtensionEditorDocument = {
  /**
   * Rises each time Studio hands over a document (the file changed outside
   * the editor: on disk, in Studio's text editor, or reloaded). An edit names
   * the version it was made against; an accepted edit keeps it.
   */
  version: number
  /** Studio will not save it: the extension may not write files, or whoever opened it may not. */
  readOnly: boolean
  content: ExtensionEditorContent
}

/** A whole-document edit, made against the document of `baseVersion`. */
export type ExtensionEditorEdit = { baseVersion: number; content: ExtensionEditorContent }

/** What a refused edit rejects with: `conflict` carries the document as it is now. */
export type ExtensionEditorEditError = ExtensionFrameError & { document?: ExtensionEditorDocument }

export type ExtensionEditorSessionOptions<T> = {
  /** From the document's content to the editor's own value. Default: the text, for a text document. */
  decode?: (content: ExtensionEditorContent) => T
  /** From the editor's value to whole-document content. Default: the value as text. */
  encode?: (value: T) => ExtensionEditorContent
  /**
   * When an edit is refused because the document changed outside first, the
   * value to send instead: `base` is what the editor last had accepted,
   * `outside` the new document, `mine` the edit that was refused. Without
   * it the outside document wins, the edit is dropped and `onReplace` hears
   * it, so nothing outside is written over unseen.
   */
  merge?: (base: T, outside: T, mine: T) => T
  /** How long `change` waits for more before it sends an edit. Default: 250 ms. */
  debounceMs?: number
}

/** The document kept in step with Studio in one call (`studio.document.session()`). */
export type ExtensionEditorSession<T> = {
  /** The editor's value now: what it changed it to, or the document Studio last handed over. */
  readonly value: T
  readonly readOnly: boolean
  /** The editor's new value; sent to Studio as an edit shortly after, one at a time. */
  change(value: T): void
  /** Settles once every change so far reached Studio, or was refused with nothing newer to send. */
  flush(): Promise<void>
  /** Hear the value replaced from outside (the file changed, a conflict dropped an edit): draw it. */
  onReplace(listener: (value: T) => void): { dispose(): void }
  dispose(): void
}

/** `studio.document`, in a custom editor's frame only. */
export type ExtensionEditorDocumentApi = {
  /** The document now, once Studio handed the first one over. */
  get(): Promise<ExtensionEditorDocument>
  /** Hear each document Studio hands over; the current one is heard first. */
  onDidChange(listener: (document: ExtensionEditorDocument) => void): { dispose(): void }
  /**
   * Replace the document's content. Rejects with `conflict` (and the current
   * `document`) when `baseVersion` is not the current version, `not_permitted`
   * when it is read only, and `too_large` past 1 MiB of text or 768 KiB of
   * bytes (`EXTENSION_EDITOR_TEXT_MAX_BYTES`, `EXTENSION_EDITOR_BYTES_MAX_BYTES`).
   */
  applyEdit(edit: ExtensionEditorEdit): Promise<void>
  /**
   * Hear Studio about to save: hand over any edit still held back (a
   * debounce) before the returned promise settles. Studio waits up to 1 s.
   */
  onWillSave(listener: () => void | Promise<void>): { dispose(): void }
  /** Document sync in one call: resolves once the first document is in. */
  session<T = string>(options?: ExtensionEditorSessionOptions<T>): Promise<ExtensionEditorSession<T>>
}

/** The theme the frame is drawn in; its colours are the `THEME_TOKENS` custom properties. */
export type ExtensionFrameTheme = { colorScheme: 'light' | 'dark' }

/** A worker event (`MainHost.emit`), as the frame hears it. */
export type ExtensionFramePush = { topic: string; payload?: unknown }

export type ExtensionFrameEvents = {
  theme: ExtensionFrameTheme
  push: ExtensionFramePush
} & { [E in ExtensionFrameEventName]: ExtensionEventPayloads[E] }

/** The `studio` a `mount` is handed, inside the surface's frame. */
export type ExtensionMountStudio = {
  /** The version of this object's shape. */
  readonly api: { readonly version: 1 }
  /** This surface. */
  readonly surface: ExtensionSurface
  readonly host: {
    /** Ask Studio to do one thing; rejects with an `ExtensionFrameError` when it is refused. */
    call<M extends ExtensionFrameMethod>(
      method: M,
      params: ExtensionFrameMethods[M]['params'],
      options?: { signal?: AbortSignal },
    ): Promise<ExtensionFrameMethods[M]['result']>
    /** Whether this Studio offers a method; it may still refuse a call to it. */
    has(method: string): boolean
  }
  /**
   * The methods the extension's worker declared (`registerMethods`), typed by
   * its contract: `studio.methods<Board>().read('cards.list', {})`. They never
   * throw: a refusal, the worker's or Studio's, is an answer.
   */
  methods<Cs extends ModuleMethodContracts = ModuleMethodContracts>(): ModuleMethodsClient<Cs>
  /** The file a custom editor is open on; absent in every other surface. */
  readonly document?: ExtensionEditorDocumentApi
  /** The theme now; `on('theme')` hears it change. */
  readonly theme: ExtensionFrameTheme
  /**
   * Hear the theme change, the worker's events (`push`), or one of Studio's
   * events (`workspace.created`, `agent.status.changed`, …): the first
   * listener for one subscribes (`events.subscribe`), and a refusal is written
   * to the frame's console, and so to its log. Returns the way to stop hearing.
   */
  on<E extends keyof ExtensionFrameEvents>(
    event: E,
    listener: (payload: ExtensionFrameEvents[E]) => void,
  ): { dispose(): void }
  /**
   * Say the surface has drawn its content. Studio measures how long a surface
   * takes from being opened to this call; call it once, after the first
   * meaningful paint of your content.
   */
  ready(): void
}

/** What `mount` may hand back: a function Studio calls when the surface closes. */
export type ExtensionMountCleanup = () => void

/**
 * A ui `entry`'s export: draw into `root`, the frame's own body, and return a
 * cleanup function if anything outlives the DOM you drew.
 */
export type ExtensionMount = (
  root: HTMLElement,
  studio: ExtensionMountStudio,
) => void | ExtensionMountCleanup | Promise<void | ExtensionMountCleanup>

/** A ui `entry` module's shape. */
export type ExtensionUiEntry = { mount: ExtensionMount }
