---
name: studio-extensions
description: Build, change, debug or ship a SprintEngine Studio extension (a folder with an extension.json, written against @sprintengine/extension-sdk) through the extension_create, extension_guide, extension_dev_load, extension_dev_events and visual_extension_shot tools or the sprintengine-extension CLI. Use when asked to make a Studio extension, panel, door, settings section, custom editor, command, hook or MCP tool for Studio, to fix one that will not load, approve or run, to read what its frames and worker logged, or to pack and sign one for others.
---

# Studio extensions

An extension is a folder holding `extension.json` and its source. There is no
build step: Studio loads the TypeScript and JavaScript as written, and reads
it again on every save. You write the code, Studio runs it, and the person
approves what it may do.

## 1. Start from a template

- New project: call `extension_create` (its `template` and `parts`), or run
  `npx sprintengine-extension init <dir> --template <id>` (an unknown
  `--template` lists them). Then `npm install`.
- Read the guide before you change anything: `extension_guide` with topic
  `start`, then the topic the work needs (`surfaces`, `manifest`,
  `permissions`, `rules`, `api-renderer`, `api-main`, `hooks`, `styling`,
  `troubleshooting`, `publishing`, and `dev-loop` for every CLI flag and
  answer). Without Studio's tools the same topics are in
  `node_modules/@sprintengine/extension-sdk/guide/`.
- Read `IDEA.md` in the project: it is the person's brief.
- Pick the smallest surface and the lowest `tier` that do the job, and ask
  for the fewest `permissions`. Add a part with
  `npx sprintengine-extension add main|mcp|settings|door`.

## 2. Run the loop

From the project folder, keep this running while you work:

```sh
npx sprintengine-extension dev watch extension --check --shot extension/.sprintengine/shots --json
```

(`npm run dev -- --json` in a project from a template.) It registers
`extension/` with the running Studio as a development folder and prints one
JSON object per line. Act on its `type`:

- `loaded`: registered. Studio reads the folder again on every save.
- `reloaded`: your save is live: the worker restarted, every open surface
  redrew.
- `check`: `ok: false` names the worker's error or each surface's `problem`
  at `file:line:col`. Fix it there.
- `shot`: a PNG at `path`. **Open it and look at it** before you say a
  surface works. `settled: false` means it never called `studio.ready()` or
  its calls were still waiting.
- `log`: `[worker]` and `[frame]` lines, errors at `file:line:col`
  (`src/panel.ts:28:17 …`). Fix every error line.
- `approval`: a save asks for more than was approved; `growth` says what.
  Stop and ask the person (below).
- `status`: how it runs now, with the reason.

Without a watch: `npx sprintengine-extension dev load extension --json` once,
`dev logs extension --json` to read what happened, `shot extension --json` for
one PNG. Agents with Studio's tools can call `extension_dev_load`,
`extension_dev_events`, `extension_dev_list`, `extension_dev_unload` and
`visual_extension_shot` instead.

Drive the worker without clicking: `dev request extension <method> --data
'<json>'`, `dev hook extension <point> --data '<json>'`, `dev emit extension
<topic>` (or `extension_dev_request`, `extension_dev_hook`,
`extension_dev_emit`).

## 3. Branch on `error.code`

With `--json` a failure is `{ "ok": false, "error": { "code", "message",
"data", "nextSteps" } }`. Branch on the code, never the words:

- `approval_required` (exit 3): it waits for the person. Show them what it
  asks for (`npx sprintengine-extension inspect extension --json`) and ask
  them to approve it in **Settings → Extensions**, where it is marked
  "Development folder". Then run the command again.
- `approval_stale` (exit 3): the fingerprint is old. Load again without
  `--approve` and ask the person again.
- `extension_invalid` (exit 2): `data.issues` lists each path and message.
  Fix them.
- `extension_check_failed`: the worker did not activate or a surface did not
  load; the message is at `file:line:col`.
- `extension_tests_failed`: read the test output and fix the code, not the
  test.
- `studio_unavailable`: Studio is not running here; ask the person to start
  it (or pass `--data-dir` for another profile).
- `not_found`: load the folder first (`dev load`).
- `shot_failed`: a shot needs the desktop app running.
- `unavailable`: try again in a moment.

## 4. Approval: never on the person's behalf

- Never approve an extension yourself, never pass `--approve`, and never
  edit Studio's approval or extension files to get around it. Studio refuses
  an approval from an agent it launched; the person approves in Settings.
- A development folder is approved once, for what it may do. Saves keep the
  approval; a save that asks for more (a permission, a hook, an MCP tool, a
  higher tier, a local server's command) waits for the person again. Asking
  for less never does.
- Removing the folder (`dev unload`, or Ctrl-C on a watch that added it)
  forgets its approval.

## 5. Follow the no-build rules

- A surface imports only its own files by relative paths (`./list` finds
  `list.ts`). Never import a package by name in a surface (`react`, values
  from the SDK): copy its ESM files into `extension/`, or bundle it yourself
  and import the bundle. `import type` from the SDK is fine.
- JSX is the classic form calling `h()` and `Fragment`: import both from a
  file of your own.
- The worker's TypeScript is types only: no `enum`, `namespace` or parameter
  properties, no JSX.
- A frame cannot import CSS: keep styles in a string and append a `<style>`
  in `mount`. Use the theme's custom properties and Studio's `se-*` classes,
  never hex colours.
- Nothing type-checks at load: run `npm run typecheck`.

## 6. Check and pack

1. `npm run check` (typecheck, tests, then `sprintengine-extension check`)
   passes.
2. The last reload printed a passing `check`, no error `log` lines, and a PNG
   that shows what the person asked for.
3. Tell the person what to click in Studio and what they should see.
4. When they want to hand it over: `npm run pack`; to sign it, the
   `publishing` topic. Never commit or pack a `*.key` or `*.pem`.
