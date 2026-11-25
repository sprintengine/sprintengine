// What a components panel imports beside the components: the host facade
// frame panels have (`host.call`, `host.has`), Studio's events (`on`), the
// window's environment (`env`), the catalogue (`ui`), and the extension's own
// storage, settings, secrets and worker. Each goes through the hidden guest's
// bridge to the window, and from there to Studio's gate, as a frame's calls do.

import type { ExtensionFrameMethod, ExtensionFrameMethods } from '../../frame.js'
import { COMPONENT_CATALOG_VERSION, componentPropNames, isComponentName } from '../catalog.js'
import { isReservedComponentEvent } from '../messages.js'
import type { ComponentsBridge, Disposable, Theme } from './renderer.js'

export type HostCallOptions = { signal?: AbortSignal; timeoutMs?: number }

function hostError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, retryable: code === 'timeout' })
}

export function createComponentsSdk(source: { bridge: () => ComponentsBridge | null; theme: () => Theme }) {
  /**
   * The bridge, or a clear error: a module's top level runs before Studio
   * starts the panel, so what it calls there would reach nothing.
   */
  function running(what: string): ComponentsBridge {
    const bridge = source.bridge()
    if (!bridge)
      throw hostError(
        'unavailable',
        `${what} was called before the panel runs; call it from setup(ctx) or a handler, not at the top level of the module.`,
      )
    return bridge
  }

  function call(method: string, params?: unknown, options: HostCallOptions = {}): Promise<unknown> {
    const bridge = running(`host.call("${String(method)}")`)
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
  }

  const host = Object.freeze({
    /** Ask Studio to do one thing, typed as frame panels' `studio.host.call` is; rejects with the refusal's `code`. */
    call<M extends ExtensionFrameMethod>(
      method: M,
      params: ExtensionFrameMethods[M]['params'],
      options: HostCallOptions = {},
    ): Promise<ExtensionFrameMethods[M]['result']> {
      return call(method, params, options) as Promise<ExtensionFrameMethods[M]['result']>
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
      return call('shell.openExternal', { url: String(url) })
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
    const bridge = running(`on("${event}")`)
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
      return unwrap(await call('storage.get', { key, ...scope }), (answer) =>
        answer.found === true ? answer.value : undefined,
      )
    },
    async set(key: string, value: unknown, scope: Scope = {}): Promise<void> {
      unwrap(await call('storage.set', { key, value, ...scope }), () => undefined)
    },
    async delete(key: string, scope: Scope = {}): Promise<void> {
      unwrap(await call('storage.delete', { key, ...scope }), () => undefined)
    },
    async keys(scope: Scope & { prefix?: string } = {}): Promise<string[]> {
      return unwrap(await call('storage.list', scope), (answer) =>
        Array.isArray(answer.keys) ? (answer.keys as string[]) : [],
      )
    },
  })

  const settings = Object.freeze({
    /** Its Settings values, or one of them. */
    async get(key?: string): Promise<unknown> {
      const values = ((await call('settings.get', {})) ?? {}) as Record<string, unknown>
      return key === undefined ? values : values[key]
    },
    async set(key: string, value: unknown): Promise<void> {
      await call('settings.set', { key, value })
    },
    /**
     * Hear its Settings values change (in Studio's Settings, or by any other
     * writer), handed the values as they are now. Needs `settings:own`, and
     * whoever opened the panel must be able to read them.
     */
    onDidChange(handler: (values: Readonly<Record<string, unknown>>) => void): Disposable {
      if (typeof handler !== 'function') throw new TypeError('settings.onDidChange() takes a handler function.')
      const bridge = running('settings.onDidChange()')
      return bridge.listen('settings.changed', () => {
        void (async () => {
          try {
            handler(Object.freeze(((await call('settings.get', {})) ?? {}) as Record<string, unknown>))
          } catch (error) {
            console.error(error)
          }
        })()
      })
    },
  })

  const secrets = Object.freeze({
    /** Whether a secret is set. Its value never reaches a panel: the worker uses it. */
    async has(key: string): Promise<boolean> {
      const answer = (await call('secrets.has', { key })) as { has?: unknown } | null
      return answer?.has === true
    },
    /** Store a secret, and the https origins the worker may send it to. */
    async set(key: string, value: string, options: { allowedOrigins: string[] }): Promise<void> {
      unwrap(await call('secrets.set', { key, value, allowedOrigins: options.allowedOrigins }), () => undefined)
    },
    async delete(key: string): Promise<void> {
      unwrap(await call('secrets.delete', { key }), () => undefined)
    },
  })

  /** The extension's worker: its declared methods, and the events it posts (`push`). */
  const worker = Object.freeze({
    read(method: string, params?: unknown): Promise<unknown> {
      return call('worker.read', { method, ...(params === undefined ? {} : { params }) })
    },
    operate(method: string, params?: unknown): Promise<unknown> {
      return call('worker.operate', { method, ...(params === undefined ? {} : { params }) })
    },
    /** Hear the worker's events (`MainHost.emit`) of one topic, or every one with `'*'`. */
    on(topic: string, handler: (payload: unknown) => void): Disposable {
      const bridge = running(`worker.on("${String(topic)}")`)
      return bridge.listen('push', (message) => {
        const heard = message as { topic?: unknown; payload?: unknown }
        if (topic === '*' || heard.topic === topic) handler(topic === '*' ? heard : heard.payload)
      })
    },
  })

  /** The version of this module's shape, as frame panels' `studio.api.version`. */
  const api = Object.freeze({ version: 1 as const })

  return { api, host, env, shell, on, ui, storage, settings, secrets, worker }
}
