import { randomUUID } from 'node:crypto'

import type { StudioPermission } from '../../../../packages/studio-protocol/src/permissions'
import { studioPrincipal } from '../../../../packages/studio-protocol/src/permissions'
import { EXTENSION_HOST_REFUSALS } from '../../../../packages/extension-sdk/src/services'
import type { CliPermissionPreset } from '../../../shared/cli-permission-preset'
import { isLooserCliPermissionPreset } from '../../../shared/cli-permission-preset'
import type { MainHost } from '../../../main/module-host/main-host'
import type { AgentStarter } from '../../../shared/agent-state'
import { ownerInvoker, runAsInvoker, type ExtensionInvoker } from '../../../main/module-host/extension-invocation'
import {
  WORKER_HOST_METHODS,
  type WorkerArg,
  type WorkerError,
  type WorkerHandleMember,
  type WorkerHandleRef,
  type WorkerHostAnswerMessage,
  type WorkerHostCallMessage,
  type WorkerHostMethod,
} from './worker-protocol'
import type { WorkerCall } from './worker-process'

// The server's side of one worker process: who each call into it serves, and
// every call it makes into Studio.
//
// Each call the server sends the worker runs as an invocation the server
// made: a fresh id, and the invoker that call was made by, kept here and
// nowhere else. A call the worker makes into Studio names the invocation it
// serves; the server finds who that is in its own record, and the call goes
// through the host's gate (extension-host-gate.ts) as the extension and as
// that invoker. An id the server did not make, or one whose call has ended,
// is refused; so is a call naming none, unless the extension is a
// `background` one, whose own work runs as the person who approved it.
//
// A background extension's own work is its activation (`activate` and its
// startup hooks) and whatever that sets going: a timer, an interval, a
// listener it registered then and every delivery to it. All of it runs under
// the activation's id, which stays live while the worker runs, so a poller
// started in `activate` keeps working after startup. Work set going during
// someone else's call (a device's, an agent's) carries that call's id, which
// ends with it, and stays refused. An on-demand worker's activation ends when
// its startup hooks have run.
//
// The ids name what a call is for, not what it may do. A worker serving two
// invokers at once holds both ids, and nothing stops it putting one on the
// other's work. So a call is held to every invocation the worker is serving
// when it is made, not only to the one it names: whichever id it carries, it
// can do no more than the least of them could. Serving the person alone, it
// does what the person may; while it also serves a paired device, what it
// does then is held to that device too.
//
// What a call hands back that can be called (an unsubscriber, a companion's
// handle) stays here as a handle; the worker calls it by number, and each
// call passes the gate again as whoever the worker serves then. What the
// worker hands Studio to call back (a listener, a validator, wherever it sits
// in an argument) is called back as whoever the call that handed it over ran
// as, never as whoever Studio happens to be serving when it calls, in an
// invocation of its own.

const ENDED_REMEMBERED = 4096

export type WorkerSessionDeps = {
  extensionId: string
  /** The host the kernel handed this extension's load. */
  host: MainHost
  /** Whether it is a `background` extension, whose own work may name no invocation. */
  background: boolean
  /** Whether the host's gate admits one of its `studio` methods now, as whoever the call runs as. */
  gate: (method: WorkerHostMethod) => { ok: true } | { ok: false; code: string; message: string }
  registerMethods: (batch: unknown) => void
  registerMcpTools: (tools: unknown) => void
  /** The points the worker registers hooks for. */
  registerHooks: (points: unknown) => void
  /** Send the worker a call as `invocation`, answered within `timeoutMs` (the supervisor's limit when absent). */
  call: (call: WorkerCall & { invocation: string }, timeoutMs?: number) => Promise<unknown>
}

export type WorkerSession = {
  /** The activation's invocation: the extension's own work, as the person who approved it. Its id. */
  startActivation(): string
  /** Its startup hooks have run: an on-demand worker's activation ends; a background one's own work goes on. */
  activationStarted(): void
  /** Start an invocation as `invoker`: its id. */
  begin(invoker: ExtensionInvoker): string
  end(id: string): void
  /** Run `call` in the worker as an invocation of `invoker`, ending it once answered (or after `timeoutMs`). */
  run(call: WorkerCall, invoker: ExtensionInvoker, timeoutMs?: number): Promise<unknown>
  /** Answer one call the worker made into Studio. */
  hostCall(message: WorkerHostCallMessage): Promise<Omit<WorkerHostAnswerMessage, 't' | 'id'>>
  /** How many invocations are live. */
  live(): number
  /** The process is gone: end every invocation and stop what it subscribed to. */
  close(): void
}

/** A refusal, as it crosses. */
const refusal = (code: string, message: string): WorkerError => ({ name: 'ExtensionHostRefusal', code, message })

function toWorkerError(error: unknown): WorkerError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return { message: error.message, name: error.name, ...(typeof code === 'string' ? { code } : {}) }
  }
  return { message: String(error) }
}

/** The tighter of two ceilings; null is no ceiling. */
function tighter(a: CliPermissionPreset | null, b: CliPermissionPreset | null): CliPermissionPreset | null {
  if (a === null) return b
  if (b === null) return a
  return isLooserCliPermissionPreset(a, b) ? b : a
}

/**
 * `own`, held to every other invoker the worker serves now: only what all of
 * them hold, the person's own reach only if every one is the person, and the
 * tightest ceiling, and no terminals if any of them may not reach them. The
 * words name whoever narrowed it.
 */
export function heldToAll(own: ExtensionInvoker, others: readonly ExtensionInvoker[]): ExtensionInvoker {
  const narrower = others.filter(
    (other) =>
      other !== own &&
      ((own.principal.owner && !other.principal.owner) ||
        (other.noTerminals === true && own.noTerminals !== true) ||
        [...own.principal.permissions].some((permission) => !other.principal.permissions.has(permission)) ||
        tighter(own.permissionCeiling, other.permissionCeiling) !== own.permissionCeiling),
  )
  if (narrower.length === 0) return own
  let permissions: Set<StudioPermission> = new Set(own.principal.permissions)
  let owner = own.principal.owner
  let ceiling = own.permissionCeiling
  let noTerminals = own.noTerminals === true
  for (const other of narrower) {
    noTerminals ||= other.noTerminals === true
    permissions = new Set([...permissions].filter((permission) => other.principal.permissions.has(permission)))
    owner = owner && other.principal.owner
    ceiling = tighter(ceiling, other.permissionCeiling)
  }
  const labels = [...new Set(narrower.map((other) => other.label))].join(' and ')
  return {
    principal: studioPrincipal({ owner, permissions }),
    permissionCeiling: ceiling,
    label: `${labels} (whom the extension's worker is also serving now)`,
    starter: sharedStarter([own, ...narrower]),
    ...(noTerminals ? { noTerminals: true as const } : {}),
    // Narrowed or not, its window is still the one whose call this is.
    ...(own.connectionId ? { connectionId: own.connectionId } : {}),
  }
}

/**
 * Who started what a narrowed invocation starts: the one starter every
 * invoker it serves shares, else no one, since a chat cannot belong to two.
 */
function sharedStarter(invokers: readonly ExtensionInvoker[]): AgentStarter {
  const first = invokers[0]?.starter
  if (!first) return { kind: 'nobody' }
  const same = invokers.every((invoker) => JSON.stringify(invoker.starter) === JSON.stringify(first))
  return same ? first : { kind: 'nobody' }
}

/** A plain object, or a host facade, with something on it that can be called. */
function isCapability(value: unknown): value is object {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.keys(value).some((name) => typeof Reflect.get(value, name) === 'function')
}

export function createWorkerSession(deps: WorkerSessionDeps): WorkerSession {
  const { extensionId, host } = deps
  const invocations = new Map<string, ExtensionInvoker>()
  const ended = new Set<string>()
  const handles = new Map<number, unknown>()
  const listeners = new Map<number, (...args: unknown[]) => unknown>()
  // What the worker subscribed to, stopped when its process ends.
  const subscriptions = new Set<() => unknown>()
  let nextHandle = 0
  let open = true
  // The extension's own work: its activation, as the person who approved it.
  const ownWork = ownerInvoker(null, 'its own work')
  let activation: string | null = null

  function begin(invoker: ExtensionInvoker): string {
    const id = randomUUID()
    invocations.set(id, invoker)
    return id
  }

  function end(id: string): void {
    if (!invocations.delete(id)) return
    ended.add(id)
    if (ended.size > ENDED_REMEMBERED) ended.delete(ended.values().next().value as string)
  }

  async function run(call: WorkerCall, invoker: ExtensionInvoker, timeoutMs?: number): Promise<unknown> {
    const id = begin(invoker)
    try {
      return await deps.call({ ...call, invocation: id }, timeoutMs)
    } finally {
      end(id)
    }
  }

  /** Who a call naming `id` runs as, or why it is refused. */
  function invokerFor(id: string | null): { ok: true; invoker: ExtensionInvoker } | { ok: false; error: WorkerError } {
    if (id === null) {
      if (!deps.background)
        return {
          ok: false,
          error: refusal(
            'not_admitted',
            `Extension "${extensionId}" called Studio outside any call Studio made to it, so Studio refused it. Only a background extension's own work may do that.`,
          ),
        }
      return { ok: true, invoker: heldToAll(ownerInvoker(null, 'its own background work'), [...invocations.values()]) }
    }
    if (ended.has(id))
      return {
        ok: false,
        error: refusal(
          'invocation_ended',
          `Extension "${extensionId}" called Studio for a call that has already ended, so Studio refused it.`,
        ),
      }
    const invoker = typeof id === 'string' ? invocations.get(id) : undefined
    if (!invoker)
      return {
        ok: false,
        error: refusal(
          'not_admitted',
          `Extension "${extensionId}" named a call Studio did not make to it, so Studio refused it.`,
        ),
      }
    return { ok: true, invoker: heldToAll(invoker, [...invocations.values()]) }
  }

  /**
   * A function the worker handed over, wherever it sat in the call that
   * carried it: called back as `registrant`, whoever that call ran as, and
   * never as whoever the host happens to be serving when it calls.
   */
  function listener(id: number, registrant: ExtensionInvoker): (...args: unknown[]) => unknown {
    const known = listeners.get(id)
    if (known) return known
    const made = (...args: unknown[]): unknown => {
      if (!open) return undefined
      const invoker = registrant
      // Registered by a background extension's own work: delivered as that work.
      const delivered =
        deps.background && invoker === ownWork && activation !== null && invocations.has(activation)
          ? deps.call({ kind: 'callback', callback: id, args, invocation: activation })
          : run({ kind: 'callback', callback: id, args }, invoker)
      // Handled here, so a delivery nobody awaits cannot fail the server; a
      // caller that awaits it (a validator) still hears its answer or its error.
      delivered.catch(() => undefined)
      return delivered
    }
    listeners.set(id, made)
    return made
  }

  function decodeArgs(args: readonly WorkerArg[], registrant: ExtensionInvoker): unknown[] {
    if (!Array.isArray(args)) throw new Error('A host call carries its arguments as a list.')
    return args.map((arg) => {
      let value = (arg as { value?: unknown } | null)?.value
      const found = Array.isArray(arg?.callbacks) ? arg.callbacks : []
      for (const { path, callback } of found) {
        if (typeof callback !== 'number' || !Array.isArray(path))
          throw new Error('A callback is sent by its number and place.')
        if (path.length === 0) {
          value = listener(callback, registrant)
          continue
        }
        // Only the argument's own plain objects and lists are walked: a path
        // naming `__proto__` or anything inherited reaches nothing.
        const ownPlace = (holder: unknown, step: string | number): boolean =>
          holder !== null &&
          typeof holder === 'object' &&
          (Array.isArray(holder)
            ? typeof step === 'number' && Number.isInteger(step) && step >= 0 && step < holder.length
            : typeof step === 'string' && step !== '__proto__' && Object.hasOwn(holder, step))
        let parent: unknown = value
        for (const step of path.slice(0, -1)) {
          if (!ownPlace(parent, step)) throw new Error('A callback names no place in its argument.')
          parent = (parent as Record<string | number, unknown>)[step]
        }
        const last = path[path.length - 1]!
        if (!ownPlace(parent, last)) throw new Error('A callback names no place in its argument.')
        ;(parent as Record<string | number, unknown>)[last] = listener(callback, registrant)
      }
      return value
    })
  }

  function keep(value: unknown): WorkerHandleRef {
    const id = nextHandle++
    handles.set(id, value)
    if (typeof value === 'function') return { handle: id, kind: 'function' }
    const members: Record<string, WorkerHandleMember> = {}
    for (const name of Object.keys(value as object)) {
      const member = Reflect.get(value as object, name) as unknown
      if (typeof member === 'function') members[name] = { fn: true }
      else if (isCapability(member)) members[name] = { nested: keep(member) }
      else members[name] = { value: member }
    }
    return { handle: id, kind: 'object', members }
  }

  async function dispatch(message: WorkerHostCallMessage, args: unknown[]): Promise<unknown> {
    const { target } = message
    if (target && typeof target === 'object' && 'host' in target) {
      const name = target.host
      if (!(WORKER_HOST_METHODS as readonly string[]).includes(name))
        throw Object.assign(new Error(`"${String(name)}" is not a host method an extension may call.`), {
          name: 'ExtensionHostRefusal',
          code: EXTENSION_HOST_REFUSALS.notPermitted,
        })
      const method = name as WorkerHostMethod
      switch (method) {
        case 'registerMethods':
        case 'registerMcpTools':
        case 'registerHooks': {
          const decision = deps.gate(method)
          if (!decision.ok)
            throw Object.assign(new Error(decision.message), { name: 'ExtensionHostRefusal', code: decision.code })
          if (method === 'registerMethods') deps.registerMethods(args[0])
          else if (method === 'registerMcpTools') deps.registerMcpTools(args[0])
          else deps.registerHooks(args[0])
          return undefined
        }
        case 'watchModuleAppState': {
          const stop = host.watchModuleAppState(args[0] as (values: Readonly<Record<string, unknown>>) => void)
          subscriptions.add(stop)
          return stop
        }
        default:
          return await (host[method] as (...given: unknown[]) => unknown)(...args)
      }
    }
    if (target && typeof target === 'object' && 'service' in target) {
      const service = host.requireService({ key: String(target.service) }) as Record<string, unknown>
      const member =
        typeof target.method === 'string' && Object.hasOwn(service, target.method) ? service[target.method] : undefined
      if (typeof member !== 'function')
        throw Object.assign(
          new Error(`Service "${String(target.service)}" has no method "${String(target.method)}".`),
          {
            name: 'ExtensionHostRefusal',
            code: EXTENSION_HOST_REFUSALS.notPermitted,
          },
        )
      const result = await (member as (...given: unknown[]) => unknown)(...args)
      if (typeof result === 'function') subscriptions.add(result as () => unknown)
      return result
    }
    if (target && typeof target === 'object' && 'handle' in target) {
      const kept = handles.get(target.handle)
      if (kept === undefined) throw new Error('That handle is not one Studio gave this worker.')
      let fn: unknown = kept
      if (target.member !== null) {
        fn =
          typeof target.member === 'string' && Object.hasOwn(kept as object, target.member)
            ? Reflect.get(kept as object, target.member)
            : undefined
      }
      if (typeof fn !== 'function') throw new Error('That handle has nothing of that name to call.')
      const result = await (fn as (...given: unknown[]) => unknown)(...args)
      // A stop function, called: it has done its work.
      if (target.member === null) subscriptions.delete(kept as () => unknown)
      if (typeof result === 'function') subscriptions.add(result as () => unknown)
      return result
    }
    throw new Error('A host call names a host method, a service or a handle.')
  }

  return {
    startActivation() {
      activation = begin(ownWork)
      return activation
    },
    activationStarted() {
      if (!deps.background && activation !== null) end(activation)
    },
    begin,
    end,
    run,
    live: () => invocations.size,
    async hostCall(message) {
      if (!open)
        return { ok: false, error: refusal('invocation_ended', `Extension "${extensionId}"'s worker was stopped.`) }
      const resolved = invokerFor(message.invocation)
      if (!resolved.ok) return { ok: false, error: resolved.error }
      try {
        const args = decodeArgs(message.args, resolved.invoker)
        const result = await runAsInvoker(resolved.invoker, () => dispatch(message, args))
        if (typeof result === 'function' || isCapability(result)) return { ok: true, handle: keep(result) }
        return { ok: true, value: result }
      } catch (error) {
        return { ok: false, error: toWorkerError(error) }
      }
    },
    close() {
      if (!open) return
      open = false
      for (const id of [...invocations.keys()]) end(id)
      for (const stop of subscriptions) {
        try {
          void Promise.resolve(stop()).catch(() => undefined)
        } catch {
          // Its stop refused (the extension is no longer approved): the host drops it when the load ends.
        }
      }
      subscriptions.clear()
      handles.clear()
      listeners.clear()
    },
  }
}
