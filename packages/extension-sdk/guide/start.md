# Building a SprintEngine Studio extension

An extension is a folder Studio installs: `extension.json` at its root, saying
what the extension is and what it adds, and the built JavaScript beside it.
It adds to Studio by declaring, not by registering at runtime: commands, menu
items, top bar items, panels, doors, settings sections and MCP tools are all
listed in extension.json, and Studio draws the ones the extension's code does
not.

Code comes in two kinds, and each is optional:

- **A ui entry** for each panel, door or settings section: an ESM bundle
  exporting `mount(root, studio)`. Studio loads it into a sandboxed frame of
  its own, on every client, and hands it the frame's root to draw in.
- **The worker**, `main`: a CommonJS bundle exporting `activate(studio)`. It
  runs in a Node process of its own, started when something needs it (or kept
  running, with `background: true`), and serves the extension's commands,
  methods and MCP tools.

The contract is `@sprintengine/extension-sdk` and nothing else; an extension
never imports Studio's source. The SDK's type declarations
(`node_modules/@sprintengine/extension-sdk/dist/*.d.ts`) are the authority on
every signature; its README is the long-form guide. This guide is the working
method and what the types do not say. Studio serves it to agents with the
`extension.guide` tool, one topic at a time; the same files are in
`node_modules/@sprintengine/extension-sdk/guide/`.

## The project

`extension.create` (or `npx sprintengine-extension init`) makes a project like
this:

```
extension/extension.json  the manifest; extension/ is the folder Studio installs
extension/dist/           build output: one bundle per ui entry, main.cjs for the worker
src/<name>.tsx            a surface: exports mount(root, studio); builds to dist/<name>.js
src/main.ts               the worker: exports activate(studio) (templates that have one)
test/smoke.test.mjs       loads the built extension the way Studio does
test/manifest.ts          extension.json, validated, for your tests
test/*.test.ts            the project's own tests, against the SDK's fake hosts
scripts/                  build-ui.mjs, validate.mjs, dev-install.mjs, check-toolchain.mjs
IDEA.md                   what the person wants — read it first
```

The build writes `extension/dist/` and never touches extension.json.

## First steps in a project

1. `npm install`, then `node scripts/check-toolchain.mjs`. Fix every FAIL
   line.
2. `npm run check`. A fresh project passes; if it does not, fix that before
   changing anything.
3. Read `IDEA.md`. If the brief leaves the surface, the data or the
   permissions open, ask — at most three questions, each with a suggested
   answer — before writing code. A project Studio's New chat made starts on the
   `blank` template, and its first message is the person's request as they
   wrote it (IDEA.md quotes it): that request is the brief.
4. Pick the smallest surface and the lowest tier that do the job (the
   `surfaces` topic) and change the template toward it. Delete what the idea
   does not need. A part the template lacks is one command:
   `npx sprintengine-extension add main|mcp|settings|door` adds its files and
   test, merges its contributions and permissions into extension.json, raises
   `tier` when it needs to, and wires it in.
5. When it works, `npm run dev:install` and tell the person what to click to
   try it (the loop below).

## The loop

```sh
npm run check        # typecheck → build → tests (smoke + test/*.test.ts) → validate. Run it after every change.
npm run dev:install  # build, validate, copy extension/ to ~/.sprintengine/extensions/local.<id>/, sign it if a key exists
```

Then in Studio: **Settings → Extensions**, find the extension, approve it.
Only the person can approve it; never try to do it for them. The approval
tells them what it asks for, and what its code can do: a `ui` extension's
runs isolated in frames and can do only what they allow; a worker's runs with
full access to this machine. `extension.status` (a Studio tool) says whether Studio sees the
installed extension, whether it is approved, and why it is not running when it
is not.

- An approval is bound to exact contents and access. Every rebuild copied in by
  `dev:install` is new contents, so it is approved again after each. That is
  the design, not a bug. A signature does not approve anything (the
  `publishing` topic).
- Say what the person should click and what they should see. You cannot see
  Studio's window; they can.

## Testing without Studio

`@sprintengine/extension-sdk/testing` has fake hosts that keep the host's rules:
the permissions every call needs (from the same table Studio's gate reads),
storage's key and size limits, chat ownership, and the MCP tools extension.json
declares. Write tests in `test/*.test.ts`; `npm test` bundles them with esbuild
and runs them with `node --test`:

```ts
import { createElement } from 'react'
import { createFakeFrameStudio, createFakeMainHost, renderToHtml } from '@sprintengine/extension-sdk/testing'
import { manifest } from './manifest'
import { activate } from '../src/main'
import { Notes } from '../src/notes'

const main = createFakeMainHost({ manifest })                           // moduleId is local.<id>
await activate(main.host)
await main.methods.operate('plan-in-chat', { where: 'palette', workspaceId: 'ws-app' }) // a command run
main.services.conversations.emitEvent(ref, { type: 'turn_completed' }) // what the agent would do
assert.deepEqual(main.undeclared, [])                                   // nothing used undeclared

const frame = createFakeFrameStudio({ manifest, main }) // a surface in its frame
const studio = frame.studio({ point: 'panels', id: 'notes', workspaceId: 'ws-app' })
assert.match(await renderToHtml(createElement(Notes, { studio })), /Saved/)
await studio.host.call('files.read', { workspaceId: 'ws-app', path: 'a.md' }) // rejects: not declared
```

Every service and host method has a fake you can arrange and read back:
`main.services.backlog.seed(...)`, `usage.record(...)`,
`activity.addChat(...)`, `storage.changeExternally(...)` (a `git pull` the
watch hears), `github.respond(...)` / `respondGraphql(...)` /
`respondDownload(...)`, `workspaces.close(id)` / `setGitInfo(id, ...)`,
`main.setAppState(key, value)` (a Settings change the worker hears),
`main.skills.setStatus(...)`, `textGeneration.respond(...)`,
`conversations.restore(...)` (a saved chat appearing after launch),
`companions.requestApproval(...)` (an agent asking for a tool mid-run),
`scheduledAgents.fire(id)` (a run, with its chat and `onRun`),
`main.setChatRuntimes(...)`. On a surface's side: `frame.toasts`,
`frame.drafts`, `frame.openedDoors`, `frame.focusedTabs`, `frame.readied`
(the surfaces that called `ready()`), `frame.settings()`, `frame.file(...)`,
`frame.emit(topic, payload)` (a worker event), `frame.setColorScheme(...)`,
and `frame.mount(entry, surface, root)` runs a `mount` into a root you give
it. Pass `invoker: [...]` to call as a paired device or browser that holds
only those permissions. Pass `capabilities: [...]` to test a worker's host
without one.

`renderToHtml` is a server render: effects do not run. The smoke test checks that
each ui entry is a self-contained bundle exporting `mount`, that the worker
activates, that every command without an `action` has an `operate` method of
the same name, and that every declared MCP tool is served.

## The other topics

| Topic | Read it when |
| --- | --- |
| `surfaces` | Choosing what the extension adds to Studio, its tier, and which API does it |
| `manifest` | Writing `extension/extension.json` |
| `permissions` | Choosing permissions; what each one allows |
| `rules` | Before writing a surface or a build change: the mistakes that cost earlier extensions time |
| `api-renderer` | The `studio` a surface's `mount` is handed |
| `api-main` | The worker's `activate(studio)`: methods, commands, MCP tools, services, storage |
| `hooks` | Checking, changing or refusing agents' tool calls, prompts, launches and saves, and hearing what they did |
| `conversations` | Starting, prompting and reading the extension's own chats; one-shot text generation |
| `brokers` | API keys and GitHub through the host |
| `styling` | Drawing a surface: React or plain DOM, the `--sem-*` properties, your own CSS |
| `troubleshooting` | Studio does not list, approve or run the extension |
| `publishing` | Signing with extension.sig, packing, handing it to others |

## Done means

- `npm run check` passes with no warnings you have not explained.
- `npm run dev:install` succeeded, and you told the person exactly what to
  click and what they should see.
- `tier` and `permissions` in extension.json are the minimum the extension
  needs; `IDEA.md` says what it does now.
- The smoke test still passes; add your own `test/*.test.ts` for logic worth
  pinning.
