// What a Studio server and an extension's worker process say to each other
// over the fork's IPC channel (structured clone, `serialization: 'advanced'`).
//
// The server forks one process per worker extension (worker-process.ts). Its
// entry, worker-entry.ts, loads the extension's `main` and calls
// `activate(studio)` with a `studio` whose every call into Studio is a `host`
// message. Everything the server asks of the worker (a method, an MCP tool, a
// listener the worker handed over, shutting down) is a `call` and carries the
// id of the invocation it serves: the server made that id, keeps the record
// of who invoked, and judges each `host` message by its own record of the id
// the message names, never by anything else the worker says.
//
// Types only, apart from the numbers: worker-entry.ts is bundled on its own
// and imports nothing at run time from the rest of the app.

/** How long a worker has from fork to `ready` (its `activate` resolved). */
export const WORKER_READY_TIMEOUT_MS = 10_000
/** How long one call into a worker may take before it is answered with a timeout. */
export const WORKER_CALL_TIMEOUT_MS = 30_000
/** An on-demand worker with nothing in flight for this long is stopped; the next call starts it again. */
export const WORKER_IDLE_REAP_MS = 5 * 60_000
/** How often idle workers are looked for. */
export const WORKER_REAP_INTERVAL_MS = 60_000
/** On-demand workers running at once; one more waits for a slot. */
export const WORKER_MAX_ACTIVE = 5
/** `background: true` workers running at once; one more waits, and says why. */
export const WORKER_MAX_BACKGROUND = 16
/** The waits before each restart after a crash. */
export const WORKER_RESTART_BACKOFF_MS: readonly number[] = [500, 2000, 5000]
/** Restarts after crashes before a worker is marked errored. */
export const WORKER_MAX_RESTARTS = 3
/** How long a worker told to stop has before it is killed. */
export const WORKER_SHUTDOWN_GRACE_MS = 2_000

/** Why a call failed, as it crosses: an Error's own fields. */
export type WorkerError = {
  message: string
  name?: string
  /** A refusal's code (`not_permitted`, `invocation_ended`, …). */
  code?: string
  /** A method's params validator refused the params. */
  invalidParams?: true
}

/**
 * One argument of a host call: its data, and where in it a function the worker
 * hands Studio to call back sat (at any depth of plain objects and lists; the
 * empty path for the argument itself). A function is sent as `null` in `value`
 * and called back by its number.
 */
export type WorkerArg = { value: unknown; callbacks?: Array<{ path: Array<string | number>; callback: number }> }

/**
 * What a host call answers that can be called: a function, or an object of
 * them (a companion's handle). Each is kept by the server under `handle`, and
 * the worker calls it with a `host` message naming that handle.
 */
export type WorkerHandleRef =
  { handle: number; kind: 'function' } | { handle: number; kind: 'object'; members: Record<string, WorkerHandleMember> }

export type WorkerHandleMember = { fn: true } | { value: unknown } | { nested: WorkerHandleRef }

/** What a worker's host call reaches. */
export type WorkerHostTarget =
  /** A `studio` method (`notify`, `registerMethods`, `getWorkspaceGitInfo`, …). */
  | { host: string }
  /** A method of a Studio service the worker resolved with `requireService`. */
  | { service: string; method: string }
  /** A capability a host call handed back: one of its members, or itself (`member: null`) when a function. */
  | { handle: number; member: string | null }

/** A service as the worker builds its stand-in: its methods, and per method what its result holds that can be called. */
export type WorkerServiceShape = {
  methods: string[]
  /** By method: the member paths that can be called (`()` for a function, `onStatus.()` for one a member hands back). */
  returns: Record<string, string[]>
}

/** What a method or tool is told about its call. */
export type WorkerCallContext = Record<string, unknown>

// ── server → worker ─────────────────────────────────────────────────────────

export type WorkerInitMessage = {
  t: 'init'
  extensionId: string
  /** The extension's `main`, resolved inside its install folder. */
  entryPath: string
  /** Its install folder, and the digests its files were approved with, for `getAssetPath`. */
  root: string
  verifiedFiles: Record<string, string>
  /** `studio.supports(name)`, as Studio answers it now. */
  supports: Record<string, boolean>
  /** `studio.getModuleDataDir()`: its folder, or why Studio refused it. */
  dataDir: { ok: true; path: string } | { ok: false; error: WorkerError }
  /** The services an extension may resolve, by key. */
  services: Record<string, WorkerServiceShape>
  /** The keys among them that something provides now. */
  provided: string[]
  /** The invocation its activation runs as. */
  invocation: string
  /** The events its extension.json lists (`contributes.events`), which `studio.events.on` takes. */
  events: string[]
  /**
   * The SDK package of the Studio running it, for a worker whose source
   * imports `@sprintengine/extension-sdk` and does not carry it (source-hooks.ts).
   */
  sdkRoot?: string
}

export type WorkerCallMessage = { t: 'call'; id: number; invocation: string } & (
  | { kind: 'method'; name: string; params: unknown; context: WorkerCallContext }
  | { kind: 'tool'; name: string; args: Record<string, unknown>; context: WorkerCallContext }
  | { kind: 'callback'; callback: number; args: unknown[] }
  /** A hook the extension lists: its handler is handed `event` and answers its decision. */
  | { kind: 'hook'; point: string; event: unknown }
  /** An event the extension lists: each handler `studio.events.on` registered for it is handed `payload`. */
  | { kind: 'event'; event: string; payload: unknown }
  | { kind: 'shutdown' }
)

export type WorkerHostAnswerMessage =
  | { t: 'host-answer'; id: number; ok: true; value?: unknown; handle?: WorkerHandleRef }
  | { t: 'host-answer'; id: number; ok: false; error: WorkerError }

export type ServerToWorkerMessage = WorkerInitMessage | WorkerCallMessage | WorkerHostAnswerMessage

// ── worker → server ─────────────────────────────────────────────────────────

export type WorkerReadyMessage = { t: 'ready' }
/** Its startup hooks have run: the activation's invocation ends. */
export type WorkerStartedMessage = { t: 'started' }
export type WorkerFatalMessage = { t: 'fatal'; error: WorkerError }
export type WorkerHostCallMessage = {
  t: 'host'
  id: number
  /** The invocation it says it serves; null when it names none. */
  invocation: string | null
  target: WorkerHostTarget
  args: WorkerArg[]
}
export type WorkerAnswerMessage =
  { t: 'answer'; id: number; ok: true; value: unknown } | { t: 'answer'; id: number; ok: false; error: WorkerError }

export type WorkerToServerMessage =
  WorkerReadyMessage | WorkerStartedMessage | WorkerFatalMessage | WorkerHostCallMessage | WorkerAnswerMessage

/** The `studio` methods a worker reaches through a `host` message; the rest it answers itself. */
export const WORKER_HOST_METHODS = [
  'listChatRuntimes',
  'registerMethods',
  'registerMcpTools',
  'registerHooks',
  'ensureSkillInstalled',
  'getSkillStatus',
  'getWorkspaceGitInfo',
  'getModuleAppState',
  'watchModuleAppState',
  'notify',
  'emit',
] as const
export type WorkerHostMethod = (typeof WORKER_HOST_METHODS)[number]
