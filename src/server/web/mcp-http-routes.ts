import { secretsMatch } from '../../main/automation/tailnet/secret-hash'
import type { McpHttpCreateResult } from '../../../packages/studio-protocol/src/public'
import { readBody, sendJson } from './web-http'
import type { WebExtraRoute } from './web-listener'

// A token to the agents' loopback MCP endpoint, made on the machine:
//
//   POST /mcp-http/mint   { name }   for `studio-server mcp-token` (the run file's key)
//
// Making one is Studio's own desktop windows' over the protocol
// (`mcpHttp.create` is `window`-only), so an owner's web tab cannot, and a
// server with no desktop has no window. This is that server's way: like
// `studio-server pair` and `embed`, a program on this machine that read the
// run file in the owner-only data directory, sending no Origin. A request
// with an Origin is a page, and is refused.

const MAX_BODY_BYTES = 4 * 1024

export function createMcpHttpRoutes(options: {
  mintKey: string
  /** The gateway's own way to make one, as Settings' is. */
  create: (name: string) => Promise<McpHttpCreateResult>
}): WebExtraRoute {
  return async ({ request, response, url }) => {
    if (url.pathname !== '/mcp-http/mint' || request.method !== 'POST') return false
    const presented = /^Bearer (.+)$/u.exec(request.headers.authorization ?? '')?.[1] ?? ''
    if (request.headers.origin !== undefined || !secretsMatch(presented, options.mintKey)) {
      sendJson(response, 403, { ok: false, message: 'Not allowed.' })
      return true
    }
    let name: unknown
    try {
      name = (JSON.parse((await readBody(request, MAX_BODY_BYTES)).toString('utf8')) as { name?: unknown } | null)?.name
    } catch {
      name = undefined
    }
    if (typeof name !== 'string' || name.trim() === '') {
      sendJson(response, 400, { ok: false, message: 'Name the client the token is for.' })
      return true
    }
    const made = await options.create(name.trim())
    if (!made.ok) {
      sendJson(response, 400, { ok: false, message: made.message })
      return true
    }
    sendJson(response, 200, { ok: true, url: made.url, token: made.token, client: made.client })
    return true
  }
}
