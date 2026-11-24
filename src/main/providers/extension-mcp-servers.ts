// Which installed extensions' MCP servers a live chat's child was started
// with, so a chat follows the projection while it runs.
//
// A child reads the extensions' servers when it starts (projection.ts,
// `chatExtensionContributions`). Killing, switching off, uninstalling an
// extension or losing its approval re-projects them, and a new chat starts
// without the server; a child already running would keep it, its tools and
// its local process, for as long as the chat lasts. So each child keeps what
// it was handed, by server name (`<publisher>_<id>_<server id>`, which names
// the extension) and as it was handed, and at each turn's start the provider
// compares it with what the extensions hand now: a server gone or changed is
// withdrawn before the turn runs (claude-agent-provider.ts,
// codex-conversation-provider.ts). Never mid-turn: a turn already running
// finishes with the servers it started with.

import { createHash } from 'node:crypto'

import type { ConversationMcpServer } from '../../shared/conversation-runtime'

/** The extensions' servers a child was handed: each by name, as handed, and one generation for all of them. */
export type HandedExtensionServers = {
  generation: string
  servers: ReadonlyMap<string, string>
}

/** `servers`, as a child is handed them, to compare with what it is handed later. */
export function handedExtensionServers(servers: readonly ConversationMcpServer[]): HandedExtensionServers {
  const entries = servers
    .map((server) => [server.id, canonical(server)] as const)
    .sort(([a], [b]) => a.localeCompare(b))
  return {
    generation: createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 24),
    servers: new Map(entries),
  }
}

/** The servers a child was started with that the extensions no longer hand as they were: gone, or changed. */
export function withdrawnExtensionServers(started: HandedExtensionServers, now: HandedExtensionServers): string[] {
  if (started.generation === now.generation) return []
  return [...started.servers].flatMap(([id, handed]) => (now.servers.get(id) === handed ? [] : [id]))
}

/** One server's fields in one order, so the same server is always the same text. */
function canonical(server: ConversationMcpServer): string {
  return JSON.stringify({
    id: server.id,
    transport: server.transport,
    command: server.command ?? null,
    args: server.args ?? [],
    env: Object.entries(server.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    url: server.url ?? null,
    headers: Object.entries(server.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    envVarNames: server.envVarNames ?? [],
  })
}
