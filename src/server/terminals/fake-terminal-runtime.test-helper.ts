import type {
  TerminalOpenParams,
  TerminalPromptUndelivered,
  TerminalSessionSnapshot,
  TerminalSessionsDelta,
  TerminalVisibilityOptions,
} from '../../../packages/studio-protocol/src/public'
import type { StudioTerminalRuntime } from './studio-terminals'
import type { TerminalViewer } from './terminal-viewer'

// A terminal runtime with no ptys, for the protocol's tests: a session is a
// screen, its output is what a test emits, and it streams to one viewer the
// way the real runtime does (`src/main/terminal-runtime.ts`): an open or a
// show adopts a viewer when the routed one has gone, and is answered with a
// replay of the screen.

export type FakeTerminal = {
  snapshot: TerminalSessionSnapshot
  viewer: TerminalViewer | null
  screen: string
  written: string[]
  acked: number
}

export type FakeTerminalRuntime = StudioTerminalRuntime & {
  terminals: Map<string, FakeTerminal>
  /** Every show or hide, with who asked and whether it was fresh. */
  shown: Array<{ sessionId: string; visible: boolean; freshPane: boolean; viewer: TerminalViewer | undefined }>
  /** A start waits this long before it answers: a folder's hold being waited on. */
  spawnDelayMs: number
  undelivered: TerminalPromptUndelivered[]
  policy: { idleSuspendMs?: unknown; keepRecentAlive?: unknown }
  /** The process printed this. */
  emit(sessionId: string, data: string): void
  /** Tell every `terminal.sessions` listener. */
  delta(delta: TerminalSessionsDelta): void
  promptUndelivered(): void
}

export function fakeTerminalSnapshot(
  sessionId: string,
  overrides: Partial<TerminalSessionSnapshot> = {},
): TerminalSessionSnapshot {
  return {
    sessionId,
    processAlive: true,
    kind: 'agent',
    visible: true,
    suspended: false,
    reapExempt: false,
    startedAt: 1,
    lastOutputAt: null,
    lastInputAt: null,
    lastVisibleAt: null,
    activity: { kind: 'idle', since: 1 },
    fileChanges: [],
    activeSubagents: 0,
    contextUsage: null,
    exitedAt: null,
    outputBufferLength: 0,
    retainedOutputBytes: 0,
    ...overrides,
  }
}

export function createFakeTerminalRuntime(): FakeTerminalRuntime {
  const deltaListeners = new Set<(delta: TerminalSessionsDelta) => void>()
  const promptListeners = new Set<() => void>()
  const deliver = (terminal: FakeTerminal, event: Parameters<TerminalViewer['deliver']>[0]) => {
    if (terminal.viewer && !terminal.viewer.isGone()) terminal.viewer.deliver(event)
  }
  const start = async (viewer: TerminalViewer, params: TerminalOpenParams) => {
    if (runtime.spawnDelayMs) await new Promise((resolve) => setTimeout(resolve, runtime.spawnDelayMs))
    const known = runtime.terminals.get(params.sessionId)
    if (known) {
      known.viewer = viewer
      deliver(known, { type: 'replay', data: known.screen })
      return { ok: true as const, sessionId: params.sessionId }
    }
    runtime.terminals.set(params.sessionId, {
      snapshot: fakeTerminalSnapshot(params.sessionId, {
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.cli ? { cli: params.cli } : {}),
      }),
      viewer,
      screen: '',
      written: [],
      acked: 0,
    })
    return { ok: true as const, sessionId: params.sessionId }
  }
  const runtime: FakeTerminalRuntime = {
    terminals: new Map(),
    shown: [],
    spawnDelayMs: 0,
    undelivered: [],
    policy: {},
    spawnTerminal: start,
    resumeTerminal: start,
    writeTerminal(sessionId, data) {
      runtime.terminals.get(sessionId)?.written.push(data)
    },
    resizeTerminal: () => undefined,
    getTerminalStatus: async (sessionId) => ({
      processAlive: runtime.terminals.has(sessionId),
      suspended: false,
    }),
    listTerminals: () => [...runtime.terminals.values()].map((terminal) => terminal.snapshot),
    setTerminalVisible(sessionId, visible, viewer, options?: TerminalVisibilityOptions) {
      runtime.shown.push({ sessionId, visible, freshPane: options?.freshPane === true, viewer })
      const terminal = runtime.terminals.get(sessionId)
      if (!terminal || !visible || !viewer) return
      const adopted = terminal.viewer !== viewer && (terminal.viewer?.isGone() ?? true)
      if (adopted) terminal.viewer = viewer
      if (terminal.viewer === viewer && (adopted || options?.freshPane))
        deliver(terminal, { type: 'replay', data: terminal.screen })
    },
    suspendTerminal: () => undefined,
    killTerminal(sessionId) {
      runtime.terminals.delete(sessionId)
    },
    setIdleSuspendThresholdMs(value) {
      runtime.policy.idleSuspendMs = value
    },
    setKeepRecentTerminalsAlive(value) {
      runtime.policy.keepRecentAlive = value
    },
    setTerminalReapExempt: () => undefined,
    ackTerminalOutput(sessionId, units, viewer) {
      const terminal = runtime.terminals.get(sessionId)
      if (terminal && terminal.viewer === viewer) terminal.acked += units
    },
    takeUndeliveredPrompts: () => runtime.undelivered.splice(0),
    onSessionsDelta(listener) {
      deltaListeners.add(listener)
      return () => deltaListeners.delete(listener)
    },
    onPromptUndelivered(listener) {
      promptListeners.add(listener)
      return () => promptListeners.delete(listener)
    },
    emit(sessionId, data) {
      const terminal = runtime.terminals.get(sessionId)
      if (!terminal) return
      terminal.screen += data
      deliver(terminal, { type: 'data', data })
    },
    delta: (delta) => deltaListeners.forEach((listener) => listener(delta)),
    promptUndelivered: () => promptListeners.forEach((listener) => listener()),
  }
  return runtime
}
