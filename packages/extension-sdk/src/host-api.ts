// What a running Studio provides behind the worker's `studio.supports(name)`:
// the names an extension may probe before it relies on a service. A surface in
// a frame asks `studio.host.has(method)` instead. Which Studio an
// extension needs at all is `engines.studio` in its extension.json.
//
// Pure (no Node APIs, no values imported from index) and safe in any runtime.

/**
 * A feature a module can ask the running host about with `host.supports(...)`
 * before it relies on it: what the host in front of it actually provides today
 * (a service can be absent because its providing module is off). Unknown names
 * answer `false`, so a module may probe for capabilities newer than its SDK.
 */
export type HostCapability =
  | 'conversations'
  // The conversation service's controls: all four permission presets,
  // `setPermissionPreset`, `setModel` and approval `decision`s.
  | 'conversation-controls'
  // `follow` (a snapshot or the events after a cursor, a `synchronized`
  // fence, then live events) and a `commandId` on every mutating call.
  | 'conversation-streams'
  // `answerQuestion` and `resolvePlan`, each refused for a request of another kind.
  | 'conversation-requests'
  // The agent CLI's own `permissionMode` beside the preset, and `allowedTools` at `create`.
  | 'conversation-permissions'
  | 'companion-agents'
  // ── Agents, conversations and scheduled agents ──
  // A companion's structured run takes `tools` ('none' by default, 'ask',
  // 'auto'), its handle `respondToApproval`, and its engine a chat runtime id.
  | 'companion-tools'
  // `turn_completed` carries `text` and `usage`, and the conversation service
  // has `reply(ref, turnId?)`.
  | 'conversation-replies'
  // `getTextGenerationService(host).generate`: one prompt, no chat.
  | 'text-generation'
  // The conversation service's `create` takes `worktree`.
  | 'conversation-worktrees'
  // `MainHost.listChatRuntimes()`.
  | 'chat-runtimes'
  // Scheduled agents take `name` and `tag`, `lastRun` names its chat's
  // `agentId`, the service has `onRun`, and a run's chat summary carries
  // `scheduledAgentId` and `scheduledAgentTag`.
  | 'scheduled-agent-runs'
  | 'scheduled-agents'
  | 'secrets'
  | 'github'
  | 'storage'
  | 'mcp-tools'
  // `MainHost.notify` reaches the bell of every open window, with `target`
  // opening your own door. False where no client delivery is wired.
  | 'notifications'
  // The Backlog write API: `getBacklogService` in the worker.
  | 'backlog-write'
  // `getUsageService` (permission `usage:read`).
  | 'usage'
  // `getActivityService` (permission `conversation:read`).
  | 'activity'
  // `MainHost.moduleId`.
  | 'module-id'
  // `--chart-1` … `--chart-8` and `--chart-other` in THEME_TOKENS.
  | 'chart-tokens'
  // ── Worker plumbing: settings, workspaces, storage, GitHub, skills, MCP ──
  // `MainHost.getSkillStatus`: is a skill present, without writing it.
  | 'skill-status'
  // `McpConnectionMetadata.verified` on every module tool call, and core tool
  // name collisions refused at `registerMcpTools`.
  | 'mcp-verified-identity'
  // GitHub broker: allow-listed response `headers`, `ifNoneMatch` and `accept`.
  | 'github-headers'
  // GitHub broker: read-only `graphql(query, variables)`.
  | 'github-graphql'
  // GitHub broker: `download(route)` following GitHub's own storage redirect.
  | 'github-download'
  // Module storage: `list({ prefix })` and `getMany(keys)`.
  | 'storage-query'
  // Module storage: `watch({ workspaceRoot? }, cb)`.
  | 'storage-watch'
  // `MainHost.getModuleDataDir()`: a private directory for data past the value limit.
  | 'module-data-dir'
  // `MainHost.getAssetPath(relative)`: a verified file's path, for workers and the like.
  | 'main-asset-path'
  // `MainHost.getWorkspaceGitInfo(workspaceId)`.
  | 'workspace-git-info'
  // `WorkspaceContextService.list({ includeClosed })` and `open` on each entry.
  | 'workspace-history'
  // `MainHost.getModuleAppState` / `watchModuleAppState`: Settings values in the worker.
  | 'main-app-state'
  | (string & {})
