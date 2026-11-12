import type { StudioClient } from '../../../../packages/client-runtime/src/public'
import {
  STUDIO_TERMINALS_CAPABILITY,
  STUDIO_TERMINAL_MAX_WRITE_UNITS,
  type TerminalOpenParams,
  type TerminalOutputEvent,
} from '../../../../packages/studio-protocol/src/public'
import type {
  AgentCli,
  CliRuntimeSettings,
  TerminalPromptUndelivered,
  TerminalSessionSnapshot,
  TerminalSessionsDelta,
  TerminalSpawnMetadata,
  TerminalSpawnResult,
  TerminalVisibilityOptions,
} from '../../../shared/electron-api'
import { watchWindowStudio, windowStudioClient, windowStudioState } from './windowStudioClient'

// This window's terminals, over its Studio connection (`terminal.*` in
// packages/studio-protocol/src/terminals.ts). The Studio runs the ptys; a pane
// follows a session's output, opens it, types into it and says what it parsed.
//
// What this module keeps so a pane does not have to:
//
// - One `terminal.output` subscription per session, shared by every listener
//   in the window, bound to the window's current client. A subscription that
//   fails is tried again; a client that is replaced (one that closed for good)
//   is left for the new one; and after any reconnect a pane that was showing
//   is shown again fresh, since the Studio routes output to the subscription
//   that last opened or showed the terminal, and that one was the old
//   connection's.
// - Writes in order, one in flight per terminal, a paste longer than the
//   protocol's limit split into pieces. Every piece carries this window's
//   writer id for the terminal and the next `seq`, so a piece the client sends
//   again after a reconnect is dropped by the Studio rather than typed twice.
// - The sessions stream, subscribed again (and the list asked for again) on a
//   new client or connection, and tried again until its first connect works.

const RETRY_MS = [250, 1_000, 2_000, 5_000]

type Api = Parameters<typeof windowStudioClient>[0]

function windowApi(): Api | null {
  const api = typeof window === 'undefined' ? null : (window.api as Api | undefined)
  return typeof api?.studioWindowTicket === 'function' ? api : null
}

/** The window's client, when it serves terminals; rejects otherwise. */
async function terminalsClient(sessionId?: string): Promise<StudioClient> {
  const api = windowApi()
  if (!api) throw new Error('This window has no Studio connection.')
  const client = await windowStudioClient(api)
  if (!client.supports(STUDIO_TERMINALS_CAPABILITY))
    throw new Error(
      'This Studio does not serve terminals while it runs in its own process (a preview setting). Turn that off in Settings to use them.',
    )
  const follow = sessionId === undefined ? undefined : follows.get(sessionId)
  if (follow) subscribeOn(follow, client)
  return client
}

function randomId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

// ── Connection changes ──────────────────────────────────────────────────────

// Bumped every time the window's connection opens: a pane shown on an earlier
// one is shown again on this one.
let connectionGeneration = 0
let watching: (() => void) | null = null
const onConnectionOpen = new Set<() => void>()

function watchConnection(): void {
  if (watching) return
  const api = windowApi()
  if (!api) return
  watching = watchWindowStudio(api, () => {
    if (windowStudioState(api) !== 'open') return
    connectionGeneration += 1
    // After the client has subscribed its streams again: it does that just
    // after saying it is open, and a re-show must reach the new subscription.
    setTimeout(() => {
      for (const listener of [...onConnectionOpen]) listener()
    }, 0)
  })
}

// ── Output ──────────────────────────────────────────────────────────────────

type Listeners = {
  replay: Set<(data: string) => void>
  data: Set<(data: string) => void>
  exit: Set<(code: number) => void>
  error: Set<(message: string) => void>
}

type Follow = {
  sessionId: string
  listeners: Listeners
  client: StudioClient | null
  stop: (() => void) | null
  binding: boolean
  retries: number
  retry: ReturnType<typeof setTimeout> | null
  /** What the pane last said: whether it shows the terminal, and on which connection it said so. */
  visible: boolean | null
  shownOn: number
}

const follows = new Map<string, Follow>()

function listenerCount(follow: Follow): number {
  const { replay, data, exit, error } = follow.listeners
  return replay.size + data.size + exit.size + error.size
}

function dispatch(follow: Follow, event: TerminalOutputEvent): void {
  const call = <T>(listeners: Set<(value: T) => void>, value: T) => {
    for (const listener of [...listeners]) {
      try {
        listener(value)
      } catch (error) {
        console.warn('[terminals] an output listener failed', error)
      }
    }
  }
  if (event.type === 'replay') call(follow.listeners.replay, event.data)
  else if (event.type === 'data') call(follow.listeners.data, event.data)
  else if (event.type === 'error') call(follow.listeners.error, event.message)
  else {
    // An exit is heard once, as a terminal's process ends once.
    const exits = [...follow.listeners.exit]
    follow.listeners.exit.clear()
    for (const listener of exits) {
      try {
        listener(event.exitCode)
      } catch (error) {
        console.warn('[terminals] an exit listener failed', error)
      }
    }
  }
}

function retryBind(follow: Follow): void {
  if (follow.retry || follows.get(follow.sessionId) !== follow) return
  const delay = RETRY_MS[Math.min(follow.retries, RETRY_MS.length - 1)]
  follow.retries += 1
  follow.retry = setTimeout(() => {
    follow.retry = null
    bind(follow)
  }, delay)
}

/** Subscribe the session's output on the window's current client, unless it already is. */
function bind(follow: Follow): void {
  if (follow.binding || follows.get(follow.sessionId) !== follow) return
  follow.binding = true
  terminalsClient().then(
    (client) => {
      follow.binding = false
      subscribeOn(follow, client)
    },
    () => {
      follow.binding = false
      retryBind(follow)
    },
  )
}

/**
 * Subscribe the follow on this client, now, unless it already is. A call that
 * takes the output over (an open, a show) does this on its own client just
 * before it is sent, so the Studio has the subscription when the call arrives.
 */
function subscribeOn(follow: Follow, client: StudioClient): void {
  if (follows.get(follow.sessionId) !== follow) return
  if (follow.client === client && follow.stop) return
  follow.stop?.()
  follow.client = client
  follow.retries = 0
  const stop = client.subscribe(
    'terminal.output',
    { sessionId: follow.sessionId },
    {
      onPayload: (event) => dispatch(follow, event),
      // Ended for good (refused, or the client closed): the next client,
      // or a later try, takes over. A drop the client resumes is no end.
      onEnd: () => {
        if (follow.stop !== stop) return
        follow.stop = null
        follow.client = null
        retryBind(follow)
      },
    },
  )
  follow.stop = stop
}

/** On a new connection: subscribe on the client it belongs to, and show again what the pane was showing. */
function rebindAll(): void {
  for (const follow of follows.values()) {
    if (follow.client && follow.client.state === 'closed') {
      follow.stop?.()
      follow.stop = null
      follow.client = null
    }
    bind(follow)
    if (follow.visible === true && follow.shownOn < connectionGeneration) {
      follow.shownOn = connectionGeneration
      void terminalsClient(follow.sessionId)
        .then((client) =>
          client.request('terminal.setVisible', { sessionId: follow.sessionId, visible: true, freshPane: true }),
        )
        .catch(() => undefined)
    }
  }
}

function followOf(sessionId: string): Follow {
  let follow = follows.get(sessionId)
  if (follow) return follow
  watchConnection()
  onConnectionOpen.add(rebindAll)
  follow = {
    sessionId,
    listeners: { replay: new Set(), data: new Set(), exit: new Set(), error: new Set() },
    client: null,
    stop: null,
    binding: false,
    retries: 0,
    retry: null,
    visible: null,
    shownOn: 0,
  }
  follows.set(sessionId, follow)
  bind(follow)
  return follow
}

function listen<K extends keyof Listeners>(
  sessionId: string,
  kind: K,
  listener: Listeners[K] extends Set<infer L> ? L : never,
): () => void {
  const follow = followOf(sessionId)
  const set = follow.listeners[kind] as Set<typeof listener>
  set.add(listener)
  return () => {
    set.delete(listener)
    if (listenerCount(follow) > 0 || follows.get(sessionId) !== follow) return
    follows.delete(sessionId)
    if (follow.retry) clearTimeout(follow.retry)
    follow.stop?.()
  }
}

/** The session's screen in full: on open, on show after it was hidden, and after a reconnect. */
export function onTerminalReplay(sessionId: string, listener: (data: string) => void): () => void {
  return listen(sessionId, 'replay', listener)
}

/** What the session printed since. */
export function onTerminalData(sessionId: string, listener: (data: string) => void): () => void {
  return listen(sessionId, 'data', listener)
}

/** The session's process ended; heard once. */
export function onTerminalExit(sessionId: string, listener: (code: number) => void): () => void {
  return listen(sessionId, 'exit', listener)
}

/** Why the session could not start. */
export function onTerminalError(sessionId: string, listener: (message: string) => void): () => void {
  return listen(sessionId, 'error', listener)
}

function noteShown(sessionId: string, visible: boolean): void {
  const follow = follows.get(sessionId)
  if (!follow) return
  follow.visible = visible
  follow.shownOn = connectionGeneration
}

// ── Commands ────────────────────────────────────────────────────────────────

function openParams(
  sessionId: string,
  cols: number,
  rows: number,
  cwd?: string,
  resume?: boolean,
  cli?: AgentCli,
  initialPrompt?: string,
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
  shellOnly?: boolean,
  metadata?: TerminalSpawnMetadata,
): TerminalOpenParams & { commandId: string } {
  const params: Record<string, unknown> = { ...metadata, sessionId, cols, rows, commandId: randomId() }
  const optional = { cwd, resume, cli, initialPrompt, cliRuntimes, shellOnly }
  for (const [name, value] of Object.entries(optional)) if (value !== undefined) params[name] = value
  for (const [name, value] of Object.entries(params)) if (value === undefined) delete params[name]
  return params as TerminalOpenParams & { commandId: string }
}

function failed(sessionId: string, error: unknown): TerminalSpawnResult {
  return { ok: false, sessionId, message: error instanceof Error ? error.message : String(error), exitCode: 1 }
}

/**
 * Start the session, or attach to it when it runs (the pane is replayed to).
 * Follow its output first: the open takes the output over for this window's
 * subscription.
 */
export async function openTerminal(...args: Parameters<typeof openParams>): Promise<TerminalSpawnResult> {
  const params = openParams(...args)
  try {
    const client = await terminalsClient(params.sessionId)
    noteShown(params.sessionId, params.visible !== false)
    return await client.request('terminal.open', params)
  } catch (error) {
    return failed(params.sessionId, error)
  }
}

/** Start a suspended session's process again. */
export async function resumeTerminal(...args: Parameters<typeof openParams>): Promise<TerminalSpawnResult> {
  const params = openParams(...args)
  try {
    const client = await terminalsClient(params.sessionId)
    noteShown(params.sessionId, params.visible !== false)
    return await client.request('terminal.resume', params)
  } catch (error) {
    return failed(params.sessionId, error)
  }
}

export async function setTerminalVisible(
  sessionId: string,
  visible: boolean,
  options?: TerminalVisibilityOptions,
): Promise<void> {
  const client = await terminalsClient(sessionId)
  noteShown(sessionId, visible)
  await client.request('terminal.setVisible', {
    sessionId,
    visible,
    ...(options?.freshPane === true ? { freshPane: true } : {}),
  })
}

/** Best effort, as a resize always was: one that cannot reach the Studio is dropped, and the next one says the size. */
export async function resizeTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
  const cells = (value: number) => Math.max(1, Math.min(2000, Math.floor(value)))
  try {
    await (await terminalsClient()).request('terminal.resize', { sessionId, cols: cells(cols), rows: cells(rows) })
  } catch {
    // Dropped: the pane resizes again when it next lays out.
  }
}

export async function terminalStatus(sessionId: string): Promise<{ processAlive: boolean; suspended: boolean }> {
  return (await terminalsClient(sessionId)).request('terminal.status', { sessionId })
}

export async function listTerminals(): Promise<TerminalSessionSnapshot[]> {
  return (await (await terminalsClient()).request('terminal.list', {})).sessions
}

export async function suspendTerminal(sessionId: string): Promise<void> {
  await (await terminalsClient()).request('terminal.suspend', { sessionId })
}

/** End the session's process and forget it. */
export async function closeTerminal(sessionId: string): Promise<void> {
  await (await terminalsClient()).request('terminal.close', { sessionId, commandId: randomId() })
}

export async function setTerminalReapExempt(sessionId: string, exempt: boolean): Promise<void> {
  await (await terminalsClient()).request('terminal.setReapExempt', { sessionId, exempt })
}

/** The machine's reaper policy: the idle-suspend threshold and how many recent terminals always run. */
export async function configureTerminals(policy: { idleSuspendMs?: number; keepRecentAlive?: number }): Promise<void> {
  await (await terminalsClient()).request('terminal.configure', policy)
}

export async function takeUndeliveredPrompts(): Promise<TerminalPromptUndelivered[]> {
  return (await (await terminalsClient()).request('terminal.takeUndeliveredPrompts', {})).prompts
}

/** The pane parsed this many units of the output it was sent. Only a followed session's pane speaks. */
export function ackTerminal(sessionId: string, units: number): void {
  const client = follows.get(sessionId)?.client
  if (!client || client.state !== 'open' || !(units > 0)) return
  void client.request('terminal.ack', { sessionId, units: Math.floor(units) }).catch(() => undefined)
}

// ── Writes ──────────────────────────────────────────────────────────────────

type Writer = { id: string; seq: number; queue: Promise<unknown> }
const writers = new Map<string, Writer>()

/**
 * Pieces of at most `max` UTF-16 units, never splitting a surrogate pair: a
 * paste of any length goes as several writes, each within the protocol's
 * limit (and so within the client's frame cap, escapes included).
 */
export function terminalWritePieces(data: string, max = STUDIO_TERMINAL_MAX_WRITE_UNITS): string[] {
  const pieces: string[] = []
  let start = 0
  while (start < data.length) {
    let end = Math.min(start + max, data.length)
    const last = data.charCodeAt(end - 1)
    if (end < data.length && last >= 0xd800 && last <= 0xdbff && end - 1 > start) end -= 1
    pieces.push(data.slice(start, end))
    start = end
  }
  return pieces
}

/**
 * Type into the session, after whatever this window typed into it before.
 * Answers false when Studio refused it or could not be reached; the reason is
 * logged, never thrown, since most writes are keystrokes nobody awaits.
 */
export function writeTerminal(sessionId: string, data: string): Promise<boolean> {
  if (!data) return Promise.resolve(true)
  let writer = writers.get(sessionId)
  if (!writer) writers.set(sessionId, (writer = { id: randomId(), seq: 0, queue: Promise.resolve() }))
  const own = writer
  const done = own.queue.then(async () => {
    try {
      const client = await terminalsClient()
      for (const piece of terminalWritePieces(data)) {
        own.seq += 1
        await client.request('terminal.write', { sessionId, data: piece, writer: own.id, seq: own.seq })
      }
      return true
    } catch (error) {
      console.warn(`[terminals] typing into ${sessionId} failed:`, error instanceof Error ? error.message : error)
      return false
    }
  })
  own.queue = done
  return done
}

// ── The sessions ────────────────────────────────────────────────────────────

/**
 * Hear what changes among the sessions. `onResubscribed` is called whenever
 * the stream starts on a connection (the first included): what changed while
 * it was not subscribed is not replayed, so the caller asks for the list.
 */
export function onTerminalSessionsDelta(
  listener: (delta: TerminalSessionsDelta) => void,
  onResubscribed?: () => void,
): () => void {
  return followPush('terminal.sessions', (payload) => listener(payload as TerminalSessionsDelta), onResubscribed)
}

/** A first message could not be typed into its agent: call `takeUndeliveredPrompts`. */
export function onTerminalPromptUndelivered(listener: () => void): () => void {
  return followPush('terminal.promptUndelivered', () => listener())
}

function followPush(
  topic: 'terminal.sessions' | 'terminal.promptUndelivered',
  onPayload: (payload: unknown) => void,
  onResubscribed?: () => void,
): () => void {
  let alive = true
  let client: StudioClient | null = null
  let stop: (() => void) | null = null
  let retries = 0
  let retry: ReturnType<typeof setTimeout> | null = null
  const later = () => {
    if (!alive || retry) return
    retry = setTimeout(
      () => {
        retry = null
        subscribe()
      },
      RETRY_MS[Math.min(retries++, RETRY_MS.length - 1)],
    )
  }
  const subscribe = () => {
    terminalsClient().then(
      (current) => {
        if (!alive) return
        if (current !== client || !stop) {
          stop?.()
          client = current
          retries = 0
          const own = current.subscribe(
            topic,
            {},
            {
              onPayload,
              onEnd: () => {
                if (stop !== own) return
                stop = null
                client = null
                later()
              },
            },
          )
          stop = own
        }
        onResubscribed?.()
      },
      () => later(),
    )
  }
  watchConnection()
  const reopen = () => subscribe()
  onConnectionOpen.add(reopen)
  subscribe()
  return () => {
    alive = false
    onConnectionOpen.delete(reopen)
    if (retry) clearTimeout(retry)
    stop?.()
  }
}

/** Forget every stream and writer (tests). */
export function resetTerminalsForTests(): void {
  for (const follow of follows.values()) {
    if (follow.retry) clearTimeout(follow.retry)
    follow.stop?.()
  }
  follows.clear()
  writers.clear()
  onConnectionOpen.clear()
  watching?.()
  watching = null
  connectionGeneration = 0
}
