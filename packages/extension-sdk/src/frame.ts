// What a surface's code sees inside its frame.
//
// A panel, door or settings section runs in a sandboxed frame of its own, on
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

/** A path inside a workspace's folder, relative to it, with `/` between its parts. */
export type ExtensionFilePath = string

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
  /** A text file's content (UTF-8), up to 4 MiB. */
  'files.read': { params: { workspaceId: string; path: ExtensionFilePath }; result: { content: string; size: number } }
  'files.stat': {
    params: { workspaceId: string; path: ExtensionFilePath }
    result: { type: 'file' | 'directory' | 'other'; size: number; modifiedAt: number }
  }
  /** Files and folders whose name holds `query`, case aside; links are not followed. */
  'files.search': {
    params: { workspaceId: string; query: string; limit?: number }
    result: { paths: ExtensionFilePath[]; truncated: boolean }
  }
  /** Write a text file. `create: true` makes a new one and refuses one that exists. */
  'files.write': {
    params: { workspaceId: string; path: ExtensionFilePath; content: string; create?: boolean }
    result: { size: number; created: boolean }
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

/** What a rejected `host.call` rejects with. */
export type ExtensionFrameError = Error & { code: ExtensionFrameErrorCode; retryable: boolean }

/** Which contribution a `mount` draws, and where. */
export type ExtensionSurface = {
  point: 'panels' | 'doors' | 'settingsSections'
  /** The contribution's id in extension.json. */
  id: string
  /** The workspace a panel was opened in; absent for doors and settings sections. */
  workspaceId?: string
}

/** The theme the frame is drawn in; its colours are the `THEME_TOKENS` custom properties. */
export type ExtensionFrameTheme = { colorScheme: 'light' | 'dark' }

/** A worker event (`MainHost.emit`), as the frame hears it. */
export type ExtensionFramePush = { topic: string; payload?: unknown }

export type ExtensionFrameEvents = {
  theme: ExtensionFrameTheme
  push: ExtensionFramePush
}

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
  /** The theme now; `on('theme')` hears it change. */
  readonly theme: ExtensionFrameTheme
  /** Hear the theme change, or the worker's events. Returns the way to stop hearing. */
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
