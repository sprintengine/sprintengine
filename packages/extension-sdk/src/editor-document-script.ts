// `studio.document` in a custom editor's frame: the file's content as Studio
// hands it over, whole-document edits back, and `session()`, the sync every
// editor would otherwise write for itself.
//
// One implementation, as source: the frame's bootstrap inlines it (it runs
// in the frame, before the extension's code), and the SDK's fake frame
// studio evaluates the same text in Node, so what an author tests is what
// runs. Plain ES2019, and it reaches nothing but the port it is handed:
//
//   port.call(method, params) → Promise   a request to the window ('document.applyEdit')
//   port.on(event, listener) → dispose    the window's events ('document', 'document.flush')
//   port.post(event, payload)             an event to the window ('document.flushed')
//
// Versions: Studio numbers each document it hands over, rising. An edit names
// the version it was made against; an accepted edit keeps that version, and
// one made against an older version is refused with `conflict`, so an edit
// never lands over a change the editor had not seen.
//
// The session's baseline (`baseVersion`, `baseContent`, `base`) moves only
// when Studio accepts an edit, or hands over a document while the editor
// holds nothing unsent, so a refused edit leaves the editor's value unsent
// (except a conflict without `merge`, where the outside document wins).

/** The source of `function (port) { … }`, which returns the frame's `studio.document`. */
export const EDITOR_DOCUMENT_SCRIPT = String.raw`function (port) {
  'use strict'
  var latest = null
  var waiting = []
  var listeners = new Set()
  var saveListeners = new Set()
  function noop() {}
  function failure(code, message) {
    var error = new Error(message)
    error.code = code
    error.retryable = false
    return error
  }
  // Told by its tag, not instanceof: a buffer made in another realm is still one.
  function isBuffer(value) { return Object.prototype.toString.call(value) === '[object ArrayBuffer]' }
  function readContent(content) {
    if (content && content.kind === 'text' && typeof content.text === 'string') return { kind: 'text', text: content.text }
    if (content && content.kind === 'bytes' && isBuffer(content.bytes)) return { kind: 'bytes', bytes: content.bytes }
    return null
  }
  // A copy, so a buffer the editor reuses cannot change what Studio accepted.
  function copied(content) {
    return content.kind === 'bytes' ? { kind: 'bytes', bytes: content.bytes.slice(0) } : content
  }
  function frozen(version, readOnly, content) {
    return Object.freeze({ version: version, readOnly: Boolean(readOnly), content: Object.freeze(content) })
  }
  function each(set, value) {
    Array.from(set).forEach(function (listener) {
      try { listener(value) } catch (error) { console.error(error) }
    })
  }
  port.on('document', function (payload) {
    if (!payload || typeof payload.version !== 'number') return
    if (latest && payload.version <= latest.version) return
    var content = readContent(payload.content)
    if (!content) return
    latest = frozen(payload.version, payload.readOnly, content)
    waiting.splice(0).forEach(function (resolve) { resolve(latest) })
    each(listeners, latest)
  })
  port.on('document.flush', function (payload) {
    var id = payload && payload.id
    var runs = Array.from(saveListeners).map(function (listener) {
      try { return Promise.resolve(listener()) } catch (error) { return Promise.reject(error) }
    })
    Promise.all(runs).then(
      function () { port.post('document.flushed', { id: id, ok: true }) },
      function () { port.post('document.flushed', { id: id, ok: false }) }
    )
  })
  function get() {
    return latest ? Promise.resolve(latest) : new Promise(function (resolve) { waiting.push(resolve) })
  }
  // The current document is heard first: an editor often listens only once its own code has loaded.
  function onDidChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('onDidChange takes a function.')
    var live = true
    var entry = function (next) { if (live) listener(next) }
    listeners.add(entry)
    var current = latest
    if (current) Promise.resolve().then(function () { if (live && latest === current) listener(current) })
    return Object.freeze({ dispose: function () { live = false; listeners.delete(entry) } })
  }
  function onWillSave(listener) {
    if (typeof listener !== 'function') throw new TypeError('onWillSave takes a function.')
    var entry = function () { return listener() }
    saveListeners.add(entry)
    return Object.freeze({ dispose: function () { saveListeners.delete(entry) } })
  }
  function applyEdit(edit) {
    var base = edit && edit.baseVersion
    var content = edit && readContent(edit.content)
    if (typeof base !== 'number' || !content)
      return Promise.reject(failure('invalid_params', 'An edit is { baseVersion, content: { kind: "text", text } or { kind: "bytes", bytes } }.'))
    content = copied(content)
    return port.call('document.applyEdit', { baseVersion: base, content: content }).then(function () {
      // Accepted: the document now holds it, at the same version.
      if (latest && latest.version === base) latest = frozen(base, latest.readOnly, content)
    })
  }
  function sameContent(a, b) {
    if (!a || !b || a.kind !== b.kind) return false
    if (a.kind === 'text') return a.text === b.text
    if (a.bytes.byteLength !== b.bytes.byteLength) return false
    var x = new Uint8Array(a.bytes)
    var y = new Uint8Array(b.bytes)
    for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
    return true
  }
  function decodeText(content) {
    if (content.kind !== 'text') throw new TypeError('A bytes document needs a session decode and encode.')
    return content.text
  }
  function encodeText(value) { return { kind: 'text', text: String(value) } }
  function session(options) {
    var o = options || {}
    var decode = typeof o.decode === 'function' ? o.decode : decodeText
    var encode = typeof o.encode === 'function' ? o.encode : encodeText
    var merge = typeof o.merge === 'function' ? o.merge : null
    // Edits are whole documents, so a few a second are plenty while typing.
    var debounceMs = typeof o.debounceMs === 'number' && o.debounceMs >= 0 ? o.debounceMs : 250
    return get().then(function (first) {
      var doc = first
      var baseVersion = first.version
      var baseContent = first.content
      var base = decode(first.content)
      var value = base
      var dirty = false
      // Counted by change() alone, so the same object changed again is still a new change.
      var generation = 0
      var sentGeneration = 0
      // Counted each time a conflict drops the editor's value for the outside one.
      var drops = 0
      var inFlight = null
      var timer = null
      var disposed = false
      var replaced = new Set()
      function stopTimer() {
        if (timer !== null) { clearTimeout(timer); timer = null }
      }
      function adopt(next) {
        doc = next
        baseVersion = next.version
        baseContent = next.content
        base = decode(next.content)
        return base
      }
      function refused(error) {
        if (disposed || !error || error.code !== 'conflict' || !latest || latest.version === baseVersion) throw error
        var previous = base
        var mine = value
        var outside = adopt(latest)
        // Without merge the outside document wins: a change made outside is never written over unseen.
        if (!merge) {
          value = outside
          dirty = false
          drops += 1
          each(replaced, outside)
          throw error
        }
        value = merge(previous, outside, mine)
        dirty = true
        generation += 1
        each(replaced, value)
        return send()
      }
      // One edit at a time: a change made while one is in flight goes once it settles.
      function send() {
        stopTimer()
        if (disposed) return Promise.resolve()
        var content
        try { content = readContent(encode(value)) } catch (error) { return Promise.reject(error) }
        if (!content) return Promise.reject(failure('invalid_params', 'encode must return { kind: "text", text } or { kind: "bytes", bytes }.'))
        content = copied(content)
        sentGeneration = generation
        var mine = generation
        var attempt = applyEdit({ baseVersion: baseVersion, content: content }).then(function () {
          baseContent = content
          base = decode(content)
          if (generation === mine) dirty = false
        }, refused)
        inFlight = attempt
        function settled() {
          if (inFlight === attempt) inFlight = null
          if (!disposed && dirty && generation !== sentGeneration && timer === null && inFlight === null) send().catch(noop)
        }
        attempt.then(settled, settled)
        return attempt
      }
      // Settles once every change so far is accepted, or refused with nothing newer to send.
      function flush() {
        stopTimer()
        if (disposed) return Promise.resolve()
        var current = inFlight || (dirty && !doc.readOnly ? send() : null)
        if (!current) return Promise.resolve()
        var waited = sentGeneration
        var dropped = drops
        return current.then(function () {
          return generation !== waited ? flush() : undefined
        }, function (error) {
          if (!disposed && generation !== waited && drops === dropped) return flush()
          throw error
        })
      }
      var documents = onDidChange(function (next) {
        if (disposed || next.version <= doc.version) return
        doc = next
        // An edit not yet accepted meets this document as its conflict, where merge runs.
        if (dirty || inFlight) return
        if (sameContent(next.content, baseContent)) { baseVersion = next.version; return }
        value = adopt(next)
        each(replaced, value)
      })
      var saves = onWillSave(function () { return disposed || doc.readOnly ? undefined : flush() })
      return Object.freeze({
        get value() { return value },
        get readOnly() { return doc.readOnly },
        change: function (next) {
          if (disposed || doc.readOnly) return
          value = next
          generation += 1
          dirty = true
          stopTimer()
          timer = setTimeout(function () {
            timer = null
            if (!inFlight) send().catch(noop)
          }, debounceMs)
        },
        flush: function () { return flush().then(noop) },
        onReplace: function (listener) {
          if (typeof listener !== 'function') throw new TypeError('onReplace takes a function.')
          var entry = function (next) { listener(next) }
          replaced.add(entry)
          return Object.freeze({ dispose: function () { replaced.delete(entry) } })
        },
        dispose: function () {
          disposed = true
          stopTimer()
          documents.dispose()
          saves.dispose()
          replaced.clear()
        }
      })
    })
  }
  return Object.freeze({
    get: get,
    onDidChange: onDidChange,
    applyEdit: applyEdit,
    onWillSave: onWillSave,
    session: session
  })
}`

/** What `EDITOR_DOCUMENT_SCRIPT` is handed: its only way to the window. */
export type EditorDocumentPort = {
  call(method: 'document.applyEdit', params: unknown): Promise<unknown>
  on(event: 'document' | 'document.flush', listener: (payload: unknown) => void): () => void
  post(event: 'document.flushed', payload: unknown): void
}
