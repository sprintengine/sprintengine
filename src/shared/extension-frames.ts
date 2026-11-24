// What every client and the server agree on about an extension's frame: the
// policy its document runs under, where a desktop window loads it from, the
// envelope its bridge speaks over postMessage, and the budgets that bound
// what a frame may send.
//
// A panel, door or settings section is one self-contained document the Studio
// server builds (server/extensions/frames). A browser loads it from the
// server's own path (`/ext-frame/<hash>`, the web client's `frame-src 'self'`
// admits it); a desktop window, local or paired, stages it with its shell,
// which serves it from `studio-ext://frame/<hash>` (main/extension-frames).
// Either way the frame is sandboxed (`allow-scripts` only, an opaque origin)
// and its policy below answers with the document, so it reaches no network,
// no storage of the app's and nothing of the window that drew it but the
// messages it posts.

/**
 * The document's policy, sent as its `Content-Security-Policy` header and
 * repeated first in its `<head>`. `script-src blob:` is the extension's entry,
 * which the bootstrap imports from a `blob:` URL it makes inside the frame;
 * `connect-src 'none'` and `default-src 'none'` keep the frame off the network.
 * `sandbox allow-scripts` gives it an opaque origin whatever URL it has.
 */
export const EXTENSION_FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/** The header form: the policy, who may frame it (null: whoever can load it), and the sandbox. */
export function extensionFrameHeaderCsp(frameAncestors: string | null): string {
  return `${EXTENSION_FRAME_CSP}${frameAncestors ? `; frame-ancestors ${frameAncestors}` : ''}; sandbox allow-scripts`
}

/** The scheme a desktop window's shell serves staged frame documents from. */
export const EXTENSION_FRAME_SCHEME = 'studio-ext'

/** A frame document's address in a desktop window. */
export function desktopExtensionFrameUrl(hash: string): string {
  return `${EXTENSION_FRAME_SCHEME}://frame/${hash}`
}

/** A frame document's path on the Studio server's web listener. */
export const EXTENSION_FRAME_PATH_PREFIX = '/ext-frame/'

/**
 * The wrapper document a browser tab frames an extension's document in, on
 * the Studio's own origin: its policy's `frame-src` names that one document,
 * so the frame inside cannot be navigated anywhere else, whoever starts it.
 * The page's own `frame-src` cannot do that: it admits the preview pane's
 * ports.
 */
export const EXTENSION_FRAME_HOST_PATH_PREFIX = '/ext-frame-host/'

/** A frame document's hash: sha256 of its bytes, hex. */
export const EXTENSION_FRAME_HASH_PATTERN = /^[0-9a-f]{64}$/u

/** The envelope's version: `{ se: 1, kind, … }`. */
export const EXTENSION_FRAME_PROTOCOL = 1

/** The events a frame and its host send each other beside calls. */
export const EXTENSION_FRAME_EVENTS = {
  /** frame → host: the bootstrap listens. */
  ready: 'ready',
  /** host → frame: the theme, before the extension's code is shown. */
  hello: 'hello',
  /** host → frame: the theme changed. */
  theme: 'theme',
  /** host → frame: a worker event (`MainHost.emit`). */
  push: 'push',
  /** host → frame: one of Studio's events the frame subscribed to (`{ event, payload }`). */
  studio: 'studio',
  /** frame → host: the surface called `studio.ready()` (`at`: epoch ms). */
  surfaceReady: 'surface.ready',
  /** frame → host: the first contentful paint (`at`: epoch ms). */
  paint: 'paint',
  /** frame → host: the entry failed to load or to mount. */
  failed: 'failed',
  /** frame → host: the frame's document is unloading (`pagehide`); the host drops the bridge. */
  leaving: 'leaving',
  /** host → custom editor: the file's document, at a new version. */
  document: 'document',
  /** host → custom editor: a save is coming; hand over what you hold back (`id`). */
  documentFlush: 'document.flush',
  /** custom editor → host: the flush `id` is done (`ok`: its listeners settled without failing). */
  documentFlushed: 'document.flushed',
  /** custom editor → host: the person pressed Cmd/Ctrl+S inside the frame. */
  documentSave: 'document.save',
} as const

/** The request a custom editor's frame makes with an edit; the window answers it, never the Studio. */
export const EXTENSION_EDITOR_APPLY_EDIT = 'document.applyEdit'

/**
 * Per frame, enforced by the host: a message is at most 64 KiB, and a frame
 * sends at most 120 messages in any 10 s (a surface loading its storage and
 * settings and first worker reads makes a burst of small calls).
 */
export const EXTENSION_FRAME_MESSAGE_MAX_BYTES = 64 * 1024
export const EXTENSION_FRAME_RATE_LIMIT = { maxMessages: 120, perMs: 10_000 } as const

/** The calls a frame may have waiting at once, and how long one waits for its answer. */
export const EXTENSION_FRAME_MAX_PENDING = 256
export const EXTENSION_FRAME_CALL_DEADLINE_MS = 120_000

export type ExtensionFrameBudget = {
  /** Null when the message may proceed, or why not. */
  admit(now: number, bytes: number): 'too_large' | 'rate_limited' | null
}

/** One frame's budget, on an injected clock. A refused message still spends the rate. */
export function createExtensionFrameBudget(
  limits: { maxBytes?: number; maxMessages?: number; perMs?: number } = {},
): ExtensionFrameBudget {
  const maxBytes = limits.maxBytes ?? EXTENSION_FRAME_MESSAGE_MAX_BYTES
  const maxMessages = limits.maxMessages ?? EXTENSION_FRAME_RATE_LIMIT.maxMessages
  const perMs = limits.perMs ?? EXTENSION_FRAME_RATE_LIMIT.perMs
  const sent: number[] = []
  return {
    admit(now, bytes) {
      while (sent.length > 0 && sent[0]! <= now - perMs) sent.shift()
      if (sent.length >= maxMessages) return 'rate_limited'
      sent.push(now)
      return bytes > maxBytes ? 'too_large' : null
    },
  }
}

const encoder = new TextEncoder()

/**
 * The size of a structured-clone message, by its strings and bytes, stopping
 * once it is past `stopAfter`. Anything that is not plain data (a function, a
 * class instance, a cycle past the walk's limits) counts as too large.
 */
export function extensionFrameMessageBytes(
  data: unknown,
  stopAfter = EXTENSION_FRAME_MESSAGE_MAX_BYTES,
  /** How deep and how many objects the walk follows; a components panel's tree is deeper and larger than a call. */
  walk: { maxDepth?: number; maxObjects?: number } = {},
): number {
  const maxDepth = walk.maxDepth ?? 100
  const maxObjects = walk.maxObjects ?? 10_000
  const seen = new WeakSet<object>()
  let total = 0
  let nodes = 0
  const add = (bytes: number) => {
    total = Math.min(stopAfter + 1, total + bytes)
  }
  const visit = (value: unknown, depth: number): void => {
    if (total > stopAfter) return
    if (value === null || value === undefined || typeof value === 'boolean') return add(1)
    if (typeof value === 'number') return add(8)
    if (typeof value === 'string')
      return add(value.length > stopAfter ? stopAfter + 1 : encoder.encode(value).byteLength)
    if (typeof value !== 'object') {
      total = stopAfter + 1
      return
    }
    if (seen.has(value)) return add(8)
    seen.add(value)
    nodes += 1
    if (nodes > maxObjects || depth > maxDepth) {
      total = stopAfter + 1
      return
    }
    if (value instanceof ArrayBuffer) return add(value.byteLength)
    if (ArrayBuffer.isView(value)) return add(value.byteLength + 16)
    if (Array.isArray(value)) {
      add(8)
      for (const entry of value) {
        add(4)
        visit(entry, depth + 1)
        if (total > stopAfter) return
      }
      return
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      total = stopAfter + 1
      return
    }
    for (const key of Object.keys(value)) {
      add(4 + encoder.encode(key).byteLength)
      visit((value as Record<string, unknown>)[key], depth + 1)
      if (total > stopAfter) return
    }
  }
  visit(data, 0)
  return total
}

/** The theme a frame is drawn in: light or dark, and each `THEME_TOKENS` property's value. */
export type ExtensionFrameTheme = { colorScheme: 'light' | 'dark'; tokens: Record<string, string> }

/** A token's value as it may sit in a frame's stylesheet: no braces, angle brackets or semicolons. */
export function safeTokenValue(value: string): string {
  return value.replace(/[{}<>;]/gu, '').trim()
}
