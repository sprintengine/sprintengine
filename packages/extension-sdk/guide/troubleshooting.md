# Troubleshooting

Start with `npm run check` and `node scripts/validate.mjs`: most problems show
up there first, with the validator Studio itself runs.

## Studio does not list the extension

| Check | Fix |
| --- | --- |
| Is it installed where Studio looks? `ls ~/.sprintengine/extensions/local.<id>/extension.json` (or under `$SPRINTENGINE_USER_EXTENSION_ROOT` if Studio was started with it) | `npm run dev:install` |
| Is the folder named for its install key, `local.<id>`? | `dev:install` names it from the id |
| Does extension.json validate? | `node scripts/validate.mjs` |
| Does its id start `studio-` or `sprintengine-`? | Those install only from Studio's own catalogue; choose another id |
| Is Settings → Extensions showing an older list? | Close and reopen Settings; the list rescans the folder |

## Listed, but not running

| Studio shows | Cause | Fix |
| --- | --- | --- |
| Needs approval | Not approved yet — or approved before the last rebuild, or the rebuild asks for more | Approve it. Every `dev:install` of a new build is new contents |
| Invalid / tampered | Files in the folder do not match `extension.sig` | `npm run dev:install` (it signs the installed copy again when it can, and drops a stale signature when it cannot). Never edit the installed copy |
| Needs a newer Studio | `engines.studio` asks for a Studio newer than this one | Update Studio, or use only fields this Studio reads (their "Since", in the `manifest` topic) |
| Off | Never turned on | Turn it on in Settings → Extensions |
| A load error | `activate` threw or rejected; a ui entry failed to import | Read the error text; `npm test` reproduces most of them |

## Running, but something is missing

| Symptom | Cause |
| --- | --- |
| A panel is not offered | It is offered by a workspace pane's + menu; check `contributes.panels` and the tier (`ui` or above) |
| A surface stays blank | `mount` threw, drew outside `root`, or the entry is not the bundle you think; open it again after `npm run dev:install` |
| Studio says a surface is slow to open | It never calls `studio.ready()`, or calls it late |
| Unstyled markup | Utility classes you wrote compile to nothing (the `styling` topic) |
| Failed to resolve module specifier "react" (or anything else) | The ui entry imports something at runtime; bundle it whole (`npm run build:ui`) |
| Cannot find module '…' from the worker | A dependency left external in the worker build; bundle it |
| A command does nothing | It has no `action`, and the worker has no `operate` method of its name |
| MCP tool rejected at registration | Declare it in `contributes.mcpTools` and `tools:contribute`; or a name another extension already holds |
| MCP tool answers "extension disabled" | Turn the extension on |
| Smoke test: "… needs "storage:own"" (or another permission) | The worker calls a method whose permission extension.json does not ask for. Ask for it |
| A call answers or throws `not_permitted` | Your extension was not approved for what it needs, or whoever set the call off (a paired device, another app, an agent) may not do it themselves. The message says which |
| A call answers or throws `approval_required` | The extension is not approved as it is now (an update waiting for approval, or uninstalled while running) |
| A call answers `extension_unavailable` | The worker is not running on that Studio: switched off, refused or failed to load (see Settings) |
| A call answers `extension_method_unknown` | No method of that name, or it is declared with the other access (`read` vs `operate`) |
| A call answers `invalid_params` | Your own params validator refused what was sent; the message is yours |
| `openChat` → `not_permitted` | Declare `chat:draft`, or `conversation:own` to send |
| `openChat` → `workspace_folder_missing` | Chats need a workspace with a folder |
| `openChat` → `unavailable` | This window cannot open chats; try the main window |
| Conversation service → `not_owned` | The chat was not created by this extension |
| `studio.supports('…')` is false | This Studio (or its providing module) does not offer it; degrade with a message |
| Secrets → `origin_not_allowed` | The URL's origin was not in `allowedOrigins` when the secret was set; set it again with the origin |
| GitHub → `not_signed_in` | The person is not signed in to GitHub in Studio |

## Dev loop problems

| Symptom | Fix |
| --- | --- |
| `validate`: "is not a field Studio knows" | A misspelt or unknown key in extension.json; the path names it |
| `validate`: "cannot carry what this manifest declares" | Raise `tier`, or drop what needs the higher tier |
| `validate`: `engines.studio` must be at least … | Raise it to the version named: the newest "Since" of the fields you use |
| `validate`: a file extension.json names does not exist | `npm run build` first; check the `entry` path matches `src/<name>.tsx` |
| `validate`: key material in the project | Move the key to `~/.sprintengine/keys/` and rotate it if it was ever committed |
| `validate`: `sprintengine-extension verify` refused it | `extension/extension.sig` no longer matches the build; sign again or delete it |
| `npm test`: a ui entry "imports …" | Something in the bundle is external that should not be |
| `npm test`: a command has no operate method | Register it with `registerMethods`, access `operate`, under the command's id |
| `npm test`: a declared MCP tool is not registered | Serve it from `activate` with `registerMcpTools` |

## Reading Studio's side

The person can open Settings → Extensions for the extension's status line and
load error. Ask them to copy it to you verbatim; do not guess from a
screenshot of the drawer.
