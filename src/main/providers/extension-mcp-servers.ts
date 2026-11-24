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
//
// A server is handed with its extension's content generation
// (`extensionGeneration`), so one whose code changed (an update, a
// development folder's reload) under the same command and arguments counts
// as changed too, and is started again rather than left running the old code
// (`restartedExtensionServers`).

import { createHash } from 'node:crypto'

import type { ConversationMcpServer } from '../../shared/conversation-runtime'

/** The extensions' servers a child was handed: each by name, as handed, and one generation for all of them. */
export type HandedExtensionServers = {
  generation: string
  /** Each server as handed: its launch and the content it runs. */
  servers: ReadonlyMap<string, string>
  /** Each server's launch alone: its command, arguments, environment and URL. */
  launches: ReadonlyMap<string, string>
}

/** `servers`, as a child is handed them, to compare with what it is handed later. */
export function handedExtensionServers(servers: readonly ConversationMcpServer[]): HandedExtensionServers {
  const sorted = [...servers].sort((a, b) => a.id.localeCompare(b.id))
  const entries = sorted.map(
    (server) => [server.id, JSON.stringify([launchOf(server), server.extensionGeneration ?? null])] as const,
  )
  return {
    generation: createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 24),
    servers: new Map(entries),
    launches: new Map(sorted.map((server) => [server.id, launchOf(server)])),
  }
}

/**
 * The servers a child was started with that are handed now as they were
 * launched, but run changed code: setting them again would leave them
 * running, so they are started again.
 */
export function restartedExtensionServers(started: HandedExtensionServers, now: HandedExtensionServers): string[] {
  if (started.generation === now.generation) return []
  return [...started.servers].flatMap(([id, handed]) =>
    now.servers.has(id) && now.servers.get(id) !== handed && now.launches.get(id) === started.launches.get(id)
      ? [id]
      : [],
  )
}

/** The servers a child was started with that the extensions no longer hand as they were: gone, or changed. */
export function withdrawnExtensionServers(started: HandedExtensionServers, now: HandedExtensionServers): string[] {
  if (started.generation === now.generation) return []
  return [...started.servers].flatMap(([id, handed]) => (now.servers.get(id) === handed ? [] : [id]))
}

/** One server's launch fields in one order, so the same launch is always the same text. */
function launchOf(server: ConversationMcpServer): string {
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
