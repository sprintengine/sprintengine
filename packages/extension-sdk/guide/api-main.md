# The worker (`main`)

The worker is the extension's background code: `main` in extension.json, a
module (`.ts`, `.mts`, `.cts`, `.js`, `.mjs` or `.cjs`) loaded as written,
with no build. It exports `activate`, as a named export or its default.
Studio runs it in a Node process of its own, one per extension, with a clean
environment (none of Studio's variables or the shell's credentials), strips
its TypeScript types in place (Node's own transpiler, every line and column
kept), loads `main` there and calls `activate` with a `studio` object. Its
output goes to the extension's log, in Studio's logs folder under
`extensions/`, and to `sprintengine-extension dev watch` as `[worker]` lines.
A worker that fails to activate says where: `src/greet.ts:4:7 message`.

When it runs:

- **On demand.** It starts when something needs it: one of its methods, a
  command, an MCP tool, a surface's `worker.request`. It is stopped after five
  idle minutes and starts again at the next call, and every listener it
  registered (`watch`, `subscribe`, `onStatus`, `watchModuleAppState`) stops
  with it. At most five on-demand workers run at once; one more waits for a
  place.
- **To keep listening across idle periods**, set `background: true`.
- **In the background.** `background: true` in extension.json starts it when
  the extension is switched on and keeps it running. At most sixteen run;
  past that the newest waits, and Settings says why.
- **Supervised.** `activate` must finish within ten seconds, and each call
  within thirty. A worker that crashes is started again after half a second,
  two seconds and five; after a fourth crash it stays stopped, shown as failed
  in Settings and in the bell, until it is switched off and on again.
- **Restarted on the new code** when a development folder it comes from is
  saved, or an update is installed or approved: Studio loads it again live,
  without a restart of Studio.
- **Stopped** when it is switched off or uninstalled, or its approval changes
  (an update installed): it has two seconds for its `onShutdown` hooks, then
  it is ended. A call still running fails with words that say why.

Every call into Studio crosses to Studio's process. A call that answers data
answers a promise (`getModuleAppState`, a conversation service's `list`, a
companion's `attach` and `status`); one that answers an unsubscriber answers it
at once, and a refusal of it is written to the extension's log. Studio holds
each call to whoever set off the work it is part of: a call made from work
left running after that call ended (a timer, say) is refused. A
`background: true` worker's own work, which is everything `activate` and its
startup hooks set going (a poller's interval, a listener and each delivery to
it), runs as the person who approved it for as long as the worker runs. A
worker provides no services of its own.

```ts
import type { MainHost } from '@sprintengine/extension-sdk'

export function activate(studio: MainHost): void {
  studio.registerMethods({ /* … */ })
}
```

`activate` may be async. It registers what the worker serves: its methods
(the surfaces call them, and so does every command without an `action`) and
the handlers of the MCP tools extension.json declares. Everything else the
extension adds is declared in extension.json. Types: `MainHost`,
`ExtensionActivate`, `ExtensionCommandContext` in
`@sprintengine/extension-sdk`.

Use a worker only when the idea needs Node, a service only the worker has, a
command that runs your code, MCP tools, or work with no window open. It takes
the `worker` tier, the most the person is asked to allow.

Write only erasable TypeScript: an `enum`, a `namespace` or a parameter
property needs code, so it fails to load, and there is no JSX. Relative imports
may leave out the extension (`./methods` finds `methods.ts`, and `./methods.js`
does too). A worker runs as plain Node: `electron` is never there to require.
`@sprintengine/extension-sdk` resolves from the extension's own
`node_modules` when it has one, else from the SDK of the Studio running it; a
packed extension has no `node_modules`, so copy any other package into the
extension or bundle it and import the bundle. It may start worker threads from
other files it ships: ship each as JavaScript and start it with
`new Worker(studio.getAssetPath('src/thread.mjs'))`.

## Commands

A command in extension.json without an `action` runs the worker method of the
same name. Declare it with `registerMethods`, access `operate`. Its params are
an `ExtensionCommandContext`: `where` it ran from (`palette`, `topBar`,
`backlog.item`, `file`, `notification`), the `workspaceId`, and what the menu
was opened on (`backlogItemIds`, `filePaths`, `notification`).

```ts
import type { ExtensionCommandContext, MainHost, ModuleMethodParsed } from '@sprintengine/extension-sdk'

const readContext = (value: unknown): ModuleMethodParsed<ExtensionCommandContext> =>
  typeof value === 'object' && value !== null && 'where' in value
    ? { ok: true, params: value as ExtensionCommandContext }
    : { ok: false, message: 'Run it from a menu.' }

export function activate(studio: MainHost): void {
  studio.registerMethods({
    'add-to-backlog': {
      access: 'operate',
      params: readContext,
      handler: async ({ workspaceId, filePaths = [] }) => {
        // …
        return { ok: true, result: null }
      },
    },
  })
}
```

`npm run check` lists the methods the worker registered: a command without an
`action` needs an `operate` method of its name there, and in Studio it does
nothing useful without one.

## `studio`

| Member | Notes |
| --- | --- |
| `moduleId`, `supports(capability)` | Your install key (`local.<id>` for a folder install and a development folder); ask `supports` before using a capability. |
| `listChatRuntimes()` | `Promise<[{ id, label, available, models, lastSelected }]>`: the agent runtimes a chat can run on, with missing ones `available: false`. `id` is the runtime id every `cli` takes. May probe (cached a minute). `supports('chat-runtimes')`. `providers:read`. |
| `registerMethods<Contract>(methods)` | Methods the surfaces call with `studio.methods<Contract>()`, and the methods your commands run: each `{ access: 'read' \| 'operate', params, handler }`. `params` validates what was sent (`{ ok: true, params }` or `{ ok: false, message }`, answered `invalid_params`); the handler gets `(params, { clientId, commandId? })` and answers `{ ok: true, result }` (JSON) or `{ ok: false, code, message }`. Names: a lower-case letter, then letters, digits, dots, dashes. Needs no permission. |
| `emit(topic, payload?)` | Push a signal to every open surface (`studio.on('push', cb)`). No replay. |
| `events.on(event, handler)` | Hear one of the Studio events extension.json lists (`contributes.events`): `{ dispose() }`. A worker that is not running is started to hear one. Each needs its permission; the `events` topic has the table. `supports('events')`. |
| `registerMcpTools(tools)` | Serve the MCP tools extension.json declares (`contributes.mcpTools`). A tool not declared there is refused; the declaration's `description` and `access` are what agents see. Needs `tools:contribute`. |
| `ensureSkillInstalled(root, id)` / `getSkillStatus(root, id)` | Put one of Studio's own skills in a workspace, or check without writing (below). `workspace:operate` / `workspace:read`. |
| `getModuleAppState(key)` / `watchModuleAppState(cb)` | Your extension's app state (what its surfaces and its settings section write), read-only, with no window open. `settings:own`. |
| `getWorkspaceGitInfo(workspaceId)` | `{ ok, branch, remotes: [{ name, url, github? }] }`, read by git from the workspace's folder. Checked: `workspace:read`. |
| `getModuleDataDir()` | A private directory under user data for data past the 1 MB value limit; removed at uninstall. `storage:own`. |
| `getAssetPath(relative)` | Absolute path of a file your extension ships (a worker thread, WASM, a data table); verified files only. |
| `notify({ severity, title, body?, target? })` | A row in the bell of every open window, under the extension's name. The bell is for what went wrong: only `warning` and `error` reach it, and an `info` notify files nothing (say routine news with `toast` from a surface). `target: { surfaceId }` (one of your own doors) gives the row an Open that lands there. Dropped: an identical repeat within 10 s, or more than 20 rows in 10 s — fold a burst into one row. Rows sent before a window opens are kept (last 50). A `notification` menu item in extension.json adds a command to your rows. `supports('notifications')` is false where no window can show it. `notifications:show`. |
| `onStartup(hook)` / `onShutdownBegin(hook)` / `onShutdown(hook)` | Start watchers on startup; stop loops at shutdown begin; release everything at shutdown. |
| `requireService(token)` / `getService(token)` | Host services by token (below). `requireService` throws when absent. |
| `registerSidecar(spec)` | A declaration only; the host does not spawn an extension's sidecars. |

## Services

Each helper closes over `studio.moduleId`, so an extension only ever reaches
its own data.

| Helper / token | Permission | What |
| --- | --- | --- |
| `getConversationService(studio)` | `conversation:own` | The extension's own chats — the `conversations` topic |
| `getModuleStorage(studio)` | `storage:own` | JSON key-value store, per workspace (`workspaceRoot`) or global; 1 MB per value; atomic writes |
| `getSecretsService(studio)` | `secrets:own` | API keys the host holds and sends only to named origins — the `brokers` topic |
| `getGitHubService(studio)` | `github:api` | GitHub API calls with the person's sign-in — the `brokers` topic |
| `getScheduledAgentsService(studio)` | `schedules:own` | Create/list/update/remove/run the extension's own scheduled agents, and hear when they change (`onChanged`) and when one starts a chat (`onRun`) |
| `getCompanionAgentsService(studio)` | `agents:companion` | A workspace-bound background agent with a structured `runStructured` task API |
| `getTextGenerationService(studio)` | `agents:generate` | One prompt answered by the person's own Claude Code or Codex with no chat or workspace — the `conversations` topic |
| `studio.requireService(WorkspaceContextToken)` | `workspace:read` | `get(id)`, and `list()` of open workspaces `{ id, name, folderPath, mode, open }`; `list({ includeClosed: true })` adds the ones closed on this machine (`open: false`, `closedAt`) |
| `studio.requireService(WorkspaceServiceToken)` | `workspace:operate` | `create({ name, folderPath })` a workspace |
| `getBacklogService(studio)` | `backlog:read` / `backlog:operate` | List, locate, create and change Backlog items through the app — below |
| `getUsageService(studio)` | `usage:read` | Token usage of every agent session on the machine — below |
| `getTerminalService(studio)` | `terminals:send`, `terminals:read` | The person's terminals: `send`, `create`, `read`, `close` — the `events` topic |
| `getActivityService(studio)` | `conversation:read` | The person's Studio chats and prompts, read-only — below |

## Settings in the worker

What your settings section and your other surfaces write with
`setModuleAppState` is one namespace, and the worker reads it with
`studio.getModuleAppState(key)` — the value the person chose, persisted, with no
window open. `studio.watchModuleAppState(cb)` hears it change. Read-only from
the worker; no second store. The worker runs in a process of its own, so the
read answers a promise.

```ts
const every = (await studio.getModuleAppState<number>('pollMinutes')) ?? 15
const stop = studio.watchModuleAppState((values) => reschedule(Number(values.pollMinutes ?? 15)))
studio.onShutdown(stop)
```

## MCP tools

Declare each tool in extension.json, with its parameters (`inputSchema`,
required: agents see it before the worker has ever run), then serve it from
`activate` with a schema that takes no more:

```json
"permissions": ["tools:contribute"],
"contributes": {
  "mcpTools": [
    {
      "name": "wordcount_count",
      "description": "Count the words in a piece of text.",
      "access": "read",
      "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }
    }
  ]
}
```

```ts
studio.registerMcpTools([
  {
    name: 'wordcount_count',
    description: 'Count the words in a piece of text.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: async (args) => ({ content: [{ type: 'text', text: String(String(args.text).split(/\s+/).length) }] }),
  },
])
```

- A tool the worker registers that extension.json does not declare is
  refused. The declaration's `description` is what agents are told, and its
  `access` decides whether the tool counts as changing anything (`operate`) or
  only reading (`read`), whatever the registration says.
- Tool names are lower-case letters, digits and underscores. They are a public
  contract: keep them stable, in a family of your own named for the extension
  (`decisions_record`, `decisions_list`). The gateway serves names verbatim. A
  name that matches a core tool (`backlog_list`), falls in a shell family
  (`browser`, `canvas`, `editor`, `tour`, `terminal`) or matches another
  extension's tool is a registration error naming the conflict. Keep out of
  the core families too (`agent`, `backlog`, `cli`, `conversation`,
  `extension`, `local_server`, `marketplace`, `module`, `pull_request`,
  `schedule`, `tailnet`, `workspace`, `worktree`, `studio`, `sprintengine`,
  `app`): new core tools land there.
- `context.metadata` says who is calling. `verified: true` means a launch token
  or the tailnet proved it; a chat Studio launched is always `studio-agent`,
  verified, with `workspaceId` and `agentId`, and `agentName` / `cliId` when
  the launch recorded them. Anything else declared its identity: never label
  that as verified authorship.
- `args` comes from an agent: validate every field; return `isError: true`
  with a sentence the agent can act on rather than throwing.
- While the extension is off its tools stay listed and answer with an
  "enable the extension" error.

## Scheduled agents

A scheduled agent is a prompt and a cron schedule: each time the schedule
comes round, a new chat starts in `folderPath` with the prompt as its first
message, on the CLI, model, permissions, skills, MCP servers and worktree
setting recorded. `getScheduledAgentsService(studio).create(draft)` validates
the draft (a cron that does not parse, or never comes round, is refused with
the reason) and answers `{ ok: true, agent }` with `agent.nextRunAt`. The
extension sees and changes only the ones it created; the person sees them in the
sidebar with their own, and can close them.

Give each a `name` (its sidebar title; absent, the prompt's first line) and a
`tag` (your own label, never shown). `onRun((agent, run) => …)` names each
run's chat as it starts — one-time schedules included, before they close —
and that chat, which your conversation service reaches, carries
`scheduledAgentId` and `scheduledAgentTag`. A time missed while the app was
closed is not replayed (a one-time schedule's is, once, at start-up); times
missed in sleep run once on waking; a time that comes while the last run is
still working is skipped. `supports('scheduled-agent-runs')`.

## Companion agents and their tools

`await getCompanionAgentsService(studio).attach(spec)` gives a background agent bound
to a workspace; `runStructured({ prompt, validate, tools? })` runs one task
and returns validated JSON. The agent asks before every tool it uses, and
`tools` decides the answer:

- `'none'` (default): denied, and the agent is told up front it has no tools.
  Use it whenever the prompt carries text you did not write.
- `'ask'`: left open for the person. Show the `approval_requested` events from
  `onEvent` and relay their answer with `handle.respondToApproval({ requestId,
  decision: 'once' | 'deny' })`; allowing needs `conversation:own`.
- `'auto'`: approved without asking. Needs `conversation:bypass` (the run is
  refused without it).

`engine: { cli, model }` takes a runtime id (`claude-code`) or a provider id
(`claude-agent`). `supports('companion-tools')`; a host without it approves every
tool call whatever `tools` says, so do not feed it untrusted text there.

## Backlog, usage and activity

**Backlog.** `getBacklogService(studio)`: `list`, `getLocation`, `create`,
`updateStatus`, `updateTriage`, `addLink`, `updateModuleMetadata`. `itemId` is
a `BacklogItemView.id`. Writes go through the app's Backlog service in the
project's mutation lane; `create` uses the app's create path and answers
`{ id, relativePath, path, numericId, displayId }`. Never write an item's file
yourself, and never derive the Backlog root: `getLocation` answers it.

**Usage.** `getUsageService(studio).query({ from, to, groupBy })` sums tokens
(`input`, `output`, `cacheRead`, `cacheWrite`) and requests over Studio chats
and terminal Claude Code / Codex sessions, each request once. `groupBy`:
`day`, `model`, `provider`, `workspace`, `session`. Tokens only — price them
yourself. The first query waits for the first read of the logs; `onChanged`
says when to query again. Do not read `~/.claude` or `~/.codex` yourself.

**Activity.** `getActivityService(studio)`: `listChats({ from?, to?,
workspaceId? })` and `prompts({ from, to, workspaceId?, limit? })` — the
person's messages with the tail of each reply, never tool output. Open
workspaces only. `conversation:read` is flagged broad in the consent
prompt; ask for it only when reading the person's chats is the extension's point.

## Storage

```ts
const storage = getModuleStorage(studio)
const saved = await storage.get({ key: 'state', workspaceRoot })   // { ok, value, found } | { ok: false, code, message }
await storage.set({ key: 'state', value: { count: 1 }, workspaceRoot })
const { keys } = await storage.list({ workspaceRoot, prefix: 'decision.' })  // one record family
const many = await storage.getMany({ keys, workspaceRoot })        // { ok, values } — unset keys are absent
const stop = storage.watch({ workspaceRoot }, ({ keys }) => refresh(keys))  // own writes at once; another window's within ~2 s
```

Keys match `^[a-z0-9][a-z0-9._-]{0,63}$`. Omit `workspaceRoot` for the
extension's global store. The host decides where files go (`modules/<id>/` in
the project's store in the person's home, or app data); never write your own
files in the home folder or the workspace for its state. Workspace keys are
not in the project's folder, so they never show in its `git status` and do not
travel with a clone.

Past the 1 MB value limit (caches, indexes, blobs), use
`studio.getModuleDataDir()`: a directory of your own under the app's user data,
created on demand and removed when the extension is uninstalled. Lay it out
however you like; it is per machine and never synced.

## Skills

An extension ships its own skills with `contributes.skills` in extension.json
(the `manifest` topic). The worker can also put one of Studio's own skills in a workspace before it starts a chat that
uses it. `ensureSkillInstalled(root, id)` writes it; `getSkillStatus(root, id)`
answers the same question without writing, for a door that shows "installed
in this project". Both never throw and answer a `ModuleSkillStatus`
(`installed`, `updated`, `missing`, `update-available`, `local`, `modified`,
`delivered-at-launch`, `missing-source`, `missing-workspace`, `unknown-skill`,
`install-failed`).
