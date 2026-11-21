// The permissions an extension may ask for: a closed vocabulary. extension.json
// refuses a name that is not here. Pure (no Node APIs, no values imported from
// index), so the manifest validator and the index can both import it.

export type CapabilityPermission =
  | 'filesystem:read-workspace'
  | 'filesystem:write-workspace'
  | 'filesystem:read-home'
  | 'process:spawn'
  | 'network'
  | 'ipc:workspace-read'
  | 'ipc:workspace-write'
  | 'ipc:settings'
  | 'ipc:invoke'
  // Your own declared methods alone (`MainHost.registerMethods`, called by
  // your window code through `RendererHost.methods`), split out of
  // `ipc:invoke`, which still allows them for manifests written before the split.
  | 'module:bridge'
  | 'backlog.read'
  | 'backlog.write'
  | 'backlog.link.open'
  // Create and manage the module's own scheduled agents through the SDK's
  // scoped service. Disclosure-level like every other scope: the service does
  // not runtime-check it.
  | 'scheduled-agents.manage'
  // Attach workspace-bound background (companion) agents through the SDK's
  // Companion Agents service. Unlike the disclosure-only scopes above, the
  // companion service checks this one explicitly at attach time.
  | 'agents:companion'
  // Send prompts to the person's own agent CLI in the background and read the
  // answers, with no chat, workspace or tools (`getTextGenerationService`).
  // Checked on every call.
  | 'agents:generate'
  // Persist the module's own data through the SDK's scoped storage service
  // (host-placed: `modules/<id>/` in the project's store in the person's home,
  // or per-user app data).
  | 'storage'
  // Read the conversations the module started through the SDK's scoped
  // conversation service: their events, transcripts and list.
  | 'conversation:read'
  // Start, prompt, interrupt and stop the module's own conversations, and open
  // a chat in the renderer (`RendererHost.openChat`). Implies read.
  | 'conversation:operate'
  // Run those conversations on `bypass`, and let them use named tools
  // without asking (`allowedTools`). Without it a module's chats go no looser
  // than `auto`, whatever it asks for.
  | 'conversation:bypass'
  // Open a chat with a prompt drafted in its composer for the person to read
  // and send (`RendererHost.openChat` without `send`). Nothing more: sending,
  // reading or driving a chat is `conversation:*`'s.
  | 'chat:draft'
  // Store secrets the host sends only to origins the module named, never
  // handing the value back (the SDK's scoped secrets service).
  | 'secrets'
  // Call the GitHub API with the user's sign-in through the SDK's GitHub
  // service; the host attaches the token and never hands it over.
  | 'github'
  // Contribute tools to the Studio MCP gateway (`MainHost.registerMcpTools`).
  | 'mcp:tools'
  // ── Backlog, usage and activity services ──
  // See token usage of every agent session on this machine (`getUsageService`).
  | 'usage:read'
  // Read every Studio chat on this machine, read-only (`getActivityService`).
  // A broad scope: the consent prompt flags it.
  | 'conversation:read-all'
  | (string & {})

export const KNOWN_CAPABILITY_PERMISSIONS: readonly string[] = [
  'filesystem:read-workspace',
  'filesystem:write-workspace',
  'filesystem:read-home',
  'process:spawn',
  'network',
  'ipc:workspace-read',
  'ipc:workspace-write',
  'ipc:settings',
  'ipc:invoke',
  // Your own declared methods, split out of `ipc:invoke`.
  'module:bridge',
  'backlog.read',
  'backlog.write',
  'backlog.link.open',
  'scheduled-agents.manage',
  'agents:companion',
  'agents:generate',
  'storage',
  'conversation:read',
  'conversation:operate',
  'conversation:bypass',
  'chat:draft',
  'secrets',
  'github',
  'mcp:tools',
  // Backlog, usage and activity services.
  'usage:read',
  'conversation:read-all',
]
