// Part of the IPC contract: MCP server configuration, listings and sync.
// ../electron-api.ts re-exports everything here.

import type { McpServerConfig } from '../../../packages/studio-protocol/src/public'

// A server's configuration is the Studio protocol's, which a terminal
// session's launch record carries (`packages/studio-protocol/src/agents.ts`).
export type {
  McpRiskLevel,
  McpScope,
  McpServerConfig,
  McpServerSource,
  McpServerSourceRef,
  McpSettings,
  McpValidationIssue,
  McpSyncTarget,
  McpSyncPreview,
  McpSyncResult,
  McpSyncInput,
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
