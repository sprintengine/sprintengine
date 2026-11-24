// What a components panel imports beside the components: the host facade
// frame panels have (`host.call`, `host.has`), Studio's events (`on`), the
// window's environment (`env`), the catalogue (`ui`), and the extension's own
// storage, settings, secrets and worker. Each goes through the hidden guest's
// bridge to the window, and from there to Studio's gate, as a frame's calls do.

import { COMPONENT_CATALOG_VERSION, componentPropNames, isComponentName } from '../catalog.js'
import { isReservedComponentEvent } from '../messages.js'
import type { ComponentsBridge, Disposable, Theme } from './renderer.js'

export type HostCallOptions = { signal?: AbortSignal; timeoutMs?: number }

function hostError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, retryable: code === 'timeout' })
}

const NOTHING: Disposable = { dispose: () => undefined }

export function createComponentsSdk(source: { bridge: () => ComponentsBridge | null; theme: () => Theme }) {
  function unavailable(what: string): Promise<never> {
    return Promise.reject(hostError('unavailable', `${what} is only available while the panel runs in Studio.`))
  }

  const host = Object.freeze({
    call(method: string, params?: unknown, options: HostCallOptions = {}): Promise<unknown> {
      const bridge = source.bridge()
      if (!bridge) return unavailable('host.call')
      const { signal, timeoutMs } = options
      if (timeoutMs === undefined) return bridge.call(method, params, signal ? { signal } : undefined)
      const controller = new AbortController()
      const forward = (): void => controller.abort()
      if (signal?.aborted) controller.abort()
      signal?.addEventListener('abort', forward, { once: true })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
      return bridge
        .call(method, params, { signal: controller.signal })
        .catch((error: unknown) => {
          throw timedOut ? hostError('timeout', `${method} took longer than ${timeoutMs} ms.`) : error
        })
        .finally(() => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', forward)
        })
    },
    has(method: string): boolean {
      return source.bridge()?.has(method) === true
    },
  })

  const env = Object.freeze({
    /** Studio's language (BCP 47). */
    get locale(): string {
      return source.bridge()?.locale ?? 'en'
    },
    /** Reading it while rendering renders again when the person switches light and dark. */
    get theme(): Theme {
      return source.theme()
    },
    /** Which client draws the panel: a desktop window (local or paired) or the web client. */
    get client(): 'desktop' | 'web' {
      return source.bridge()?.client ?? 'desktop'
    },
  })

  const shell = Object.freeze({
    /** Open an `https:`, `http:` or `mailto:` URL in the system browser; needs a press on a still control. */
    openExternal(url: string): Promise<unknown> {
      return host.call('shell.openExternal', { url: String(url) })
    },
  })

  /**
   * Hear one of Studio's events (with its read permission, as frames do), or
   * the theme. Returns a Disposable; the panel's own wire traffic is refused.
   */
  function on(event: string, handler: (payload: unknown) => void): Disposable {
    if (typeof event !== 'string' || isReservedComponentEvent(event))
      throw new TypeError(`"${String(event)}" is not an event a panel can follow.`)
    if (typeof handler !== 'function') throw new TypeError('on() takes a handler function.')
    const bridge = source.bridge()
    if (!bridge) return NOTHING
    if (event === 'theme') return bridge.on('theme', handler)
    return bridge.listen(event, handler)
  }

  const ui = Object.freeze({
    /** Grows with the component catalogue. */
    catalog: COMPONENT_CATALOG_VERSION,
    /** Whether Studio draws `component`, and takes `prop` on it when given. */
    has(component: string, prop?: string): boolean {
      if (!isComponentName(component)) return false
      return prop === undefined || componentPropNames(component).includes(prop)
    },
  })

  /** The answer of a storage call, or its refusal thrown with the code. */
  function unwrap<T>(answer: unknown, pick: (answer: Record<string, unknown>) => T): T {
    const record = (answer ?? {}) as Record<string, unknown>
    if (record.ok === false)
      throw hostError(String(record.code ?? 'action_failed'), String(record.message ?? 'Storage refused.'))
    return pick(record)
  }
  type Scope = { workspaceId?: string }
  const storage = Object.freeze({
    async get(key: string, scope: Scope = {}): Promise<unknown> {
      return unwrap(await host.call('storage.get', { key, ...scope }), (answer) =>
        answer.found === true ? answer.value : undefined,
      )
    },
    async set(key: string, value: unknown, scope: Scope = {}): Promise<void> {
      unwrap(await host.call('storage.set', { key, value, ...scope }), () => undefined)
    },
    async delete(key: string, scope: Scope = {}): Promise<void> {
      unwrap(await host.call('storage.delete', { key, ...scope }), () => undefined)
    },
    async keys(scope: Scope & { prefix?: string } = {}): Promise<string[]> {
      return unwrap(await host.call('storage.list', scope), (answer) =>
        Array.isArray(answer.keys) ? (answer.keys as string[]) : [],
      )
    },
  })

  const settings = Object.freeze({
    /** Its Settings values, or one of them. */
    async get(key?: string): Promise<unknown> {
      const values = ((await host.call('settings.get', {})) ?? {}) as Record<string, unknown>
      return key === undefined ? values : values[key]
    },
    async set(key: string, value: unknown): Promise<void> {
      await host.call('settings.set', { key, value })
    },
  })

  const secrets = Object.freeze({
    /** Whether a secret is set. Its value never reaches a panel: the worker uses it. */
    async has(key: string): Promise<boolean> {
      const answer = (await host.call('secrets.has', { key })) as { has?: unknown } | null
      return answer?.has === true
    },
    /** Store a secret, and the https origins the worker may send it to. */
    async set(key: string, value: string, options: { allowedOrigins: string[] }): Promise<void> {
      unwrap(await host.call('secrets.set', { key, value, allowedOrigins: options.allowedOrigins }), () => undefined)
    },
    async delete(key: string): Promise<void> {
      unwrap(await host.call('secrets.delete', { key }), () => undefined)
    },
  })

  /** The extension's worker: its declared methods, and the events it posts (`push`). */
  const worker = Object.freeze({
    read(method: string, params?: unknown): Promise<unknown> {
      return host.call('worker.read', { method, ...(params === undefined ? {} : { params }) })
    },
    operate(method: string, params?: unknown): Promise<unknown> {
      return host.call('worker.operate', { method, ...(params === undefined ? {} : { params }) })
    },
    /** Hear the worker's events (`MainHost.emit`) of one topic, or every one with `'*'`. */
    on(topic: string, handler: (payload: unknown) => void): Disposable {
      const bridge = source.bridge()
      if (!bridge) return NOTHING
      return bridge.listen('push', (message) => {
        const heard = message as { topic?: unknown; payload?: unknown }
        if (topic === '*' || heard.topic === topic) handler(topic === '*' ? heard : heard.payload)
      })
    },
  })

  return { host, env, shell, on, ui, storage, settings, secrets, worker }
}
