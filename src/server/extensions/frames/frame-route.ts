// The web listener's routes for a browser tab's extension frames.
//
// - `/ext-frame-host/<hash>`: Studio's wrapper document. The tab frames it,
//   and it frames the extension's document. Its policy runs no script and lets
//   its frame load that one document and nothing else (`frame-src` naming the
//   document's full URL), so the extension's frame cannot be navigated
//   anywhere, to another site, another port of this host or another path of
//   this origin, before any request leaves. The tab's own `frame-src` cannot
//   do that: it admits the preview pane's ports.
// - `/ext-frame/<hash>`: the extension frame's document. It answers with its
//   own policy, the sandbox in it, so it runs in an opaque origin whatever
//   its URL; only this origin may frame it.
//
// A paired browser's session is needed for both (the request carries its
// cookie), and the document must be one this server built for an admitted
// client (frame-cache.ts).

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { WebExtraRoute } from '../../web/web-listener'
import { AUTHENTICATED_HEADERS, sendText } from '../../web/web-http'
import {
  EXTENSION_FRAME_HASH_PATTERN,
  EXTENSION_FRAME_HOST_PATH_PREFIX,
  EXTENSION_FRAME_PATH_PREFIX,
  extensionFrameHeaderCsp,
} from '../../../shared/extension-frames'
import type { ExtensionFrameCache } from './frame-cache'

/** The wrapper's policy: no script, and a frame that may hold the one document at `documentUrl`. */
export function extensionFrameHostCsp(documentUrl: string): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `frame-src ${documentUrl}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ')
}

/** The wrapper document: one full-size sandboxed frame holding the extension's document. */
export function extensionFrameHostDocument(hash: string): string {
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    '<style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style>',
    '</head><body>',
    `<iframe sandbox="allow-scripts" src="..${EXTENSION_FRAME_PATH_PREFIX}${hash}"></iframe>`,
    '</body></html>',
    '',
  ].join('\n')
}

function send(request: IncomingMessage, response: ServerResponse, html: string, headers: Record<string, string>): void {
  const body = Buffer.from(html, 'utf8')
  response.writeHead(200, {
    ...AUTHENTICATED_HEADERS,
    ...headers,
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(body.byteLength),
    // Content-addressed: the same hash is always the same bytes.
    'Cache-Control': 'private, max-age=31536000, immutable',
  })
  response.end(request.method === 'HEAD' ? undefined : body)
}

export function createExtensionFrameRoute(cache: ExtensionFrameCache): WebExtraRoute {
  return ({ request, response, url, origin, session }) => {
    const wrapper = url.pathname.startsWith(EXTENSION_FRAME_HOST_PATH_PREFIX)
    if (!wrapper && !url.pathname.startsWith(EXTENSION_FRAME_PATH_PREFIX)) return false
    const method = request.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      sendText(response, 405, 'method_not_allowed', { Allow: 'GET, HEAD' })
      return true
    }
    if (!session()) {
      sendText(response, 401, 'not_paired')
      return true
    }
    const hash = url.pathname.slice((wrapper ? EXTENSION_FRAME_HOST_PATH_PREFIX : EXTENSION_FRAME_PATH_PREFIX).length)
    const html = EXTENSION_FRAME_HASH_PATTERN.test(hash) ? cache.get(hash) : undefined
    if (html === undefined) {
      sendText(response, 404, 'not_found')
      return true
    }
    if (wrapper) {
      send(request, response, extensionFrameHostDocument(hash), {
        'Content-Security-Policy': extensionFrameHostCsp(`${origin}${EXTENSION_FRAME_PATH_PREFIX}${hash}`),
      })
      return true
    }
    send(request, response, html, { 'Content-Security-Policy': extensionFrameHeaderCsp("'self'") })
    return true
  }
}
