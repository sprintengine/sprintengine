# Which surface

Pick the smallest surface and the lowest tier that do the job.
`extension.create` takes a `template` that starts from one of these, and
`parts` (`main`, `mcp`, `settings`, `door`) add more; in an existing project,
`npx sprintengine-extension add <part>` does the same.

## What extension.json adds

| The idea needs… | In extension.json | Tier | Template |
| --- | --- | --- | --- |
| A palette entry for one of Studio's own commands | `commands[]` with an `action` | `declarative` | settings-section |
| A palette entry that runs your code | `commands[]` without `action`, served by a worker method of the same name | `worker` | backlog-action |
| An item in a Backlog item's menu | `menus[]` `where: "backlog.item"`, naming a contributed command | `declarative` (`worker` for your code) | backlog-action |
| An item in a file's menu in the Files tree | `menus[]` `where: "file"` | as above | file-action |
| An action on one of your own bell rows | `menus[]` `where: "notification"` | as above | — |
| A button in the top bar | `topBarItems[]` with a `command` or a `door` | `declarative` | top-bar-item |
| A tab in a workspace's pane | `panels[]` with an `entry` | `ui` | panel, blank |
| A page of its own, with a row in the Extensions drawer | `doors[]` with an `entry` | `ui` | door |
| Options in Settings | `settingsSections[]` with an `entry` | `ui` | settings-section |
| An editor for files of a type (a form, a diagram, a binary format) | `customEditors[]` with an `entry` and its `extensions` or `filenames`; `workspace-files:read`, `:write` to save | `ui` | editor |
| Tools agents call | `mcpTools[]`, served by the worker; `tools:contribute` | `worker` | mcp-tools |
| Checks on what agents and Studio do (tool calls, prompts, launches, saves) | `hooks[]`, served by the worker (`registerHooks`) | `worker` | hook-guard |
| A skill every agent on the machine can use | `skills[]`, a folder holding a `SKILL.md` | `declarative` | agent-kit |
| An MCP server of your own (a local command, or a hosted URL) for every agent | `mcpServers[]` | `declarative` | agent-kit |
| A model provider for chats (an OpenAI-compatible endpoint) | `providers[]` | `declarative` | — |
| Work with no window open, Node, or a service only the worker has | `main` | `worker` | chat-companion |

A command's context tells the worker how it ran (`where`), the workspace, and
what the menu was opened on: `backlogItemIds` or `filePaths`
(`ExtensionCommandContext`). A top bar item has no drawing of its own: Studio
draws the button from its `title` and `icon`, and it runs a command or opens a
door. A cluster of controls belongs in a door.

## What the code reaches

| The idea needs… | API (`studio` in a surface, or the worker's) | Permission |
| --- | --- | --- |
| Tell the person something went wrong | worker: `studio.notify({ severity, title, target })` (the bell; `target` opens your door) | — |
| Say "done" | surface: `studio.toast({ tone, message })` (transient) | — |
| Open one of your doors | surface: `studio.openGlobalSurface(id)` | — |
| Reading or changing Backlog items | surface: `listBacklogItems`, `createBacklogItem`, `updateBacklogStatus`, …; worker: `getBacklogService(studio)` | `backlog:read` / `backlog:operate` |
| Token usage and cost across agent sessions | worker: `getUsageService(studio)`; surface: `queryUsage` | `usage:read` |
| Reading the person's own chats (standups, prompt coaching) | worker: `getActivityService(studio)` | `conversation:read` (broad) |
| An agent doing work in a chat | worker: `getConversationService(studio)` | `conversation:own` (or `:read`) |
| Hand the person a prepared chat | surface: `studio.host.call('chat.draft', { workspaceId, prompt, name })` | `chat:draft` |
| Ask a model one question (summary, digest, JSON), no chat | worker: `getTextGenerationService(studio).generate` | `agents:generate` |
| A background agent returning validated JSON | worker: `getCompanionAgentsService(studio)`, `runStructured({ tools: 'none' })` | `agents:companion` |
| An agent that runs on a schedule | worker: `getScheduledAgentsService(studio)` (`tag`, `onRun` to trace runs) | `schedules:own` |
| Calling an API with a key | worker: `getSecretsService(studio).fetchWithSecret` | `secrets:own` |
| Calling GitHub as the person | worker: `getGitHubService(studio).request` / `.graphql` (read-only) / `.download` (logs) | `github:api` |
| The workspaces, and a workspace's branch and GitHub remote | surface: `workspace.list`, `workspace.get`; worker: `WorkspaceContextToken`, `getWorkspaceGitInfo(workspaceId)` | `workspace:read` |
| Saving data | surface: `storage.*` (per workspace with `workspaceId`); worker: `getModuleStorage(studio)` (`list({ prefix })`, `getMany`, `watch`), `studio.getModuleDataDir()` past 1 MB | `storage:own` |
| Settings values | surface: `settings.get`, `settings.set`; worker: `getModuleAppState`, `watchModuleAppState` | `settings:own` |
| Files in a workspace's folder | surface: `files.read`, `files.stat`, `files.search`, `files.write` | `workspace-files:read`, `workspace-files:write` |
| The file a custom editor is open on | custom editor: `studio.document` (`session()`, or `get`, `onDidChange`, `applyEdit`) | `workspace-files:read` (`:write` to save) |
| A surface asking the worker | worker `studio.registerMethods<Contract>({ … })`, surface `studio.methods<Contract>().read` / `.operate`; worker → surface `studio.emit` / `studio.on('push', …)` | — |
| Files inside the extension (WASM, data) | surface: put them in a module it imports (images and fonts as `data:` URLs); worker: `studio.getAssetPath('src/data.json')` | — |

The details are in the `api-renderer`, `api-main`, `conversations`, `brokers`
and `styling` topics.

## Agents are chats

Studio drives agents as chats. An extension starts, prompts, watches and stops
its **own** chats through `getConversationService(studio)` in the worker, or
opens one for the person with `chat.draft` from a surface (a draft: the
person reads and sends it). It never drives the person's own chats
or another extension's; reading the person's chats is the separate, read-only
`getActivityService(studio)` behind the broad `conversation:read` (the
`api-main` topic). A question with one answer (a summary, a digest, a
classification) needs no chat at all: `getTextGenerationService(studio)`. Read
what an agent answered with `chats.reply(ref)`, never by joining streamed
text deltas. There is no API to spawn a terminal agent, run a CLI in a
pane, or inject into another session — do not look for one, and do not shell
out to an agent CLI from the worker to get around it. See the
`conversations` topic.

## Ask the host first

Before relying on a capability, ask: `studio.supports('conversations')`,
`'chat.open'`, `'secrets'`, `'github'`, `'storage'`, `'mcp-tools'`, … A host
without it answers `false`; degrade with a message instead of throwing.
