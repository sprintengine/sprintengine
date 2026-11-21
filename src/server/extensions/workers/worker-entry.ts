// The entry of an extension's worker process (worker-process.ts forks it).
//
// It loads the extension's `main`, calls `activate(studio)`, and serves what
// the server asks over the IPC channel: the methods and MCP tool handlers the
// extension registered, and the listeners it handed Studio. Its `studio` is a
// stand-in: every call into Studio is a `host` message carrying the id of the
// invocation the code making it serves, kept across awaits by
// AsyncLocalStorage. The server judges each message by its own record of that
// id; this file decides nothing about what the extension may do.
//
// What crosses is asynchronous: a service method, or a member of a handle a
// service hands back, answers a promise, except one whose row in the host's
// table says it hands back a function (an unsubscriber), which answers that
// function at once. What the worker can answer itself it answers at once:
// `supports`, `getModuleDataDir`, `getAssetPath`, the services it may resolve.
//
// Bundled on its own (electron.vite.config.ts, scripts/build-server.mjs) and
// imports nothing at run time but Node's own modules, so the bundle is one
// file with no chunk shared with the app.

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, relative, resolve } from 'node:path'

import type {
  ServerToWorkerMessage,
  WorkerArg,
  WorkerCallMessage,
  WorkerError,
  WorkerHandleRef,
  WorkerHostTarget,
  WorkerInitMessage,
  WorkerServiceShape,
  WorkerToServerMessage,
} from './worker-protocol'

type Fn = (...args: unknown[]) => unknown
type Hook = () => unknown
type MethodRegistration = { access: unknown; params: Fn; handler: Fn }
type ToolRegistration = { name: string; description?: unknown; inputSchema?: unknown; mutates?: unknown; handler: Fn }

const invocation = new AsyncLocalStorage<string>()
const pendingHost = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
const callbacks = new Map<number, Fn>()
const methods = new Map<string, MethodRegistration>()
const tools = new Map<string, Fn>()
const startupHooks: Hook[] = []
const shutdownBeginHooks: Hook[] = []
const shutdownHooks: Hook[] = []
// Registrations made while activating: ready waits for Studio to accept them all.
const registrations: Promise<unknown>[] = []
let nextHostCall = 0
let nextCallback = 0
let init: WorkerInitMessage | null = null

function send(message: WorkerToServerMessage): void {
  if (process.connected) process.send?.(message)
}

function toWorkerError(error: unknown): WorkerError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return { message: error.message, name: error.name, ...(typeof code === 'string' ? { code } : {}) }
  }
  return { message: String(error) }
}

function fromWorkerError(error: WorkerError): Error {
  const made = new Error(error.message)
  if (error.name) made.name = error.name
  if (error.code) (made as Error & { code?: string }).code = error.code
  return made
}

/** What went wrong in something the extension could not be told about directly, for its log. */
function report(what: string, error: unknown): void {
  process.stderr.write(`[studio] ${what}: ${error instanceof Error ? error.message : String(error)}\n`)
}

function isPlain(value: unknown): value is Record<string, unknown> | unknown[] {
  if (Array.isArray(value)) return true
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/** An argument as it crosses: functions, at any depth of plain objects and lists, become callback numbers. */
function encodeArg(arg: unknown): WorkerArg {
  const found: NonNullable<WorkerArg['callbacks']> = []
  // The objects on the way down to here: only one of them seen again is a
  // cycle. An object the argument holds twice is walked, and copied, twice.
  const above = new Set<object>()
  const walk = (value: unknown, path: Array<string | number>): unknown => {
    if (typeof value === 'function') {
      const id = nextCallback++
      callbacks.set(id, value as Fn)
      found.push({ path, callback: id })
      return null
    }
    if (!isPlain(value) || above.has(value)) return value
    above.add(value)
    try {
      if (Array.isArray(value)) return value.map((item, index) => walk(item, [...path, index]))
      const copy: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) copy[key] = walk(item, [...path, key])
      return copy
    } finally {
      above.delete(value)
    }
  }
  const value = walk(arg, [])
  return found.length > 0 ? { value, callbacks: found } : { value }
}

function hostCall(target: WorkerHostTarget, args: unknown[], shape?: readonly string[]): Promise<unknown> {
  const id = nextHostCall++
  const message: WorkerToServerMessage = {
    t: 'host',
    id,
    invocation: invocation.getStore() ?? null,
    target,
    args: args.map(encodeArg),
  }
  return new Promise<unknown>((resolveCall, rejectCall) => {
    pendingHost.set(id, {
      resolve: (value) => resolveCall(value && isHandleRef(value) ? handleOf(value, shape ?? []) : value),
      reject: rejectCall,
    })
    try {
      send(message)
    } catch (error) {
      // Not sent (something in it cannot be cloned): nothing will answer it.
      pendingHost.delete(id)
      rejectCall(error)
    }
  })
}

// A handle answer is passed to `resolve` boxed, so data that looks like one is never taken for it.
const HANDLE = Symbol('handle')
function isHandleRef(value: unknown): value is { [HANDLE]: WorkerHandleRef } {
  return typeof value === 'object' && value !== null && HANDLE in value
}

/**
 * A capability the host handed back. `shape` is what its row says can be
 * called and hands back a function (`onStatus.()`), which answers one at once.
 */
function handleOf(boxed: { [HANDLE]: WorkerHandleRef }, shape: readonly string[]): unknown {
  const ref = boxed[HANDLE]
  return materialize(ref, shape)
}

function materialize(ref: WorkerHandleRef, shape: readonly string[]): unknown {
  if (ref.kind === 'function') return (...args: unknown[]) => hostCall({ handle: ref.handle, member: null }, args)
  const object: Record<string, unknown> = {}
  for (const [name, member] of Object.entries(ref.members)) {
    if ('value' in member) object[name] = member.value
    else if ('nested' in member) object[name] = materialize(member.nested, [])
    else if (shape.includes(`${name}.()`))
      object[name] = (...args: unknown[]) => unsubscriber({ handle: ref.handle, member: name }, args)
    else object[name] = (...args: unknown[]) => hostCall({ handle: ref.handle, member: name }, args)
  }
  return Object.freeze(object)
}

/**
 * A call whose answer is a function that stops something (an unsubscriber):
 * the function is answered at once, and stops what the call started once
 * Studio has answered it. A refusal goes to the extension's log, and the
 * function then does nothing.
 */
function unsubscriber(target: WorkerHostTarget, args: unknown[]): () => void {
  const pending = hostCall(target, args)
  pending.catch((error: unknown) => report(`${describe(target)} was refused`, error))
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    void pending
      .then((stop) => (typeof stop === 'function' ? (stop as Fn)() : undefined))
      .catch((error: unknown) => report(`stopping ${describe(target)} failed`, error))
  }
}

function describe(target: WorkerHostTarget): string {
  if ('host' in target) return `studio.${target.host}`
  if ('service' in target) return `${target.service}.${target.method}`
  return target.member ? `a handle's ${target.member}` : 'a handle'
}

function serviceStandIn(key: string, shape: WorkerServiceShape): Record<string, unknown> {
  const standIn: Record<string, unknown> = {}
  for (const method of shape.methods) {
    const returns = shape.returns[method] ?? []
    standIn[method] = returns.includes('()')
      ? (...args: unknown[]) => unsubscriber({ service: key, method }, args)
      : (...args: unknown[]) => hostCall({ service: key, method }, args, returns)
  }
  return Object.freeze(standIn)
}

// ── `studio` ────────────────────────────────────────────────────────────────

function assetPath(root: string, verified: Record<string, string>, relativePath: string): string {
  if (
    typeof relativePath !== 'string' ||
    !relativePath ||
    relativePath.startsWith('/') ||
    /[\\\0?#]/.test(relativePath) ||
    relativePath.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Asset path must be a path inside the extension, got "${relativePath}".`)
  }
  const expected = verified[relativePath]
  if (expected === undefined) throw new Error(`"${relativePath}" is not among the extension's verified files.`)
  const realRoot = realpathSync(root)
  const real = realpathSync(resolve(root, relativePath))
  const within = relative(realRoot, real)
  if (!within || within.startsWith('..') || isAbsolute(within)) {
    throw new Error(`Asset "${relativePath}" resolves outside the extension.`)
  }
  if (createHash('sha256').update(readFileSync(real)).digest('hex') !== expected) {
    throw new Error(`Asset "${relativePath}" changed after it was verified.`)
  }
  return real
}

function fireAndForget(name: string, args: unknown[]): void {
  void hostCall({ host: name }, args).catch((error: unknown) => report(`studio.${name} was refused`, error))
}

function createStudio(start: WorkerInitMessage): Record<string, unknown> {
  const services = new Map<string, Record<string, unknown>>()
  const resolveService = (token: unknown, required: boolean): unknown => {
    const key = (token as { key?: unknown } | null)?.key
    if (typeof key !== 'string') throw new Error('A service is resolved with its token.')
    const shape = Object.hasOwn(start.services, key) ? start.services[key] : undefined
    if (!shape) throw new Error(`Service "${key}" is not available to extensions.`)
    if (!start.provided.includes(key)) {
      if (required)
        throw new Error(`Extension "${start.extensionId}" requires service "${key}", which no enabled module provides.`)
      return undefined
    }
    let standIn = services.get(key)
    if (!standIn) services.set(key, (standIn = serviceStandIn(key, shape)))
    return standIn
  }
  return Object.freeze({
    moduleId: start.extensionId,
    supports: (capability: unknown) =>
      typeof capability === 'string' &&
      Object.hasOwn(start.supports, capability) &&
      start.supports[capability] === true,
    listChatRuntimes: () => hostCall({ host: 'listChatRuntimes' }, []),
    registerMethods: (batch: unknown) => {
      if (batch === null || typeof batch !== 'object' || Array.isArray(batch)) {
        throw new Error(`Extension "${start.extensionId}" declares its methods as an object of name to method.`)
      }
      const entries = Object.entries(batch as Record<string, MethodRegistration>)
      for (const [name, registration] of entries) {
        if (typeof registration?.params !== 'function')
          throw new Error(
            `Extension "${start.extensionId}" method "${name}" has no params validator; every method reads its params.`,
          )
        if (typeof registration.handler !== 'function')
          throw new Error(`Extension "${start.extensionId}" method "${name}" has no handler.`)
        if (methods.has(name)) throw new Error(`Extension "${start.extensionId}" already declares "${name}".`)
      }
      const described = Object.fromEntries(
        entries.map(([name, registration]) => [name, { access: registration.access }]),
      )
      const accepted = hostCall({ host: 'registerMethods' }, [described]).then(() => {
        for (const [name, registration] of entries) methods.set(name, registration)
      })
      registrations.push(accepted)
      accepted.catch((error: unknown) => report('studio.registerMethods was refused', error))
    },
    registerMcpTools: (list: unknown) => {
      if (!Array.isArray(list)) throw new Error('registerMcpTools takes a list of tools.')
      for (const tool of list as ToolRegistration[]) {
        if (typeof tool?.handler !== 'function') throw new Error(`MCP tool "${String(tool?.name)}" has no handler.`)
      }
      const described = (list as ToolRegistration[]).map(({ name, description, inputSchema, mutates }) => ({
        name,
        description,
        inputSchema,
        ...(mutates === undefined ? {} : { mutates }),
      }))
      const accepted = hostCall({ host: 'registerMcpTools' }, [described]).then(() => {
        for (const tool of list as ToolRegistration[]) tools.set(tool.name, tool.handler)
      })
      registrations.push(accepted)
      accepted.catch((error: unknown) => report('studio.registerMcpTools was refused', error))
    },
    ensureSkillInstalled: (root: unknown, skillId: unknown) =>
      hostCall({ host: 'ensureSkillInstalled' }, [root, skillId]),
    getSkillStatus: (root: unknown, skillId: unknown) => hostCall({ host: 'getSkillStatus' }, [root, skillId]),
    getModuleDataDir: () => {
      if (!start.dataDir.ok) throw fromWorkerError(start.dataDir.error)
      return start.dataDir.path
    },
    getAssetPath: (relativePath: string) => assetPath(start.root, start.verifiedFiles, relativePath),
    getWorkspaceGitInfo: (workspaceId: unknown) => hostCall({ host: 'getWorkspaceGitInfo' }, [workspaceId]),
    getModuleAppState: (key: unknown) => hostCall({ host: 'getModuleAppState' }, [key]),
    watchModuleAppState: (cb: unknown) => unsubscriber({ host: 'watchModuleAppState' }, [cb]),
    getService: (token: unknown) => resolveService(token, false),
    requireService: (token: unknown) => resolveService(token, true),
    onStartup: (hook: Hook) => void startupHooks.push(hook),
    onShutdownBegin: (hook: Hook) => void shutdownBeginHooks.push(hook),
    onShutdown: (hook: Hook) => void shutdownHooks.push(hook),
    // A declaration: Studio does not spawn an extension's sidecar.
    registerSidecar: (spec: { id: string; kind: string; description?: string }) => {
      const status = () => ({
        id: spec.id,
        moduleId: start.extensionId,
        kind: spec.kind,
        ...(spec.description === undefined ? {} : { description: spec.description }),
        state: 'declared' as const,
      })
      return {
        start: () =>
          Promise.reject(new Error(`Sidecar "${spec.id}" was registered without a lifecycle and cannot be started.`)),
        stop: () => Promise.resolve(),
        status,
      }
    },
    notify: (input: unknown) => fireAndForget('notify', [input]),
    emit: (topic: unknown, payload?: unknown) =>
      fireAndForget('emit', payload === undefined ? [topic] : [topic, payload]),
  })
}

function resolveActivate(entry: Record<string, unknown>): Fn {
  if (typeof entry.activate === 'function') return entry.activate as Fn
  if (typeof entry.default === 'function') return entry.default as Fn
  const fallback = entry.default as { activate?: unknown } | undefined
  if (fallback && typeof fallback === 'object' && typeof fallback.activate === 'function')
    return fallback.activate as Fn
  throw new Error('main must export activate(studio), as a named export or its default.')
}

async function runHooks(hooks: readonly Hook[], label: string): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook()
    } catch (error) {
      report(`a ${label} hook failed`, error)
    }
  }
}

async function activate(start: WorkerInitMessage): Promise<void> {
  try {
    const entry = createRequire(start.entryPath)(start.entryPath) as Record<string, unknown>
    await resolveActivate(entry)(createStudio(start))
    // Whatever it registered while starting is accepted, or it did not start.
    await Promise.all(registrations)
  } catch (error) {
    send({ t: 'fatal', error: toWorkerError(error) })
    // The server kills it on `fatal`; leave on our own if it cannot.
    setTimeout(() => process.exit(1), 1000).unref()
    return
  }
  send({ t: 'ready' })
  await runHooks(startupHooks, 'startup')
  send({ t: 'started' })
}

// ── What the server asks ─────────────────────────────────────────────────────

async function serve(call: WorkerCallMessage): Promise<unknown> {
  switch (call.kind) {
    case 'method': {
      const registration = methods.get(call.name)
      if (!registration) throw new Error(`The worker serves no method "${call.name}".`)
      const parsed = (await registration.params(call.params)) as { ok: boolean; params?: unknown; message?: unknown }
      if (!parsed || parsed.ok !== true) {
        const error: WorkerError = {
          message: typeof parsed?.message === 'string' && parsed.message ? parsed.message : '',
          invalidParams: true,
        }
        throw error
      }
      return await registration.handler(parsed.params, call.context)
    }
    case 'tool': {
      const handler = tools.get(call.name)
      if (!handler) throw new Error(`The worker serves no MCP tool "${call.name}".`)
      return await handler(call.args, call.context)
    }
    case 'callback': {
      const callback = callbacks.get(call.callback)
      if (!callback) throw new Error('That listener is not the worker’s.')
      // Its answer goes back: a validator's verdict is what Studio waits for.
      return await callback(...call.args)
    }
    case 'shutdown':
      await runHooks(shutdownBeginHooks, 'shutdown-begin')
      await runHooks([...shutdownHooks].reverse(), 'shutdown')
      setImmediate(() => process.exit(0))
      return undefined
  }
}

function answer(call: WorkerCallMessage): void {
  void invocation.run(call.invocation, async () => {
    try {
      const value = await serve(call)
      try {
        send({ t: 'answer', id: call.id, ok: true, value })
      } catch (error) {
        send({
          t: 'answer',
          id: call.id,
          ok: false,
          error: { message: `Its answer cannot be sent to Studio: ${toWorkerError(error).message}` },
        })
      }
    } catch (error) {
      const failure =
        error && typeof error === 'object' && (error as WorkerError).invalidParams === true
          ? (error as WorkerError)
          : toWorkerError(error)
      send({ t: 'answer', id: call.id, ok: false, error: failure })
    }
  })
}

process.on('message', (raw: unknown) => {
  const message = raw as ServerToWorkerMessage
  if (!message || typeof message !== 'object') return
  switch (message.t) {
    case 'init':
      if (init) return
      init = message
      void invocation.run(message.invocation, () => activate(message))
      return
    case 'call':
      answer(message)
      return
    case 'host-answer': {
      const pending = pendingHost.get(message.id)
      if (!pending) return
      pendingHost.delete(message.id)
      if (!message.ok) pending.reject(fromWorkerError(message.error))
      else if (message.handle) pending.resolve({ [HANDLE]: message.handle })
      else pending.resolve(message.value)
      return
    }
  }
})

// Studio went away: so does its worker.
process.on('disconnect', () => process.exit(0))
// A call into Studio nobody awaited (a handle's `dispose()`, say) that Studio
// refused is the extension's to hear in its log, not a crash.
process.on('unhandledRejection', (error) => report('a call nobody awaited failed', error))
