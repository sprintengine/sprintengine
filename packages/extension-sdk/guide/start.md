# Building a SprintEngine Studio extension

An extension is a folder Studio loads: `extension.json` at its root, saying
what the extension is and what it adds, and its source beside it. There is no
build step: Studio reads the TypeScript and JavaScript as you wrote them.
It adds to Studio by declaring, not by registering at runtime: commands, menu
items, top bar items, panels, doors, settings sections and MCP tools are all
listed in extension.json, and Studio draws the ones the extension's code does
not.

Code comes in two kinds, and each is optional:

- **A surface entry** for each panel, door, settings section or custom
  editor: a module (`.ts`, `.tsx`, `.js`, …) exporting `mount(root, studio)`.
  Studio loads it, and the files it imports by relative paths, into a
  sandboxed frame of its own, on every client, and hands it the frame's root
  to draw in.
- **The worker**, `main`: a module (`.ts`, `.js`, …) exporting
  `activate(studio)`. It runs in a Node process of its own, started when
  something needs it (or kept running, with `background: true`), and serves
  the extension's commands, methods, hooks and MCP tools.

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
extension/extension.json  the manifest; extension/ is the folder Studio loads and you pack
extension/src/<name>.ts   a surface: exports mount(root, studio)
extension/src/main.ts     the worker: exports activate(studio) (templates that have one)
test/manifest.ts          extension.json, validated, for your tests
test/*.test.ts            the project's own tests, against the SDK's fake hosts
scripts/check-toolchain.mjs  is this machine ready
IDEA.md                   what the person wants — read it first
```

Every `entry` and `main` in extension.json names a source file under
`extension/src/`. Nothing writes extension.json but you.

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
5. Start the loop below and keep it running while you work.

## The loop

```sh
npm run dev     # sprintengine-extension dev watch extension --check --shot extension/.sprintengine/shots
```

`npm run dev` registers `extension/` with the Studio running on this machine as
a **development folder**: Studio loads it from where it is, under
`local.<id>`, and reads it again every time a file in it is saved. It keeps
running and prints what happens; add `--json` (`npm run dev -- --json`) for one
JSON object per line. The `dev-loop` topic is the full reference.

1. **Approve it once.** The first run prints `waiting` ("waiting for approval
   in Studio") and waits: Studio's window asks the person at once, showing
   the folder and what it may do (also in **Settings → Extensions**, marked
   "Development folder"). Only the person approves, with a click there;
   nothing on the command line can. Tell them it is waiting. Once they
   approve it, `npm run dev` goes on by itself.
2. **Edit and save.** Each save prints `reloaded`: the worker restarted on the
   new code and every open surface redrew, on every client. There is nothing
   to build, copy or reinstall.
3. **Read what came back.** After each reload `--check` prints a `check`
   (extension.json valid, the worker activated against the SDK's fake host,
   each surface's imports resolved) and `--shot` writes a PNG of the first
   surface as Studio draws it, to `extension/.sprintengine/shots/`. Open the
   PNG and look at it. Lines the worker prints arrive as `[worker]`, and the
   frames' `console.error`, `console.warn` and uncaught errors as `[frame]`,
   each at the file and line: `[frame] src/panel.ts:28:17 Cannot read
   properties of undefined`. Fix it at that place and save again.
4. **When it asks for more.** A save that adds a permission, a hook, an MCP
   tool or anything else the approval did not cover prints `approval` with
   what grew, and the extension waits until the person approves again. Asking
   for less, or changing only code, never asks again.
5. **Before you call it done**, `npm run check` (typecheck, tests, check), then
   `npm run pack` for the folder to hand over (the `publishing` topic).

`extension.status` (a Studio tool) says whether Studio sees the extension,
whether it is approved, and why it is not running when it is not. Say what the
person should click and what they should see: the PNG shows you a surface, but
only they can try it in Studio's window.

Without `npm run dev`: `npx sprintengine-extension dev load extension` once
does the same registration, and the folder stays loaded (and reloads on save)
until `dev unload`.

## How the source loads

- A surface imports only its own files, by relative paths: `./list` finds
  `list.tsx`, `list.ts`, … or `list/index.*`, and `./list.js` finds
  `list.ts`. A package by name (`react`, or a value from the SDK) is refused,
  with the file and line: copy the package's ESM files into the extension, or
  bundle it yourself and import the bundle. `import type` from the SDK is
  fine; types are removed.
- JSX is the classic form: `<b>x</b>` calls `h('b', null, 'x')` and `<>` is
  `Fragment`. Import both from a file of your own; nothing supplies them.
- The worker runs in Node with its types stripped (Node's own transpiler): no
  `enum`, no `namespace`, no JSX. Relative imports may leave out the
  extension. `@sprintengine/extension-sdk` resolves from the extension's own
  `node_modules` if it has one, else from the SDK of the Studio running it.
- Nothing type-checks at load: `npm run typecheck` (part of `npm run check`)
  is the only type check.

## Testing without Studio

`@sprintengine/extension-sdk/testing` has fake hosts that keep the host's rules:
the permissions every call needs (from the same table Studio's gate reads),
storage's key and size limits, chat ownership, and the MCP tools extension.json
declares. Write tests in `test/*.test.ts` with `node:test`; `npm test`
(`sprintengine-extension test`) runs them with `node --test`, loading
TypeScript the way Studio loads the extension:

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFakeFrameStudio, createFakeMainHost } from '@sprintengine/extension-sdk/testing'
import { manifest } from './manifest'
import { activate } from '../extension/src/main'
import { loadNotes } from '../extension/src/notes'

test('the worker and the panel', async () => {
  const main = createFakeMainHost({ manifest })                           // moduleId is local.<id>
  await activate(main.host)
  await main.methods.operate('plan-in-chat', { where: 'palette', workspaceId: 'ws-app' }) // a command run
  main.services.conversations.emitEvent(ref, { type: 'turn_completed' }) // what the agent would do
  assert.deepEqual(main.undeclared, [])                                   // nothing used undeclared

  const frame = createFakeFrameStudio({ manifest, main }) // a surface in its frame
  const studio = frame.studio({ point: 'panels', id: 'notes', workspaceId: 'ws-app' })
  assert.equal(await loadNotes(studio), '')
  await studio.host.call('files.read', { workspaceId: 'ws-app', path: 'a.md' }) // rejects: not declared
})
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
(the surfaces that called `ready()`), `frame.logs` (its `log.write` lines),
`frame.settings()`, `frame.file(...)`, `frame.emit(topic, payload)` (a worker
event), `frame.setColorScheme(...)`, and `frame.mount(entry, surface, root)`
runs a `mount` into a root you give it. Pass `invoker: [...]` to call as a
paired device or browser that holds only those permissions. Pass
`capabilities: [...]` to test a worker's host without one.

A test has no DOM. Keep what a surface asks Studio for, and how it reads the
answer, in functions a test can call, and look at the drawing in the PNGs
`npm run dev` writes. `npm run check` also activates the worker against the
fake host and lists the methods, MCP tools and hooks it registered: every
command without an `action` needs an `operate` method of its name, and every
declared MCP tool must be among them.

## The other topics

| Topic | Read it when |
| --- | --- |
| `dev-loop` | The `sprintengine-extension` commands: every flag, the `--json` answers, events, error and exit codes |
| `surfaces` | Choosing what the extension adds to Studio, its tier, and which API does it |
| `components` | A panel drawn with Studio's own controls (`"ui": "components"`): atoms, testing with `mountPanel`, check scenarios, the catalogue |
| `manifest` | Writing `extension/extension.json` |
| `permissions` | Choosing permissions; what each one allows; how an approval holds |
| `rules` | Before writing a surface or a worker: the mistakes that cost earlier extensions time |
| `api-renderer` | The `studio` a surface's `mount` is handed |
| `api-main` | The worker's `activate(studio)`: methods, commands, MCP tools, services, storage |
| `hooks` | Checking, changing or refusing agents' tool calls, prompts, launches and saves, and hearing what they did |
| `events` | Hearing Studio's events (workspaces made, removed or changed, agents' status) in a worker or a surface, and reaching the person's terminals from a worker |
| `conversations` | Starting, prompting and reading the extension's own chats; one-shot text generation |
| `brokers` | API keys and GitHub through the host |
| `styling` | Drawing a surface: plain DOM or JSX, the theme's properties, your own CSS |
| `troubleshooting` | Studio does not list, approve or run the extension |
| `publishing` | Signing with extension.sig, packing, handing it to others |
| `catalogue` | Listing it in a catalogue: release entries, updates, the kill list, install links |

## Done means

- `npm run check` passes with no warnings you have not explained.
- The last `npm run dev` reload printed a passing `check`, no `[frame]` or
  `[worker]` errors, and a PNG that shows what the person asked for; you told
  them exactly what to click and what they should see.
- `tier` and `permissions` in extension.json are the minimum the extension
  needs; `IDEA.md` says what it does now.
- Your own `test/*.test.ts` pin the logic worth pinning.
