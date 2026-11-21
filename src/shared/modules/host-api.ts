// What this host provides: what `supports()` answers on every MainHost. Which Studio an extension needs at all is `engines.studio` in
// its extension.json (shared/modules/third-party-manifest.ts).

import type { HostCapability } from '../../../packages/extension-sdk/src/host-api'

export type { HostCapability } from '../../../packages/extension-sdk/src/host-api'

// Only what exists today. A capability joins this list in the same change that
// makes it real, so `supports()` never promises a service nobody provides.
// `notifications` is not here: its answer depends on wiring rather than on
// this build (main-host.ts: a client delivery is wired).
export const HOST_CAPABILITIES: ReadonlySet<HostCapability> = new Set<HostCapability>([
  'conversations',
  'conversation-controls',
  'conversation-streams',
  'conversation-requests',
  'conversation-permissions',
  'secrets',
  'github',
  'companion-agents',
  'scheduled-agents',
  'storage',
  'mcp-tools',
  // Backlog, usage and activity services (main/module-host/module-backlog.ts,
  // main/usage, main/module-host/module-activity.ts).
  'backlog-write',
  'usage',
  'activity',
  'module-id',
  'chart-tokens',
  // Main-host plumbing: settings, workspaces, storage, GitHub, skills, MCP.
  'skill-status',
  'mcp-verified-identity',
  'github-headers',
  'github-graphql',
  'github-download',
  'storage-query',
  'storage-watch',
  'module-data-dir',
  'main-asset-path',
  'workspace-git-info',
  'workspace-history',
  'main-app-state',
  // Agents, conversations and scheduled agents.
  'companion-tools',
  'conversation-replies',
  'text-generation',
  'conversation-worktrees',
  'chat-runtimes',
  'scheduled-agent-runs',
])

export function hostSupports(capability: HostCapability): boolean {
  return HOST_CAPABILITIES.has(capability)
}
