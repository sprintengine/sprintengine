import type {
  TerminalOpenParams,
  TerminalOutputEvent,
  TerminalPromptUndelivered,
  TerminalSessionSnapshot,
  TerminalSessionsDelta,
  TerminalSpawnResult,
  TerminalVisibilityOptions,
} from '../../../packages/studio-protocol/src/public'
import type { TerminalViewer } from './terminal-viewer'

// The terminals on this machine, as the Studio protocol serves them
// (`packages/studio-protocol/src/terminals.ts`): the one way any client, the
// app's own windows included, reaches a pty.
//
// The runtime streams a session's output to one viewer at a time. Here a
// viewer is one connection's `terminal.output` subscription for the session:
// `follow` makes it, and the router's `open`, `setVisible`, `status` and `ack`
// name it by the connection that asks, so a pane's own subscription is what
// takes the output over. A subscription that ends, or a connection that
// closes, leaves a viewer that has gone, which the next pane to open or show
// the session adopts and replays to, as a window reload always did.
//
// A write carries its pane's `writer` and a `seq` counted from 1: the client
// sends again whatever was unanswered when a connection dropped, and a write
// it sends again is dropped here rather than typed twice.

/** What the server asks of the terminal runtime. */
export type StudioTerminalRuntime = {
  spawnTerminal(viewer: TerminalViewer, payload: TerminalOpenParams): Promise<TerminalSpawnResult>
  resumeTerminal(viewer: TerminalViewer, payload: TerminalOpenParams): Promise<TerminalSpawnResult>
  writeTerminal(sessionId: string, data: string): void
  resizeTerminal(sessionId: string, cols: number, rows: number): void
  getTerminalStatus(sessionId: string, viewer?: TerminalViewer): Promise<{ processAlive: boolean; suspended: boolean }>
  listTerminals(): TerminalSessionSnapshot[]
  setTerminalVisible(
    sessionId: string,
    visible: boolean,
    viewer?: TerminalViewer,
    options?: TerminalVisibilityOptions,
  ): void
  suspendTerminal(sessionId: string): void
  killTerminal(sessionId: string): void
  setIdleSuspendThresholdMs(value: unknown): void
  setKeepRecentTerminalsAlive(value: unknown): void
  setTerminalReapExempt(sessionId: string, exempt: boolean): void
  ackTerminalOutput(sessionId: string, units: number, viewer?: TerminalViewer): void
  takeUndeliveredPrompts(): TerminalPromptUndelivered[]
  onSessionsDelta(listener: (delta: TerminalSessionsDelta) => void): () => void
  onPromptUndelivered(listener: () => void): () => void
}

/** Who is asking: the connection, and the window it belongs to when it is one of Studio's own. */
export type StudioTerminalCaller = { connectionId: string; windowKey?: string }

/** One connection's subscription to a session's output. */
export type StudioTerminalFollow = {
  dispose(): void
  /** Send this pane the session's screen in full again: what it holds can no longer be trusted. */
  repaint(): void
}

export type StudioTerminals = {
  list(): TerminalSessionSnapshot[]
  status(sessionId: string, caller: StudioTerminalCaller): Promise<{ processAlive: boolean; suspended: boolean }>
  open(params: TerminalOpenParams, caller: StudioTerminalCaller): Promise<TerminalSpawnResult>
  resume(params: TerminalOpenParams, caller: StudioTerminalCaller): Promise<TerminalSpawnResult>
  /** False for a write this writer already sent (`seq` not past its last). */
  write(input: { sessionId: string; data: string; writer: string; seq: number }, clientId: string): boolean
  ack(sessionId: string, units: number, caller: StudioTerminalCaller): void
  resize(sessionId: string, cols: number, rows: number): void
  setVisible(sessionId: string, visible: boolean, freshPane: boolean, caller: StudioTerminalCaller): void
  suspend(sessionId: string): void
  close(sessionId: string): void
  setReapExempt(sessionId: string, exempt: boolean): void
  takeUndeliveredPrompts(): TerminalPromptUndelivered[]
  configure(policy: { idleSuspendMs?: number; keepRecentAlive?: number }): void
  /** Become a viewer of the session's output for this connection; a later follow of it on the same connection replaces this one. */
  follow(connectionId: string, sessionId: string, deliver: (event: TerminalOutputEvent) => void): StudioTerminalFollow
  onSessionsDelta(listener: (delta: TerminalSessionsDelta) => void): () => void
  onPromptUndelivered(listener: () => void): () => void
}

export type StudioTerminalsOptions = {
  runtime: StudioTerminalRuntime
  /**
   * Whether a window may take over the output of a session that runs. A pane
   * popped out into its own window may only while its owner still has that
   * terminal out there: a re-attach it sent before it heard the tab was taken
   * back must not be the last word. Absent: any may.
   */
  mayAttach?: (windowKey: string, sessionId: string) => boolean
  /** Applied beside the terminals' threshold: the headless chats idle out on the same setting. */
  onIdleSuspendMs?: (value: number) => void
}

// How many writers' last `seq` are kept; past this the longest-quiet go.
const MAX_WRITERS = 4096

type Viewer = TerminalViewer & { gone: boolean }

export function createStudioTerminals(options: StudioTerminalsOptions): StudioTerminals {
  const { runtime } = options
  // Each connection's viewer of each session it follows.
  const viewers = new Map<string, Viewer>()
  const lastSeq = new Map<string, number>()
  const key = (connectionId: string, sessionId: string) => `${connectionId}\0${sessionId}`
  // A caller with no subscription for the session still opens it: the session
  // runs and buffers, and its output goes to whoever follows it next.
  const viewerOf = (sessionId: string, caller: StudioTerminalCaller): Viewer | undefined =>
    viewers.get(key(caller.connectionId, sessionId))
  // A caller that follows no output for the session: it speaks as a pane that
  // has gone, so the runtime's routing rule holds it to the pane the session
  // streams to (a window sweeping its hidden terminals does not hide one shown
  // in another window), and the next pane that follows it takes it over.
  const stranger = (): TerminalViewer => ({ isGone: () => true, deliver: () => undefined })

  function start(
    params: TerminalOpenParams,
    caller: StudioTerminalCaller,
    how: 'open' | 'resume',
  ): Promise<TerminalSpawnResult> {
    // Only a window's connection is asked about: a pop-out is a window.
    const refused =
      options.mayAttach !== undefined &&
      caller.windowKey !== undefined &&
      !options.mayAttach(caller.windowKey, params.sessionId) &&
      runtime.listTerminals().some((session) => session.sessionId === params.sessionId)
    if (refused)
      return Promise.resolve({
        ok: false,
        sessionId: params.sessionId,
        message: 'This terminal is shown in another window.',
        exitCode: 1,
      })
    const viewer = viewerOf(params.sessionId, caller) ?? stranger()
    return how === 'open' ? runtime.spawnTerminal(viewer, params) : runtime.resumeTerminal(viewer, params)
  }

  return {
    list: () => runtime.listTerminals(),
    status: (sessionId, caller) => runtime.getTerminalStatus(sessionId, viewerOf(sessionId, caller) ?? stranger()),
    open: (params, caller) => start(params, caller, 'open'),
    resume: (params, caller) => start(params, caller, 'resume'),
    write({ sessionId, data, writer, seq }, clientId) {
      // Writers are named by the client, so one client's names never reach another's.
      const writerKey = `${clientId}\0${sessionId}\0${writer}`
      const last = lastSeq.get(writerKey) ?? 0
      if (seq <= last) return false
      lastSeq.delete(writerKey)
      lastSeq.set(writerKey, seq)
      while (lastSeq.size > MAX_WRITERS) lastSeq.delete(lastSeq.keys().next().value!)
      runtime.writeTerminal(sessionId, data)
      return true
    },
    ack(sessionId, units, caller) {
      // An ack from a pane with no subscription speaks for no stream.
      const viewer = viewerOf(sessionId, caller)
      if (viewer) runtime.ackTerminalOutput(sessionId, units, viewer)
    },
    resize: (sessionId, cols, rows) => runtime.resizeTerminal(sessionId, cols, rows),
    setVisible(sessionId, visible, freshPane, caller) {
      runtime.setTerminalVisible(
        sessionId,
        visible,
        viewerOf(sessionId, caller) ?? stranger(),
        freshPane ? { freshPane: true } : undefined,
      )
    },
    suspend: (sessionId) => runtime.suspendTerminal(sessionId),
    close: (sessionId) => runtime.killTerminal(sessionId),
    setReapExempt: (sessionId, exempt) => runtime.setTerminalReapExempt(sessionId, exempt),
    takeUndeliveredPrompts: () => runtime.takeUndeliveredPrompts(),
    configure({ idleSuspendMs, keepRecentAlive }) {
      if (idleSuspendMs !== undefined) {
        runtime.setIdleSuspendThresholdMs(idleSuspendMs)
        options.onIdleSuspendMs?.(idleSuspendMs)
      }
      if (keepRecentAlive !== undefined) runtime.setKeepRecentTerminalsAlive(keepRecentAlive)
    },
    follow(connectionId, sessionId, deliver) {
      const at = key(connectionId, sessionId)
      const replaced = viewers.get(at)
      if (replaced) replaced.gone = true
      const viewer: Viewer = {
        gone: false,
        isGone: () => viewer.gone,
        deliver: (event) => {
          if (!viewer.gone) deliver(event)
        },
      }
      viewers.set(at, viewer)
      return {
        dispose() {
          viewer.gone = true
          if (viewers.get(at) === viewer) viewers.delete(at)
        },
        repaint() {
          if (viewer.gone) return
          // Shown again as a pane that holds nothing: the runtime sends the
          // screen in full if the session still streams to this viewer.
          runtime.setTerminalVisible(sessionId, true, viewer, { freshPane: true })
        },
      }
    },
    onSessionsDelta: (listener) => runtime.onSessionsDelta(listener),
    onPromptUndelivered: (listener) => runtime.onPromptUndelivered(listener),
  }
}
