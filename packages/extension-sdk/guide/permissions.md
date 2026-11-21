# Permissions

`permissions` in `extension/extension.json` is what the person reads before
trusting the extension. The consent prompt shows each as a sentence (below).
Some are also checked by the host at the call; the rest are disclosure: the
host does not sandbox an extension's code, so declaring honestly is the
author's side of the bargain.

Rules:

- Declare what the code does, no more. "Might need it later" is not a reason.
- Only the `ui` and `worker` tiers hold permissions. A `content` or
  `declarative` extension runs none of its own code, so it asks for nothing.
- The list is closed: a name the SDK does not know fails validation, so a typo
  is caught before anyone reads it.
- Changing permissions changes extension.json, so trust is asked for again.

| Permission | The prompt says | Declare it when you use | Checked at the call |
| --- | --- | --- | --- |
| `storage` | Save its own data in the workspace folder and app data | `getModuleStorage`, module app state (also the worker's `getModuleAppState`), workspace module state, `getModuleDataDir` | — |
| `module:bridge` | Let its window code talk to its own background code | `registerMethods` in the worker: methods your surfaces call with `studio.methods()`, and the methods commands without an `action` run | yes (`registerMethods` throws without it) |
| `ipc:invoke` | Call any of the app's internal APIs, including its own background code (broad scope) | Nothing new: the legacy scope still allows declaring methods, but reads as "any internal API". Use `module:bridge` | yes (as `module:bridge`) |
| `ipc:workspace-read` | See workspace, window, git, and task state through the app's APIs | `getWorkspace`, `listWorkspaces`, `watchWorkspaces`, `getWorkingRoot`, `WorkspaceContextToken`, `getWorkspaceGitInfo` | `getWorkspaceGitInfo` |
| `ipc:workspace-write` | Create and change workspaces, files, and tasks through the app's APIs | `WorkspaceServiceToken.create` | — |
| `ipc:settings` | Read and change app settings and integrations | — (legacy scope) | — |
| `filesystem:read-workspace` | Read files in the open workspace | `watchWorkspaceFile`; Node reads under a workspace root in the worker | — |
| `filesystem:write-workspace` | Create and modify files in the open workspace | Node writes under a workspace root in the worker | — |
| `filesystem:read-home` | Read your app configuration and home folder | Reading outside workspaces. Almost never right — use storage | — |
| `process:spawn` | Run external programs on your machine | `child_process` in the worker | — |
| `network` | Make network requests | `fetch`/sockets from the worker or a surface (not needed for the brokers) | — |
| `backlog.read` | Read Backlog item details and source content | `listBacklogItems`, `watchBacklogItems`, `getBacklogLocation`, `getBacklogService` reads | yes |
| `backlog.write` | Change Backlog item status, triage, links, and metadata, and create new items | `createBacklogItem`, `updateBacklogStatus`, `updateBacklogTriage`, `addBacklogLink`, `updateBacklogModuleMetadata`, `getBacklogService` writes | yes (service) |
| `backlog.link.open` | Open links and targets attached to Backlog items | Opening a Backlog item's links | — |
| `scheduled-agents.manage` | Schedule agents of its own that start a chat on a timer | `getScheduledAgentsService` | — |
| `agents:companion` | Run its own background agents inside the workspace | `getCompanionAgentsService` | yes |
| `agents:generate` | Send prompts to your AI models in the background, without opening a chat | `getTextGenerationService` | yes |
| `conversation:read` | Read the chats it started, including everything the agent says in them | `subscribe`, `follow`, `transcript`, `reply`, `list`, `watch` | yes |
| `conversation:operate` | Start chats with agents, send them messages, and stop them | `openChat` with `send: true`, every conversation-service call (implies read), allowing a companion's tool call | yes |
| `conversation:bypass` | Let the agents in its chats edit files and run commands without asking you first | `bypass` chats, `allowedTools`, a companion task with `tools: 'auto'` | yes |
| `chat:draft` | Open a chat with a message drafted for you to read and send | `openChat` without `send` | yes |
| `secrets` | Store API keys and send them to the sites it names (the key is never shown back to the extension) | `getSecretsService` | yes |
| `github` | Use your GitHub sign-in to call the GitHub API (the token is never shown to the extension) | `getGitHubService` (`request`, `graphql`, `download`) | yes |
| `mcp:tools` | Add tools that agents in your workspaces can call | `registerMcpTools`, and declaring `contributes.mcpTools` | yes |
| `usage:read` | See token usage and cost of every agent session on this machine | `getUsageService`, `queryUsage` | yes |
| `conversation:read-all` | Read every chat on this machine, including what you and the agents wrote (broad scope) | `getActivityService` | yes |

Contributions themselves need no permission: commands, menu items, top bar
items, panels, doors and settings sections are covered by the tier. What their
code then does is what the permissions above cover. Declaring
`contributes.mcpTools` is the exception: it needs `mcp:tools`.

The smoke test (`test/smoke.test.mjs`) activates the worker against the SDK's
fake host, which refuses what the real host checks (`registerMethods` throws
without `module:bridge`, a checked service answers `permission_missing`) and
lists every disclosure-only use the manifest does not declare. Either fails the
test. It reads the SDK's own table of what each service needs
(`MODULE_SERVICE_REQUIREMENTS`), so it cannot fall behind the host. A
surface's tests do the same with `createFakeRendererHost`: its `undeclared`
list should stay empty.
