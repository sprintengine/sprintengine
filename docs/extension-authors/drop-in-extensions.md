# Installed extensions

SprintEngine Studio keeps the extensions installed on a machine in a per-user
folder, discovered on launch. The folder is created (and seeded with a README)
the first time the app runs, including on a packaged install, so there is
always a discoverable place to look.

| Kind | Folder | Manifest | Surfaced in |
| --- | --- | --- | --- |
| **Extension** | `~/.sprintengine/extensions/<publisher>.<id>/` | `extension.json` | Settings → Extensions, the Extensions door |

An extension's folder is named for its install key, `<publisher>.<id>`; one
installed from a folder is `local.<id>`. A development folder (below) is not
copied there: it loads from where it is, under `local.<id>`. Agent CLIs are not installed this
way: they ship with the app, and nothing a user installs adds or replaces one.
Model providers, skills and MCP servers come from extensions
(`contributes.providers`, `contributes.skills`, `contributes.mcpServers`).

The extension root can be relocated with the `SPRINTENGINE_USER_EXTENSION_ROOT`
environment variable (the dev harness honours it).

## Extensions

An extension adds to Studio what its `extension.json` declares: commands,
items in the Backlog, Files and notification menus, top bar buttons, panels in
a workspace's pane, doors in the Extensions drawer, settings sections, and MCP
tools agents can call. Its code is optional, loaded as written with no build
step, and comes in two kinds: an entry per panel, door, settings section or
custom editor (a module exporting `mount(root, studio)`, in TypeScript, JSX or
JavaScript, importing its own files by relative paths), and a worker (`main`,
a module exporting `activate(studio)`, TypeScript with its types stripped by
Node, or JavaScript) that serves its commands, methods and tools and reaches
the host's services — chats of its own with the app's agents, Backlog reads
and writes, token usage, the person's own activity. Anything beyond content
runs only once the person approved it, and every call it makes into Studio is
checked against what they approved and against what whoever set the call off
may do (the `permissions` reference).

- Author against [`@sprintengine/extension-sdk`](../../packages/extension-sdk/README.md).
  The fastest start is a template:
  `npx -p @sprintengine/extension-sdk sprintengine-extension init my-extension --template panel`,
  or **Build your own extension** (the Extensions door, or the palette), which
  opens New chat in extension mode: name the extension, pick the project it goes
  in, describe it, and the project is scaffolded in `<project>/<name>` with a
  chat on it. Any agent Studio serves can do the same itself: `extension.create`
  makes the project, and `extension.guide` is the manual it builds from.
  Templates combine: `init … --with main,mcp,settings,door`, or
  `sprintengine-extension add <part>` in an existing project.
- **One strict manifest.** `extension.json` is validated by
  `validateExtensionManifest`, the same code in the app and the SDK. A key it
  does not know is refused at every level. `tier` (`content`, `declarative`,
  `ui`, `worker`) is the most authority the extension needs, and anything
  above it fails. `engines.studio` is the oldest Studio it runs on; an
  extension asking for a newer one than this app is refused with a message
  saying so — never shown as merely "waiting for approval". extension.json is read from
  Studio 0.13.0 (`EXTENSION_MANIFEST_SINCE`).
- **Surfaces bring their own drawing.** An entry runs in a sandboxed frame of
  its own with the files it imports by relative paths; a package by name is
  refused, so a library is copied into the extension or bundled by the author.
  Studio shares no React or UI kit with it. It styles with Studio's
  `--sem-*` CSS custom properties and calls `studio.ready()` once drawn, and
  Studio measures the time from opening to that call.
- **Commands without an `action` run worker code.** Studio calls the worker
  method of the command's name (access `operate`) with an
  `ExtensionCommandContext`: where it ran and what it was picked on. Menu items
  and top bar items run a contributed command, or a top bar item opens a
  contributed door.
- Test without the app. `@sprintengine/extension-sdk/testing` has fake hosts
  that keep this app's rules (the permissions it checks, storage's limits, chat
  ownership, the MCP tools extension.json declares); a scaffolded project's
  `npm run check` typechecks it, runs its TypeScript tests with `node --test`
  and runs `sprintengine-extension check`, which activates the worker against
  the fake host and loads each surface's modules as the app does. See the SDK
  README's "Testing".
- What runs is the Studio server's to change: Settings installs a folder,
  approves it, switches it on or off and uninstalls it through the server
  (`extension.install`, `extension.approve`, `extension.setEnabled`,
  `extension.uninstall`, each an owner's), and `extension.list` says what runs there
  and the methods each declares. Switching an extension off unloads its worker
  (its methods, tools, services and sidecars go, and its calls are refused
  `extension_unavailable`), and switching it back on activates it again.
  Keep state inside `activate`, and release timers, watchers and handles in
  `onShutdown`: once its shutdown hooks have run, the `studio` a
  switched-off extension was given drops its `emit` and `notify` calls and
  refuses every call to the host's services.
- Sign, verify and pack with the bundled `sprintengine-extension` CLI. `sign`
  writes `extension.sig` beside extension.json: the sha256 of every file the
  extension ships (extension.json included) and an ed25519 signature over
  them, so the signature covers the code and the declaration together.
- Install a folder from **Settings → Extensions**: Studio copies it to
  `~/.sprintengine/extensions/local.<id>/`. Symbolic links are left out of the
  copy, and Settings names them; a folder with `node_modules`, `.git` or key
  files in it is refused, and `pack` leaves those out. An install, an
  approval or an update loads live, worker and surfaces alike, with no
  restart of Studio.
- **Develop in a development folder.** A template's `npm run dev`
  (`sprintengine-extension dev watch`), `sprintengine-extension dev load
  <dir>`, or Settings → Extensions → Install → As a development folder
  registers a folder holding extension.json with the Studio on this machine.
  It loads from where it is, under `local.<id>`, after every installed
  extension and in the order the folders were registered (the order their
  hooks run in), and again within a moment of every save: its worker restarts
  on the new code and its surfaces redraw on every client. `node_modules`,
  `.git`, dotted files and folders and symbolic links in it are left out; it
  holds at most 2000 files and 50 MiB. Anyone on this machine, an agent
  included, may register one, but nothing runs from it until the person
  approves it in Studio's window, which asks them at once (or Settings →
  Extensions); every folder asks once. One whose key an installed extension
  has stands in for it only once the person approves that, and the installed
  one runs until then. The CLI's `dev watch` prints
  each reload, a check, a PNG of a surface (`shot`) and the worker's and
  frames' log lines at their file and line; the SDK guide's `dev-loop` topic
  is the reference.
- **Approval binds to access and contents.** An extension beyond content waits
  for the person to approve it, and an installed extension's approval binds to
  a fingerprint over its permissions, tier, worker and background and the
  digests of every file, so different bytes under the same install key never
  inherit it. A development folder's binds to its real path and its access,
  not its files: saves keep it, a save that asks for more asks again, and
  removing the folder forgets it. Settings marks it "Development folder", and
  its approval never covers the installed extension with its key, nor the
  other way round. An agent Studio launched cannot approve either. A new
  version installed through Studio keeps the approval when it asks for no
  more. An `extension.sig` is a badge (verified, by a publisher key Studio
  trusts) and approves nothing; a changed, missing or extra file after signing
  is refused as tampered.
- Ids starting `studio-` or `sprintengine-` install only from Studio's own
  catalogue.
- Permissions are install-time disclosure — see [permissions.md](./permissions.md).
- **What a person sees of an extension.** Each door is a row in the
  Extensions drawer. The worker's `notify` is a row in the bell of every
  window, under the extension's name, whose `target` opens one of its doors; a
  window that opens later files the rows it missed. A surface's `toast` is a
  transient report in the window's toast region. Notifications reach the
  windows through the same client bus as extension events, so they work
  unchanged when the server runs in a process of its own.
- **The worker runs in a Node process of its own**, forked by the Studio
  server, with no Electron APIs and a clean environment. It starts when something needs it and is
  stopped after five idle minutes, unless extension.json says
  `background: true`. Once packed it has no `node_modules`: the SDK comes from
  the Studio running it, and anything else is copied into the extension.

### Creating a workspace from the worker

A worker can create workspaces through the always-on core, the same flow the
UI uses:

```ts
import { WorkspaceServiceToken } from '@sprintengine/extension-sdk'

const workspaces = studio.requireService(WorkspaceServiceToken)
const result = await workspaces.create({ name: 'Scratch', folderPath: '/abs/path' })
// { ok: true, workspaceId } | { ok: false, code, message }
```

The promise resolves only after the workspace is confirmed on the
workspace-sync bus, so a returned id is always a real workspace. Declare
`workspace:operate`.

### Trusting your own key while developing

`resources/marketplace/trusted-publishers.dev.json` lets a contributor building
the app from source trust a key of their own. It has the same shape as
`trusted-publishers.json`, it is gitignored, and its fingerprints are unioned
into the trusted set **only when the app is not packaged**
(`src/main/marketplace/trusted-publishers.ts`). A packaged build never reads
it, and neither does the registry verifier (`npm run verify:marketplace-registry`
opens `trusted-publishers.json` by name), so a dev key can never become a
signing authority for anybody else.

```bash
# once
sprintengine-extension keygen --out ~/.sprintengine/keys/my-dev.key
# prints: Public key fingerprint: <fingerprint>

cat > resources/marketplace/trusted-publishers.dev.json <<'JSON'
{
  "schemaVersion": 1,
  "publishers": [
    {
      "name": "SprintEngine Labs",
      "verified": true,
      "publicKey": "<the public key the keygen printed>",
      "fingerprint": "<fingerprint>",
      "scope": "Local development only; never committed."
    }
  ]
}
JSON
```

Then sign the extension (`sprintengine-extension sign extension --key …`),
pack it (`sprintengine-extension pack extension`), install the packed copy,
and restart the app so it reads the dev key. A development folder's
signature is not read, so this is for an installed copy.

### Skills, MCP servers and model providers

An extension hands the person's agents and chats skills, MCP servers and model
providers with `contributes.skills`, `contributes.mcpServers` and
`contributes.providers` in its extension.json (the SDK guide's `manifest`
topic; the `agent-kit` template is a skill and a local MCP server). They are
declarative: no worker runs for them.

- **Skills** are folders holding a `SKILL.md`. Studio copies each into a
  folder of its own and hands it to agents at launch, in every workspace on the
  machine; nothing is written into a project. They ask for no approval and are
  listed when the extension is installed.
- **MCP servers** are a local command (`stdio`) each agent starts, or a hosted
  server (`http`) it reaches. A hosted one asks for nothing and is listed at
  install. A local one is approved once, at install, with its command,
  arguments and environment shown; an update that changes them, or the files
  of the extension they run, asks again, and until then the server is held
  back.
- **Model providers** are OpenAI-compatible endpoints chats can use. Each asks
  for approval once, naming the origin its key goes to; the key is entered in
  Settings, stored under `<publisher>.<id>/<provider id>`, never read from an
  environment variable, and sent to that origin only. An update that moves a
  provider to another origin asks again. A provider may not take the id of one
  of Studio's own.

An update that drops one of them takes it back from agents, and an uninstall
takes back everything the extension handed them, the keys entered for its
providers included.

Its worker can also serve MCP tools of its own through `contributes.mcpTools`
and `registerMcpTools`, and put one of Studio's own skills in a workspace with
`ensureSkillInstalled`.

Agent CLIs (`kind: "cli"`) ship with the app, and their manifest contract is
the app's own (`src/shared/cli-plugin-manifest.ts`), not part of the SDK.
