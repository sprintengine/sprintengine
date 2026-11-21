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
| Tools agents call | `mcpTools[]`, served by the worker; `mcp:tools` | `worker` | mcp-tools |
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
| Reading or changing Backlog items | surface: `listBacklogItems`, `createBacklogItem`, `updateBacklogStatus`, …; worker: `getBacklogService(studio)` | `backlog.read` / `backlog.write` |
| Token usage and cost across agent sessions | worker: `getUsageService(studio)`; surface: `queryUsage` | `usage:read` |
| Reading the person's own chats (standups, prompt coaching) | worker: `getActivityService(studio)` | `conversation:read-all` (broad) |
| An agent doing work in a chat | worker: `getConversationService(studio)` | `conversation:operate` (or `:read`) |
| Hand the person a prepared chat | surface: `studio.openChat({ workspaceId, prompt, name, dedupeKey })` | `chat:draft` (`conversation:operate` to send it) |
| Ask a model one question (summary, digest, JSON), no chat | worker: `getTextGenerationService(studio).generate` | `agents:generate` |
| A background agent returning validated JSON | worker: `getCompanionAgentsService(studio)`, `runStructured({ tools: 'none' })` | `agents:companion` |
| An agent that runs on a schedule | worker: `getScheduledAgentsService(studio)` (`tag`, `onRun` to trace runs) | `scheduled-agents.manage` |
| Calling an API with a key | worker: `getSecretsService(studio).fetchWithSecret` | `secrets` |
| Calling GitHub as the person | worker: `getGitHubService(studio).request` / `.graphql` (read-only) / `.download` (logs) | `github` |
| The workspaces, and a workspace's branch and GitHub remote | `listWorkspaces`, `watchWorkspaces`, `getWorkspaceGitInfo(workspaceId)` | `ipc:workspace-read` |
| Saving data | surface: `get/setModuleAppState`, `get/setWorkspaceModuleState`; worker: `getModuleStorage(studio)` (`list({ prefix })`, `getMany`, `watch`), `studio.getModuleDataDir()` past 1 MB | `storage` |
| A surface asking the worker | worker `studio.registerMethods<Contract>({ … })`, surface `studio.methods<Contract>().read` / `.operate`; worker → surface `studio.emit` / `studio.subscribe` | `module:bridge` |
| Files inside the extension (HTML, WASM, images) | surface: `studio.getAssetUrl('runtime/index.html')`; worker: `studio.getAssetPath('dist/worker.cjs')` | — |

The details are in the `api-renderer`, `api-main`, `conversations`, `brokers`
and `styling` topics.

## Agents are chats

Studio drives agents as chats. An extension starts, prompts, watches and stops
its **own** chats through `getConversationService(studio)` in the worker, or
opens one for the person with `studio.openChat` in a surface (a draft by
default: the person reads and sends it). It never drives the person's own chats
or another extension's; reading the person's chats is the separate, read-only
`getActivityService(studio)` behind the broad `conversation:read-all` (the
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
