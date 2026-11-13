// The Studio MCP gateway over loopback HTTP: what a window reads of it. It is
// managed over the Studio protocol (`mcpHttp.*`,
// packages/studio-protocol/src/access.ts), where the shapes are defined; the
// endpoint itself is the gateway's (src/main/automation/mcp-http-server.ts).
//
// An MCP client that cannot spawn the stdio bridge (one that only takes a URL)
// reaches the same tools at `http://127.0.0.1:<port>/mcp`, with a bearer
// token the person made for it in Settings. Each token is named for the client
// it was made for, kept only as its hash, and revoked on its own.

export {
  MCP_HTTP_CLIENT_NAME_MAX,
  MCP_HTTP_MAX_CLIENTS,
  type McpHttpClientView,
  type McpHttpCreateResult,
  type McpHttpStatus,
} from '../../packages/studio-protocol/src/public'

/**
 * What "Copy MCP URL" puts on the clipboard: the server as an MCP client's
 * configuration names one by URL, with its token as the bearer header. The
 * shape most clients that take a URL read, and plain enough to copy the two
 * values out of for one that does not.
 */
export function mcpHttpClientConfig(serverName: string, url: string, token: string): string {
  return JSON.stringify(
    { mcpServers: { [serverName]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  )
}
