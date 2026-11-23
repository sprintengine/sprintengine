# Troubleshooting

Start with `npm run check` and `npx sprintengine-extension validate extension
--json`: most problems show up there first, with the validator Studio itself
runs, each at its path in extension.json or at a file and line. With `npm run
dev` running, read its `check`, `log` and `status` lines (the `dev-loop`
topic); `npx sprintengine-extension dev logs extension` prints what Studio
kept of them.

## Studio does not load the extension

| Check | Fix |
| --- | --- |
| Is the folder registered? `npx sprintengine-extension dev list` | `npm run dev`, or `npx sprintengine-extension dev load extension` |
| `dev` fails `studio_unavailable` | Start Studio on this machine; for another profile, pass `--data-dir <its data folder>` |
| `dev` fails `extension_invalid` | `data.issues` names each problem; `validate` prints the same |
| `dev list` shows the folder with an `error` | Its extension.json does not load; or another development folder already holds that id: remove one of them |
| Does its id start `studio-` or `sprintengine-`? | Those install only from Studio's own catalogue; choose another id |
| A development folder is refused for its size | It holds more than 2000 files or 50 MiB, leaving out `node_modules`, `.git` and dotted folders: point it at `extension/`, not the project or a home folder |
| An installed copy (`~/.sprintengine/extensions/local.<id>/`) is not listed | Close and reopen Settings; the list rescans the folder |

## Loaded, but not running

| Studio shows | Cause | Fix |
| --- | --- | --- |
| Needs approval, `approval_required` | Not approved yet, or a save asks for more than was approved (`dev watch` printed `approval` with what grew) | The person approves it in Settings → Extensions. Never approve it for them |
| `approval_stale` | The fingerprint given to `--approve` is not what the folder asks for now | Load it again without `--approve` and show the person the new fingerprint |
| An installed extension needs approval again after its development folder was removed | A development folder's approval never covers the installed extension with its key, and the other way round | Approve the installed one |
| Invalid / tampered (an installed extension) | Files in its installed folder do not match `extension.sig`, or changed since it was approved | Install it again from a packed copy. Never edit an installed copy; work in a development folder |
| Needs a newer Studio | `engines.studio` asks for a Studio newer than this one | Update Studio, or use only fields this Studio reads (their "Since", in the `manifest` topic) |
| Off | Never turned on | Turn it on in Settings → Extensions |
| A load error | `activate` threw or rejected | The error is at its file and line (`src/main.ts:4:7 …`); `npm run check` reproduces most of them |

## Running, but something is missing

| Symptom | Cause |
| --- | --- |
| A panel is not offered | It is offered by a workspace pane's + menu; check `contributes.panels` and the tier (`ui` or above) |
| A surface shows an error at a file and line | Its code did not load: a syntax error, or an import that is refused. Fix it there and save |
| A surface stays blank | `mount` threw or drew outside `root`; read the `[frame]` lines and the PNG `npm run dev` wrote |
| A save does not show | Was it under a dotted folder, `node_modules` or a symbolic link? Those are never read. Otherwise `dev load` reads the folder again now |
| Studio says a surface is slow to open | It never calls `studio.ready()`, or calls it late |
| Unstyled markup | Utility classes you wrote compile to nothing (the `styling` topic) |
| `cannot import "react"` (or any package by name) | A surface imports only its own files by relative paths. Copy the package's ESM files into the extension, or bundle it and import the bundle |
| `imports a module named at run time` | `import(variable)` cannot load; import a relative path written out |
| `… which imports it back: cycles cannot load` | Two of a surface's files import each other; move what they share into a third |
| `is larger than 1 MiB` | A transpiled file is at most 1 MiB; split it. A surface loads at most 500 modules |
| `h is not defined` | JSX calls `h()` and `Fragment`: import them from a file of your own |
| The worker fails on an `enum`, a `namespace` or a parameter property ("not supported in strip-only mode") | Node strips types only, and those need code; use a union, an object or a plain field instead |
| Cannot find module '…' from the worker | Only Node's own modules, the extension's own files and `@sprintengine/extension-sdk` are there once packed: copy or bundle anything else into the extension |
| A command does nothing | It has no `action`, and the worker has no `operate` method of its name |
| MCP tool rejected at registration | Declare it in `contributes.mcpTools` and `tools:contribute`; or a name another extension already holds |
| MCP tool answers "extension disabled" | Turn the extension on |
| A fake host refuses: "… needs "storage:own"" (or another permission) | The code calls a method whose permission extension.json does not ask for. Ask for it |
| A call answers or throws `not_permitted` | Your extension was not approved for what it needs, or whoever set the call off (a paired device, another app, an agent) may not do it themselves. The message says which |
| A call answers or throws `approval_required` | The extension is not approved as it is now (a save or an update waiting for approval, or removed while running) |
| A call answers `extension_unavailable` | The worker is not running on that Studio: switched off, refused or failed to load (see Settings) |
| A call answers `extension_method_unknown` | No method of that name, or it is declared with the other access (`read` vs `operate`) |
| A call answers `invalid_params` | Your own params validator refused what was sent; the message is yours |
| `chat.draft` → `not_permitted` | Declare `chat:draft` |
| `chat.draft` → `workspace_folder_missing` | Chats need a workspace with a folder |
| `chat.draft` → `unavailable` | This window cannot open chats; try the main window |
| A `host.call` → `not_permitted` naming a permission the extension holds | Whoever opened the surface (a paired device, a browser) does not hold it themselves |
| A surface's `fetch` or image URL fails | A surface has no network: ship the data in the extension, inline images as `data:` URLs |
| Conversation service → `not_owned` | The chat was not created by this extension |
| `studio.supports('…')` is false | This Studio (or its providing module) does not offer it; degrade with a message |
| Secrets → `origin_not_allowed` | The URL's origin was not in `allowedOrigins` when the secret was set; set it again with the origin |
| GitHub → `not_signed_in` | The person is not signed in to GitHub in Studio |

## Checks and tests

| Symptom | Fix |
| --- | --- |
| `validate`: "is not a field Studio knows" | A misspelt or unknown key in extension.json; the path names it |
| `validate`: "cannot carry what this manifest declares" | Raise `tier`, or drop what needs the higher tier |
| `validate`: `engines.studio` must be at least … | Raise it to the version named: the newest "Since" of the fields you use |
| `validate`: a file extension.json names "is not in the folder" | Paths are relative to `extension/`: `src/<name>.ts`, not `extension/src/…` |
| `validate`: a worker's main is … | `main` is `.js`, `.cjs`, `.mjs`, `.ts`, `.mts` or `.cts` |
| `validate`: key material in the project | Move the key to `~/.sprintengine/keys/` and rotate it if it was ever committed |
| `validate` warns about `extension.sig` | A development folder's signature is not read; sign the folder you pack |
| `check`: a surface "must export mount" | Export `mount(root, studio)` from the entry, by that name |
| `check`: the worker did not activate | The error is at its file and line; `activate` must finish within the check's 15 seconds |
| `check`: a method, tool or hook is missing from what the worker registered | Register a command's method with `registerMethods` (access `operate`, the command's id), a declared tool with `registerMcpTools`, a hook with `registerHooks` |
| `test`: `not_found` | No `*.test.ts` (or `.mts`, `.js`, `.mjs`) outside `node_modules`, `dist` and dotted folders |
| `shot`: `shot_failed` | It needs the desktop app running; a surface that never calls `ready()` is pictured after eight seconds with `settled: false` |

## Reading Studio's side

`dev logs` and `dev watch` print what the worker and the frames logged, and
Studio's own words about the extension (`[studio]`). The person can also open
Settings → Extensions for the extension's status line and load error. Ask them
to copy it to you verbatim; do not guess from a screenshot of the drawer.
