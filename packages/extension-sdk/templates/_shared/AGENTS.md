# {{displayName}} — a SprintEngine Studio extension

This project builds a SprintEngine Studio extension with
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

| Path | What it is |
| --- | --- |
| `extension/extension.json` | What the extension is, what it adds to Studio, and the permissions it asks for. Studio reads it; the build never rewrites it |
| `extension/dist/` | The build: one self-contained bundle per panel, door and settings section, and `main.cjs` for the worker. `extension/` is the folder Studio installs |
| `src/` | Source. `src/<name>.tsx` exports `mount(root, studio)` for the entry `dist/<name>.js`; `src/main.ts` exports `activate(studio)` for the worker |
| `test/` | `smoke.test.mjs` loads the build as Studio does; `manifest.ts` hands tests the validated manifest; `*.test.ts` are your tests |
| `scripts/` | `check-toolchain.mjs` (is this machine ready), `build-ui.mjs`, `validate.mjs` and `dev-install.mjs`, the dev loop |

## Commands

```sh
npm install
node scripts/check-toolchain.mjs   # Node, npm, git, the SDK installed, extension.json valid
npm run check        # typecheck, build, tests, validate — run before calling anything done
npm test             # bundle test/*.test.ts with esbuild, then run them and the smoke test with node --test
npm run dev:install  # build, then install into ~/.sprintengine/extensions/local.{{id}} (signed if you have a key)
npm run keygen       # once: a signing key in ~/.sprintengine/keys/{{id}}.key (never in this repo)
npx sprintengine-extension add main|mcp|settings|door   # add a part: files, test, contributions, permissions, build script
```

## Tests

Write tests in TypeScript as `test/*.test.ts`. `npm test` bundles them with
esbuild into `test/.build/` (ignored) and runs them with `node --test`. Import
the source (`../src/main`, `../src/<surface>`) and drive it with
`createFakeMainHost` / `createFakeRendererHost` from
`@sprintengine/extension-sdk/testing`, handing them `manifest` from
`./manifest`: they keep Studio's rules, so a missing permission fails here
rather than in Studio. `renderToHtml` renders a React component in Node.

After `dev:install`, trust the extension in Studio (Settings → Extensions)
unless it is signed with a key you trust.

## Rules

- Everything the extension adds is declared in `extension/extension.json`:
  panels, doors, settings sections, commands, menu items, top bar items, MCP
  tools. Code never registers a surface. Keep `tier` the least that carries
  what it declares, and `permissions` minimal: they are shown to the person
  installing, and Studio enforces many of them.
- A surface's bundle is imported on its own: bundle everything it uses, React
  included. Style it with Studio's `--sem-*` CSS custom properties, keep your
  CSS inside the root you are given, and call `studio.ready()` once it is drawn.
- A command without an `action` runs the worker method of the same name: declare
  it with `registerMethods` as an `operate` method.
- Agents are chats: start them with the conversation service or `openChat`.
  There is no terminal-agent API.
- Store data with `getModuleStorage(studio)` or the extension's app state, never
  files in the home folder. Reach secrets and GitHub through the brokers, never
  by holding a token.
- Text an agent or a web page produced is untrusted input: never evaluate it,
  and never let it choose a path, a URL or a command unchecked.
- Never commit `*.key` / `*.pem`.
