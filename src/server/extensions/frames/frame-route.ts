// `/ext-frame/<hash>` on the web listener: an extension frame's document, for
// a browser tab of this Studio to draw a panel, door or settings section in.
//
// A paired browser's session is needed (the iframe's request carries its
// cookie), and the document must be one this server built for an admitted
// client (frame-cache.ts). It answers with its own policy, the sandbox in it,
// so it runs in an opaque origin whatever its URL; only this origin may frame
// it.

import type { WebExtraRoute } from '../../web/web-listener'
import { AUTHENTICATED_HEADERS, sendText } from '../../web/web-http'
import {
  EXTENSION_FRAME_HASH_PATTERN,
  EXTENSION_FRAME_PATH_PREFIX,
  extensionFrameHeaderCsp,
} from '../../../shared/extension-frames'
import type { ExtensionFrameCache } from './frame-cache'

export function createExtensionFrameRoute(cache: ExtensionFrameCache): WebExtraRoute {
  return ({ request, response, url, session }) => {
    if (!url.pathname.startsWith(EXTENSION_FRAME_PATH_PREFIX)) return false
    const method = request.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      sendText(response, 405, 'method_not_allowed', { Allow: 'GET, HEAD' })
      return true
    }
    if (!session()) {
      sendText(response, 401, 'not_paired')
      return true
    }
    const hash = url.pathname.slice(EXTENSION_FRAME_PATH_PREFIX.length)
    const html = EXTENSION_FRAME_HASH_PATTERN.test(hash) ? cache.get(hash) : undefined
    if (html === undefined) {
      sendText(response, 404, 'not_found')
      return true
    }
    const body = Buffer.from(html, 'utf8')
    response.writeHead(200, {
      ...AUTHENTICATED_HEADERS,
      'Content-Security-Policy': extensionFrameHeaderCsp("'self'"),
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': String(body.byteLength),
      // Content-addressed: the same hash is always the same bytes.
      'Cache-Control': 'private, max-age=31536000, immutable',
    })
    response.end(method === 'HEAD' ? undefined : body)
    return true
  }
}
