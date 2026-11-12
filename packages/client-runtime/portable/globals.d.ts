// What the client runtime may use beyond the language itself: the globals
// every place it runs provides, React Native (Hermes), a browser and Node
// alike. The runtime's build compiles it with `lib: ES2023`, no DOM and no
// Node types, and only these, so reaching for anything else (`window`,
// `document`, `Buffer`, `process`, a Node module) fails the build instead of
// failing on the phone. Kept outside `src/` so the app's own compiles, which
// have the DOM's or Node's real declarations, never see these.

declare function setTimeout(run: () => void, ms?: number): unknown
declare function clearTimeout(handle: unknown): void
declare function btoa(data: string): string
declare function queueMicrotask(run: () => void): void

declare const console: {
  warn(...data: unknown[]): void
  error(...data: unknown[]): void
}

// React Native's AbortController (the `abort-controller` polyfill) drops the
// reason `abort()` is given, and its signal has no `reason`: code here may
// pass one, for a browser's or Node's sake, but must never read it back.
interface AbortSignal {
  readonly aborted: boolean
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
  removeEventListener(type: 'abort', listener: () => void): void
}
declare const AbortSignal: { prototype: AbortSignal }

interface AbortController {
  readonly signal: AbortSignal
  abort(reason?: unknown): void
}
declare const AbortController: { prototype: AbortController; new (): AbortController }

// Read by the conversation protocol's tool wording (a web tool's host).
// React Native's `URL` never throws on a malformed address and reads `host`
// from http(s) addresses only, so code here must not rely on either: a
// `catch` around it is a browser's and Node's fallback, not the phone's.
interface URL {
  readonly host: string
}
declare const URL: { prototype: URL; new (url: string, base?: string): URL }
