// The script that runs first in every extension frame, before the extension's
// code: it keeps links, forms, popups and peer connections from leaving the frame,
// builds the frozen `studio` a surface's `mount` is handed, speaks the
// envelope to the window that drew it, and loads the entry.
//
// The envelope (`{ se: 1, kind, … }`, shared/extension-frames.ts) is the
// bridge's own: an extension sees only `studio`. The host knows the frame by
// the window its messages come from, never by anything the frame says, and
// checks every message against the frame's budget before it acts on it.
//
// Plain ES2019 in a string: it runs in the frame, not in the app.

import { EDITOR_DOCUMENT_SCRIPT } from '../../../../packages/extension-sdk/src/editor-document-script'
import { EXTENSION_FRAME_METHODS } from '../../../../packages/extension-sdk/src/services'
import { EXTENSION_FRAME_EVENTS as STUDIO_FRAME_EVENTS } from '../../../../packages/extension-sdk/src/events'
import { COMPONENTS_MODULE } from '../../../../packages/extension-sdk/src/source-modules'
import {
  COMPONENT_FRAME_MAX_TIMERS,
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
  'conflict',
  'missing',
]

export const FRAME_ROOT_ID = 'se-root'
/** The most lines a frame logs (`log.write`) in one window of `FRAME_LOG_WINDOW_MS`; past it, one notice. */
export const FRAME_LOG_LIMIT = 20
export const FRAME_LOG_WINDOW_MS = 10_000
export const FRAME_TOKENS_ID = 'se-tokens'

export type FrameBootstrapInput = {
  /** The entry's path in extension.json, for the words of a failure. */
  entryPath: string
  /**
   * The entry and every module it imports, each after what it imports, the
   * entry last (source-modules.ts): ES modules, the entry exporting `mount`.
   * In each, `<token><n>` stands for the module at index `n`.
   */
  modules: ReadonlyArray<{ path: string; code: string }>
  token: string
  /** Why its code cannot load, at its file and line: shown in the frame, and logged, instead of running it. */
  problem?: string
  /** The surface, before the host says which workspace it was opened in. */
  surface: { point: string; id: string }
  colorScheme: 'light' | 'dark'
  /**
   * A components panel: the entry's default export is booted by the
   * components module (COMPONENTS_MODULE, among `modules`), which renders
   * trees the window draws; the frame itself shows nothing.
   */
  components?: boolean
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
// Leaving the document is stopped outside it, where a frame cannot undo it:
// the desktop shell refuses the navigation, and the window closes a surface
// whose frame loads a second document. Links and forms here are only kept
// from starting one.
// The policy has no directive for peer connections, which would be a way out.
// Every WebRTC interface goes, for good (not configurable), before the
// extension's code runs. No child frame runs script, so no fresh realm
// brings them back (frame-document.ts says why).
Object.getOwnPropertyNames(window).filter(function (name) {
  return /^(webkit)?RTC/.test(name)
}).concat(['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']).forEach(function (name) {
  try { Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false, enumerable: false }) } catch (_) {}
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
    studioEvents: STUDIO_FRAME_EVENTS,
    maxPending: EXTENSION_FRAME_MAX_PENDING,
    deadlineMs: EXTENSION_FRAME_CALL_DEADLINE_MS,
    rootId: FRAME_ROOT_ID,
    tokensId: FRAME_TOKENS_ID,
    surface: input.surface,
    colorScheme: input.colorScheme,
    entryPath: input.entryPath,
    modules: input.modules,
    token: input.token,
    problem: input.problem ?? null,
    logLimit: FRAME_LOG_LIMIT,
    logWindowMs: FRAME_LOG_WINDOW_MS,
    components: input.components === true,
    componentsModule: COMPONENTS_MODULE,
    maxTimers: COMPONENT_FRAME_MAX_TIMERS,
  })
  return `${PRELUDE};(function (C) {
  var E = C.events
  // The window that drew the frame: its parent on desktop; in a browser tab
  // the frame sits in Studio's wrapper document, so the window is the top.
  var host = window.top
  var nextId = 1
  var pending = new Map()
  var listeners = { theme: new Set(), push: new Set() }
  // The Studio events: the first listener for one subscribes, through the host gate.
  C.studioEvents.forEach(function (name) { listeners[name] = new Set() })
  var theme = { colorScheme: C.colorScheme }
  var surface = Object.freeze(C.surface)
  var started = false
  var readied = false
  function post(message) {
    message.se = C.protocol
    try { host.postMessage(message, '*') } catch (_) {}
  }
  // A components panel's frame is not drawn (display: none), and the browser
  // runs an undrawn frame's timers about once a second. Its timers are kept by
  // the window instead: the frame says when ('timer'), the window wakes it then
  // ('wake'), and a timer cleared before that is cleared there too ('clear'),
  // so its slot comes back on both sides at once. Past C.maxTimers held at
  // once, or for a handler that is not a function, the frame's own timers
  // take over.
  if (C.components) (function () {
    var nativeSet = window.setTimeout.bind(window)
    var nativeClear = window.clearTimeout.bind(window)
    var nativeSetInterval = window.setInterval.bind(window)
    var nativeClearInterval = window.clearInterval.bind(window)
    var timers = new Map()
    var nextTimer = 1
    // Ids the window holds a timer for (odd, apart from the frame's own, which are even).
    var held = new Set()
    function delayOf(ms) {
      ms = Number(ms)
      return ms > 0 && ms < 2147483647 ? Math.floor(ms) : 0
    }
    function arm(id, timer) {
      held.add(id)
      post({ kind: 'timer', id: id, ms: timer.ms })
    }
    function schedule(handler, ms, args, repeat) {
      if (typeof handler !== 'function' || held.size >= C.maxTimers) return null
      var id = nextTimer
      nextTimer += 2
      var timer = { handler: handler, args: args, ms: repeat ? Math.max(4, delayOf(ms)) : delayOf(ms), repeat: repeat }
      timers.set(id, timer)
      arm(id, timer)
      return id
    }
    window.addEventListener('message', function (event) {
      if (event.source !== host) return
      var message = event.data
      if (!message || message.se !== C.protocol || message.kind !== 'wake' || typeof message.id !== 'number') return
      // A wake already on its way when the timer was cleared: its slot is back already.
      if (!held.delete(message.id)) return
      var timer = timers.get(message.id)
      if (!timer) return
      if (timer.repeat) arm(message.id, timer)
      else timers.delete(message.id)
      try { timer.handler.apply(window, timer.args) } catch (error) { setTimeout(function () { throw error }) }
    })
    window.setTimeout = function (handler, ms) {
      var id = schedule(handler, ms, Array.prototype.slice.call(arguments, 2), false)
      return id === null ? nativeSet.apply(null, arguments) * 2 : id
    }
    window.setInterval = function (handler, ms) {
      var id = schedule(handler, ms, Array.prototype.slice.call(arguments, 2), true)
      return id === null ? nativeSetInterval.apply(null, arguments) * 2 : id
    }
    window.clearTimeout = window.clearInterval = function (id) {
      id = Number(id)
      if (id % 2 === 1) {
        timers.delete(id)
        if (held.delete(id)) post({ kind: 'clear', id: id })
      } else if (id > 0) { nativeClear(id / 2); nativeClearInterval(id / 2) }
    }
  })()
  function failure(code, message, retryable, document, retryAfterMs) {
    var error = new Error(String(message || 'The host call failed.'))
    error.code = C.codes.indexOf(code) >= 0 ? code : 'action_failed'
    error.retryable = Boolean(retryable)
    if (document) error.document = document
    if (typeof retryAfterMs === 'number' && retryAfterMs > 0) error.retryAfterMs = retryAfterMs
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
        if (message.error) reject(failure(message.error.code, message.error.message, message.error.retryable, message.error.document, message.error.retryAfterMs))
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
  // Where the extension's code is: each module's blob URL, by the file it came from.
  // Studio's components module is named apart, so a place is always the extension's own.
  var sources = {}
  var studioModules = {}
  function located(text) {
    var out = String(text)
    Object.keys(sources).forEach(function (url) { out = out.split(url).join(sources[url]) })
    Object.keys(studioModules).forEach(function (url) { out = out.split(url).join(studioModules[url]) })
    return out
  }
  // The first place in a stack that is the extension's own file, as file:line:col.
  function placeOf(error) {
    var stack = error && typeof error.stack === 'string' ? error.stack : ''
    var urls = Object.keys(sources)
    var lines = stack.split('\\n')
    for (var i = 0; i < lines.length; i++) {
      for (var j = 0; j < urls.length; j++) {
        var at = lines[i].indexOf(urls[j] + ':')
        if (at < 0) continue
        var rest = /^:(\\d+):(\\d+)/.exec(lines[i].slice(at + urls[j].length))
        if (rest) return sources[urls[j]] + ':' + rest[1] + ':' + rest[2]
      }
    }
    return ''
  }
  // What the frame prints reaches the extension's log as [frame] lines, at
  // most C.logLimit in each C.logWindowMs, and the same line once a window.
  var logged = 0
  var logWindow = 0
  var seen = {}
  var noticed = false
  function log(level, message) {
    var now = Date.now()
    if (now - logWindow > C.logWindowMs) { logWindow = now; logged = 0; seen = {}; noticed = false }
    var line = located(message).slice(0, 2000)
    if (seen[line]) return
    seen[line] = true
    if (logged >= C.logLimit) {
      if (noticed) return
      noticed = true
      line = 'More lines were dropped: a frame logs at most ' + C.logLimit + ' every ' + (C.logWindowMs / 1000) + ' s.'
    }
    logged++
    call('log.write', { level: level, message: line }).catch(function () {})
  }
  function describe(value) {
    if (value instanceof Error) {
      var place = placeOf(value)
      return (place ? place + ' ' : '') + String(value.message || value)
    }
    if (typeof value === 'string') return value
    try { return JSON.stringify(value) } catch (_) { return String(value) }
  }
  ;['error', 'warn'].forEach(function (level) {
    var original = console[level]
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments)
      try { log(level === 'warn' ? 'warn' : 'error', args.map(describe).join(' ')) } catch (_) {}
      return original.apply(console, args)
    }
  })
  window.addEventListener('error', function (event) {
    var file = event.filename && sources[event.filename]
    var place = file ? file + ':' + event.lineno + ':' + event.colno + ' ' : (event.error ? (placeOf(event.error) ? placeOf(event.error) + ' ' : '') : '')
    log('error', place + String(event.message || (event.error && event.error.message) || 'An error was thrown.'))
  })
  window.addEventListener('unhandledrejection', function (event) {
    log('error', 'Unhandled rejection: ' + describe(event.reason))
  })
  function fail(error) {
    var message = located(error instanceof Error ? describe(error) : String((error && error.message) || error)).slice(0, 500)
    log('error', message)
    var root = document.getElementById(C.rootId)
    if (root) {
      var line = document.createElement('p')
      line.className = 'se-failed'
      line.textContent = 'This extension could not draw: ' + message
      root.replaceChildren(line)
    }
    post({ kind: 'evt', event: E.failed, payload: { message: message } })
  }
  // A custom editor's document (EDITOR_DOCUMENT_SCRIPT): the window hands it
  // over and takes its edits; the frame never sees the file's path.
  var editor = C.surface.point === 'customEditors'
  var documentListeners = { document: new Set(), 'document.flush': new Set() }
  var document_ = editor ? (${input.surface.point === 'customEditors' ? EDITOR_DOCUMENT_SCRIPT : 'null'})({
    call: function (method, params) { return call(method, params) },
    on: function (name, listener) {
      documentListeners[name].add(listener)
      return function () { documentListeners[name].delete(listener) }
    },
    post: function (name, payload) { post({ kind: 'evt', event: name, payload: payload }) }
  }) : undefined
  if (editor) {
    // Cmd/Ctrl+S inside the frame saves the file, as it does in Studio's own editor.
    window.addEventListener('keydown', function (event) {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && String(event.key).toLowerCase() === 's') {
        event.preventDefault()
        post({ kind: 'evt', event: E.documentSave, payload: {} })
      }
    }, true)
  }
  var studio = Object.freeze({
    api: Object.freeze({ version: 1 }),
    get surface() { return surface },
    get document() { return document_ },
    host: Object.freeze({
      call: call,
      has: function (method) { return C.methods.indexOf(String(method)) >= 0 }
    }),
    methods: methods,
    get theme() { return { colorScheme: theme.colorScheme } },
    on: function (name, listener) {
      if (!Object.prototype.hasOwnProperty.call(listeners, name) || typeof listener !== 'function')
        throw new TypeError('studio.on takes "theme", "push" or one of the Studio events (' + C.studioEvents.join(', ') + '), and a function.')
      var entry = function (payload) { listener(payload) }
      if (C.studioEvents.indexOf(name) >= 0 && listeners[name].size === 0) {
        call('events.subscribe', { event: name }).catch(function (error) { console.error(error) })
      }
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
    if (typeof workspaceId === 'string' && (C.surface.point === 'panels' || C.surface.point === 'customEditors')) {
      surface = Object.freeze({ point: C.surface.point, id: C.surface.id, workspaceId: workspaceId })
    }
    document.documentElement.removeAttribute('data-se-waiting')
    if (C.problem) return fail(C.problem)
    // Each module after the ones it imports: their tokens become their URLs.
    var urls = []
    // The token is letters, digits and dashes (source-modules.ts): nothing to escape.
    var pattern = new RegExp(C.token + '([0-9]+)', 'g')
    C.modules.forEach(function (module, index) {
      var code = module.code.replace(pattern, function (_, n) { return urls[Number(n)] || '' })
      var url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
      urls[index] = url
      if (C.components && module.path === C.componentsModule) studioModules[url] = module.path
      else sources[url] = module.path
    })
    if (C.components) {
      var runtimeUrl = Object.keys(studioModules)[0]
      if (!runtimeUrl) return fail(new Error('This Studio could not load the components module.'))
      Promise.all([import(runtimeUrl), import(urls[urls.length - 1])]).then(function (loaded) {
        return loaded[0].bootComponentsPanel(componentsBridge, loaded[1])
      }).catch(fail)
      return
    }
    import(urls[urls.length - 1]).then(function (entry) {
      if (!entry || typeof entry.mount !== 'function') throw new Error(C.entryPath + ' must export mount(root, studio).')
      return entry.mount(document.getElementById(C.rootId), studio)
    }).catch(fail)
  }
  // A components panel's runtime speaks the ui.* events over this; it reaches
  // Studio only through the same calls and events as any frame.
  var uiListeners = {}
  // What the runtime sends as the document unloads, before the window hears it is leaving.
  var leaveHooks = new Set()
  var context = { locale: 'en', client: 'desktop' }
  var componentsBridge = {
    post: function (event, payload) { post({ kind: 'evt', event: String(event), payload: payload }) },
    on: function (event, handler) {
      if (event === 'theme') return studio.on('theme', handler)
      var set = uiListeners[event] || (uiListeners[event] = new Set())
      set.add(handler)
      return { dispose: function () { set.delete(handler) } }
    },
    call: call,
    has: function (method) { return C.methods.indexOf(String(method)) >= 0 },
    listen: function (event, handler) { return studio.on(event, handler) },
    get surface() { return { id: surface.id, workspaceId: surface.workspaceId } },
    get colorScheme() { return theme.colorScheme },
    get locale() { return context.locale },
    get client() { return context.client },
    describe: function (error) { return located(describe(error)) },
    onLeave: function (flush) {
      leaveHooks.add(flush)
      return { dispose: function () { leaveHooks.delete(flush) } }
    }
  }
  window.addEventListener('message', function (event) {
    if (event.source !== host) return
    var message = event.data
    if (!message || message.se !== C.protocol) return
    if (message.kind === 'res') {
      var settle = pending.get(message.id)
      if (settle) { pending.delete(message.id); settle(message) }
    } else if (message.kind === 'evt' && C.components && typeof message.event === 'string' && message.event.indexOf('ui.') === 0) {
      Array.from(uiListeners[message.event] || []).forEach(function (listener) {
        try { listener(message.payload) } catch (error) { console.error(error) }
      })
    } else if (message.kind === 'evt' && message.event === E.leave) {
      leave()
    } else if (message.kind === 'evt' && message.event === E.hello) {
      var hello = message.payload || {}
      if (typeof hello.locale === 'string') context.locale = hello.locale.slice(0, 35)
      if (hello.client === 'web' || hello.client === 'desktop') context.client = hello.client
      applyTheme(hello.theme)
      start(hello.workspaceId)
    } else if (message.kind === 'evt' && message.event === E.theme) {
      if (applyTheme(message.payload)) emit('theme', { colorScheme: theme.colorScheme })
    } else if (message.kind === 'evt' && editor && (message.event === E.document || message.event === E.documentFlush)) {
      Array.from(documentListeners[message.event]).forEach(function (listener) {
        try { listener(message.payload) } catch (error) { console.error(error) }
      })
    } else if (message.kind === 'evt' && message.event === E.studio) {
      var heard = message.payload
      if (heard && C.studioEvents.indexOf(heard.event) >= 0) emit(heard.event, heard.payload)
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
  // Registered before the extension's code runs, so nothing it does comes
  // first: the window drops the bridge as soon as this document unloads.
  // A components panel's last writes go first: the window drops whatever follows the leaving event.
  // Once: the window asks first when the surface closes (\`leave\`), and the
  // document unloading says it again.
  var left = false
  function leave() {
    if (left) return
    left = true
    Array.from(leaveHooks).forEach(function (flush) {
      try { flush() } catch (error) { console.error(error) }
    })
    post({ kind: 'evt', event: E.leaving, payload: {} })
  }
  window.addEventListener('pagehide', leave)
  post({ kind: 'evt', event: E.ready, payload: {} })
})(${config})
`
}
