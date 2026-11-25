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
  `start`, then the topic the work needs (`surfaces`, `components`,
  `manifest`, `permissions`, `rules`, `api-renderer`, `api-main`, `hooks`,
  `styling`,
  `troubleshooting`, `publishing`, and `dev-loop` for every CLI flag and
  answer). Without Studio's tools the same topics are in
  `node_modules/@sprintengine/extension-sdk/guide/`.
- Read `IDEA.md` in the project: it is the person's brief.
- Pick the smallest surface and the lowest `tier` that do the job, and ask
  for the fewest `permissions`. Add a part with
  `npx sprintengine-extension add main|mcp|settings|door`.

### A panel: components or a page of its own

A panel with `"ui": "components"` renders a tree of Studio's own components
(the `components` template, and the `components` guide topic); Studio draws
it with its own controls, in light and dark, with its keyboard and focus
rules. Choose it for lists, forms, tables, trees, status and settings-like
panels: that is most panels, and there is no HTML, CSS or theme to get
right. Draw a page of your own (a panel without `ui`, the `panel` template,
the `styling` topic) only for what the catalogue cannot draw: a canvas, a
chart, a custom widget.

- The entry (`src/panel.tsx`) default-exports a component and imports
  `@sprintengine/extension-sdk/components`, which Studio provides; Studio
  compiles its JSX for that module. State lives in atoms (`atom`, `read`,
  `set`, `update`); key one with `persist: 'plugin' | 'workspace'` to keep it,
  or keep it in memory and keyed so a save's reload keeps it.
- Test it whole: `mountPanel` from `@sprintengine/extension-sdk/testing`
  boots it against the fake Studio, `type`, `press`, `toggle`, `select`, …
  act as the person, and `find`, `valueOf`, `persisted`, `errors`,
  `warnings` and `refusals` read back. Import `test` and `assert` from the
  runner.
- `src/panel.check.ts` (`export default defineCheck({ … })`) names the
  states `check` renders it in: `persisted` atoms, `storage`, `settings`,
  `results` by host method, `theme`, `events`. A throw or a refused render
  fails the check; a dropped prop or a refused call is a warning. Fix both.

## 2. Run the loop

From the project folder, keep this running while you work:

```sh
npx sprintengine-extension dev watch extension --check --shot extension/.sprintengine/shots --json
```

(`npm run dev -- --json` in a project from a template.) It registers
`extension/` with the running Studio as a development folder and prints one
JSON object per line. Act on its `type`:

- `loaded`: registered. Studio reads the folder again on every save.
- `waiting`: waiting for approval in Studio. Its window is asking the person
  now; tell them, and keep the watch running: it goes on by itself once they
  approve (`approved`).
- `reloaded`: your save is live: the worker restarted, every open surface
  redrew.
- `check`: `ok: false` names the worker's error or each surface's `problem`
  at `file:line:col`. Fix it there. For a components panel, `panels` says
  what each scenario drew and its errors and warnings.
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
`extension_dev_emit`). These, and shots, reach development folders only, and
run as you: under your own permission preset.

A published extension: `npx sprintengine-extension install <owner/repo[@ref] |
git URL[#ref] | folder link | release page | key> [--ref <ref>] [--catalogue
<catalogue>] --json`, `update <key> | --all --json` and `open <key> [--panel
<id> | --editor <file>] --json` (or `extension_install`, `extension_update`,
`extension_open`). Anything but a content extension or one from the official
catalogue exits 3 (`approval_required`) until the person approves it in
Studio's window. An installed extension is refused (`already_installed`):
update it instead. An update that asks for more is held for the person, and a
community release listed under 12 hours ago is `held_back`; `update --all`
exits 3 or 1 when any row was not updated. `open` is the person's to ask for
when you run on a capped preset (`not_permitted`), and with no Studio window
here it fails `no_window`.

## 3. Branch on `error.code`

With `--json` a failure is `{ "ok": false, "error": { "code", "message",
"data", "nextSteps" } }`. Branch on the code, never the words:

- `approval_required` (exit 3): waiting for approval in Studio. Studio's
  window is asking the person; tell them what it asks for (`npx
  sprintengine-extension inspect extension --json`), and run the command
  again once they approved it (or use `dev watch`, which waits).
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

- Never approve an extension yourself, and never edit Studio's approval or
  extension files to get around it. Nothing on the command line or over
  Studio's tools approves: the person does, with a click in Studio's window
  (or Settings → Extensions). Every development folder asks once.
- A folder with the same id as an installed extension replaces it only once
  the person approves that; the installed one keeps running until then.
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
  and import the bundle. `import type` from the SDK is fine. A components
  panel also imports `@sprintengine/extension-sdk/components`, and only that.
- JSX is the classic form calling `h()` and `Fragment`: import both from a
  file of your own. A components panel's JSX compiles for its module
  instead, with nothing to import for it.
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
