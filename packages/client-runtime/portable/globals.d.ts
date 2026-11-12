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

declare const console: {
  warn(...data: unknown[]): void
  error(...data: unknown[]): void
}

interface AbortSignal {
  readonly aborted: boolean
  readonly reason: unknown
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
interface URL {
  readonly host: string
}
declare const URL: { prototype: URL; new (url: string, base?: string): URL }
