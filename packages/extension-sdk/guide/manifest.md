# extension.json

`extension/extension.json` is the extension: what it is, what it adds to
Studio, and the most authority it needs. Every path in it is relative to the
folder that holds it, `extension/`, which is the folder Studio loads as a
development folder and the folder you pack.

One validator reads it, the same one in Studio, the `sprintengine-extension`
CLI and the project's scripts: `validateExtensionManifest(raw, { authoring })`
from `@sprintengine/extension-sdk`. It is strict. A key it does not know is
refused, at every level, so nothing reaches the install review that Studio
does not read. `npx sprintengine-extension validate extension` (`npm run
validate`) runs it the way an author should (`authoring: true`), and checks
the files it names too.

Nothing writes extension.json but you, and it changes only when you change
it. In a development folder a save to it reloads the extension like any other
file.

## A whole manifest

```json
{
  "$schema": "../node_modules/@sprintengine/extension-sdk/extension.schema.json",
  "manifestVersion": 1,
  "id": "notes",
  "version": "1.0.0",
  "engines": { "studio": ">=0.13.0" },
  "tier": "worker",
  "name": "Notes",
  "description": "A scratchpad beside your work.",
  "permissions": ["storage:own"],
  "main": "src/main.ts",
  "contributes": {
    "commands": [
      { "id": "notes.clear", "title": "Clear notes" },
      { "id": "notes.show-backlog", "title": "Show the Backlog", "action": "panel.backlog.toggle" }
    ],
    "menus": [{ "where": "backlog.item", "command": "notes.clear" }],
    "panels": [{ "id": "notes", "title": "Notes", "icon": "notes", "entry": "src/notes.ts" }]
  }
}
```

`$schema` is for your editor: the SDK ships the JSON Schema as
`@sprintengine/extension-sdk/extension.schema.json`. Studio ignores the key.

## Tiers

`tier` says the most authority the extension needs. Each tier carries what the
ones below it do; a field or a contribution above the tier fails validation.

| Tier          | What it may carry                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content`     | Its name and images, and content Studio draws itself: syntaxes, keybindings, status bar items and settings. Nothing that runs, so it installs without an approval prompt.             |
| `declarative` | Commands that run Studio's own commands (`action`), menu items and top bar items for them, and the skills, MCP servers and model providers it hands agents and chats. No permissions. |
| `ui`          | Panels, doors and settings sections drawn by its own code, and permissions.                                                                                                           |
| `worker`      | `main`: code that runs in the background, serves commands without an `action`, methods and MCP tools.                                                                                 |

Pick the lowest tier that does the job. The install review says what the tier
means, and a lower tier asks less of the person. `requiredExtensionTier(manifest)`
answers the least tier a manifest needs.

## Contributions

- **`commands`** are palette entries. One with an `action` runs that Studio
  command and no extension code. One without needs the worker tier: running it
  calls the worker method of the same name, declared with `registerMethods`
  and access `operate`, with an `ExtensionCommandContext` as its params.
- **`menus`** put a contributed command in a Backlog item's menu
  (`backlog.item`), a file's menu in the Files tree (`file`), or the menu of
  one of the extension's own notifications (`notification`). The command's
  title is the item's label; the context says what it was picked on.
- **`topBarItems`** are buttons in the top bar. Each runs a contributed
  `command` or opens a contributed `door`, never both.
- **`panels`**, **`doors`**, **`settingsSections`** and **`customEditors`** are drawn by the
  extension. Each names an `entry`: a module exporting `mount(root, studio)`,
  loaded as written with the files it imports by relative paths (the `rules`
  topic). A panel is a tab in a workspace's pane, offered by the
  pane's + menu. A door is a full-window surface with a row in the Extensions
  drawer. A settings section sits in Settings.
- **`customEditors`** open the person's files of a type in the extension's
  own editor, drawn in a frame in the file's tab like a panel. An editor names
  the file-name suffixes (`extensions`, with the dot) and exact file names
  (`filenames`) it takes, ignoring case: a name beats any suffix, a longer
  suffix a shorter one, and a file named only the suffix never matches. With
  `priority: "default"` (the default) a matching file opens in it from the
  Files tree, an agent's `editor.open` or a link in a chat; with `"option"` it
  opens in Studio's text editor and the editor is offered under Open with.
  A file Studio's own editor has a language for (`.json`, `.ts`, `.py`,
  `.md`, `package.json` and the like, by its last suffix) or shows as an
  image is only ever offered, whatever the priority and whether the editor
  names it by suffix or by name, so installing an extension never changes how
  a person's code opens. The person can always reopen the file in the text
  editor, and back. Its
  `entry`'s `mount` gets `studio.document`: the file as text, or as raw bytes
  with `contentKind: "bytes"`, never its path. Studio keeps the unsaved state,
  saves the file (its Save, or Cmd/Ctrl+S in the editor), and watches it on
  disk. A file of more than 1 MiB of text, or 768 KiB of bytes, does not open
  in a custom editor: a save is one request to the Studio, and bytes travel in
  base64. Needs the `workspace-files:read` permission, and
  `workspace-files:write` to save; without it the file opens read only. A new
  editor, or one that takes more files, is asked for again when the extension
  updates. See the `api-renderer` topic.
- **`mcpTools`** are tools agents reach through Studio's MCP server. Declare
  each one here, with what agents are told it does and whether it changes
  anything; the worker serves them with `registerMcpTools`. A tool the worker
  registers that is not declared is refused, and the declaration's words win.
  Each names its parameters in `inputSchema` (required): agents see them
  before the worker has ever run, and the schema the worker registers must
  take no more than it. Needs the `tools:contribute` permission.

- **`syntaxes`** highlight a language with a TextMate grammar (JSON, at most
  1 MiB), the format code editors and highlighters share, so one grammar
  serves more than one app. A chat code block fenced with the syntax's `id`,
  or one of its `extensions` without the dot, is highlighted with it, and so
  is a file the editor opens whose name is in `filenames` or ends in one of
  `extensions` (the longest suffix wins, a name wins over any suffix). It adds
  languages and never replaces one: a fence, an alias or a suffix Studio's own
  grammars already highlight stays Studio's. `configuration` (at most 64 KiB)
  gives the editor comment markers, brackets, auto-closing and surrounding
  pairs. Studio keeps only the keys a TextMate engine reads, and refuses a
  grammar whose `scopeName` differs from the entry's, that includes a `#name`
  no repository holds, or whose includes expand to more than 10,000 rules; an
  include of another scope (an embedded `source.js`) is allowed and stays
  plain. Each extension's grammars run in a registry of their own, in a worker
  apart from the window, so a scope name never stands in for Studio's or
  another extension's. Lines are coloured in slices of 400, and loading
  the grammar and each slice have a budget (a slice has a second in chat, a
  second and a half in the editor): past it the worker is stopped, the code
  stays plain, and the extension's highlighting stays off until the window
  reloads. The worker's own start never counts against a grammar. Code is
  coloured by what each token is (comment, keyword, string, number, function,
  type), in the active theme's colours.
- **`keybindings`** bind a key chord to a command: one the extension
  contributes, or one of Studio's own command actions (the list under the
  reference), which a content extension may bind with no code. `Mod` is Cmd on
  macOS and Ctrl elsewhere. A chord the system or the browser keeps (copy,
  paste, cut, select all, undo and redo, find, print, save, quit, close,
  reload, a new window or tab, zoom, `F5`, `F11`, `F12`, developer tools) is
  refused, and one Studio's own shortcuts already use is not bound. The
  binding is listed under the extension in Settings ▸ Shortcuts, where the
  person can change or remove it; its `when` holds for that binding alone.
- **`statusBarItems`** are short labels (text, an icon or both) in the
  window's band beside the top bar items, with a tooltip. One with a `command`
  runs it when pressed: the extension's own, or one of Studio's actions.
- **`settings`** declare settings Studio draws itself, in a section of
  Settings named for the extension: text (one line or several), a number, a
  whole number, true or false, or a choice from `enum`. Each value lives on
  the Studio the extension is installed on, so every window shows the same
  one and an open Settings page follows changes made anywhere, and Studio
  refuses a value outside what the setting declares, from Settings and from
  the extension's own code alike. The extension's code reads them with the
  `settings:own` permission: `settings.get` in a frame, `getModuleAppState` in
  a worker. A setting reads as its stored value while that fits the
  declaration, else as its `default`, the same for Settings and for code, so
  a value kept from before an update narrowed the setting falls back. Studio
  shows and changes the values only on a connection allowed to change its
  settings; elsewhere the section is read only. The extension's own frame
  reads them for anyone who may open it, since an extension needs its
  configuration to draw itself, and what it shows of them is the extension's
  responsibility; a frame's `settings.set` changes one only for someone who
  holds `settings:write`. Settings has a "Reset to default" for each setting.

- **`skills`**, **`mcpServers`** and **`providers`** are what the extension
  hands the person's agents and chats, in every workspace on the machine. They
  are declarative: no worker runs for them. Studio copies each skill into a
  folder of its own and hands it to agents at launch, gives agents each MCP
  server beside the person's own, and lists each provider in the model
  picker; nothing is written into a project. An update that drops one takes it
  back, and an uninstall takes back all of them.
  - A skill names a `path`: a folder holding its `SKILL.md` and the files it
    names. No approval is asked for it; it is listed when the extension is
    installed. Studio's copy is named `x<8 hex>-<skill id>`, such as
    `x1f2e3d4c-review`, in its folder's name and in its `SKILL.md`'s `name`:
    the hex is of a hash of the install key, so two extensions' skills of one
    name, or one of the person's own, never collide, and the name keeps to the
    Agent Skills rule (lowercase letters, digits and single hyphens, at most
    64 characters; a long skill id is cut). Codex, Grok, OpenCode and Cursor
    list it by that name; Claude Code lists it under the extension's plugin,
    as `<publisher>--<id>:x<8 hex>-<skill id>`. The copy's frontmatter keeps only
    `name` and `description`: a skill is words for agents, so a key that
    grants tools or runs commands (`allowed-tools`, `hooks`, any other) is
    dropped, and the install review lists it as ignored.
  - An MCP server is `stdio`, a command each agent starts on this machine
    (`command`, `args`, and `env` as `{ "name", "value" }` pairs, values as
    written: Studio reads none from its own environment), or `http`, a hosted
    server agents reach at `url`. `${extensionPath}` in a command, an argument
    or an environment value (never a `url`) stands for the extension's folder (the installed copy, or the
    development folder itself):
    `"command": "node", "args": ["${extensionPath}/src/server.mjs"]`. Agents
    see the server as `<publisher>_<id>_<server id>`. A hosted server asks
    for no approval. A local one is approved at install with its command,
    arguments and environment shown, and is bound to them and to every file
    the extension ships (all of them but extension.sig: Studio cannot tell
    which files a command reads), so an update that changes any of them asks
    again; until then agents do not get it.
  - A provider is an OpenAI-compatible endpoint: `baseUrl` (https, or plain
    http to localhost), the paths joined after its own path
    (`chatCompletionsPath`, by default `/v1/chat/completions`, and
    `modelsPath` for a live model list: a base of
    `https://api.example.com/openai` and `/v1/chat/completions` call
    `https://api.example.com/openai/v1/chat/completions`), the
    `models` to offer, and `apiKey` when it takes a key. Studio knows it as
    `<publisher>.<id>/<provider id>` and keeps its key under that id. The person
    enters the key in Settings; it is never read from an environment variable,
    and it is sent to `baseUrl`'s origin only: a path that would leave it fails
    validation, and a redirect is refused. A provider asks for approval once,
    naming that origin, and again when an update moves it to another. It may
    not take the id of one of Studio's own providers or agents.

Every point defaults to empty. The points held for later formats (themes,
fonts, agent providers run by an extension's own code and the rest, listed
under the reference) must be empty or absent.

## Ids and install keys

`id` is kebab-case, at most 63 characters. Studio installs an extension under
`<publisher>.<id>`: the publisher comes from where it was installed from, and
a folder install is `local`, so a packed copy installed from a folder lands
in `~/.sprintengine/extensions/local.<id>/`. A development folder loads under
the same key, `local.<id>`, from where it is. The install key is what
`studio.moduleId` answers and what storage and approval are keyed by, so never
change `id` after you release. Ids starting `studio-` or `sprintengine-` install
only from Studio's own catalogue.

## Versions

`version` is the extension's own semver. Raise it with every release.

`engines.studio` is the oldest Studio it runs on, as `>=x.y.z`. Every field in
the reference below has a "Since": the first Studio that reads it. With
`authoring: true` (the scripts, the CLI) the validator holds `engines.studio`
to the newest "Since" of the fields you use, so a manifest never asks a Studio
for something it cannot read. extension.json is read from Studio 0.13.0
(`EXTENSION_MANIFEST_SINCE`), so `>=0.13.0` is the floor.

What a running Studio provides beyond the manifest, such as a service whose
providing module is off, is `studio.supports(name)`: ask before relying on it.

## Paths

`main`, each `entry`, `icon`, `cover` and `screenshots` are paths relative to
`extension/`, with `/` between folders. A path that leaves the folder (`..`),
starts at the root, uses a backslash or a drive letter, or names a Windows
device (`CON`, `NUL`, …) is refused. A surface's `entry` ends in `.js`,
`.mjs`, `.ts`, `.mts`, `.tsx` or `.jsx`; `main` in `.js`, `.cjs`, `.mjs`,
`.ts`, `.mts` or `.cts`. TypeScript and JSX load as written (the `rules`
topic).

## Signing

A signature is a file beside the manifest, `extension/extension.sig`, written
by `sprintengine-extension sign`. It holds the sha256 of every file in the
folder (extension.json included, extension.sig left out), the signer's public
key and an ed25519 signature over those digests. The `publishing` topic has the
rest.

## Reference

Generated from the validator's own field table; do not edit between the
markers.

<!-- generated:extension-manifest-reference:start -->

| Field | Type | Required | Since | Tier | Description |
|---|---|---|---|---|---|
| `$schema` | string |  | 0.13.0 |  | JSON Schema URL for editor completion. Studio ignores it. |
| `manifestVersion` | `1` | yes | 0.13.0 |  | The manifest format. Always `1`. |
| `id` | string | yes | 0.13.0 |  | Extension id, kebab-case. Studio installs it under `<publisher>.<id>`, the publisher derived from where it came from (`local` for a folder). Ids starting `studio-` or `sprintengine-` install only from Studio’s own catalogue. |
| `version` | string | yes | 0.13.0 |  | The extension’s version, semver. |
| `engines` | object | yes | 0.13.0 |  | The Studio versions it runs on. |
| `engines.studio` | string | yes | 0.13.0 |  | The oldest Studio it runs on, as `>=x.y.z`: at least the newest “since” of any field it uses. |
| `tier` | `content` \| `declarative` \| `ui` \| `worker` | yes | 0.13.0 |  | The most authority it needs, least first: `content` (syntaxes, keybindings, status bar items, settings: data Studio draws, no approval asked), `declarative` (commands, menus, top bar items, and the skills, MCP servers and model providers it hands agents and chats), `ui` (panels, doors, settings sections, custom editors, drawn by its own code), `worker` (`main`, running in the background). Each carries what the ones below it do; a contribution above it fails validation. |
| `name` | string | yes | 0.13.0 |  | Display name. |
| `description` | string |  | 0.13.0 |  | One or two sentences shown with the name. |
| `icon` | string |  | 0.13.0 |  | A square image shown beside the name. |
| `cover` | string |  | 0.13.0 |  | A wide image for its listing. |
| `screenshots` | string[] (at most 8) |  | 0.13.0 |  | Images of it at work, for its listing. |
| `license` | string |  | 0.13.0 |  | Its licence, as an SPDX expression. |
| `repository` | string |  | 0.13.0 |  | Where its source lives. |
| `homepage` | string |  | 0.13.0 |  | Its home page. |
| `permissions` | `workspace:read` \| `workspace:operate` \| `conversation:read` \| `backlog:read` \| `backlog:operate` \| `providers:read` \| `usage:read` \| `workspace-files:read` \| `workspace-files:write` \| `storage:own` \| `settings:own` \| `secrets:own` \| `notifications:show` \| `conversation:own` \| `conversation:bypass` \| `chat:draft` \| `schedules:own` \| `agents:generate` \| `agents:companion` \| `github:api` \| `tools:contribute` \| `terminals:send` \| `terminals:read`[] (at most 32) |  | 0.13.0 | ui | What it asks the person to allow. `content` and `declarative` extensions hold none. |
| `main` | string |  | 0.13.0 | worker | The worker’s entry: a module (`.js`, `.mjs`, `.cjs`, or `.ts`, `.mts`, `.cts` loaded as written) whose `activate(studio)` (its default export, or a named `activate`) registers what it serves. Worker tier only, and required by it. |
| `background` | boolean |  | 0.13.0 | worker | `true` keeps the worker running while the extension is on. |
| `contributes` | object |  | 0.13.0 |  | What it adds to Studio. Every point defaults to empty. |
| `contributes.commands` | object[] (at most 256) |  | 0.13.0 | declarative | Command palette entries. |
| `contributes.commands[].id` | string | yes | 0.13.0 |  | Command id, unique among this extension’s commands. Without `action`, running the command calls the worker method of this name (`registerMethods`, access `operate`). |
| `contributes.commands[].title` | string | yes | 0.13.0 |  | Title in the command palette and in menus. |
| `contributes.commands[].when` | `global` \| `workspace` |  | 0.13.0 |  | Where the command is offered. `workspace` hides it while no workspace is open. Defaults to `global`. |
| `contributes.commands[].action` | `app.settings.open` \| `commandPalette.open` \| `search.everywhere` \| `search.goToFile` \| `chat.new` \| `workspace.history.back` \| `workspace.history.forward` \| `workspace.sidebar.toggle` \| `panel.files.toggle` \| `panel.editor.toggle` \| `panel.git.toggle` \| `panel.backlog.toggle` \| `git.refresh` \| `git.fetch` \| `terminal.new` \| `usage.show` |  | 0.13.0 |  | A Studio command this command runs. A command with an `action` is declarative and runs no extension code; one without needs the worker tier. |
| `contributes.menus` | object[] (at most 64) |  | 0.13.0 | declarative | Items in Studio’s own menus. |
| `contributes.menus[].where` | `backlog.item` \| `file` \| `notification` | yes | 0.13.0 |  | The menu: a backlog item’s, a file’s in the Files tree, or one of this extension’s own notifications. |
| `contributes.menus[].command` | string | yes | 0.13.0 |  | A command this extension contributes. Its title is the menu item’s label, and it runs with the item it was picked on. |
| `contributes.topBarItems` | object[] (at most 8) |  | 0.13.0 | declarative | Buttons in the top bar. |
| `contributes.topBarItems[].id` | string | yes | 0.13.0 |  | Id, unique among this extension’s top bar items. |
| `contributes.topBarItems[].title` | string | yes | 0.13.0 |  | The button’s name and tooltip. |
| `contributes.topBarItems[].icon` | `extension` \| `chat` \| `branch` \| `folder` \| `schedule` \| `spark` \| `lock` \| `settings` \| `check` \| `warning` \| `copy` \| `notes` |  | 0.13.0 |  | The button’s glyph. Defaults to `extension`. |
| `contributes.topBarItems[].command` | string |  | 0.13.0 |  | A contributed command the button runs. Give `command` or `door`, not both. |
| `contributes.topBarItems[].door` | string |  | 0.13.0 |  | A contributed door the button opens. |
| `contributes.panels` | object[] (at most 16) |  | 0.13.0 | ui | Pane tabs, offered by the pane’s + menu. |
| `contributes.panels[].id` | string | yes | 0.13.0 |  | Id, unique within this point. |
| `contributes.panels[].title` | string | yes | 0.13.0 |  | What Studio calls it. |
| `contributes.panels[].icon` | `extension` \| `chat` \| `branch` \| `folder` \| `schedule` \| `spark` \| `lock` \| `settings` \| `check` \| `warning` \| `copy` \| `notes` |  | 0.13.0 |  | Glyph beside the title. Defaults to `extension`. |
| `contributes.panels[].entry` | string | yes | 0.13.0 |  | What the panel draws, as a tab in a workspace’s pane. A module (`.js`, `.mjs`, or `.ts`, `.mts`, `.tsx`, `.jsx` loaded as written) whose `mount(root, studio)` draws into `root` and may return a cleanup function; it imports only its own files, by relative paths. |
| `contributes.doors` | object[] (at most 8) |  | 0.13.0 | ui | Full-window surfaces, opened from the Extensions drawer. |
| `contributes.doors[].id` | string | yes | 0.13.0 |  | Id, unique within this point. |
| `contributes.doors[].title` | string | yes | 0.13.0 |  | What Studio calls it. |
| `contributes.doors[].icon` | `extension` \| `chat` \| `branch` \| `folder` \| `schedule` \| `spark` \| `lock` \| `settings` \| `check` \| `warning` \| `copy` \| `notes` |  | 0.13.0 |  | Glyph beside the title. Defaults to `extension`. |
| `contributes.doors[].entry` | string | yes | 0.13.0 |  | What the door draws when it is open. A module (`.js`, `.mjs`, or `.ts`, `.mts`, `.tsx`, `.jsx` loaded as written) whose `mount(root, studio)` draws into `root` and may return a cleanup function; it imports only its own files, by relative paths. |
| `contributes.settingsSections` | object[] (at most 4) |  | 0.13.0 | ui | Sections in Settings. |
| `contributes.settingsSections[].id` | string | yes | 0.13.0 |  | Id, unique within this point. |
| `contributes.settingsSections[].title` | string | yes | 0.13.0 |  | What Studio calls it. |
| `contributes.settingsSections[].icon` | `extension` \| `chat` \| `branch` \| `folder` \| `schedule` \| `spark` \| `lock` \| `settings` \| `check` \| `warning` \| `copy` \| `notes` |  | 0.13.0 |  | Glyph beside the title. Defaults to `extension`. |
| `contributes.settingsSections[].entry` | string | yes | 0.13.0 |  | What the section draws in Settings. A module (`.js`, `.mjs`, or `.ts`, `.mts`, `.tsx`, `.jsx` loaded as written) whose `mount(root, studio)` draws into `root` and may return a cleanup function; it imports only its own files, by relative paths. |
| `contributes.syntaxes` | object[] (at most 16) |  | 0.13.0 | content | Syntax highlighting for a language, in chat code blocks and the editor. |
| `contributes.syntaxes[].id` | string | yes | 0.13.0 |  | Language id, unique among this extension’s syntaxes. A chat code block whose fence names it (```gleam), or one of its extensions without the dot, is highlighted with it. |
| `contributes.syntaxes[].title` | string | yes | 0.13.0 |  | The language’s name. |
| `contributes.syntaxes[].scopeName` | string | yes | 0.13.0 |  | The grammar’s root scope, unique among this extension’s syntaxes; the grammar file’s own `scopeName` must match. |
| `contributes.syntaxes[].path` | string | yes | 0.13.0 |  | A TextMate grammar in JSON, at most 1 MiB. Keys a TextMate engine does not read are dropped; every `#name` it includes must name a rule in a repository. |
| `contributes.syntaxes[].configuration` | string |  | 0.13.0 |  | A language configuration, at most 64 KiB: `comments`, `brackets`, `autoClosingPairs` and `surroundingPairs`, which the editor reads. |
| `contributes.syntaxes[].extensions` | string[] (at most 32) |  | 0.13.0 |  | File-name suffixes the editor opens in this language, ignoring case. A longer suffix wins over a shorter one, and one of Studio’s own languages that drives completions (TypeScript, JavaScript, JSON, CSS, SCSS, Less, HTML, Markdown) is never replaced. |
| `contributes.syntaxes[].filenames` | string[] (at most 32) |  | 0.13.0 |  | Exact file names the editor opens in this language, ignoring case; a name wins over any suffix. |
| `contributes.customEditors` | object[] (at most 16) |  | 0.13.0 | ui | Editors for files of a type, drawn in the file’s tab. Needs the `workspace-files:read` permission, and `workspace-files:write` to save; without it the file opens read only. |
| `contributes.customEditors[].id` | string | yes | 0.13.0 |  | Id, unique among this extension’s editors. |
| `contributes.customEditors[].title` | string | yes | 0.13.0 |  | Its name, in the editor’s Open with menu. |
| `contributes.customEditors[].icon` | `extension` \| `chat` \| `branch` \| `folder` \| `schedule` \| `spark` \| `lock` \| `settings` \| `check` \| `warning` \| `copy` \| `notes` |  | 0.13.0 |  | Glyph beside its name. Defaults to `extension`. |
| `contributes.customEditors[].entry` | string | yes | 0.13.0 |  | What the editor draws, in a frame of its own in the file’s tab: a `.js` or `.mjs` module whose `mount(root, studio)` draws into `root`. Its `studio.document` holds the file’s content and takes its edits; Studio keeps the unsaved state, saves and watches the file, and the frame never gets a path. |
| `contributes.customEditors[].extensions` | string[] (at most 32) |  | 0.13.0 |  | File-name suffixes it opens, with the dot, ignoring case. A longer suffix (`.todo.json`) wins over a shorter one (`.json`), and a file named only the suffix never matches. Give `extensions`, `filenames` or both. |
| `contributes.customEditors[].filenames` | string[] (at most 32) |  | 0.13.0 |  | Exact file names it opens, ignoring case; a name wins over any suffix. |
| `contributes.customEditors[].priority` | `default` \| `option` |  | 0.13.0 |  | `default` (the default) opens matching files in this editor; `option` opens them in Studio’s text editor and offers this one under Open with. A file Studio’s own editor has a language for (`.json`, `.ts`, `.py`, `.md`, `package.json` and the like) or shows as an image is always `option`, whether the editor names it by suffix or by name, so installing an extension never changes how a person’s code opens. Either way the person can reopen the file in the text editor. |
| `contributes.customEditors[].contentKind` | `text` \| `bytes` |  | 0.13.0 |  | `text` (the default) hands the editor the file as UTF-8 text and takes whole-text edits; `bytes` hands it the raw bytes, for a binary format, and takes whole-byte edits. |
| `contributes.keybindings` | object[] (at most 64) |  | 0.13.0 | content | Keyboard shortcuts. |
| `contributes.keybindings[].command` | string | yes | 0.13.0 |  | The command the key runs. Either a command this extension contributes in `contributes.commands`, or one of Studio’s own command actions (listed below), which a content extension may bind without any code. |
| `contributes.keybindings[].key` | string | yes | 0.13.0 |  | The key chord: modifiers and one key joined by `+`. `Mod` is Cmd on macOS and Ctrl elsewhere. It can be changed or removed in Settings ▸ Shortcuts like any of Studio’s. |
| `contributes.keybindings[].when` | `global` \| `workspace` |  | 0.13.0 |  | Where the key works. `workspace` only while a workspace is open. Defaults to `global`. |
| `contributes.statusBarItems` | object[] (at most 8) |  | 0.13.0 | content | Short status items, shown in the window’s band beside the top bar. |
| `contributes.statusBarItems[].id` | string | yes | 0.13.0 |  | Id, unique among this extension’s status bar items. |
| `contributes.statusBarItems[].text` | string |  | 0.13.0 |  | A short label. Give `text`, `icon` or both. |
| `contributes.statusBarItems[].icon` | `extension` \| `chat` \| `branch` \| `folder` \| `schedule` \| `spark` \| `lock` \| `settings` \| `check` \| `warning` \| `copy` \| `notes` |  | 0.13.0 |  | A glyph before the text. |
| `contributes.statusBarItems[].tooltip` | string |  | 0.13.0 |  | Shown on hover. Defaults to the extension’s name. |
| `contributes.statusBarItems[].command` | string |  | 0.13.0 |  | The command pressing the item runs. Without one, the item only shows. Either a command this extension contributes in `contributes.commands`, or one of Studio’s own command actions (listed below), which a content extension may bind without any code. |
| `contributes.settings` | object[] (at most 64) |  | 0.13.0 | content | Settings Studio shows under the extension in Settings, with no code of its own; the extension’s code reads their values with `settings:own`. |
| `contributes.settings[].key` | string | yes | 0.13.0 |  | The key its value is read under (`settings.get` in a frame, `getModuleAppState` in a worker, both with `settings:own`). |
| `contributes.settings[].title` | string | yes | 0.13.0 |  | Its label in Settings. |
| `contributes.settings[].description` | string |  | 0.13.0 |  | Help shown under the label. |
| `contributes.settings[].type` | `string` \| `number` \| `integer` \| `boolean` | yes | 0.13.0 |  | The value’s type. |
| `contributes.settings[].default` | string \| number \| boolean |  | 0.13.0 |  | The value read while the person has set none; of `type`. |
| `contributes.settings[].enum` | string \| number \| boolean[] (at most 64) |  | 0.13.0 |  | The values allowed, of `type`; Settings shows a picker. |
| `contributes.settings[].enumLabels` | string[] (at most 64) |  | 0.13.0 |  | The picker’s labels, one per `enum` value. |
| `contributes.settings[].minimum` | number |  | 0.13.0 |  | Numbers: the smallest value. |
| `contributes.settings[].maximum` | number |  | 0.13.0 |  | Numbers: the largest value. |
| `contributes.settings[].maxLength` | integer |  | 0.13.0 |  | Strings: the most characters. Defaults to 4096. |
| `contributes.settings[].multiline` | boolean |  | 0.13.0 |  | Strings: a box of several lines. |
| `contributes.settings[].placeholder` | string |  | 0.13.0 |  | Strings and numbers: a hint shown while empty. |
| `contributes.mcpTools` | object[] (at most 64) |  | 0.13.0 | worker | Tools agents reach through Studio’s MCP server. Needs the `tools:contribute` permission. |
| `contributes.mcpTools[].name` | string | yes | 0.13.0 |  | The tool’s name on Studio’s MCP server. The worker serves it with `registerMcpTools`; a tool it registers that is not declared here is refused. |
| `contributes.mcpTools[].description` | string | yes | 0.13.0 |  | What agents are told the tool does. |
| `contributes.mcpTools[].access` | `read` \| `operate` | yes | 0.13.0 |  | `read` changes nothing; `operate` may, and agents are asked before it runs where their settings say so. |
| `contributes.mcpTools[].inputSchema` | JSON Schema object | yes | 0.13.0 |  | The tool’s parameters, as a JSON Schema for an object: what agents see, before the worker has ever run. The schema the worker registers must take no more than this one (no parameter it leaves out, none it requires dropped). A tool that takes none says `{ "type": "object", "properties": {} }`. |
| `contributes.hooks` | object[] (at most 8) |  | 0.13.0 | worker | Hooks the worker runs before (or after) Studio acts: Studio calls them in order, the installed extensions by install key and then the development folders in the order they were registered, waiting at most 2 s on each. The approval names each point in plain words, and an update that adds one asks again. |
| `contributes.hooks[].point` | `agent.launch.before` \| `agent.prompt.before` \| `agent.tool.before` \| `agent.tool.after` \| `terminal.write.before` \| `workspace.create.before` \| `workspace.create.after` \| `editor.save.before` | yes | 0.13.0 |  | Where Studio asks the worker, which serves it with `registerHooks`. A `.before` point may refuse or change what Studio is about to do; an `.after` point only hears what it did. The guide’s hooks topic says what each one carries. |
| `contributes.hooks[].onError` | `pass` \| `deny` |  | 0.13.0 |  | What a failed hook does: one that throws, answers after 2 s, answers something else, or whose worker crashed or did not start. `pass` (the default) lets the action go on as if it had passed; `deny` refuses it, naming the extension, so a guard fails closed. Ignored for an `.after` point. |
| `contributes.events` | object[] (at most 5) |  | 0.13.0 | worker | Events Studio delivers to the worker, at most 5. A worker that is not running is started to hear one. Each event needs its permission, and an extension switched off, stopped or not approved as it is hears none. |
| `contributes.events[].on` | `workspace.created` \| `workspace.removed` \| `agent.status.changed` \| `workspace.changed` | yes | 0.13.0 |  | The event the worker hears, with `studio.events.on(event, handler)`. Each needs the permission the guide’s events topic names for it: `workspace:read` for the workspace events, `conversation:read` for `agent.status.changed`. |
| `contributes.skills` | object[] (at most 64) |  | 0.13.0 | declarative | Skills the person’s agents can use, in every workspace on this machine. Studio copies each into a folder of its own and hands it to agents at launch; it never writes into a project. Listed when the extension is installed; no approval is asked for them. |
| `contributes.skills[].id` | string | yes | 0.13.0 |  | Id, unique among this extension’s skills. Agents are handed a copy named `x<8 hex of a hash of the install key>-<skill id>`, its frontmatter holding only `name` and `description`. |
| `contributes.skills[].path` | string | yes | 0.13.0 |  | A folder holding the skill: its `SKILL.md` (at most 256 KiB) and any files it names, 256 files at most. |
| `contributes.mcpServers` | object[] (at most 16) |  | 0.13.0 | declarative | MCP servers the person’s agents get, in every workspace on this machine. A `stdio` server’s command, arguments, environment and the extension’s files are part of what the person approves at install, so an update that changes any of them asks again; an `http` server is listed when the extension is installed and asks nothing. |
| `contributes.mcpServers[].id` | string | yes | 0.13.0 |  | Id, unique among this extension’s servers. Agents see the server as `<publisher>_<id>_<server id>`. |
| `contributes.mcpServers[].name` | string | yes | 0.13.0 |  | Its name, for the person. |
| `contributes.mcpServers[].description` | string |  | 0.13.0 |  | What it gives agents, in a sentence. |
| `contributes.mcpServers[].transport` | `stdio` \| `http` | yes | 0.13.0 |  | `stdio`: a local command each agent starts, with `command`. `http`: a hosted server agents reach at `url`. |
| `contributes.mcpServers[].command` | string |  | 0.13.0 |  | What a `stdio` server runs: a program on the PATH, such as `node` or `npx`, or a file the extension ships, as `${extensionPath}/bin/server`. |
| `contributes.mcpServers[].args` | string[] (at most 64) |  | 0.13.0 |  | Its arguments. `${extensionPath}` stands for the extension’s installed folder. |
| `contributes.mcpServers[].env` | object[] (at most 32) |  | 0.13.0 |  | Environment variables the command runs with, shown on the install review. |
| `contributes.mcpServers[].env[].name` | string | yes | 0.13.0 |  | The variable’s name. |
| `contributes.mcpServers[].env[].value` | string | yes | 0.13.0 |  | Its value, as written: Studio reads none from its own environment, and a value naming a variable (`${…}`, `{env:…}`) is refused, since an agent would fill it in from the person’s machine. `${extensionPath}` stands for the installed folder. |
| `contributes.mcpServers[].url` | string |  | 0.13.0 |  | Where an `http` server is: `https`, or plain `http` to localhost. It names no variable (`${…}`, `{env:…}`): an agent would fill one in from the person’s machine. Nor `${extensionPath}`: a hosted server is not in the extension’s folder. |
| `contributes.providers` | object[] (at most 8) |  | 0.13.0 | declarative | Model providers for chats: OpenAI-compatible endpoints. The person approves each at install, seeing the origin its key goes to; an update that adds one or moves it to another origin asks again. |
| `contributes.providers[].id` | string | yes | 0.13.0 |  | Id, unique among this extension’s providers. Studio knows it, and keeps its key, as `<publisher>.<id>/<provider id>`. |
| `contributes.providers[].name` | string | yes | 0.13.0 |  | Its name in the model picker. |
| `contributes.providers[].baseUrl` | string | yes | 0.13.0 |  | The OpenAI-compatible API’s base: `https`, or plain `http` to localhost. Its key is sent to this origin and no other, and the install review names it. A path on it is kept: the request paths are joined after it, so `https://api.example.com/openai` and `/v1/chat/completions` make `https://api.example.com/openai/v1/chat/completions`. |
| `contributes.providers[].chatCompletionsPath` | string |  | 0.13.0 |  | The chat completions path, joined after `baseUrl`’s own path. Defaults to `/v1/chat/completions`. |
| `contributes.providers[].modelsPath` | string |  | 0.13.0 |  | A models path, joined after `baseUrl`’s own path, answering `{ data: [{ id }] }`, for the picker to list what the endpoint offers now. |
| `contributes.providers[].models` | object[] (at most 64) | yes | 0.13.0 |  | Models to offer, the first being the default. At least one. |
| `contributes.providers[].models[].id` | string | yes | 0.13.0 |  | The model id the endpoint takes. |
| `contributes.providers[].models[].name` | string |  | 0.13.0 |  | Its name in the picker. |
| `contributes.providers[].apiKey` | object |  | 0.13.0 |  | The provider takes an API key, entered in Settings and sent as a bearer token. Never read from an environment variable. |
| `contributes.providers[].apiKey.label` | string | yes | 0.13.0 |  | What the key is called where the person enters it, in Settings. |

Reserved, and must be empty for now: `contributes.themes`, `contributes.terminalThemes`, `contributes.iconThemes`, `contributes.fonts`, `contributes.snippets`, `contributes.newFiles`, `contributes.sidecars`, `contributes.agentProviders`.

Icons: `extension`, `chat`, `branch`, `folder`, `schedule`, `spark`, `lock`, `settings`, `check`, `warning`, `copy`, `notes`.

Command actions: `app.settings.open`, `commandPalette.open`, `search.everywhere`, `search.goToFile`, `chat.new`, `workspace.history.back`, `workspace.history.forward`, `workspace.sidebar.toggle`, `panel.files.toggle`, `panel.editor.toggle`, `panel.git.toggle`, `panel.backlog.toggle`, `git.refresh`, `git.fetch`, `terminal.new`, `usage.show`.

<!-- generated:extension-manifest-reference:end -->
