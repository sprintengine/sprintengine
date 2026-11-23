# {{displayName}} — a SprintEngine Studio extension

This project is a SprintEngine Studio extension, written with
`@sprintengine/extension-sdk`. It never compiles against the app's source: the
SDK is the whole contract.

**Read first:** the extension guide. Call SprintEngine Studio's
`extension.guide` tool (on the `sprintengine-studio` MCP server) with topic
`start` before changing anything; its other topics answer "which surface",
"which API", "which permission" and "why won't it load". Without Studio's tools
the same topics are the files in `node_modules/@sprintengine/extension-sdk/guide/`
(after `npm install`). The SDK's own README is
`node_modules/@sprintengine/extension-sdk/README.md`, and its type declarations in
`node_modules/@sprintengine/extension-sdk/dist/*.d.ts` are the authority on every
signature. What the extension is for is in `IDEA.md`.

## Layout

| Path                          | What it is                                                                                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension/`                  | The extension, as Studio loads it: no build step. `npm run dev` loads this folder where it is, and `npm run pack` packs it                                                          |
| `extension/extension.json`    | What the extension is, what it adds to Studio, and the permissions it asks for. Every `entry` and `main` names a source file in `extension/src/`                                    |
| `extension/src/`              | Source, TypeScript as written. `src/<name>.ts` exports `mount(root, studio)` for a panel, door, settings section or editor; `src/main.ts` exports `activate(studio)` for the worker |
| `test/`                       | `manifest.ts` hands tests the validated manifest; `*.test.ts` are your tests                                                                                                        |
| `scripts/check-toolchain.mjs` | Is this machine ready: Node, npm, git, the SDK installed, extension.json valid                                                                                                      |

## Commands

```sh
npm install
node scripts/check-toolchain.mjs   # is this machine ready
npm run dev          # load extension/ into the running Studio, check it and reload it on every save
npm run check        # typecheck, tests, then sprintengine-extension check — run before calling anything done
npm test             # test/*.test.ts with node --test, TypeScript loaded as Studio loads it
npm run validate     # extension.json as Studio reads it
npm run pack         # the folder to publish
npm run keygen       # once: a signing key in ~/.sprintengine/keys/{{id}}.key (never in this repo)
npx sprintengine-extension add main|mcp|settings|door   # add a part: files, test, contributions, permissions
```

`npm run dev` keeps running: it loads `extension/` into Studio as a
development folder and reloads it each time a file in it is saved. The first
time, approve it once in Studio (Settings → Extensions). After every reload it
checks the extension (`--check`: the manifest, the worker activated against
the SDK's fake host, each surface's imports) and writes a PNG of each surface
to `extension/.sprintengine/shots/` (`--shot`): open the picture to see what
you drew. `npx sprintengine-extension shot` takes one on demand.
`.sprintengine/` is git-ignored, and Studio skips dotted folders, so the shots
never ship.

## How the source loads

Studio loads the files in `extension/` as they are; nothing is compiled.

- A surface (`mount`) runs in a sandboxed frame. Studio removes its types and
  gathers the files it imports by a relative path (`./list` finds `list.ts`).
  It cannot import a package by name (`react`, or the SDK's values): only
  `import type` from `@sprintengine/extension-sdk`. Draw with DOM APIs, and
  put styles in a TypeScript string appended as a `<style>` element in
  `mount`: a frame cannot import a CSS file.
- The worker (`main`) runs in Node. Studio strips its types with Node's own
  transpiler, so write only erasable TypeScript (no `enum`, no `namespace`;
  `tsc` refuses them here), and import relative files without an extension.
- `tsc` is the only type check: run `npm run typecheck` (or `npm run check`).

## Tests

Write tests in TypeScript as `test/*.test.ts` with `node:test` and
`node:assert`. `npm test` runs every test file with `node --test`, loading
TypeScript the way Studio loads the extension. Import the source extensionless
(`../extension/src/main`, `../extension/src/<surface>`) and drive it with
`createFakeMainHost` (the worker) / `createFakeFrameStudio` (a surface) from
`@sprintengine/extension-sdk/testing`, handing them `manifest` from
`./manifest`: they keep Studio's rules, so a missing permission fails here
rather than in Studio. A test has no DOM: keep what a surface asks Studio for,
and how it reads the answer, in functions a test can call, and look at the
drawing in the shots `npm run dev` writes.

## Rules

- Everything the extension adds is declared in `extension/extension.json`:
  panels, doors, settings sections, commands, menu items, top bar items, MCP
  tools. Code never registers a surface. Keep `tier` the least that carries
  what it declares, and `permissions` minimal: they are shown to the person
  installing, and Studio enforces many of them.
- A surface runs in a sandboxed frame of its own: no network, no Node, and
  nothing of Studio's window. It reaches Studio only through
  `studio.host.call(method, params)`, which Studio checks against the
  permissions in extension.json. Style it with the theme's CSS custom
  properties (`--bg-surface`, `--text-default`, …) and Studio's kit classes
  (`se-button`, `se-input`, `se-list-row`, …), and call `studio.ready()` once
  it is drawn.
- A command without an `action` runs the worker method of the same name: declare
  it with `registerMethods` as an `operate` method.
- Agents are chats: start them with the conversation service in the worker, or
  draft one for the person from a surface (`chat.draft`).
  There is no terminal-agent API.
- Store data with `getModuleStorage(studio)` in the worker, `storage.*` or
  `settings.*` from a surface, never files in the home folder. Reach secrets and GitHub through the brokers, never
  by holding a token.
- Text an agent or a web page produced is untrusted input: never evaluate it,
  and never let it choose a path, a URL or a command unchecked.
- Never commit `*.key` / `*.pem`.
