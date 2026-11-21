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

A permission does **not** limit the extension's own code. A `ui` or `worker`
extension's code runs inside Studio with full access to this machine: its
files, its programs, its network and its accounts. The approval says so in
those words. Do not describe your extension as "sandboxed" or "restricted to"
its permissions.

A refused call answers, in the method's own failure shape where it has one
(`{ ok: false, code, message }`), or throws where it has none:

- `not_permitted`: the extension's approval, or whoever set the call off,
  lacks what the method needs;
- `approval_required`: the extension is not approved as it is now (or was
  uninstalled while running).

The table of every host method and what it needs is
`packages/extension-sdk/src/services.ts` (`EXTENSION_HOST_SERVICES`,
`EXTENSION_MAIN_HOST_METHODS`, `EXTENSION_RENDERER_METHODS`). Studio's gate
reads it, and so do the fake hosts in `@sprintengine/extension-sdk/testing`.

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
  is new. A version that kept its approval runs on until Studio starts again,
  held to what both versions were approved for.
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
| `workspace:read` | See your workspaces, their folders, branches and remotes | `WorkspaceContextToken`, `getWorkspaceGitInfo`, `getSkillStatus`; a surface's workspace reads | `workspace:read` |
| `workspace:operate` | Make workspaces and put Studio's skills in them | `WorkspaceServiceToken`, `ensureSkillInstalled` | `workspace:operate` |
| `conversation:read` | Read every chat on this machine (broad) | `getActivityService` | `conversation:read` |
| `backlog:read` | Read Backlog items | `getBacklogService` reads; a surface's `listBacklogItems`, `watchBacklogItems`, `getBacklogLocation` | `backlog:read` |
| `backlog:operate` | Create Backlog items and change them | `getBacklogService` writes; a surface's Backlog write methods | `backlog:operate` |
| `providers:read` | See which agents a chat can run on | `listChatRuntimes` | `providers:read` |
| `usage:read` | See token usage and cost of every agent session | `getUsageService`, a surface's `queryUsage` | `workspace:read` |
| `storage:own` | Save its own data | `getModuleStorage`, `getModuleDataDir`; a surface's workspace state | `extension:read` to read, `extension:operate` to write |
| `settings:own` | Read the values of its own Settings section | `getModuleAppState`, `watchModuleAppState`; a surface's app state | `extension:read` |
| `secrets:own` | Store API keys and send them to the sites it names | `getSecretsService` | `extension:operate` |
| `notifications:show` | Show notifications in the bell | `notify` | `extension:operate` |
| `conversation:own` | Start chats of its own, drive them and read them | `getConversationService`; `openChat` with `send: true` | `conversation:create` to start, `conversation:operate` to drive, `conversation:read` to read |
| `conversation:bypass` | Let its chats run without asking | `bypass` and `allowedTools` for its chats, `tools: 'auto'` for a companion | (the chat's ceiling, below) |
| `chat:draft` | Open a chat with a drafted message | `openChat` without `send` | — |
| `schedules:own` | Schedule agents of its own | `getScheduledAgentsService` | `workspace:operate` to change, `workspace:read` to read |
| `agents:generate` | Send prompts to your models, with no chat | `getTextGenerationService` | `conversation:create` |
| `agents:companion` | Run its own background agents | `getCompanionAgentsService` | `conversation:create` |
| `github:api` | Call the GitHub API with your sign-in | `getGitHubService` | the person alone |
| `tools:contribute` | Add tools that agents can call | `registerMcpTools`, `contributes.mcpTools` | — |

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
  "main": "dist/main.cjs",
  "permissions": ["workspace:read", "conversation:own", "secrets:own"]
}
```

`permissions` may be omitted (it defaults to `[]`). When present it is an
array of names from the vocabulary above, each at most once; an unknown name
or a duplicate fails validation. The validator is `validateExtensionManifest`
in `packages/extension-sdk/src/extension-manifest.ts`, the one Studio and the
SDK's CLI both run.
