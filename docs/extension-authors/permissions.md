# Extension Permissions Reference

An extension declares the access it needs in the `permissions` array of its
`extension.json`. Only the `ui` and `worker` tiers hold permissions: a
`content` or `declarative` extension runs no code of its own and asks for
nothing. In the studio's security model (ed25519 signing in `extension.sig`,
explicit user trust, in-process execution), permissions are **install-time
disclosure**: they are shown to the user before they trust your extension, and
they describe what it does. They are **not a runtime sandbox** — a trusted
extension's code runs with the app's access. Declare what you actually touch
so users can make an informed trust decision.

The host's own services do hold an extension to what it declared. Each SDK
helper (`getConversationService`, `getSecretsService`, `getBacklogService`, …)
checks the scope its call needs, against your extension.json, and reaches the
service as your extension: one extension cannot use another's permissions,
chats, secrets or storage.

The vocabulary is closed. It lives in
`packages/extension-sdk/src/permissions.ts` (`KNOWN_CAPABILITY_PERMISSIONS`),
and extension.json validation refuses a scope that is not in it.

## Vocabulary

| Scope | Consent description | Discloses |
| --- | --- | --- |
| `filesystem:read-workspace` | Read files in the open workspace | Direct reads of workspace files |
| `filesystem:write-workspace` | Create and modify files in the open workspace | Direct writes to workspace files |
| `filesystem:read-home` | Read your app configuration and home folder | Reads outside the workspace (home, userData) |
| `process:spawn` | Run external programs on your machine | Spawning child processes |
| `network` | Make network requests | Any outbound network access |
| `ipc:workspace-read` | See workspace, window, git, and task state through the app's APIs | See tier mapping below |
| `ipc:workspace-write` | Create and change workspaces, files, and tasks through the app's APIs | See tier mapping below |
| `ipc:settings` | Read and change app settings and integrations | See tier mapping below |
| `ipc:invoke` | Call any of the app's internal APIs, including its own background code (broad scope) | The entire `window.api` surface, **and** declaring its own methods |
| `module:bridge` | Let its window code talk to its own background code | Its own declared methods alone: its surfaces' `studio.methods()` calling what its worker declared with `registerMethods`, and the methods its commands run |
| `backlog.read` | Read Backlog item details and source content | `listBacklogItems`, `watchBacklogItems`, `getBacklogLocation`, and the reads of `getBacklogService` |
| `backlog.write` | Change Backlog item status, triage, links, and metadata, and create new items | The Backlog write API (`getBacklogService`, `createBacklogItem`, `updateBacklogStatus`, `updateBacklogTriage`, `addBacklogLink`, `updateBacklogModuleMetadata`) |
| `backlog.link.open` | Open links and targets attached to Backlog items | Opening a Backlog item's link targets |
| `scheduled-agents.manage` | Schedule agents of its own that start a chat on a timer | Creating, changing and running its own scheduled agents |
| `agents:companion` | Run its own background agents inside the workspace | The companion-agents service |
| `agents:generate` | Send prompts to your AI models in the background, without opening a chat | `getTextGenerationService`: one prompt answered by the person's own agent CLI (Claude Code or Codex), with no chat or workspace |
| `storage` | Save its own data in the workspace folder and app data | The extension's storage, its app state (read from the worker with `getModuleAppState`), and its private data directory (`getModuleDataDir`) |
| `conversation:read` | Read the chats it started, including everything the agent says in them | `getConversationService`: `subscribe`, `follow`, `transcript`, `reply`, `list`, `watch` |
| `conversation:operate` | Start chats with agents, send them messages, and stop them | The whole conversation service, `openChat` with `send: true`, and allowing a companion's tool call. Implies `conversation:read` |
| `conversation:bypass` | Let the agents in its chats edit files and run commands without asking you first | Running the extension's chats on `bypass`, starting them with `allowedTools`, and a companion task with `tools: 'auto'`. Without it they run no looser than `auto` |
| `chat:draft` | Open a chat with a message drafted for you to read and send | `openChat` without `send`: the prompt waits in the composer for the person |
| `secrets` | Store API keys and send them to the sites it names (the key is never shown back to the extension) | `getSecretsService` |
| `github` | Use your GitHub sign-in to call the GitHub API (the token is never shown to the extension) | `getGitHubService`: REST requests, read-only GraphQL queries, and downloads that follow GitHub's own storage redirect |
| `mcp:tools` | Add tools that agents in your workspaces can call | `registerMcpTools`, and declaring `contributes.mcpTools` |
| `usage:read` | See token usage and cost of every agent session on this machine | `getUsageService`, `queryUsage`: token counts of Studio chats and of the Claude Code and Codex sessions on the machine |
| `conversation:read-all` | Read every chat on this machine, including what you and the agents wrote (broad scope) | `getActivityService`: summaries of the person's Studio chats and the messages they sent, with the end of each reply |

## The `ipc:*` tiers

`ipc:invoke` discloses the whole internal API surface in one opaque scope, and
the consent UI flags it as broad. Declare the tier(s) matching the areas you
use instead, and `module:bridge` for the methods your own worker declares:

- **`ipc:workspace-read`** — observing workspace and project state:
  workspace-sync snapshots and events, window state, git read models (status,
  branches, history, graph, worktree lists), Backlog reads,
  knowledge/memory reads, terminal
  session lists, workspace backup reads.
- **`ipc:workspace-write`** — changing workspace and project state through
  the studio: workspace-sync command dispatch, filesystem mutation routes, git
  mutations (stage/commit/push/branch/worktrees), Backlog mutations,
  workspace backup writes.
- **`ipc:settings`** — reading and changing the studio's settings and
  integrations: extension enablement, install and trust, MCP
  servers and their sync, Skills, the plugin registry, GitHub token, app updates.

A few surfaces (window controls, native dialogs, clipboard, auth/session,
external-URL opening, and launching or driving agents and terminals) sit
outside every tier today; only the broad
`ipc:invoke` scope discloses those. The host's own narrow versions need no
permission: the worker's `notify` (a bell row under the extension's name),
a surface's `toast` (a transient report under the extension's name), and
`openExternal` (an absolute http(s) URL, in the system browser,
through the app's own link path — nothing else). An extension that wants an agent should not
reach for them: the conversation service and `openChat` are the supported way,
behind `conversation:read` / `conversation:operate` (and `chat:draft` for a
draft), with companions (`agents:companion`) and one-shot text generation
(`agents:generate`) beside them.

## Honesty rules

- Permissions are disclosure first, not a sandbox. Do not describe your extension
  as "sandboxed" or "restricted to" its declared scopes — the app does not
  broker most API calls at runtime.
- These scopes are genuinely checked, and an extension missing them is refused
  with `permission_missing` (or a throw, where a call has no failure shape):
  - `module:bridge` gates declaring methods (`registerMethods`, which throws
    without it), and so the worker's commands. `ipc:invoke` also allows it;
    declare `module:bridge`, whose consent line says what it is instead of
    "any of the app's internal APIs";
  - `agents:companion` is checked when an extension attaches a companion agent.
    A companion's structured run denies every tool call its agent asks for
    unless the run says otherwise: `tools: 'auto'` needs `conversation:bypass`,
    and allowing one tool call with `respondToApproval` needs
    `conversation:operate`;
  - `agents:generate` is checked on every call to the text generation
    service, which also bounds each extension to two calls at once, eight
    waiting, and thirty a minute;
  - `conversation:read` and `conversation:operate` are checked on every call to
    the conversation service, and `openChat` takes `chat:draft`
    or `conversation:operate` for a draft and `conversation:operate` for
    `send: true`. The service is scoped further, by owner: an extension
    reaches only the chats it created, never another extension's and never the
    user's own;
  - `conversation:bypass` is read on every `create` and `setPermissionPreset`.
    It sets the loosest preset the extension's chats run on, `bypass` with it and
    `auto` without, and a looser request is lowered to that rather than
    refused. The one thing it refuses is `allowedTools` at `create`, which
    lets a chat use the named tools without asking and so needs the permission
    that lets it ask about nothing;
  - `secrets` and `github` are checked on every call to their brokers. Neither
    hands the credential to extension code: a secret leaves the host only inside a
    request to an https origin it was stored with, and the GitHub token only
    inside a request to the GitHub API;
  - `mcp:tools` is required to declare `contributes.mcpTools`, and checked
    when the worker registers them;
  - `backlog.read` and `backlog.write` are checked on every call to the
    Backlog service (`getBacklogService` and a surface's Backlog write
    methods), and `backlog.read` on a surface's
    `listBacklogItems` / `watchBacklogItems`;
  - `usage:read` is checked on every call to the usage service;
  - `conversation:read-all` is checked on every call to the activity service.
    It is the one scope that reaches the person's own chats, read-only, and
    the consent prompt flags it as broad, as it does `ipc:invoke`.
  - `ipc:workspace-read` is checked on `getWorkspaceGitInfo` (the worker and surfaces); the
    rest of what it discloses stays disclosure-only.
- An extension reaches agents only as chats, companions and one-shot prompts.
  There is no scope for launching or driving an agent terminal, because no
  extension API does it.
- Declaring less than you use is a trust violation users can hold against your
  publisher key. `extension.sig` covers every file in the extension,
  extension.json included, so changing declared access or shipped code
  requires signing again and trusting again.

## Example

```json
{
  "manifestVersion": 1,
  "id": "workspace-dashboard",
  "version": "1.0.0",
  "engines": { "studio": ">=0.13.0" },
  "tier": "worker",
  "name": "Workspace Dashboard",
  "main": "dist/main.cjs",
  "permissions": ["ipc:workspace-read", "conversation:operate", "secrets"]
}
```

`permissions` may be omitted (it defaults to `[]`). When present it is an
array of scopes from the vocabulary above, each at most once; an unknown scope
or a duplicate fails validation. The validator is `validateExtensionManifest`
in `packages/extension-sdk/src/extension-manifest.ts`, the one Studio and the
SDK's CLI both run.
