import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { test } from 'vitest'

import { EXTENSION_FRAME_CSP } from '../../../shared/extension-frames'
import { EXTENSION_FRAME_THEMES } from '../../../shared/extension-frame-themes.generated'
import { createExtensionFrameCache } from './frame-cache'
import { buildExtensionFrameDocument, extensionFrameHash } from './frame-document'
import { createExtensionFrameRoute } from './frame-route'

// The one document every client draws a surface from, and the web listener's
// route that serves it to a browser tab.

const ENTRY = "export function mount(root) { root.textContent = '</script><script>alert(1)</script>' }\n"

function documentFor(theme = EXTENSION_FRAME_THEMES.dark!) {
  return buildExtensionFrameDocument({
    surface: { point: 'doors', id: 'deck' },
    entryPath: 'dist/door.js',
    entryCode: ENTRY,
    theme,
  })
}

test('the document carries its policy first, the theme’s tokens, and the entry only as data', () => {
  const html = documentFor()
  assert.ok(html.indexOf(EXTENSION_FRAME_CSP) < html.indexOf('<style'), 'the policy comes before anything else')
  assert.match(html, /<html class="dark">/)
  assert.ok(html.includes(`--bg-app:${EXTENSION_FRAME_THEMES.dark!.tokens['--bg-app']};`))
  // The entry cannot close the bootstrap's script: its markup is escaped inside a JSON string.
  assert.equal(html.split('</script>').length - 1, 1)
  assert.ok(!html.includes('<script>alert(1)'))
  assert.match(html, /\\u003c\/script\\u003e/)
})

test('a theme this server does not know keeps the body hidden until the window sends its own', () => {
  const html = buildExtensionFrameDocument({
    surface: { point: 'panels', id: 'p' },
    entryPath: 'p.js',
    entryCode: ENTRY,
    theme: null,
  })
  assert.match(html, /<html class="dark" data-se-waiting>/)
  assert.match(html, /<style id="se-tokens">:root\{\}<\/style>/)
})

test('another theme or another entry is another document', () => {
  const dark = documentFor()
  assert.equal(extensionFrameHash(dark), extensionFrameHash(documentFor()))
  assert.notEqual(extensionFrameHash(dark), extensionFrameHash(documentFor(EXTENSION_FRAME_THEMES.light!)))
  assert.match(extensionFrameHash(dark), /^[0-9a-f]{64}$/)
})

function respond(route: ReturnType<typeof createExtensionFrameRoute>, path: string, paired = true) {
  const answer: { status?: number; headers?: Record<string, string>; body?: unknown } = {}
  const response = {
    writeHead(status: number, headers?: Record<string, string>) {
      answer.status = status
      answer.headers = headers
    },
    setHeader() {},
    end(body?: unknown) {
      answer.body = body
    },
  } as unknown as ServerResponse
  const handled = route({
    request: { method: 'GET', headers: {} } as IncomingMessage,
    response,
    url: new URL(path, 'http://127.0.0.1:4791'),
    origin: 'http://127.0.0.1:4791',
    session: () => (paired ? ({ id: 's' } as never) : null),
  })
  return { handled, answer }
}

test('the route serves a document built for an admitted client, sandboxed, to a paired browser only', () => {
  const cache = createExtensionFrameCache()
  const html = documentFor()
  const hash = extensionFrameHash(html)
  cache.put(hash, html)
  const route = createExtensionFrameRoute(cache)
  const served = respond(route, `/ext-frame/${hash}`)
  assert.equal(served.handled, true)
  assert.equal(served.answer.status, 200)
  assert.match(served.answer.headers!['Content-Security-Policy']!, /sandbox allow-scripts/)
  assert.match(served.answer.headers!['Content-Security-Policy']!, /frame-ancestors 'self'/)
  assert.match(served.answer.headers!['Content-Security-Policy']!, /connect-src 'none'/)
  assert.equal(String(served.answer.body), html)
  assert.equal(respond(route, `/ext-frame/${hash}`, false).answer.status, 401)
  assert.equal(respond(route, `/ext-frame/${'0'.repeat(64)}`).answer.status, 404, 'never built here')
  assert.equal(respond(route, '/ext-frame/x/y').answer.status, 404)
  assert.equal(respond(route, '/assets/x.js').handled, false)
})

test('the cache keeps the newest documents within its bounds', () => {
  const cache = createExtensionFrameCache({ maxDocuments: 2 })
  cache.put('a', 'A')
  cache.put('b', 'B')
  cache.get('a')
  cache.put('c', 'C')
  assert.equal(cache.get('a'), undefined)
  assert.equal(cache.get('c'), 'C')
})

test('a browser tab’s wrapper admits the one document and nothing else, and runs no script', () => {
  const cache = createExtensionFrameCache()
  const html = documentFor()
  const hash = extensionFrameHash(html)
  cache.put(hash, html)
  const route = createExtensionFrameRoute(cache)
  const served = respond(route, `/ext-frame-host/${hash}`)
  assert.equal(served.answer.status, 200)
  const policy = served.answer.headers!['Content-Security-Policy']!
  assert.match(policy, new RegExp(`frame-src http://127\\.0\\.0\\.1:4791/ext-frame/${hash}(;|$)`))
  assert.match(policy, /default-src 'none'/)
  assert.doesNotMatch(policy, /script-src/)
  assert.match(
    String(served.answer.body),
    new RegExp(`<iframe sandbox="allow-scripts" src="\\.\\./ext-frame/${hash}">`),
  )
  assert.equal(respond(route, `/ext-frame-host/${'0'.repeat(64)}`).answer.status, 404, 'never built here')
  assert.equal(respond(route, `/ext-frame-host/${hash}`, false).answer.status, 401)
})

test('the frame’s bootstrap answers the window that drew it, and says when its document unloads', () => {
  const html = documentFor()
  assert.match(html, /var host = window\.top/)
  assert.ok(
    html.indexOf("addEventListener('pagehide'") < html.indexOf('event: E.ready'),
    'before the extension can run',
  )
})
