# @sprintengine/extension-sdk

The contract, templates and authoring CLI for building **SprintEngine Studio
extensions**: the `extension.json` manifest, its validator and JSON Schema,
the `mount` / `activate` entry contract, chat conversations with the app's
agents, brokered secrets and GitHub access, scheduled agents, storage,
notifications, and signing.

Studio is a home for agent runtimes — Claude Code, Codex and the ACP agents —
and an extension reaches those agents one way: **as chats**. An extension
starts, drives and reads chat conversations it owns, opens a chat for the
person with a drafted prompt, or runs a background companion agent. It never
launches, types into, or watches an agent terminal; that surface is not part
of the SDK.

The package is types-first. Beyond the declarations it ships the manifest
validator (`validateExtensionManifest`), the JSON Schema
(`@sprintengine/extension-sdk/extension.schema.json`), a few small pure values
(`KNOWN_CAPABILITY_PERMISSIONS`, `EXTENSION_MANIFEST_SINCE`,
`createServiceToken`, the `get*Service` helpers), signing
(`@sprintengine/extension-sdk/signing`), the `sprintengine-extension` CLI, the
starter templates, the extension guide for agents (`guide/`,
`@sprintengine/extension-sdk/guide`), and fake hosts for testing
(`@sprintengine/extension-sdk/testing`). It has no runtime dependency on
Electron or on the app's code, so a project compiles against the tarball
alone. Node 22.15 or newer.

## Quick start

```sh
npx -p @sprintengine/extension-sdk sprintengine-extension init my-extension --template panel
cd my-extension
npm install
npm run check        # typecheck, build, tests (smoke test and yours), validate
npm run dev:install  # side-load into Studio on this machine
```

`init <dir> --template <id> [--with <part,...>] [--id <id>] [--name <display name>]`
scaffolds a project that already builds, passes its own tests and installs.
`--sdk-tarball <file>` depends on a local SDK build instead of the npm release
(for working on the SDK itself). Templates:

| Template | What it starts you with | Tier |
| --- | --- | --- |
| `blank` | One small panel: the smallest extension that draws something | `ui` |
| `panel` | A notes panel, saved in the extension's app state | `ui` |
| `door` | A full-window door listing the open workspaces | `ui` |
| `chat-companion` | A worker that starts and follows chats of its own, and a panel to drive it | `worker` |
| `top-bar-item` | A top bar button opening a focus-timer door | `ui` |
| `settings-section` | A section in Settings, and a command that opens Settings | `ui` |
| `backlog-action` | A Backlog item menu command whose worker starts a planning chat per item | `worker` |
| `file-action` | A Files-tree menu command whose worker files a Backlog item naming the files | `worker` |
| `mcp-tools` | A worker serving declared tools to any agent through Studio's MCP server | `worker` |

Templates combine. `--with` adds parts on top of the one you start from, and
`sprintengine-extension add <part>...` adds them to a project you already have:

| Part | What it adds |
| --- | --- |
| `main` | The worker: `src/main.ts` exporting `activate`, its methods' contract in `src/methods.ts`, `main` in extension.json and its `build:main` script, and `module:bridge` |
| `mcp` | MCP tools declared in `contributes.mcpTools` and served from `activate` (`mcp:tools`); brings `main` when missing |
| `settings` | A settings section (`storage`) |
| `door` | A door with a row in the Extensions drawer |

A part copies its files and its test, merges its contributions and permissions
into `extension/extension.json`, raises `tier` when it needs to, adds its
scripts and devDependencies to `package.json`, and wires an MCP part into
`activate` in `src/main.ts`. When `activate` is not one of the shapes the
templates write, `add` says what to call instead.

Studio can do the same from the Extensions door: **Build your own extension**
opens New chat in extension mode. You name the extension, pick the project it
goes in and describe it (or start from one of the ideas, one per template);
Studio scaffolds `<project>/<name>` from the `blank` template and opens a chat
on it with the agent you pick, which adds what your description needs. The app
ships this SDK beside itself, so such a project depends on its own copy,
`vendor/sprintengine-extension-sdk-<version>.tgz`, by `file:`: `npm install`
needs no registry, and the project builds against the SDK of the Studio that
made it. Commit `vendor/` with the project.

### The extension guide

The working method for an agent building an extension — the project layout,
which contribution or API to reach for, choosing a tier and permissions, the
check / side-load loop, signing, and what "not trusted", "tampered" and "needs
a newer Studio" mean — is a set of topics in the package's `guide/` folder
(`start`, `surfaces`, `manifest`, `permissions`, `rules`, `api-renderer`,
`api-main`, `conversations`, `brokers`, `styling`, `troubleshooting`,
`publishing`), listed by `EXTENSION_GUIDE_TOPICS` in
`@sprintengine/extension-sdk/guide`.

An agent Studio serves reads them with Studio's `extension.guide` tool, and
`extension.create` makes a new project the way `init` does, answering with the
`start` topic. A scaffolded project's `AGENTS.md` sends its agent to the
guide, and to `node_modules/@sprintengine/extension-sdk/guide/` when Studio's
tools are not to hand. Projects carry no copy of it, so they never hold a
stale one.

### Project layout

```
extension/extension.json  the manifest; extension/ is the folder Studio installs
extension/dist/           build output: one self-contained bundle per ui entry, main.cjs for the worker
src/<name>.tsx            a surface, exporting mount(root, studio); builds to dist/<name>.js
src/main.ts               the worker, exporting activate(studio) (templates that have one)
test/smoke.test.mjs       loads the built extension the way Studio does
test/manifest.ts          extension.json, validated, for your tests
test/*.test.ts            your tests, in TypeScript (see Testing)
scripts/                  build-ui.mjs, validate.mjs, dev-install.mjs, check-toolchain.mjs
IDEA.md                   the brief
```

The scripts: `build:ui` (`node scripts/build-ui.mjs`, bundling each ui entry
extension.json names from `src/<name>.tsx`, React included), `build:main`
(esbuild, CommonJS, `electron` external), `build`, `test`, `validate`,
`check` (typecheck, build, test, validate), `dev:install` and `keygen`. The
build writes `extension/dist/` and never touches extension.json.

## What an extension is

A folder with `extension.json` at its root and the files it names. Every path
in it is relative to that folder.

```json
{
  "$schema": "../node_modules/@sprintengine/extension-sdk/extension.schema.json",
  "manifestVersion": 1,
  "id": "notes",
  "version": "1.0.0",
  "engines": { "studio": ">=0.13.0" },
  "tier": "worker",
  "name": "Notes",
  "permissions": ["storage", "module:bridge"],
  "main": "dist/main.cjs",
  "contributes": {
    "commands": [{ "id": "notes.clear", "title": "Clear notes" }],
    "menus": [{ "where": "backlog.item", "command": "notes.clear" }],
    "panels": [{ "id": "notes", "title": "Notes", "icon": "notes", "entry": "dist/notes.js" }]
  }
}
```

- **`tier`** is the most authority the extension needs: `content` (a name and
  images), `declarative` (commands that run Studio's own commands, menu items
  and top bar items for them), `ui` (panels, doors and settings sections drawn
  by its own code, and permissions), `worker` (`main`, background code). Each
  carries what the ones below it do; anything above the tier fails validation.
- **`contributes`** is everything it adds: `commands`, `menus`
  (`backlog.item`, `file`, `notification`), `topBarItems`, `panels`, `doors`,
  `settingsSections`, `mcpTools`. Other point names are reserved and must be
  empty.
- **A ui entry** (`panels[].entry`, `doors[].entry`,
  `settingsSections[].entry`) is a self-contained ESM bundle exporting
  `mount(root, studio)`. Studio imports its text as a blob module, so it
  bundles everything it imports, React included; Studio shares no React or UI
  kit with it. `mount` draws into `root`, calls `studio.ready()` once drawn,
  and may return a cleanup.
- **The worker** (`main`) is a CommonJS bundle loaded with Node's `require`,
  exporting `activate(studio)` as a named export or its default. It registers
  its methods and serves the MCP tools extension.json declares.
- **A command without `action`** runs the worker method of its name
  (`registerMethods`, access `operate`), with an `ExtensionCommandContext`
  saying where it ran and what it was picked on. One with an `action` runs a
  Studio command and no extension code.

`validateExtensionManifest(raw, { authoring })` is the one validator — Studio,
the CLI and the templates all call it. Unknown keys are refused at every
level. With `authoring: true`, `engines.studio` must cover the newest field
the manifest uses; extension.json is read from Studio 0.13.0
(`EXTENSION_MANIFEST_SINCE`). The JSON Schema and the guide's `manifest` topic
are generated from the validator's field table.

**Install keys.** Studio installs an extension under `<publisher>.<id>`; a
folder install is `local.<id>`, in `~/.sprintengine/extensions/local.<id>/`
(`SPRINTENGINE_USER_EXTENSION_ROOT` moves the root). The key is
`studio.moduleId`, and what trust and storage are keyed by. Ids starting
`studio-` or `sprintengine-` install only from Studio's own catalogue.

**Trust.** Only an extension the person trusts runs code. Unsigned, it waits
for them to trust it in Settings → Extensions, and the trust binds to its
content fingerprint (the digests of every file), so different bytes under the
same key never inherit it. Signed (`extension.sig`) by a publisher key they
trust, it is trusted. Changed after signing, it is refused.

## Testing

`@sprintengine/extension-sdk/testing` runs an extension in Node without the app:

```ts
import { createElement } from 'react'
import { createFakeMainHost, createFakeRendererHost, renderToHtml } from '@sprintengine/extension-sdk/testing'
import { manifest } from './manifest'                      // extension.json, validated
import { activate } from '../src/main'
import { Notes } from '../src/notes'

const main = createFakeMainHost({ manifest })              // moduleId: local.<id>
await activate(main.host)
await main.methods.operate('start', { workspaceId: 'ws-app' })          // as a surface would
main.services.conversations.emitEvent(ref, { type: 'turn_completed' })  // make the agent answer
await main.tools.call('notes_search', { query: 'x' })                   // as an agent would

const renderer = createFakeRendererHost({ manifest, main }) // methods and subscribe reach `main`
const studio = renderer.studio({ point: 'panels', id: 'notes', workspaceId: 'ws-app' })
const html = await renderToHtml(createElement(Notes, { studio }))
```

- **`createFakeMainHost({ manifest } | { moduleId, permissions }, …)`** is a
  `MainHost` with stateful fakes of every published service, held to the
  host's rules. `registerMcpTools` refuses a tool the manifest does not
  declare and takes the declaration's description and access. Each service's
  handle is on `services`, to arrange the world and read what the extension
  did to it:
  - `storage`: the real key pattern, absolute-root rule and 1 MB cap;
    `list({ prefix })`, `getMany` and `watch`, which hears the extension's own
    writes and `changeExternally(key, value, root)` (a `git pull`, a hand edit).
  - `conversations`: `emitEvent` (turn events get a `turnId`; give
    `turn_completed` its `text` and `usage` and `reply(ref)` reads it),
    ownership and the preset ceiling, `create({ worktree })` in a workspace
    of its own (for a project `setGitInfo` made a repository, else
    `worktree_unavailable`), and `restore(chat)` to make a saved chat known.
  - `scheduledAgents`: `fire(id)` starts a chat the extension owns (with
    `scheduledAgentId` and `scheduledAgentTag`), sets `lastRun.agentId` and
    tells `onRun`; `failNextRun`.
  - `companions`: `respond` (may be async), and `requestApproval` for an
    agent asking to use a tool mid-run.
  - `textGeneration`: `respond`, `setPreferred`, `calls`; `agents:generate`
    checked, and the host's two-running, eight-waiting lane (`busy`).
  - `secrets` (origins, https, redaction).
  - `github`: `respond('GET', '/route', …)`, `respondGraphql` (a mutation is
    refused before it is sent), `respondDownload`, `setSignedIn`.
  - `backlog` (`seed`, `setKey`, `setLocation`, `failScan`), `usage`
    (`record`) and `activity` (`addChat`, `addPrompt`), behind their
    permissions.
  - `workspaces`: `setHydrated(false)` for the after-launch null, `close(id)`
    for `list({ includeClosed: true })`, `setGitInfo(id, …)`.

  A permission the host checks is refused as the host refuses it
  (`permission_missing`, or a throw); a disclosure-only one used undeclared is
  listed in `undeclared`. `methods.read` / `methods.operate` call your
  declared methods as a surface or a command would; `tools.call` hands the
  handler agent metadata. `setAppState(key, value)` pushes a settings change
  `watchModuleAppState` hears. `getModuleDataDir()` hands out a temporary
  folder (`dispose()` removes it), `getAssetPath` resolves under `moduleRoot`,
  `skills.setStatus(root, id, status)` scripts `getSkillStatus`, and
  `setChatRuntimes` what `listChatRuntimes` answers. `emitted`,
  `notifications`, `startup()` and `shutdown()` cover the rest.
- **`createFakeRendererHost({ manifest, main? })`** is the window's `studio`.
  `studio(surface)` is what one `mount` is handed; `mount(entry, surface,
  root)` runs a ui entry into a root you give it and resolves to its cleanup.
  It records `readied` (surfaces that called `ready()`), `openedDoors`,
  `openedChats`, `focusedTabs`, `toasts` (validated and clipped; press one's
  `action.run()`) and `openedUrls`. Given `main`, the app state, the Backlog,
  usage and git info are main's; alone, it keeps its own. `capabilities`
  without a name tests a host that lacks it.
- **`renderToHtml(node)`** renders a React tree in Node, waiting for `lazy`
  components. It is a server render: no effects run, and
  `useSyncExternalStore` needs its third argument.

A scaffolded project's tests are TypeScript: `npm test` bundles
`test/**/*.test.ts` with esbuild into `test/.build/` and runs them with
`node --test` beside the smoke test. The smoke test validates extension.json,
checks that each ui entry is built, imports nothing and exports `mount`,
activates the worker against the fake main host, and checks that every command
without an `action` has an `operate` method, every declared MCP tool is
served, and nothing undeclared is used.

## What the host provides

Which Studio an extension needs is `engines.studio`. What the running Studio
provides *today* is a separate question, and both `studio` objects answer it:

```ts
if (studio.supports('conversations')) startChatFeatures(studio)
```

`supports(name)` is true for a capability the host provides now — a service
can be missing because the module that provides it is turned off. Names:
`conversations`, `chat.open`, `companion-agents`, `scheduled-agents`,
`secrets`, `github`, `storage`, `mcp-tools`, `module-assets`,
`notifications`, `backlog-write`, `usage`, `activity`, and the finer ones
described where their API is below. An unknown name answers `false`, so an
extension may probe for capabilities newer than its SDK.

## Permissions

Declare what the extension touches in `permissions`; only the `ui` and
`worker` tiers hold any. They are install-time disclosure: the consent prompt
lists them before the person trusts the extension. Most are not a sandbox —
trusted code runs in the app's process — but these are checked on every call,
and an extension without them gets `permission_missing`:

| Permission | Checked on |
| --- | --- |
| `conversation:read` | `getConversationService`: `subscribe`, `follow`, `transcript`, `reply`, `list`, `watch` |
| `conversation:operate` | Everything in the conversation service, `openChat` with `send: true`, and allowing a companion's tool call. Implies read. |
| `conversation:bypass` | Running the extension's chats on `bypass` (without it they go no looser than `auto`), and a companion task with `tools: 'auto'` |
| `chat:draft` | `openChat` without `send` (a draft the person reads and sends) |
| `secrets` | `getSecretsService` |
| `github` | `getGitHubService` |
| `mcp:tools` | `registerMcpTools`, and declaring `contributes.mcpTools` |
| `agents:companion` | Attaching a companion agent |
| `module:bridge` | Declaring methods (`registerMethods`): the ones surfaces call with `studio.methods()`, and the ones commands run. The broad `ipc:invoke` also allows it; declare `module:bridge` instead |
| `backlog.read` | `getBacklogService` reads; `listBacklogItems`, `watchBacklogItems`, `getBacklogLocation` |
| `backlog.write` | `getBacklogService` writes; `createBacklogItem`, `updateBacklogStatus`, `updateBacklogTriage`, `addBacklogLink`, `updateBacklogModuleMetadata` |
| `usage:read` | `getUsageService`, `queryUsage` |
| `conversation:read-all` | `getActivityService` (flagged as a broad scope in the consent prompt) |
| `agents:generate` | `getTextGenerationService(studio).generate` |

The list is closed: `KNOWN_CAPABILITY_PERMISSIONS` exports it, and a name not
in it fails validation. Its consent copy is in
[`docs/extension-authors/permissions.md`](../../docs/extension-authors/permissions.md)
in the app repository.

## Chats with the app's agents

### From the worker: the conversation service

```ts
import { getConversationService, type MainHost } from '@sprintengine/extension-sdk'

export function activate(studio: MainHost): void {
  if (!studio.supports('conversations')) return
  const chats = getConversationService(studio)

  studio.registerMethods({
    ask: {
      access: 'operate',
      params: readWorkspaceId, // (value) => { ok: true, params } | { ok: false, message }
      handler: async ({ workspaceId }, { commandId }) => {
        const created = await chats.create({
          commandId, // a retried call finds the chat the first one made
          workspaceId,
          prompt: 'Summarise what changed on this branch.',
          skills: ['my-review-guide'], // installed before the first turn and invoked in it
        })
        if (!created.ok) return created // { ok: false, code, message }
        const { conversation } = created
        const off = chats.subscribe(conversation, async (event) => {
          if (event.type !== 'turn_completed') return
          off()
          const reply = await chats.reply(conversation) // the agent's last message of the turn
          if (reply.ok) studio.emit('summary', reply.text)
        })
        return { ok: true, result: { agentId: conversation.agentId } }
      },
    },
  })
}
```

Declare `conversation:operate` (or `conversation:read` for a extension that only
reads its chats).

- **`create(input)`** starts a chat in a workspace: `cli` and `model` default
  to the person's last choice, `prompt` is the opening turn, `skills` are
  installed and invoked, `attachments` are images, `name` is optional.
  `permissionPreset` is `'manual'`, `'none'`, `'auto'` or `'bypass'`; absent
  takes the person's default. `worktree: { name? }` starts the chat in a fresh
  git worktree of the project (branch `<prefix>/<name>-<suffix>`, the person's
  worktree branch prefix being `agent` unless they changed it), in a workspace
  of its own whose id the answer names; a project that is not a git
  repository answers `worktree_unavailable`. Check
  `studio.supports('conversation-worktrees')`.
- **`send(ref, { message, skills?, attachments?, steer? })`** adds a turn;
  `steer: true` lands it inside the turn already running. `interrupt` and
  `stop` do what they say.
- **`respondToApproval(ref, { requestId, decision, answers? })`** answers an
  `approval_requested` event: `decision` is `'once'`, `'conversation'` (allow
  requests of that kind for the rest of the chat) or `'deny'`. The older
  `approved: boolean` still works, as `'once'` or `'deny'`. A rule that
  outlives the chat is the person's to make, so no answer makes one.
- **`setPermissionPreset(ref, preset)`** and **`setModel(ref, modelId)`**
  switch a running chat's preset (from its next tool call) or its model (from
  its next turn; an id `listChatRuntimes()` lists for the chat's runtime, or
  `'default'`). Each answers with what is now in force, plus the runtime's
  `notice` when the change applies later than at once. A runtime that binds a
  chat to its model refuses `setModel`.
- **The preset ceiling.** A extension's chats run no looser than `'auto'` unless
  its manifest declares `conversation:bypass`. A looser preset is lowered to
  the ceiling, not refused, and `create` and `setPermissionPreset` name the
  preset in force. Check `studio.supports('conversation-controls')` before
  `setPermissionPreset`, `setModel`, a `decision`, or a preset other than
  `'none'` and `'bypass'`.
- **`answerQuestion(ref, { requestId, answers })`** answers a question the
  agent asked, and **`resolvePlan(ref, { requestId, decision })`** carries a
  plan out (`'approve'`) or sends the agent back to planning (`'reject'`).
  Each is refused for a request of another kind. Check
  `studio.supports('conversation-requests')`; a host without it takes a question's
  answers on `respondToApproval`, which `answerQuestion` falls back to.
- **CLI modes and allowed tools.** `create` and `setPermissionPreset` take the
  agent CLI's own `permissionMode` beside the preset (Claude Code's
  `'acceptEdits'`), which goes with a preset lowered to the ceiling; `create`
  also takes `allowedTools`, tools the chat uses without asking, which needs
  `conversation:bypass`. Check `studio.supports('conversation-permissions')`.
- **`commandId`.** Every mutating call but `stop` takes your own id for it. A
  retry with the same id, even after the app restarted, is answered with the
  first call's result and never carried out twice; a retried `create` answers
  with the chat the first one made. Check `studio.supports('conversation-streams')`.
- **`subscribe(ref, cb)`** streams `ModuleConversationEvent`s from now on;
  **`follow(ref, cursor, onFrame)`** streams with no gap: a `snapshot` (or,
  given the `afterSeq` and `generation` of events you already hold, only the
  ones after them), one `synchronized` fence, then live events. Render what
  you cached, then follow from its cursor; keep each fence's `seq` and
  `generation` as the next cursor. A snapshot with `reset: true` replaces what
  you held. Check `studio.supports('conversation-streams')`. Both attach to a
  chat the host has not loaded yet (a saved chat at startup) and deliver once
  it is; they throw only without `conversation:read` or for a malformed ref.
  **`transcript(ref)`** replays everything recorded. **`list(filter?)`** and
  **`watch(filter, cb)`** give `ModuleConversationSummary` rows; a scheduled
  run's chat carries `scheduledAgentId` and `scheduledAgentTag`.
- **Replies and usage.** A `turn_completed` event's payload carries `text`
  (the agent's last message of the turn), `usage` (`{ inputTokens,
  outputTokens, cacheReadTokens, cacheWriteTokens }`, summed over the turn's
  model requests, fresh input apart from the prompt cache's share; a count
  the runtime cannot report is absent) and `costUsd`, where the runtime can
  say them (`ModuleConversationTurnCompletedPayload`).
  **`reply(ref, turnId?)`** reads a finished turn's text for you; never
  rebuild it from `content_delta`s. Check `studio.supports('conversation-replies')`.
- A extension reaches **only the chats it created** — never the person's own and
  never another extension's (`not_owned`). Its chats are otherwise ordinary: they
  appear in the sidebar and on paired devices like any other. Reading the
  person's chats is a separate, read-only service behind its own broad
  permission: see "The person's chats" below.
- Failures come back as `{ ok: false, code, message }` with a
  `ModuleConversationErrorCode`, never a throw.

### From a surface: open a chat for the person

```ts
const runtimes = studio.listChatRuntimes() // [{ id, label, available, models, lastSelected }]
const opened = await studio.openChat({
  workspaceId,
  prompt: 'Review the open pull request against our style guide.',
  skills: ['my-review-guide'],
})
if (opened.ok) studio.focusTab({ workspaceId, kind: 'chat', id: opened.agentId })
```

`openChat` adds a chat to the workspace and focuses it. By default the prompt
lands in the composer as a **draft** the person reads and sends; `send: true`
sends it as the first turn. Declare `chat:draft` for drafts, or
`conversation:operate`, which `send: true` needs; check
`studio.supports('chat.open')` first (`unavailable` means this window cannot
open chats). `name` titles the chat, and `dedupeKey` (your own key for it)
focuses the chat this extension already opened under that key in the workspace
instead of opening a second, answering `existing: true` and changing nothing
in it (`studio.supports('chat.open-options')`). `listChatRuntimes()` is the
catalog the shell's own chat picker reads, with the person's last choice
marked — use it for a picker, and pass the chosen `id` / model as `cli` /
`model`. The same list is `await studio.listChatRuntimes()` in the worker.

A runtime's `id` (`claude-code`, `codex`, `cursor`, `opencode`, `grok`) is the
one id every API takes for it: a conversation's and a scheduled agent's
`cli`, a companion's `engine.cli` (which also takes the older provider ids,
`claude-agent` and the like) and text generation's `cli`.

`focusTab({ workspaceId, kind, id })` focuses a chat by its agent id
(`kind: 'chat'`) or a file tab by workspace-relative path (`kind: 'file'`).
It returns `false` for an id that is not a chat in that workspace.

### Companion agents

`getCompanionAgentsService(studio)` attaches a workspace-bound background agent
your extension drives with structured runs (`runStructured`) and messages, without
a chat tab. `attach` never starts anything; the first run does. Declare
`agents:companion`.

The agent asks before every tool it uses, and a run's `tools` decides the
answer: `'none'` (the default) denies them all and tells the agent up front
it has no tools — use it for any prompt carrying text you did not write;
`'ask'` leaves them for the person, whose answer you relay with
`handle.respondToApproval({ requestId, decision })` (allowing needs
`conversation:operate`); `'auto'` approves them all and needs
`conversation:bypass`. `engine.cli` takes a runtime id. Check
`studio.supports('companion-tools')`: a host without it approves every tool call.

### One prompt, no chat: text generation

```ts
import { getTextGenerationService } from '@sprintengine/extension-sdk'

const answer = await getTextGenerationService(studio).generate({
  prompt: digest,
  system: 'Write a three-line standup from this work log.',
  json: true, // optional: the answer must be one JSON value
})
if (answer.ok) console.log(answer.text, answer.usage, answer.model)
```

`generate` answers one prompt through the person's own agent CLI, headless and
under its own sign-in: no workspace, no chat tab, nothing in their history.
`cli` is `claude-code` or `codex`; absent, the runtime the person chose for
Studio's text generation in Settings, else `claude-code`. `model` absent takes
the person's chosen model on their chosen runtime, else the runtime's small
default (`claude-haiku-5-5`, `gpt-5.6-luna`); `maxOutputTokens` caps the
answer on Claude Code (Codex has no output cap and ignores it). Declare `agents:generate` and check
`studio.supports('text-generation')`. Each extension gets two calls at once and
eight waiting, and more than thirty a minute answer `busy`. Failures are typed
(`ModuleTextGenerationErrorCode`), never thrown.

## Brokered credentials

### Secrets

```ts
import { getSecretsService } from '@sprintengine/extension-sdk'

const secrets = getSecretsService(studio)
await secrets.set('weather-api', apiKey, { allowedOrigins: ['https://api.weather.example'] })
const res = await secrets.fetchWithSecret('weather-api', 'https://api.weather.example/v1/today', {
  placement: { header: 'Authorization', scheme: 'Bearer' },
})
if (res.ok) render(JSON.parse(res.body))
```

A stored value never comes back to extension code — not from `has`, not in a
response, not in an error. It leaves the host only inside a `fetchWithSecret`
request to one of the https origins it was stored with (exact origin, bound at
`set`; change the list by setting the value again). Requests refuse redirects
and cap the response at 1 MiB. Values are encrypted with the operating
system's keychain; where it has none, `set` answers `storage_unavailable`.
Declare `secrets`; check `studio.supports('secrets')`.

### GitHub

```ts
import { getGitHubService } from '@sprintengine/extension-sdk'

const github = getGitHubService(studio)
const { signedIn } = await github.status()
const pulls = await github.request({
  route: '/repos/{owner}/{repo}/pulls',
  params: { owner: 'acme', repo: 'app', state: 'open' },
})
```

The request goes to the GitHub API with the person's own sign-in; the extension
never sees the token. `route` is a `/`-prefixed template: `{name}` placeholders
are filled from `params` (encoded, so a value cannot add a segment, a query or
a host) and the rest of `params` becomes the query string. Anything that could
move the request elsewhere is `invalid_route`. Declare `github`; check
`studio.supports('github')`.

Beyond plain requests:

- **Headers and cheap polling** (`supports('github-headers')`): every answer
  carries `headers` narrowed to `x-ratelimit-*`, `link`, `etag` and
  `retry-after`. Send an `etag` back as `ifNoneMatch` and an unchanged resource
  answers `{ ok: true, status: 304, data: null }`, free of the rate limit.
  `accept` takes one of GitHub's media types (`ModuleGitHubMediaType`), such as
  `application/vnd.github.diff`.
- **Read-only GraphQL** (`supports('github-graphql')`):
  `github.graphql(query, variables)`. A document holding a top-level `mutation`
  or `subscription` is refused (`invalid_query`) before it is sent, so a poll is
  a read, not a write acting as the person. `data` is `{ data, errors? }`.
- **Downloads** (`supports('github-download')`): `github.download({ route,
  params, encoding? })` for a job's logs or an archive. GitHub answers those
  with a redirect to its own storage; the host follows that one redirect only
  to a GitHub storage host and strips the token before it does
  (`redirect_not_allowed` otherwise).

## The worker's `studio`

`MainHost`, handed to `activate`:

- `moduleId` (your install key) and `supports(capability)`.
- `listChatRuntimes()` — the agent runtimes a chat can run on, with the ones
  this machine lacks marked unavailable (`supports('chat-runtimes')`).
- `registerMethods(methods)` — the methods your surfaces (or a client the
  person granted them) call through `methods`, and the ones commands without
  an `action` run: each with its access (`read` or `operate`), a params
  validator and a handler. Needs `module:bridge`.
- `registerMcpTools(tools)` — serve the tools extension.json declares in
  `contributes.mcpTools` on Studio's MCP server. A tool not declared is
  refused, and the declaration's `description` and `access` are what agents
  see. Declare `mcp:tools`. An off extension's tools stay listed and answer an
  enable error instead of running.
- `provideService` / `getService` / `requireService(token)` — the service
  bridge. An extension resolves only the services the SDK publishes (its
  exported tokens and the ones behind the `get*Service` helpers).
- `onStartup`, `onShutdownBegin` and `onShutdown` hooks.
- `registerSidecar(spec)` — a declaration the host lists; it does not spawn
  it. Spawn your own process if you need one (declare `process:spawn`).
- `notify({ severity, title, body?, target? })` — a row in the bell of every
  open window, under your extension's name (stamped by the host). Only
  `warning` and `error` reach it. `target: { surfaceId }` names one of your
  doors: the row's Open lands there. Flood-bounded (an identical repeat within
  10 s, or more than 20 in 10 s, is dropped). A row sent before any window is
  open is kept and filed when one opens. Check `supports('notifications')`.
- `emit(topic, payload?)` — an event to your surfaces (below).
- `ensureSkillInstalled(workspaceRoot, skillId)` / `getSkillStatus(…)` — put
  one of Studio's own skills in a workspace, or ask without writing. An
  extension ships no skills of its own yet (`contributes.skills` is reserved).
- `getModuleAppState(key)` / `watchModuleAppState(cb)` — the extension's app
  state (what its surfaces and settings section write), read-only, persisted,
  so the worker sees the person's settings with no window open
  (`supports('main-app-state')`).
- `getWorkspaceGitInfo(workspaceId)` — the branch and remotes of a workspace,
  each remote with `owner/repo` when it is on GitHub. Declare
  `ipc:workspace-read`; it is checked.
- `getModuleDataDir()` — a directory of your own under the app's user data,
  for data past storage's 1 MB value limit; removed at uninstall.
- `getAssetPath(relativePath)` — the absolute path of a file the extension
  ships, for a worker thread or a data file; only verified files whose bytes
  still match resolve.

MCP tool names are lower-case letters, digits and underscores. A name that
matches a core gateway tool, falls in one of the shell's families (`browser`,
`canvas`, `editor`, `tour`, `terminal`) or matches another extension's tool is
a registration error naming the conflict. The core families (`agent`,
`backlog`, `cli`, `conversation`, `extension`, `local_server`, `marketplace`,
`module`, `pull_request`, `schedule`, `tailnet`, `workspace`, `worktree`, and
`studio`, `sprintengine`, `app`) are reserved for core tools; name yours in a
family of your own (`decisions_record`). The gateway does not rename or prefix
extension tools. A tool's handler receives `context.metadata.verified`: true
when a launch token or the tailnet proved who is calling
(`supports('mcp-verified-identity')`).

## A surface's `studio`

`ExtensionMountStudio`, handed to `mount`: the window's `RendererHost`, plus
`surface` (`{ point, id, workspaceId? }`: which contribution this is, and a
panel's workspace) and `ready()`.

- **Who you are:** `moduleId`, your install key — the extension your
  `methods()` calls reach.
- **Your doors:** `openGlobalSurface(id)` opens one of your doors; `false` for
  an id that is not yours, or while the extension is off.
- **Telling the person:** `toast({ tone, message, detail?, action? })` for
  transient feedback (one optional button); the worker's `notify` for anything
  they must find again.
- **Links:** `openExternal(url)` opens an http(s) URL in the system browser
  through the app's own link path; anything else is refused.
- **The window:** `getActiveWorkspaceId()` and `watchActiveWorkspace(cb)`.
- **Workspaces:** `getWorkspace`, `listWorkspaces`, `watchWorkspaces`,
  `getWorkingRoot`, `getWorkspaceGitInfo` (declare `ipc:workspace-read`),
  `watchWorkspaceFile` (`filesystem:read-workspace`).
- **Chats:** `openChat`, `listChatRuntimes`, `focusTab` (above).
- **State:** `getWorkspaceModuleState` / `setWorkspaceModuleState` (your entry
  on a workspace, synced across windows) and `getModuleAppState` /
  `setModuleAppState` / `watchModuleAppState` (app-level, readable from the
  worker). Declare `storage`.
- **Backlog:** `listBacklogItems`, `watchBacklogItems(id, cb, { onError })`,
  `getBacklogLocation` (declare `backlog.read`); `createBacklogItem`,
  `updateBacklogStatus`, `updateBacklogTriage`, `addBacklogLink`,
  `updateBacklogModuleMetadata` (declare `backlog.write`). See "The Backlog".
- **Usage:** `queryUsage(query)` (declare `usage:read`).
- **Theme:** `watchColorScheme(cb)` for a runtime you host (an editor, a chart
  library); ordinary styling uses the `--sem-*` properties.
- **Methods and events:** `methods<Contract>()` (`read`, `operate`) and
  `subscribe(topic, cb)`.
- **Assets:** `getAssetUrl(relativePath)`.

The TSDoc on each member in `dist/index.d.ts` is the reference for its exact
behaviour.

## Calling the worker from a surface

Declare what your surfaces call as methods, in one contract both sides
import:

```ts
// src/methods.ts
export type EventsMethods = {
  'events.count': { access: 'read'; params: { day: string }; result: number }
  'events.save': { access: 'operate'; params: { events: string[] }; result: { saved: number }; errors: 'full' }
}

// the worker
export function activate(studio: MainHost): void {
  studio.registerMethods<EventsMethods>({
    'events.count': { access: 'read', params: readDay, handler: ({ day }) => ({ ok: true, result: count(day) }) },
    'events.save': {
      access: 'operate',
      params: readEvents,
      handler: async ({ events }) =>
        (await save(events))
          ? { ok: true, result: { saved: events.length } }
          : { ok: false, code: 'full', message: 'No room left.' },
    },
  })
}

// a surface
const methods = studio.methods<EventsMethods>()
const answer = await methods.operate('events.save', { events })
if (!answer.ok) studio.toast({ tone: 'error', message: answer.message })
```

- **Access.** A `read` method changes nothing and is reached by a client
  granted `extensions:read`; an `operate` one changes something, needs
  `extensions:operate`, and is carried out once per command id (a retry is
  answered with the first answer; the handler is told the id as
  `context.commandId`). `methods().read` offers only `read` methods and
  `operate` only `operate` ones.
- **Params.** Every method reads its params with its own validator,
  `(value) => { ok: true, params } | { ok: false, message }`; a refusal is
  answered `invalid_params` in your words and the handler never runs.
- **Answers.** A handler answers `{ ok: true, result }` (JSON) or its own
  `{ ok: false, code, message }`. A call never throws: the host's refusals are
  answers too: `extension_unavailable` (the worker is not running here),
  `extension_method_unknown`, `invalid_params`, `scope_required`,
  `unavailable` (a handler that threw, or no connection).
- **Names** are a lower-case letter, then letters, digits, dots and dashes;
  your install key is their namespace. Declaring methods needs
  `module:bridge`.
- **Commands.** A command without an `action` calls the method of its id with
  access `operate` and an `ExtensionCommandContext` as params (`where`,
  `workspaceId`, and `backlogItemIds`, `filePaths` or `notification` for a
  menu).

They travel over the window's Studio connection to the server the extension
runs on (`extension.read` / `extension.operate` on the Studio protocol), as
every other client's calls do.

## Events (worker → surfaces)

The worker's `studio.emit(topic, payload?)` pushes to your surfaces'
`studio.subscribe(topic, cb)`. Only your extension's subscribers receive
it; one emit reaches every open window, in order per extension. **Nothing is
replayed**: keep the durable answer readable through a `read` method and let
the event say "read it again". Payloads must be JSON (they ride the Studio
protocol's `extension.events` stream); delivery pauses while your extension is off.

## Storage

`getModuleStorage(studio)` → `get` / `set` / `delete` / `list`, keyed per extension
and optionally per workspace. Workspace keys live in the project's store in
the person's home (`~/.sprintengine/workspaces/<project>/modules/<install key>/`),
never in the project's folder; global keys under the app's data; JSON
values up to 1 MB, atomic writes. Declare `storage`.

`list({ prefix })` and `getMany({ keys })` read a record family in one call
(`supports('storage-query')`). `watch({ workspaceRoot? }, cb)` says which keys
changed: your own writes at once, and a change made by other means — a
hand edit — within a couple of seconds (`supports('storage-watch')`).
Workspace keys do not travel with a clone; data that belongs to the project
is a file your extension writes where the person asks. Data past the value limit
belongs in `studio.getModuleDataDir()` (`supports('module-data-dir')`).

## Workspaces from the worker

```ts
import { WorkspaceContextToken, WorkspaceServiceToken } from '@sprintengine/extension-sdk'

const created = await studio.requireService(WorkspaceServiceToken).create({ name: 'Scratch', folderPath: '/abs/path' })
const view = await studio.requireService(WorkspaceContextToken).get(workspaceId) // { id, name, folderPath, mode } | null
```

`create` resolves once the workspace is confirmed, so a returned id is real.
The context service (declare `ipc:workspace-read`) also has `list()`: the open
workspaces, each with `open: true`. `list({ includeClosed: true })` adds the
workspaces closed on this machine, newest first, with `open: false` and
`closedAt` (`supports('workspace-history')`), so a extension can tie what it kept
back to a project that is no longer open. `studio.getWorkspaceGitInfo(id)` reads
a workspace's branch and remotes without parsing `.git` yourself.

<!-- Backlog, usage and activity services -->

## The Backlog

A extension reads and changes a workspace's Backlog through the host, never by
reading or writing item files itself. `getBacklogService(studio)` in
the worker, and the same calls on a surface's `studio`:

```ts
import { getBacklogService } from '@sprintengine/extension-sdk'

const backlog = getBacklogService(studio)
const created = await backlog.create(workspaceId, { title: 'Faster refunds', status: 'ready', epic: 'payments' })
if (created.ok) console.log(created.displayId, created.relativePath) // "MC-241", "backlog/payments/2026-10-09-faster-refunds.md"
await backlog.updateStatus(workspaceId, itemId, 'in_progress')
await backlog.addLink(workspaceId, itemId, { id: 'board-chat', type: 'agent', label: 'Board chat', target: { kind: 'chat', id: agentId } })

// a surface
const moved = await studio.updateBacklogStatus(workspaceId, item.id, 'completed')
```

- `itemId` is a `BacklogItemView.id` (the item's logical path, `backlog/…`).
- Every write is a call into the app's own Backlog service, in the project's
  mutation lane, so it never interleaves with another writer. `create` takes
  the app's create path: it allocates the next number, files the item under
  its epic's folder with a unique name, and answers `{ id, relativePath,
  path, numericId, displayId }`.
- `addLink` records the link as your extension's (a `moduleId` naming another
  extension is refused); `updateModuleMetadata` writes your extension's entry only.
- `getLocation` / `getBacklogLocation` answer `{ root, isDefault, exists }`:
  where the item files are, including a Backlog the person moved elsewhere.
- `list(workspaceId)` (main) reads the items from disk now.
- Answers are `{ ok: true, … }` or `{ ok: false, code, message }` with a
  `ModuleBacklogErrorCode`; values outside the app's vocabulary are refused
  as `invalid_input`, never guessed.
- `BacklogItemView` carries `numericId`, `displayId` (`MC-240`, with the
  workspace's key), `epic` and `modifiedAt`.
- `watchBacklogItems(workspaceId, cb, { onError })`: `onError` hears a
  workspace with no folder, one that cannot be resolved, or a Backlog that
  could not be read. The watch stays open and calls `cb` again after the next
  readable scan.

Declare `backlog.read` for reads and `backlog.write` for writes; the host
checks both. `studio.supports('backlog-write')` says whether the host has the
write API.

## Token usage

`getUsageService(studio).query({ from, to, groupBy })` answers token usage of
every agent session on this machine: Studio's chats, and the Claude Code and
Codex sessions a person ran in a terminal (read from the CLIs' own session
logs). The twin in a surface is `studio.queryUsage(query)`.

```ts
import { getUsageService } from '@sprintengine/extension-sdk'

const usage = getUsageService(studio)
const week = await usage.query({ from: Date.now() - 7 * 864e5, to: Date.now(), groupBy: ['day', 'model'] })
// week.rows: [{ day: '2026-10-08', model: 'claude-opus-4-1', tokens: { input, output, cacheRead, cacheWrite }, requests, reportedCostUsd }]
const off = usage.onChanged(() => refreshMyView())
```

- `groupBy` is any of `day` (local calendar day), `model`, `provider`,
  `workspace` and `session`; without it the query answers one total row.
- A session a Studio chat ran is counted once: from the CLI's own log when this
  machine has it, under the chat's workspace, agent id and title. A terminal
  session is attributed to the open workspace whose folder holds it (a
  worktree is followed to its repository); `workspaceId` is null otherwise.
- The service returns tokens; pricing them is your extension's job.
  `reportedCostUsd` is set only for turns whose tokens come from a Studio
  transcript, where the runtime reported a cost.
- Usage is kept to the hour, so a window is too.
- Nothing is read at startup. The first query waits for the first read of the
  logs (seconds on a large history; incremental after that, cached across
  runs); later queries answer at once and read again in the background.
  `onChanged` fires after a read that changed the numbers.

Declare `usage:read` (the consent prompt says "See token usage and cost of
every agent session on this machine"); check `studio.supports('usage')`.

## The person's chats (activity)

`getActivityService(studio)` reads the person's Studio chats in every open
workspace, read-only:

- `listChats({ from?, to?, workspaceId? })` → `{ workspaceId, agentId, title,
  cli, providerId, model, createdAt, updatedAt, turnCount, status }` per chat,
  newest first.
- `prompts({ from, to, workspaceId?, limit? })` → `{ at, workspaceId,
  agentId, text, replyTail? }`: each message the person sent, with the last
  few hundred characters of the agent's reply. `limit` defaults to 200 (at
  most 1000); `truncated` says older ones were left out.

It never returns tool calls, tool output, reasoning or attachments, and every
event is redacted the way the conversation service redacts what it hands
extensions. Messages the app sent on the person's behalf are not theirs and are
left out. Chats in closed workspaces, and agent sessions outside Studio, are
not covered.

Declare `conversation:read-all`. Its consent prompt says "Read every chat on
this machine, including what you and the agents wrote" and is flagged as a
broad scope, so ask for it only when reading the person's chats is the point
of the extension. Check `studio.supports('activity')`.

## Scheduled agents

A scheduled agent is a prompt and a cron schedule: each time the schedule
comes round, a new chat starts in the project with that prompt as its first
message, on the CLI, model, permissions, skills, MCP servers and worktree
setting it was made with. Nothing carries from one run to the next. A extension
creates its own with `getScheduledAgentsService(studio)` (declare
`scheduled-agents.manage`). Every method
is scoped to your extension: `list` returns only yours, and `update`, `remove`
and `runNow` refuse an id you did not create. They appear in the person's
sidebar like the ones they make themselves, and they can close them.

```ts
import { getScheduledAgentsService, type MainHost } from '@sprintengine/extension-sdk'

export function activate(studio: MainHost): void {
  studio.registerMethods({
    'forecast.schedule': {
      access: 'operate',
      params: readFolderPath,
      handler: async (folderPath) => {
        const created = await getScheduledAgentsService(studio).create({
          prompt: 'Refresh the forecast notes for the watched city.',
          schedule: { cron: '0 9 * * 1-5', timezone: 'Europe/Dublin' },
          folderPath,
          hostId: null,
          cli: 'claude-code',
          cliModel: null,
          permissionPreset: null,
          skills: [],
          mcpServers: [],
          worktree: null,
          name: 'Morning forecast', // the sidebar's title; absent, the prompt's first line
          tag: 'city:dublin', // your own label; each run's chat carries it
        })
        return created.ok ? { ok: true, result: created.agent.id } : created
      },
    },
  })
}
```

To follow a run, listen with `onRun((agent, run) => …)`: it names each run's
chat (`run.workspaceId`, `run.agentId`) as it starts, a one-time schedule's
included (it closes itself straight after, so `onChanged` never shows that
run). The chat is your extension's, so the conversation service follows it, and
its summary carries `scheduledAgentId` and `scheduledAgentTag`; `lastRun` also
names its `agentId`. A repeating schedule's times missed while the app was
closed are not replayed (the next run counts from start-up); a one-time
schedule missed that way runs once the app is open; times missed while the
computer slept run once on waking; and a time that comes while the previous
run is still working is skipped, not queued. Check
`studio.supports('scheduled-agent-runs')` before relying on `name`, `tag` or
`onRun`.

## Accepting drags from the Backlog and Files panels

`readFileDropPayload(dataTransfer)` reads the published payload under
`SPRINTENGINE_FILE_DROP_MIME` and returns `null` — never throws — for anything
it does not recognise. `hasFileDropData` is the `dragover`-safe presence check;
`setFileDropData` originates a drag the app's own drop targets accept.

## Styling a surface

A surface draws with what it bundles: React, another library, or plain DOM.
It sits in Studio's document, so Studio's `--sem-*` CSS custom properties
reach it — `--sem-color-bg-surface`, `--sem-color-text-default`,
`--sem-color-text-muted`, `--sem-color-border-subtle`,
`--sem-color-accent-primary`, `--sem-space-sm`, `--sem-font-family-ui`,
`--sem-font-size-body` and the rest — and styling with them follows every
theme. Only the names are contract; never copy a value as hex.

Utility classes you write produce no CSS: Studio's stylesheet is built from
its own source. Write plain CSS, put the `<style>` inside the root you are
given, and prefix every selector with something of your own. The guide's
`styling` topic has the details and an example.

## Signing and packaging

```sh
npx sprintengine-extension keygen --out ~/.sprintengine/keys/my-extension.key   # once; keep it out of the project
npx sprintengine-extension sign extension --key ~/.sprintengine/keys/my-extension.key
npx sprintengine-extension verify extension
npx sprintengine-extension pack extension --out packed/my-extension
```

`sign` validates extension.json, records the sha256 of every file the
extension ships (everything `pack` copies, extension.json included) in
`extension.sig` beside it, and signs those digests. `verify` checks the
signature and every file, byte for byte, and fails when the extension is
unsigned or changed after signing. `pack` checks that every file extension.json
names is there and copies an installable folder, leaving out `node_modules`,
`.git`, key files and symbolic links. Sign again after every build.

The pieces are exported for tooling: `signExtensionFiles`,
`verifyExtensionSignature`, `parseExtensionSignature`,
`extensionContentFingerprint`, `computeModuleFileDigestsSync` and
`moduleFileDigestIssuesSync` (`@sprintengine/extension-sdk/signing`, Node).

A marketplace plugin bundle (`plugin.json`, components `mcp` and `skills`) is
a separate thing: `sprintengine-extension plugin scaffold|sign|verify|pack`
work on it, and a bundle naming a `module` component is refused.

## Installing

`npm run dev:install` builds, validates, and copies `extension/` to
`~/.sprintengine/extensions/local.<id>/` (or under
`$SPRINTENGINE_USER_EXTENSION_ROOT`), replacing the old copy and leaving out
symbolic links, `node_modules`, `.git` and key files. When a key is at hand
(`--key`, `$SPRINTENGINE_SIGNING_KEY`, or `~/.sprintengine/keys/<id>.key`;
`--no-sign` skips it) it signs the installed copy. Unsigned, Studio waits for
you to trust it in Settings → Extensions, and asks again after each rebuild,
since trust binds to exact contents. Settings → Extensions can also install a
folder: `extension/`, or a packed copy.

## Packaged web runtimes and WebAssembly

`studio.getAssetUrl('runtime/index.html')` returns a stable URL for a file in
the installed extension — use it as an iframe `src`. Relative scripts,
workers, WebAssembly (`application/wasm`) and IndexedDB work inside it, under
a private per-installation origin. The host checks trust and enablement on
every request and serves only files the extension was verified with, up to
128 MiB. Never store secrets in the extension's folder or log these URLs; use
the secrets broker. This is not a sandbox for hostile code.

## Intentional narrowings

The drift guard keeps these narrowings sound — an SDK-typed extension is
always valid for the app:

- `BacklogItemView` widens enumerated app internals to `string`.
- `CompanionAgentEvent.type` is widened to `string`.

## Versioning

Semver; `4.0.0-beta.1` is the first release of the extension.json format (see
`CHANGELOG.md`). Which Studio an extension needs is its `engines.studio`,
not the package version; each field of extension.json says the first Studio
that reads it. In the app repository a drift guard
(`drift/sdk-drift-guard.ts`, `npm run test:sdk:drift`) fails the build
whenever these declarations diverge from the app's own contracts, and
`npm run test:sdk:pack` imports every published name from the packed tarball.

## License

MIT — see [`LICENSE`](./LICENSE). You may build extensions against this SDK and
distribute or sell them, including closed-source. Marketplace distribution is
covered by separate marketplace terms.
