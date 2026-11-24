# The dev loop: `sprintengine-extension`

The SDK's CLI, `sprintengine-extension` (`npx sprintengine-extension …` in a
project), does everything between an idea and a packed folder. None of it
builds anything: Studio and the CLI load the source as written.

- `validate`, `inspect`, `test` and `check` work on the folder alone, on this
  machine, without Studio.
- `dev …` and `shot` drive the Studio running on this machine.
- `init`, `add`, `keygen`, `pack`, `sign` and `verify` make and ship the
  project (the `publishing` topic).

`<dir>` is an extension folder (the one holding extension.json) or a project
holding one in `extension/`; it defaults to the current folder. Where a command
takes `<dir|key>`, an install key (`local.<id>`) names a development folder
Studio already has.

## Answers, for agents

Every command in this topic but `init`, `add`, `keygen`, `pack`, `sign` and
`verify` takes `--json`. It then prints one JSON object and nothing else on
stdout:

```json
{ "ok": true, "result": { … } }
{ "ok": false, "error": { "code": "approval_required", "message": "…", "data": { … }, "nextSteps": ["…"] } }
```

Branch on `error.code`, never on the words. `data` carries the details
(`issues` as `[{ path, message }]` for an invalid extension; `growth` for an
approval), and `nextSteps` the commands or clicks that
fix it. Without `--json` the same is printed as words, the failure on stderr.

| `error.code` | What it means | Exit |
| --- | --- | --- |
| `invalid_argument` | A flag or argument is missing or wrong | 1 |
| `extension_invalid` | Studio cannot load it: `data.issues` says where | 2 |
| `approval_required` | It is waiting for approval in Studio, which only the person gives, in Studio's window: `data.growth` when it asks for more than before | 3 |
| `studio_unavailable` | No running Studio could be reached on this machine | 1 |
| `not_found` | That folder or extension is not loaded here, or there are no tests | 1 |
| `extension_tests_failed` | Its tests failed | the runner's |
| `extension_check_failed` | The worker did not activate, or a surface would not load | 1 |
| `extension_request_failed` | A worker method answered a failure: `data.requestCode` is its code | 1 |
| `extension_hook_failed` | A hook threw, timed out or answered nonsense | 1 |
| `shot_failed` | The picture could not be taken | 1 |
| `unavailable` | Studio could not do it now (starting, or something broke): try again | 1 |

Exit codes: 0 ok, 1 an error, 2 `extension_invalid`, 3 `approval_required`.
`test` exits with the test runner's code.

## Without Studio

`test` and `check` run the extension's code on this machine, outside Studio:
run them only on code you trust.

- **`validate <dir>`** (or `validate <dir>/extension.json`): extension.json
  as Studio reads it, strictly (every field, the tier, `engines.studio`
  covering the fields used), every file it names, its skill folders (each a
  folder with a `SKILL.md`, as Studio checks them), the worker's file type,
  each surface's imports, and the host calls its code writes out: a
  `studio.host.call('<method>')` that names no host method (unless guarded by
  `studio.host.has('<method>')`), or needs a permission extension.json does
  not ask for, `worker.*` and `studio.methods()` with no worker,
  `studio.document` outside a custom editor, and a worker's `studio.<method>()`
  that needs a permission it does not ask for, each at `file:line:col`. Only
  literal calls are checked. Answers `key`,
  `id`, `tier`, `files`, `warnings`. An `extension.sig` in the folder is a
  warning: a development folder's signature is not read.
- **`inspect <dir>`**: what it contributes and the access it asks for, which
  is what the person is asked to approve: `needsApproval`, `access`
  (`permissions`, `worker`, `background`, `mcpTools`, `hooks`,
  `commandsRunningActions`, `localMcpServers`, `providers`), `contributes`,
  `files`, `contentHash`. Show it to the person before asking them to approve.
- **`test [dir]`**: every `*.test.ts` (`.tsx`, `.mts`, `.js`, `.jsx`,
  `.mjs`) under the folder, leaving out `node_modules`, `dist` and dotted
  folders. With the project's own Vitest when it has one installed (with a
  config `test` writes to `.sprintengine/test/`), else with `node --test`;
  either way TypeScript and JSX (classic `h()` and `Fragment`) load as Studio
  loads them. Answers `runner` (`vitest` or `node:test`), `code`, `files`.
  A project's `npm test`.
- **`check [dir]`**: `validate`, then the worker activated against the SDK's
  fake host in a child process (at most 15 seconds), then each surface's
  module graph built as Studio builds it and its entry checked for `mount`.
  Answers `key`, `ok`, `worker` (`{ ok, methods, tools, hooks, logs }` or
  `{ ok: false, error }`, the error at `file:line:col`; `null` without a
  worker) and `surfaces` (`[{ point, id, entry, ok, modules }]`, or `problem`
  at `file:line:col`). A project's `npm run check` runs `typecheck`, `test`
  and then this.

## Reaching Studio

`dev` and `shot` reach the Studio running on this machine through its
gateway's local socket, the one Studio's own agents use, found from the
discovery file in Studio's data folder. `--data-dir <folder>` names another
profile's data folder; `SPRINTENGINE_USER_DATA_DIR` does the same. With no
Studio running they fail `studio_unavailable`.

Nothing here approves an extension, for an agent or for the person: approval
is a click in Studio's window. As soon as a development folder is registered,
the window asks the person, showing the folder and what it may do; the same
review is in Settings → Extensions. Every development folder asks once, even
one that asks for nothing, and again only when a save asks for more.

## `dev load <dir>`

Registers the folder as a development folder: Studio loads it from where it
is, under `local.<id>`, and reads it again within a moment of every save. Run
on a folder already registered, it reads it again now. Answers `moduleId`,
`path` (its real path), `added` (false when it was already registered),
`approval` (`{ state, fingerprint? }`) and `latestEvent`.

Until the person approves it, it fails `approval_required` (exit 3): the
folder stays registered, waiting for approval in Studio, where the window asks
them. Run it again, or `dev list`, to see it approved; `dev watch` waits by
itself.

A development folder:

- loads after every installed extension, in the order the folders were
  registered, and its hooks run in that order too;
- stands in for an installed extension with the same key only once the
  person approves it for that, under its own approval; until then the
  installed one keeps running and the folder is listed beside it, waiting;
- leaves out `node_modules`, `.git`, dotted files and folders (such as
  `.sprintengine/`) and symbolic links, none of which a save there reloads;
- holds at most 2000 files and 50 MiB, so a folder named by mistake (a home
  folder) is refused rather than read;
- may not be inside Studio's extensions folder or its data folder;
- is loaded only while it is still the folder it was registered as: one
  swapped for a link since (or with a parent swapped) is not loaded, until it
  is registered again, which asks again.

## `dev watch <dir> [--check] [--shot <out-dir> [--shot-panel <id>]]`

`dev load`, then follows the extension until Ctrl-C, which removes the folder
again if this watch added it (approved or not). A folder waiting for approval
prints `waiting` ("waiting for approval in Studio") and waits until the person
approves it in Studio's window, then goes on. With `--json` it prints one
JSON object per line, each with a `type`:

| `type` | When | Fields |
| --- | --- | --- |
| `loaded` | Once, at the start | `key`, `path` (its real path, used from then on), `added` |
| `waiting` | It waits for the person's approval in Studio | `key`, `path`, `growth?` |
| `approved` | The person approved it; the watch goes on | `key`, `path` |
| `reloaded` | Studio read it again after a save: the worker restarted, its surfaces redraw on every client | `key`, `message` |
| `check` | With `--check`, at the start and after each reload | `key`, `ok`, `offline` (`{ ok, worker, surfaces }` as `check` answers, or `error` and `issues`), `live` (`{ ok, status, message? }`: how Studio runs it now) |
| `shot` | With `--shot`, at the start and after each reload | `key`, `path`, `width`, `height`, `theme`, `settled`, `pendingRequests`, `errors` |
| `shot_failed` | The picture could not be taken | `key`, `message` |
| `log` | A line its worker or a frame printed | `key`, `source` (`worker`, `frame`, `studio`), `level`, `message` |
| `status` | How it stands changed | `key`, `state` (`running`, `waiting`, `errored`, `invalid`, …), `message` |
| `approval` | A save asks for more than was approved: it waits for the person | `key`, `growth`, `fingerprint`, `message` |
| `unloaded` | Ctrl-C removed the folder | `key`, `path` |
| `disconnected` | Studio stopped answering; the watch exits 1 | `key` |

Every event from Studio also carries `seq` (rising) and `at`.

- `--check` runs `check` on this machine after each reload, and reads how
  Studio runs it now: `ok` only when both pass, the live state being
  `runs_worker` or `runs_without_worker`.
- `--shot <out-dir>` writes a PNG of the first panel, door or settings section
  (`--shot-panel <id>` names a panel) to `<out-dir>/<key>-<id>.png` after each
  reload. Read the PNG: it is the surface as Studio draws it, with its host
  calls answered by Studio.
- A `log` line is where an error is: `src/greet.ts:4:7 activate failed` from
  a worker, `src/panel.ts:28:17 …` from a frame. Frames report their
  `console.error`, `console.warn`, uncaught errors and unhandled rejections,
  at most 20 lines every 10 seconds per extension. A surface whose code does
  not load (a syntax error, an import that is refused) draws the error in its
  frame at its file, line and column, and logs it.

A project's `npm run dev` is
`sprintengine-extension dev watch extension --check --shot extension/.sprintengine/shots`.

## The other `dev` commands

`request`, `hook`, `emit` (with or without `--studio`) and `shot` reach a development folder's extension
only; an installed one is refused (`not_found`). They run as whoever calls
them: a request or hook from an agent runs under that agent's own permission
preset, and an agent below `bypass` is refused a shot, whose surface calls
are answered as the person.

- **`dev reload [<dir|key>]`**: reads one development folder, or every one,
  again now, for a folder whose saves Studio does not hear (a network share).
  Answers `reloaded`, a `dev load` answer for each.
- **`dev unload <dir|key>`**: takes the folder out of Studio. Its files stay;
  every approval it was given is forgotten. Answers `path`, `moduleId`.
- **`dev list`**: the development folders, in load order: `folders` as
  `[{ path, moduleId?, name?, approval?, overrides?, waiting?, error?, launch? }]`
  (`waiting`: it waits to replace the installed extension with its key)
  (`error` says why a folder holds no extension Studio loads).
- **`dev logs <dir|key> [--after <seq>]`**: what was kept of its events (the
  newest few hundred), the same events `dev watch` prints: `events`, `latest`.
  Pass the last `seq` you saw as `--after` to read only what is new.
- **`dev request <dir|key> <method> [--data <json>] [--read] [--timeout-ms <ms>]`**: calls a
  worker method (`registerMethods`) the way a surface's
  `studio.methods().operate` does (`.read` with `--read`), starting the worker
  if it is not running. `--timeout-ms` is how long to wait for the answer.
  Answers `moduleId`, `method`, `result`.
- **`dev hook <dir|key> <point> --data <json>`**: runs one of the worker's
  hooks with the event you give, as Studio runs it before an action, and
  answers what it decided (`answer`). Nothing else in Studio happens.
- **`dev emit <dir|key> <topic> [--data <json>]`**: sends its open frames a
  push (`studio.on('push')`), as the worker's `studio.emit` would.
- **`dev emit <dir|key> <event> --studio --data <json>`**: fires one of
  Studio's events (`workspace.created`, `workspace.changed`, …) at this
  extension alone, its worker's `studio.events.on` handlers and its open
  surfaces' `studio.on`, as Studio would send it: test a handler without
  making the change. The payload is checked against the event's shape (the
  `events` topic's table); the worker hears it only if extension.json lists
  the event and its approval holds the event's permission, and the answer
  says whether it did.

## Installed extensions

- **`list`**: every third-party extension Studio has, installed or a
  development folder, as `extension.list` reports it: `modules`.
- **`logs <key|dir> [--after <seq>]`**: what was kept of an extension's
  events, installed ones included, as `dev logs` answers.

## `shot <dir|key> [--panel <id> | --door <id> | --settings <id>]`

A PNG of one surface as Studio draws it: its real frame document, in a hidden
window of the desktop app, with its host calls answered by Studio. Without a
surface named, the first panel, door or settings section. `--theme light|dark`
(default `dark`), `--width` and `--height` in pixels (default 420 × 640;
200–2000 wide, 120–2000 high), `--out <file.png>` (default
`<dir>/.sprintengine/shots/<key>-<id>.png`). It waits for `studio.ready()` and
for the surface's calls to be answered, at most eight seconds. Answers `path`,
`width`, `height`, `theme`, `settled` (false: it may show the surface still
loading), `pendingRequests` and `errors` (what it threw or logged, at
`file:line:col`). A Studio without its desktop window (a server on its own)
fails `shot_failed`.

## The same from Studio's tools

An agent with Studio's MCP tools can skip the CLI: `extension.dev.load`
(`path`, the folder's absolute path), `extension.dev.unload`,
`extension.dev.list`, `extension.dev.events` (`after`, `moduleId`, `limit`),
`extension.dev.request`, `extension.dev.hook`, `extension.dev.emit`, `extension.dev.studioEvent` and
`visual.extension_shot` (`moduleId`, `point`, `id`, `out`). They answer the
same results; a failure is the tool's error with the same codes. A paired
device cannot use them: a development folder is a path on this machine.
