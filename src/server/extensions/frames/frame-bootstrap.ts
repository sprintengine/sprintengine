// The script that runs first in every extension frame, before the extension's
// code: it fences the frame (no navigation, no popups, no peer connections),
// builds the frozen `studio` a surface's `mount` is handed, speaks the
// envelope to the window that drew it, and loads the entry.
//
// The envelope (`{ se: 1, kind, … }`, shared/extension-frames.ts) is the
// bridge's own: an extension sees only `studio`. The host knows the frame by
// the window its messages come from, never by anything the frame says, and
// checks every message against the frame's budget before it acts on it.
//
// Plain ES2019 in a string: it runs in the frame, not in the app.

import { EXTENSION_FRAME_METHODS } from '../../../../packages/extension-sdk/src/services'
import {
  EXTENSION_FRAME_CALL_DEADLINE_MS,
  EXTENSION_FRAME_EVENTS,
  EXTENSION_FRAME_MAX_PENDING,
  EXTENSION_FRAME_PROTOCOL,
} from '../../../shared/extension-frames'

/** The codes a host call may reject with; anything else reads as `action_failed`. */
const FRAME_ERROR_CODES = [
  'not_permitted',
  'approval_required',
  'unknown_method',
  'invalid_params',
  'rate_limited',
  'too_large',
  'unavailable',
  'timeout',
  'cancelled',
  'action_failed',
]

export const FRAME_ROOT_ID = 'se-root'
export const FRAME_TOKENS_ID = 'se-tokens'

export type FrameBootstrapInput = {
  /** The entry's path in extension.json, for the words of a failure. */
  entryPath: string
  /** The entry's source: an ES module exporting `mount`. */
  entryCode: string
  /** The surface, before the host says which workspace it was opened in. */
  surface: { point: string; id: string }
  colorScheme: 'light' | 'dark'
}

/** JSON safe to put inside an inline `<script>`. */
export function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029')
}

const PRELUDE = `'use strict'
// A frame is a document, never a browsing context: it does not navigate.
if (window.navigation && typeof window.navigation.addEventListener === 'function') {
  window.navigation.addEventListener('navigate', function (event) { if (event.cancelable) event.preventDefault() })
}
// The policy has no directive for peer connections, which would be a way out.
;['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel'].forEach(function (name) {
  try { Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false }) } catch (_) {}
})
try { Object.defineProperty(window, 'open', { value: function () { return null }, writable: false, configurable: false }) } catch (_) {}
window.addEventListener('click', function (event) {
  var node = event.target
  while (node && node !== document) {
    if (node.nodeType === 1 && (node.tagName === 'A' || node.tagName === 'AREA') && node.hasAttribute('href')) {
      event.preventDefault()
      return
    }
    node = node.parentNode
  }
}, true)
window.addEventListener('submit', function (event) { event.preventDefault() }, true)
`

/** The whole script, its configuration inlined. */
export function frameBootstrapScript(input: FrameBootstrapInput): string {
  const config = inlineJson({
    protocol: EXTENSION_FRAME_PROTOCOL,
    events: EXTENSION_FRAME_EVENTS,
    codes: FRAME_ERROR_CODES,
    methods: Object.keys(EXTENSION_FRAME_METHODS),
    maxPending: EXTENSION_FRAME_MAX_PENDING,
    deadlineMs: EXTENSION_FRAME_CALL_DEADLINE_MS,
    rootId: FRAME_ROOT_ID,
    tokensId: FRAME_TOKENS_ID,
    surface: input.surface,
    colorScheme: input.colorScheme,
    entryPath: input.entryPath,
    entry: input.entryCode,
  })
  return `${PRELUDE};(function (C) {
  var E = C.events
  var parent = window.parent
  var nextId = 1
  var pending = new Map()
  var listeners = { theme: new Set(), push: new Set() }
  var theme = { colorScheme: C.colorScheme }
  var surface = Object.freeze(C.surface)
  var started = false
  var readied = false
  function post(message) {
    message.se = C.protocol
    try { parent.postMessage(message, '*') } catch (_) {}
  }
  function failure(code, message, retryable) {
    var error = new Error(String(message || 'The host call failed.'))
    error.code = C.codes.indexOf(code) >= 0 ? code : 'action_failed'
    error.retryable = Boolean(retryable)
    return error
  }
  function call(method, params, options) {
    var signal = options && options.signal
    if (signal && signal.aborted) return Promise.reject(failure('cancelled', 'The call was cancelled.'))
    // Bounded and deadlined: a lost answer never leaves a call, or the map, waiting for ever.
    if (pending.size >= C.maxPending) return Promise.reject(failure('rate_limited', 'Too many calls are waiting.', true))
    var id = nextId++
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        if (!pending.delete(id)) return
        post({ kind: 'cancel', id: id })
        reject(failure('timeout', 'Studio did not answer in time.', true))
      }, C.deadlineMs)
      function abort() {
        clearTimeout(timer)
        if (!pending.delete(id)) return
        post({ kind: 'cancel', id: id })
        reject(failure('cancelled', 'The call was cancelled.'))
      }
      if (signal) signal.addEventListener('abort', abort, { once: true })
      pending.set(id, function (message) {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', abort)
        if (message.error) reject(failure(message.error.code, message.error.message, message.error.retryable))
        else resolve(message.result)
      })
      post({ kind: 'req', id: id, method: String(method), params: params === undefined ? {} : params })
    })
  }
  function methods() {
    function answered(kind, name, params) {
      return call(kind, { method: String(name), params: params }).catch(function (error) {
        return { ok: false, code: (error && error.code) || 'unavailable', message: String(error && error.message || error) }
      })
    }
    return Object.freeze({
      read: function (name, params) { return answered('worker.read', name, params) },
      operate: function (name, params) { return answered('worker.operate', name, params) }
    })
  }
  function emit(name, payload) {
    Array.from(listeners[name]).forEach(function (listener) {
      try { listener(payload) } catch (error) { console.error(error) }
    })
  }
  function applyTheme(next) {
    if (!next || (next.colorScheme !== 'light' && next.colorScheme !== 'dark')) return false
    var root = document.documentElement
    root.classList.remove('light', 'dark')
    root.classList.add(next.colorScheme)
    if (next.tokens && typeof next.tokens === 'object') {
      var css = ''
      Object.keys(next.tokens).forEach(function (name) {
        var value = next.tokens[name]
        if (/^--[a-z0-9-]+$/.test(name) && typeof value === 'string') css += name + ':' + value.replace(/[{}<>;]/g, '') + ';'
      })
      var tokens = document.getElementById(C.tokensId)
      if (tokens) tokens.textContent = ':root{' + css + '}'
    }
    theme = { colorScheme: next.colorScheme }
    return true
  }
  function fail(error) {
    var message = String((error && error.message) || error).slice(0, 500)
    var root = document.getElementById(C.rootId)
    if (root) {
      var line = document.createElement('p')
      line.className = 'se-failed'
      line.textContent = 'This extension could not draw: ' + message
      root.replaceChildren(line)
    }
    post({ kind: 'evt', event: E.failed, payload: { message: message } })
  }
  var studio = Object.freeze({
    api: Object.freeze({ version: 1 }),
    get surface() { return surface },
    host: Object.freeze({
      call: call,
      has: function (method) { return C.methods.indexOf(String(method)) >= 0 }
    }),
    methods: methods,
    get theme() { return { colorScheme: theme.colorScheme } },
    on: function (name, listener) {
      if (!listeners[name] || typeof listener !== 'function') throw new TypeError('studio.on takes "theme" or "push", and a function.')
      var entry = function (payload) { listener(payload) }
      listeners[name].add(entry)
      return Object.freeze({ dispose: function () { listeners[name].delete(entry) } })
    },
    ready: function () {
      if (readied) return
      readied = true
      post({ kind: 'evt', event: E.surfaceReady, payload: { at: performance.timeOrigin + performance.now() } })
    }
  })
  function start(workspaceId) {
    if (started) return
    started = true
    if (typeof workspaceId === 'string' && C.surface.point === 'panels') {
      surface = Object.freeze({ point: C.surface.point, id: C.surface.id, workspaceId: workspaceId })
    }
    document.documentElement.removeAttribute('data-se-waiting')
    var url = URL.createObjectURL(new Blob([C.entry], { type: 'text/javascript' }))
    import(url).then(function (entry) {
      URL.revokeObjectURL(url)
      if (!entry || typeof entry.mount !== 'function') throw new Error(C.entryPath + ' must export mount(root, studio).')
      return entry.mount(document.getElementById(C.rootId), studio)
    }).catch(fail)
  }
  window.addEventListener('message', function (event) {
    if (event.source !== parent) return
    var message = event.data
    if (!message || message.se !== C.protocol) return
    if (message.kind === 'res') {
      var settle = pending.get(message.id)
      if (settle) { pending.delete(message.id); settle(message) }
    } else if (message.kind === 'evt' && message.event === E.hello) {
      var hello = message.payload || {}
      applyTheme(hello.theme)
      start(hello.workspaceId)
    } else if (message.kind === 'evt' && message.event === E.theme) {
      if (applyTheme(message.payload)) emit('theme', { colorScheme: theme.colorScheme })
    } else if (message.kind === 'evt' && message.event === E.push) {
      var push = message.payload
      if (push && typeof push.topic === 'string') emit('push', push.payload === undefined ? { topic: push.topic } : { topic: push.topic, payload: push.payload })
    }
  })
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        if (entry.name === 'first-contentful-paint') post({ kind: 'evt', event: E.paint, payload: { at: performance.timeOrigin + entry.startTime } })
      })
    }).observe({ type: 'paint', buffered: true })
  } catch (_) {}
  post({ kind: 'evt', event: E.ready, payload: {} })
})(${config})
`
}
