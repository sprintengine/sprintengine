# extension.json

`extension/extension.json` is the extension: what it is, what it adds to
Studio, and the most authority it needs. Every path in it is relative to the
folder that holds it, `extension/`, which is the folder Studio installs.

One validator reads it, the same one in Studio, the `sprintengine-extension`
CLI and the project's scripts: `validateExtensionManifest(raw, { authoring })`
from `@sprintengine/extension-sdk`. It is strict. A key it does not know is
refused, at every level, so nothing reaches the install review that Studio
does not read. `node scripts/validate.mjs` runs it the way an author should
(`authoring: true`).

The build never writes extension.json. You write it, and it changes only when
you change it.

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
  "main": "dist/main.cjs",
  "contributes": {
    "commands": [
      { "id": "notes.clear", "title": "Clear notes" },
      { "id": "notes.show-backlog", "title": "Show the Backlog", "action": "panel.backlog.toggle" }
    ],
    "menus": [{ "where": "backlog.item", "command": "notes.clear" }],
    "panels": [{ "id": "notes", "title": "Notes", "icon": "notes", "entry": "dist/notes.js" }]
  }
}
```

`$schema` is for your editor: the SDK ships the JSON Schema as
`@sprintengine/extension-sdk/extension.schema.json`. Studio ignores the key.

## Tiers

`tier` says the most authority the extension needs. Each tier carries what the
ones below it do; a field or a contribution above the tier fails validation.

| Tier | What it may carry |
| --- | --- |
| `content` | Its name and images. Nothing that runs. |
| `declarative` | Commands that run Studio's own commands (`action`), menu items and top bar items for them. No permissions. |
| `ui` | Panels, doors and settings sections drawn by its own code, and permissions. |
| `worker` | `main`: code that runs in the background, serves commands without an `action`, methods and MCP tools. |

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
- **`panels`**, **`doors`** and **`settingsSections`** are drawn by the
  extension. Each names an `entry`: an ESM bundle exporting
  `mount(root, studio)`. A panel is a tab in a workspace's pane, offered by the
  pane's + menu. A door is a full-window surface with a row in the Extensions
  drawer. A settings section sits in Settings.
- **`mcpTools`** are tools agents reach through Studio's MCP server. Declare
  each one here, with what agents are told it does and whether it changes
  anything; the worker serves them with `registerMcpTools`. A tool the worker
  registers that is not declared is refused, and the declaration's words win.
  Give each its `inputSchema` too: agents see its parameters before the
  worker has ever run, and the schema the worker registers must take no more
  than it. Needs the `tools:contribute` permission.

Every point defaults to empty. The points held for later formats (themes,
keybindings, skills and the rest, listed under the reference) must be empty
or absent.

## Ids and install keys

`id` is kebab-case, at most 63 characters. Studio installs an extension under
`<publisher>.<id>`: the publisher comes from where it was installed from, and
a folder install is `local`, so a project's `dev:install` lands in
`~/.sprintengine/extensions/local.<id>/`. The install key is what
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
device (`CON`, `NUL`, …) is refused. A ui `entry` ends in `.js` or `.mjs`;
`main` in `.js`, `.cjs` or `.mjs`.

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
| `tier` | `content` \| `declarative` \| `ui` \| `worker` | yes | 0.13.0 |  | The most authority it needs, least first: `content`, `declarative` (commands, menus, top bar items), `ui` (panels, doors, settings sections, drawn by its own code), `worker` (`main`, running in the background). Each carries what the ones below it do; a contribution above it fails validation. |
| `name` | string | yes | 0.13.0 |  | Display name. |
| `description` | string |  | 0.13.0 |  | One or two sentences shown with the name. |
| `icon` | string |  | 0.13.0 |  | A square image shown beside the name. |
| `cover` | string |  | 0.13.0 |  | A wide image for its listing. |
| `screenshots` | string[] (at most 8) |  | 0.13.0 |  | Images of it at work, for its listing. |
| `license` | string |  | 0.13.0 |  | Its licence, as an SPDX expression. |
| `repository` | string |  | 0.13.0 |  | Where its source lives. |
| `homepage` | string |  | 0.13.0 |  | Its home page. |
| `permissions` | `workspace:read` \| `workspace:operate` \| `conversation:read` \| `backlog:read` \| `backlog:operate` \| `providers:read` \| `usage:read` \| `workspace-files:read` \| `workspace-files:write` \| `storage:own` \| `settings:own` \| `secrets:own` \| `notifications:show` \| `conversation:own` \| `conversation:bypass` \| `chat:draft` \| `schedules:own` \| `agents:generate` \| `agents:companion` \| `github:api` \| `tools:contribute`[] (at most 32) |  | 0.13.0 | ui | What it asks the person to allow. `content` and `declarative` extensions hold none. |
| `main` | string |  | 0.13.0 | worker | The worker’s entry: a module whose `activate(studio)` (its default export, or a named `activate`) registers what it serves. Worker tier only, and required by it. |
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
| `contributes.panels[].entry` | string | yes | 0.13.0 |  | What the panel draws, as a tab in a workspace’s pane. A `.js` or `.mjs` module whose `mount(root, studio)` draws into `root` and may return a cleanup function. |
| `contributes.doors` | object[] (at most 8) |  | 0.13.0 | ui | Full-window surfaces, opened from the Extensions drawer. |
| `contributes.doors[].id` | string | yes | 0.13.0 |  | Id, unique within this point. |
| `contributes.doors[].title` | string | yes | 0.13.0 |  | What Studio calls it. |
| `contributes.doors[].icon` | `extension` \| `chat` \| `branch` \| `folder` \| `schedule` \| `spark` \| `lock` \| `settings` \| `check` \| `warning` \| `copy` \| `notes` |  | 0.13.0 |  | Glyph beside the title. Defaults to `extension`. |
| `contributes.doors[].entry` | string | yes | 0.13.0 |  | What the door draws when it is open. A `.js` or `.mjs` module whose `mount(root, studio)` draws into `root` and may return a cleanup function. |
| `contributes.settingsSections` | object[] (at most 4) |  | 0.13.0 | ui | Sections in Settings. |
| `contributes.settingsSections[].id` | string | yes | 0.13.0 |  | Id, unique within this point. |
| `contributes.settingsSections[].title` | string | yes | 0.13.0 |  | What Studio calls it. |
| `contributes.settingsSections[].icon` | `extension` \| `chat` \| `branch` \| `folder` \| `schedule` \| `spark` \| `lock` \| `settings` \| `check` \| `warning` \| `copy` \| `notes` |  | 0.13.0 |  | Glyph beside the title. Defaults to `extension`. |
| `contributes.settingsSections[].entry` | string | yes | 0.13.0 |  | What the section draws in Settings. A `.js` or `.mjs` module whose `mount(root, studio)` draws into `root` and may return a cleanup function. |
| `contributes.mcpTools` | object[] (at most 64) |  | 0.13.0 | worker | Tools agents reach through Studio’s MCP server. Needs the `tools:contribute` permission. |
| `contributes.mcpTools[].name` | string | yes | 0.13.0 |  | The tool’s name on Studio’s MCP server. The worker serves it with `registerMcpTools`; a tool it registers that is not declared here is refused. |
| `contributes.mcpTools[].description` | string | yes | 0.13.0 |  | What agents are told the tool does. |
| `contributes.mcpTools[].access` | `read` \| `operate` | yes | 0.13.0 |  | `read` changes nothing; `operate` may, and agents are asked before it runs where their settings say so. |
| `contributes.mcpTools[].inputSchema` | JSON Schema object |  | 0.13.0 |  | The tool’s parameters, as a JSON Schema for an object: what agents see before the worker has ever run. The schema the worker registers must take no more than this one (no parameter it leaves out, none it requires dropped). Without it, agents see the worker’s schema once it has run. |

Reserved, and must be empty for now: `contributes.themes`, `contributes.terminalThemes`, `contributes.iconThemes`, `contributes.syntaxes`, `contributes.fonts`, `contributes.snippets`, `contributes.keybindings`, `contributes.statusBarItems`, `contributes.settings`, `contributes.customEditors`, `contributes.newFiles`, `contributes.events`, `contributes.hooks`, `contributes.sidecars`, `contributes.agentProviders`, `contributes.skills`, `contributes.mcpServers`, `contributes.providers`.

Icons: `extension`, `chat`, `branch`, `folder`, `schedule`, `spark`, `lock`, `settings`, `check`, `warning`, `copy`, `notes`.

Command actions: `app.settings.open`, `commandPalette.open`, `search.everywhere`, `search.goToFile`, `chat.new`, `workspace.history.back`, `workspace.history.forward`, `workspace.sidebar.toggle`, `panel.files.toggle`, `panel.editor.toggle`, `panel.git.toggle`, `panel.backlog.toggle`, `git.refresh`, `git.fetch`, `terminal.new`, `usage.show`.

<!-- generated:extension-manifest-reference:end -->
