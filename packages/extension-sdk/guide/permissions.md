# Permissions

`permissions` in `extension/extension.json` is what the person reads before
approving the extension, and what Studio holds its calls to. Every call your
code makes into Studio is checked at the host against two things, and goes
through only when both hold:

- the permissions the person approved for your extension;
- what whoever set the call off may do themselves: the person at this machine
  may do everything; a paired device or another app may do what it was
  granted; an agent calling your MCP tool may do what the person may, and the
  chats you start for it run no looser than it does.

A refused call answers `not_permitted` (your approval, or the invoker, lacks
what it needs) or `approval_required` (your extension is not approved as it is
now), in the method's own failure shape where it has one, or throws.

What your code can do beyond that depends on where it runs. A `ui`
extension's code runs in sandboxed frames with no network and no reach into
Studio's window or this machine, so its permissions are all it can do, and the
approval says so. A `worker` extension's code runs on this machine with full
access, and the approval tells the person exactly that.

`workspace-files:read` and `workspace-files:write` are a surface's way to the
files in a workspace's folder (`files.*`): only inside the folder, never
through a link out of it, never under `.git`, and only for a person, device or
browser that may read or write files on that machine themselves. A project's
files can run code, so `workspace-files:write` is full access to the person's
account, and the approval of a `ui` extension holding it says so instead of
"runs isolated".

Rules:

- Ask for what the code does, no more. "Might need it later" is not a reason.
- Only the `ui` and `worker` tiers hold permissions. A `content` or
  `declarative` extension runs none of its own code, so it asks for nothing.
- The list is closed: a name the SDK does not know fails validation, so a typo
  is caught before anyone reads it.
- The approval is bound to your permissions, tier, worker and files. A new
  version keeps it when it asks for no more; asking for more asks the person
  again, and shows them what is new.

| Permission | The approval says | Ask for it when you use | Whoever set the call off needs |
| --- | --- | --- | --- |
| `workspace:read` | See your workspaces, their folders, branches and remotes | `WorkspaceContextToken`, `getWorkspaceGitInfo`, `getSkillStatus`, a surface's `workspace.list`, `workspace.get` | `workspace:read` |
| `workspace:operate` | Make workspaces and put Studio’s skills in them | `WorkspaceServiceToken`, `ensureSkillInstalled` | `workspace:operate` |
| `conversation:read` | Read every chat on this machine, including what you and the agents wrote (broad) | `getActivityService` | `conversation:read` |
| `backlog:read` | Read Backlog items | `getBacklogService` reads, a surface's `backlog.list`, `backlog.location` | `backlog:read` |
| `backlog:operate` | Create Backlog items and change their status, triage, links and metadata | `getBacklogService` writes, a surface's `backlog.create`, `.updateStatus`, `.updateTriage`, `.addLink`, `.updateModuleMetadata` | `backlog:operate` |
| `providers:read` | See which agents a chat can run on | `listChatRuntimes` | `providers:read` |
| `workspace-files:read` | Read the files in your workspaces’ folders | a surface's `files.read`, `files.stat`, `files.search` | `filesystem:read` |
| `workspace-files:write` | Change and create files in your workspaces’ folders | a surface's `files.write` | `filesystem:write` |
| `usage:read` | See token usage and cost of every agent session on this machine | `getUsageService`, a surface's `usage.query` | `workspace:read` |
| `storage:own` | Save its own data | `getModuleStorage`, `getModuleDataDir`, a surface's `storage.*` | `extension:read` / `extension:operate` |
| `settings:own` | Read the values of its own Settings section | `getModuleAppState`, `watchModuleAppState`, a surface's `settings.get`, `settings.set` | `extension:read` |
| `secrets:own` | Store API keys and send them to the sites it names | `getSecretsService` | `extension:operate` |
| `notifications:show` | Show notifications in the bell | `notify` | `extension:operate` |
| `conversation:own` | Start chats of its own with your agents, send them messages, read them and stop them | `getConversationService`, allowing a companion's tool call | `conversation:create` / `operate` / `read` |
| `conversation:bypass` | Let the agents in its chats edit files and run commands without asking you first | `bypass` chats, `allowedTools`, a companion task with `tools: 'auto'` | a ceiling of `bypass` |
| `chat:draft` | Open a chat with a message drafted for you to read and send | a surface's `chat.draft` | `conversation:create` |
| `schedules:own` | Schedule agents of its own that start a chat on a timer | `getScheduledAgentsService` | `workspace:operate` / `workspace:read` |
| `agents:generate` | Send prompts to your AI models in the background, without opening a chat | `getTextGenerationService` | `conversation:create` |
| `agents:companion` | Run its own background agents inside a workspace | `getCompanionAgentsService` | `conversation:create` |
| `github:api` | Use your GitHub sign-in to call the GitHub API (the token is never shown to the extension) | `getGitHubService` (`request`, `graphql`, `download`, `status`) | the person alone |
| `tools:contribute` | Add tools that agents in your workspaces can call | `registerMcpTools`, and declaring `contributes.mcpTools` | — |

Your own methods (`registerMethods`, which your surfaces call with
`studio.methods()` and your commands without an `action` run), your own events
(`emit`) and your own files (`getAssetPath`) need no permission. Contributions
themselves need none either: commands, menu items, top bar items, panels,
doors and settings sections are covered by the tier. Declaring
`contributes.mcpTools` is the exception: it needs `tools:contribute`.

The smoke test (`test/smoke.test.mjs`) activates the worker against the SDK's
fake host, which refuses what the real host refuses, from the same table
(`EXTENSION_HOST_SERVICES` and `EXTENSION_MAIN_HOST_METHODS` in the SDK), so it
cannot fall behind the host; every refusal is also listed in `undeclared`,
which a clean extension leaves empty. A surface's tests do the same with
`createFakeFrameStudio`, from the same table (`EXTENSION_FRAME_METHODS`).
