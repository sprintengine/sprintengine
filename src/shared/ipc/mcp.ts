// Part of the IPC contract: MCP server configuration, listings and sync.
// ../electron-api.ts re-exports everything here.

import type { McpClientTarget, McpServerConfig, McpSettings } from '../../../packages/studio-protocol/src/public'

// A server's configuration is the Studio protocol's, which a terminal
// session's launch record carries (`packages/studio-protocol/src/agents.ts`).
export type {
  McpRiskLevel,
  McpScope,
  McpServerConfig,
  McpServerSource,
  McpServerSourceRef,
  McpSettings,
} from '../../../packages/studio-protocol/src/public'

/**
 * An MCP server presented for display, without the fields that only a server
 * the person has actually installed can have (`enabled`, `scope`, `source`).
 *
 * Until the third-party retirement (2026-09-08) this was
 * `McpCatalogServer`, the row shape of a bundled MCP catalogue file
 * — a list of 16 servers nobody here wrote. That catalogue is gone and no
 * bundled list replaced it: an MCP server now arrives inside a plugin the
 * person installed from a source. What survives is the presentation shape,
 * because a surface still has to draw an installed server without pretending it
 * knows the settings-owned fields.
 */
export type McpServerListing = Omit<McpServerConfig, 'enabled' | 'scope' | 'source'> & {
  icon?: string
}

export type McpValidationIssue = {
  level: 'error' | 'warning'
  serverId?: string
  client?: McpClientTarget
  message: string
}

export type McpSyncTarget = {
  client: McpClientTarget
  path: string
  serverIds: string[]
}

export type McpSyncPreview =
  | { ok: true; targets: McpSyncTarget[]; issues: McpValidationIssue[] }
  | { ok: false; message: string; issues?: McpValidationIssue[] }

export type McpSyncResult =
  | { ok: true; targets: McpSyncTarget[]; issues: McpValidationIssue[] }
  | { ok: false; message: string; issues?: McpValidationIssue[] }

export type McpSyncInput = {
  workspaceRoot: string
  settings: McpSettings
  clients?: McpClientTarget[]
  /**
   * Servers this sync must take OUT of every CLI's config, named because the
   * settings no longer do. A server is pruned from a config only while
   * `settings` still names it, so a caller that has just forgotten one — an
   * uninstalled plugin's, say — has to say so here or the entry survives in
   * `.mcp.json` for good
   * (backlog/2026-09-06-a-github-marketplace-plugin-installs-nothing-for-claude-code.md).
   */
  forgetServerIds?: string[]
  requiredOnly?: boolean
  write?: boolean
  // Connector-scoped writes are exclusive: the worktree config must end with
  // exactly the servers in this sync (the connector set). Any MCP server the
  // base repo committed into the worktree config is pruned rather than merged,
  // preserving the connector-only isolation contract. Off (default) keeps the
  // normal workspace behavior of merging over the user's configured servers.
  pruneUnlistedServers?: boolean
}
