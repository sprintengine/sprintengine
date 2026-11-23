import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

import { buildWorkerEnv } from './worker-env'
import {
  WORKER_CALL_TIMEOUT_MS,
  WORKER_READY_TIMEOUT_MS,
  WORKER_SHUTDOWN_GRACE_MS,
  type WorkerCallMessage,
  type WorkerError,
  type WorkerHostAnswerMessage,
  type WorkerHostCallMessage,
  type WorkerInitMessage,
  type WorkerToServerMessage,
} from './worker-protocol'

// One extension's worker process, as the server holds it: forked from our own
// entry (worker-entry.ts) with Node's flags cleared and the environment
// scrubbed (worker-env.ts), its output written to the extension's log, and
// every call into it answered or timed out. What it may do, who it serves and
// when it starts and stops are decided above this (worker-session.ts,
// worker-manager.ts).

/** Where the worker entry was built: beside this file's bundle, unpacked when the app is an archive. */
export function resolveWorkerEntryPath(dir: string = __dirname): string {
  const candidates = ['extension-worker.js', 'extension-worker.cjs'].map((name) =>
    join(dir.replace(/([\\/])app\.asar([\\/])/u, '$1app.asar.unpacked$2'), name),
  )
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
}

/**
 * Studio's own copy of the extension SDK package, which a worker's
 * `import … from '@sprintengine/extension-sdk'` loads when the extension does
 * not carry one: beside the app in an installed build (`extension-sdk-runtime`,
 * package.json `build.extraResources`), the checkout's in development. Null
 * when it is not there (a checkout whose SDK was never built).
 */
export function resolveExtensionSdkRoot(resourcesDir: string | null, appRoot: string): string | null {
  const candidates = [
    ...(resourcesDir ? [join(resourcesDir, 'extension-sdk-runtime')] : []),
    join(appRoot, 'packages', 'extension-sdk'),
  ]
  return candidates.find((candidate) => existsSync(join(candidate, 'dist', 'index.js'))) ?? null
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A call the server makes into a worker, but for the invocation it runs as. */
export type WorkerCall = DistributiveOmit<
  Extract<WorkerCallMessage, { kind: 'method' | 'tool' | 'callback' | 'hook' }>,
  't' | 'id' | 'invocation'
>

export type WorkerProcessOptions = {
  extensionId: string
  /** The entry to fork (resolveWorkerEntryPath). */
  entryPath: string
  init: Omit<WorkerInitMessage, 't'>
  /** One line of the worker's own output, for its log. */
  log: (stream: 'stdout' | 'stderr', line: string) => void
  /** A call the worker makes into Studio; answered with what the promise settles to. */
  onHostCall: (message: WorkerHostCallMessage) => Promise<Omit<WorkerHostAnswerMessage, 't' | 'id'>>
  /** Its startup hooks have run. */
  onStarted?: () => void
  /**
   * The process as soon as it is forked, before it is ready: what Studio
   * calls back while it activates (a listener's first delivery) goes through it.
   */
  onSpawn?: (process: WorkerProcess) => void
  readyTimeoutMs?: number
  callTimeoutMs?: number
  /** Stops a start still under way. */
  signal?: AbortSignal
  /** For tests: what runs the entry. */
  execPath?: string
}

export type WorkerProcess = {
  readonly pid: number | undefined
  call(call: WorkerCall & { invocation: string }, timeoutMs?: number): Promise<unknown>
  /** Calls answered or pending, and the time of the last thing that happened. */
  inFlight(): number
  lastActivityAt(): number
  /**
   * Ask it to stop (its shutdown hooks run as `invocation`), and kill it after
   * the grace period. A call still in flight fails with `reason`.
   */
  stop(invocation: string, reason?: string, graceMs?: number): Promise<void>
  kill(): void
  /** Called once when it exits, with whether it was asked to. */
  onExit(listener: (exit: { code: number | null; signal: NodeJS.Signals | null; requested: boolean }) => void): void
  exited(): boolean
}

/** A failure of a call into the worker, with the code the caller tells apart. */
export class WorkerCallError extends Error {
  readonly code: string | undefined
  readonly invalidParams: boolean
  constructor(error: WorkerError) {
    super(error.message)
    this.name = error.name && error.name !== 'Error' ? error.name : 'WorkerCallError'
    this.code = error.code
    this.invalidParams = error.invalidParams === true
  }
}

function pipeLines(stream: Readable | null, write: (line: string) => void): void {
  if (!stream) return
  let buffered = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffered += chunk
    let at = buffered.indexOf('\n')
    while (at >= 0) {
      write(buffered.slice(0, at))
      buffered = buffered.slice(at + 1)
      at = buffered.indexOf('\n')
    }
    // A line with no end is cut at 64 KiB rather than held forever.
    if (buffered.length > 65_536) {
      write(buffered)
      buffered = ''
    }
  })
  stream.on('end', () => {
    if (buffered) write(buffered)
    buffered = ''
  })
}

export function startWorkerProcess(options: WorkerProcessOptions): Promise<WorkerProcess> {
  const tag = `Extension "${options.extensionId}"`
  const readyTimeoutMs = options.readyTimeoutMs ?? WORKER_READY_TIMEOUT_MS
  const callTimeoutMs = options.callTimeoutMs ?? WORKER_CALL_TIMEOUT_MS
  const child: ChildProcess = fork(options.entryPath, [], {
    execPath: options.execPath ?? process.execPath,
    // Studio's own inspector and loader flags must not run in third-party code.
    execArgv: [],
    env: buildWorkerEnv(),
    // Structured clone, so a Map or a Date crosses as itself.
    serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  pipeLines(child.stdout, (line) => options.log('stdout', line))
  pipeLines(child.stderr, (line) => options.log('stderr', line))

  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  const exitListeners: Array<
    (exit: { code: number | null; signal: NodeJS.Signals | null; requested: boolean }) => void
  > = []
  let nextId = 0
  let exited = false
  let requested = false
  let lastActivity = Date.now()
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null }

  const sendToChild = (message: unknown): void => {
    if (child.connected) child.send(message as never)
  }
  const rejectAll = (reason: string): void => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      pending.delete(id)
      entry.reject(new WorkerCallError({ message: reason, code: 'worker_stopped' }))
    }
  }

  child.on('exit', (code, signal) => {
    exited = true
    exitInfo = { code, signal }
    rejectAll(
      requested
        ? `${tag}'s worker was stopped before it answered.`
        : `${tag}'s worker exited before it answered (${signal ?? `code ${code}`}).`,
    )
    for (const listener of exitListeners.splice(0)) listener({ ...exitInfo, requested })
  })
  // The channel can close while the process lives on: end it, so supervision sees it.
  child.on('disconnect', () => {
    if (!exited) child.kill('SIGKILL')
  })

  const handle: WorkerProcess = {
    get pid() {
      return child.pid
    },
    call(call, timeoutMs = callTimeoutMs) {
      if (exited || requested) {
        return Promise.reject(
          new WorkerCallError({ message: `${tag}'s worker is not running.`, code: 'worker_stopped' }),
        )
      }
      const id = nextId++
      lastActivity = Date.now()
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          lastActivity = Date.now()
          reject(
            new WorkerCallError({
              message: `${tag}'s worker did not answer within ${Math.round(timeoutMs / 1000)}s.`,
              code: 'timeout',
            }),
          )
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        try {
          sendToChild({ t: 'call', id, ...call })
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(new WorkerCallError({ message: `${tag}'s worker could not be sent the call: ${String(error)}` }))
        }
      })
    },
    inFlight: () => pending.size,
    lastActivityAt: () => lastActivity,
    async stop(invocation, reason, graceMs = WORKER_SHUTDOWN_GRACE_MS) {
      if (exited) return
      if (requested) {
        await new Promise<void>((resolve) => (exited ? resolve() : exitListeners.push(() => resolve())))
        return
      }
      requested = true
      rejectAll(reason ?? `${tag}'s worker was stopped before it answered.`)
      await new Promise<void>((resolve) => {
        exitListeners.push(() => {
          clearTimeout(killTimer)
          resolve()
        })
        const killTimer = setTimeout(() => child.kill('SIGKILL'), graceMs)
        try {
          sendToChild({ t: 'call', id: nextId++, invocation, kind: 'shutdown' })
        } catch {
          child.kill('SIGKILL')
        }
      })
    },
    kill() {
      if (!exited) child.kill('SIGKILL')
    },
    onExit(listener) {
      if (exited) listener({ ...exitInfo, requested })
      else exitListeners.push(listener)
    },
    exited: () => exited,
  }

  options.onSpawn?.(handle)
  return new Promise<WorkerProcess>((resolve, reject) => {
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      child.kill('SIGKILL')
      reject(error)
    }
    const timer = setTimeout(
      () => fail(new Error(`${tag}'s worker did not start within ${Math.round(readyTimeoutMs / 1000)}s.`)),
      readyTimeoutMs,
    )
    const onAbort = (): void => fail(new Error(`${tag}'s worker was stopped while it started.`))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      fail(new Error(`${tag}'s worker could not run: ${error.message}`))
      rejectAll(`${tag}'s worker could not run: ${error.message}`)
    })
    child.on('exit', (code, signal) =>
      fail(new Error(`${tag}'s worker exited while it started (${signal ?? `code ${code}`}).`)),
    )

    child.on('message', (raw: unknown) => {
      const message = raw as WorkerToServerMessage
      if (!message || typeof message !== 'object') return
      lastActivity = Date.now()
      switch (message.t) {
        case 'ready':
          if (settled) return
          settled = true
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
          resolve(handle)
          return
        case 'started':
          options.onStarted?.()
          return
        case 'fatal':
          fail(new Error(`${tag}'s worker failed to start: ${message.error.message}`))
          return
        case 'answer': {
          const entry = pending.get(message.id)
          if (!entry) return
          pending.delete(message.id)
          clearTimeout(entry.timer)
          if (message.ok) entry.resolve(message.value)
          else entry.reject(new WorkerCallError(message.error))
          return
        }
        case 'host': {
          const id = message.id
          void options.onHostCall(message).then(
            (answer) => {
              lastActivity = Date.now()
              try {
                sendToChild({ t: 'host-answer', id, ...answer })
              } catch (error) {
                sendToChild({
                  t: 'host-answer',
                  id,
                  ok: false,
                  error: { message: `Studio's answer could not be sent to the worker: ${String(error)}` },
                })
              }
            },
            (error: unknown) =>
              sendToChild({
                t: 'host-answer',
                id,
                ok: false,
                error: { message: error instanceof Error ? error.message : String(error) },
              }),
          )
          return
        }
      }
    })

    if (options.signal?.aborted) {
      onAbort()
      return
    }
    try {
      sendToChild({ t: 'init', ...options.init })
    } catch (error) {
      fail(new Error(`${tag}'s worker could not be started: ${String(error)}`))
    }
  })
}
