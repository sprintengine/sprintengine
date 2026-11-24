# Extension Permissions Reference

An extension asks for the access it needs in the `permissions` array of its
`extension.json`. Only the `ui` and `worker` tiers hold permissions: a
`content` or `declarative` extension runs no code of its own and asks for
nothing.

## What a permission is, and what it is not

Studio checks every call an extension's code makes into Studio, at the host,
against two things:

1. **What the person approved for the extension.** Its permissions, as they
   were when the person approved it.
2. **What whoever set the call off may do themselves.** The person at this
   machine may do everything. A paired device, another app or a browser session
   may do what it was granted. An agent on this machine may do what the person
   may, and the chats an extension starts for it run no looser than the
   agent's own preset. Work the extension does on its own (a startup hook, a
   timer it set while starting, a sidecar) runs as the person who approved it.
   A listener it hands Studio runs as whoever was calling when it handed it
   over: one registered while serving a device stays held to that device.

A call goes through only when both hold. So an extension never lets a paired
device or an agent do something that device or agent could not do itself: a
device paired with workspace access only cannot read chats through an
extension's MCP tool, even if the extension may.

What the extension's own code can do depends on its tier. A `ui` extension's
code runs in sandboxed frames: no network, no Node, nothing of Studio's window
or this machine, so the calls above are all it can do, and the approval says
it runs isolated and can do only what the person allows. A `worker`
extension's code runs on this machine with full access: its files, its
programs, its network and its accounts. The approval says so in those words;
do not describe a worker as "sandboxed" or "restricted to" its permissions.

A refused call answers, in the method's own failure shape where it has one
(`{ ok: false, code, message }`), or throws where it has none:

- `not_permitted`: the extension's approval, or whoever set the call off,
  lacks what the method needs;
- `approval_required`: the extension is not approved as it is now (or was
  uninstalled while running).

The table of every host method and what it needs is
`packages/extension-sdk/src/services.ts` (`EXTENSION_HOST_SERVICES`,
`EXTENSION_MAIN_HOST_METHODS`, and a surface's `EXTENSION_FRAME_METHODS`).
Studio's gate reads it, and so do the fake hosts in
`@sprintengine/extension-sdk/testing`.

## Approval

Studio asks the person once, when an extension is installed or first switched
on, before it draws or runs any of it. The approval is bound to a fingerprint:
a sha256 over the permissions (sorted), the tier, whether it has a worker,
whether the worker runs in the background, and the content of every file it
ships. Approving names the fingerprint the person was shown, so an extension
that changed since is refused rather than approved unseen.

- A new version keeps its approval when it asks for no more: no new
  permission, no higher tier, no new worker, no background worker, no new MCP
  tool, no tool that may now change things, no command running a Studio
  action it did not run. Otherwise it waits for the person, who is shown what
  is new. A version that kept its approval, or one the person approves, loads
  at once, without restarting Studio.
- A development folder, which Studio loads from where it is and again on
  every save, is approved once for that folder and its access: the
  fingerprint covers its real path, permissions, tier, worker, background, MCP
  tools and their access, the Studio actions its commands run, custom
  editors, hooks, local MCP servers' command, arguments and environment, and
  providers' key origins, but not its files. A save keeps the approval, a
  save that asks for more waits for the person again, and asking for less
  keeps it. Removing the folder forgets it. It never covers an installed
  extension with the same key, nor the installed one's the folder, so a
  development folder cannot change an installed extension silently.
- Only the person approves: Studio refuses an approval from one of its own
  agents.
- An extension that only carries content (`tier: "content"`) needs no
  approval.
- Uninstalling forgets the approval.
- `extension.sig` is a badge, not a gate: a signature by a key Studio trusts
  shows as verified, and the extension still waits for the person's approval.
  A signature its files do not match keeps it from running at all.

## Vocabulary

The vocabulary is closed. It lives in
`packages/extension-sdk/src/permissions.ts` (`EXTENSION_PERMISSIONS`), and
extension.json validation refuses a name that is not in it. "Invoker" is what
whoever set the call off must hold, in the Studio protocol's permission names.

| Permission | What the person allows | Methods | Invoker |
| --- | --- | --- | --- |
| `workspace:read` | See your workspaces, their folders, branches and remotes | `WorkspaceContextToken`, `getWorkspaceGitInfo`, `getSkillStatus`; a surface's workspace reads, the workspace events (`workspace.created`, `.removed`, `.changed`) | `workspace:read` |
| `workspace:operate` | Make workspaces and put Studio's skills in them | `WorkspaceServiceToken`, `ensureSkillInstalled` | `workspace:operate` |
| `conversation:read` | Read every chat on this machine (broad) | `getActivityService`, the `agent.status.changed` event | `conversation:read` |
| `backlog:read` | Read Backlog items | `getBacklogService` reads; a surface's `backlog.list`, `backlog.location` | `backlog:read` |
| `backlog:operate` | Create Backlog items and change them | `getBacklogService` writes; a surface's other `backlog.*` | `backlog:operate` |
| `providers:read` | See which agents a chat can run on | `listChatRuntimes` | `providers:read` |
| `usage:read` | See token usage and cost of every agent session | `getUsageService`, a surface's `usage.query` | `workspace:read` |
| `workspace-files:read` | Read the files in your workspaces' folders | a surface's `files.read`, `files.stat`, `files.search`; a custom editor's file (`customEditors` needs it) | `filesystem:read` |
| `workspace-files:write` | Change and create files in your workspaces' folders | a surface's `files.write`; saving a custom editor's file | `filesystem:write` |
| `storage:own` | Save its own data | `getModuleStorage`, `getModuleDataDir`; a surface's `storage.*` | `extension:read` to read, `extension:operate` to write |
| `settings:own` | Read the values of its own Settings section | `getModuleAppState`, `watchModuleAppState`; a surface's `settings.get`, `settings.set` | `extension:read` to read, `extension:operate` to write |
| `secrets:own` | Store API keys and send them to the sites it names | `getSecretsService` | `extension:operate` |
| `notifications:show` | Show notifications in the bell | `notify` | `extension:operate` |
| `conversation:own` | Start chats of its own, drive them and read them | `getConversationService` | `conversation:create` to start, `conversation:operate` to drive, `conversation:read` to read |
| `conversation:bypass` | Let its chats run without asking | `bypass` and `allowedTools` for its chats, `tools: 'auto'` for a companion | (the chat's ceiling, below) |
| `chat:draft` | Open a chat with a drafted message | a surface's `chat.draft` | `conversation:create` |
| `schedules:own` | Schedule agents of its own | `getScheduledAgentsService` | `workspace:operate` to change, `workspace:read` to read |
| `agents:generate` | Send prompts to your models, with no chat | `getTextGenerationService` | `conversation:create` |
| `agents:companion` | Run its own background agents | `getCompanionAgentsService` | `conversation:create` |
| `github:api` | Call the GitHub API with your sign-in | `getGitHubService` | the person alone |
| `tools:contribute` | Add tools that agents can call | `registerMcpTools`, `contributes.mcpTools` | — |
| `terminals:send` | Type into your terminals and run commands: open terminals in your workspaces, type into any of them, and close the ones it opened | `getTerminalService` `send`, `create`, `close` (worker tier only) | the person alone, and not from a browser tab; an agent that asks before running commands cannot set it off |
| `terminals:read` | Read what your terminals show, which can include what commands print | `getTerminalService` `read` (worker tier only) | the person alone, and not from a browser tab |

Its own methods (`registerMethods`), events (`emit`) and files
(`getAssetPath`) need no permission.

## Policy beyond the gate

- An extension reaches only the chats, companions, schedules, secrets and
  storage it created, never another extension's and never the person's own
  (except read-only through `conversation:read`).
- `conversation:bypass` sets the loosest preset its chats run on: `bypass`
  with it, `auto` without. A chat it starts on someone's behalf is held to
  the lower of that and the invoker's own ceiling.
- `secrets:own` and `github:api` never hand the credential to extension
  code: a secret leaves the host only inside a request to an https origin it
  was stored with, and the GitHub token only inside a request to the GitHub
  API.
- The text generation service bounds each extension to two calls at once,
  eight waiting, and thirty a minute.

## Example

```json
{
  "manifestVersion": 1,
  "id": "workspace-dashboard",
  "version": "1.0.0",
  "engines": { "studio": ">=0.13.0" },
  "tier": "worker",
  "name": "Workspace Dashboard",
  "main": "src/main.ts",
  "permissions": ["workspace:read", "conversation:own", "secrets:own"]
}
```

`permissions` may be omitted (it defaults to `[]`). When present it is an
array of names from the vocabulary above, each at most once; an unknown name
or a duplicate fails validation. The validator is `validateExtensionManifest`
in `packages/extension-sdk/src/extension-manifest.ts`, the one Studio and the
SDK's CLI both run.
