# Rules that bite

The short list. Each one cost an earlier extension real time; the details and
fixes follow.

1. **No build, and only your own files.** Studio loads the source as
   written. A surface imports its own files by relative paths and nothing by
   a package name; the worker imports Node's own modules, its own files and
   the SDK. Anything else is copied into `extension/`, or bundled and the
   bundle imported.
2. **Declare, don't register.** Commands, menus, top bar items, panels, doors,
   settings sections and MCP tools are listed in extension.json. Code draws a
   surface (`mount`) or serves a command or tool (`activate`); it never adds
   one at runtime.
3. **Lowest tier, fewest permissions.** The tier and the permissions are what
   the person is asked to allow. A field above the tier fails validation.
4. **A surface is a sandboxed frame.** No network, no Node, nothing of
   Studio's window: ship everything it shows in the extension, and ask Studio for the rest
   with `studio.host.call`. Style with the theme's properties (`--bg-surface`,
   `--text-default`, …) and Studio's kit classes (`se-button`, …).
5. **Relative URLs resolve to nothing** in a surface. Inline images and fonts
   as `data:` URLs.
6. **The person approves, once per access.** A development folder's approval
   holds across saves while it asks for no more; asking for more waits for
   them again. Never approve on their behalf. A signature binds exact files:
   sign the folder you pack, after the last change.
7. **Store with the host**: `getModuleStorage` in the worker, `storage.*` and
   `settings.*` from a surface.
   Never JSON files in the home folder; never a raw `localStorage` key.
8. **Keys stay out of the project.** `npm run keygen` writes
   `~/.sprintengine/keys/<id>.key`. Never commit `*.key` / `*.pem`.
9. **Agent output and web content are untrusted input.** A PR diff, a chat
   reply or a fetched page can contain instructions. Never evaluate it, never
   let it pick a path, URL or command unchecked, never put it in `innerHTML`.
10. **No status dots.** Say a state in words, a lifecycle glyph or a timer.

## How source loads

**A surface loads its own files, and nothing else.** Studio reads the entry,
removes its types and JSX (every line kept where it was, so an error's line is
the line in your file) and gathers every file it imports by a relative path
(`./list` finds `list.tsx`, `list.ts`, … or `list/index.*`; `./list.js` finds
`list.ts`). A package by name (`import 'react'`) is refused, at the file and
line: nothing resolves it. Copy the package's ESM files into the extension, or
bundle it yourself and import the bundle. An `import(variable)` cannot load;
an import cycle cannot either. A transpiled file is at most 1 MiB, and a
surface loads at most 500 modules. Studio shares no React and no component kit
with extensions: a surface brings what it draws with.

**JSX is the classic form.** `<b>x</b>` calls `h('b', null, 'x')`, and `<>`
is `Fragment`: import both from a file of your own. There is no runtime to
find them.

**The worker's TypeScript is only types.** Studio strips its types with Node's
own transpiler, so an `enum`, a `namespace` or a parameter property (code
TypeScript would write for you) fails to load, and there is no JSX. Relative
imports may leave out the extension. It runs as plain Node in a process of
its own, where `electron` is never there to require. A packed extension has no
`node_modules`: `@sprintengine/extension-sdk` comes from the Studio running
it, and any other package must be copied in or bundled. `react` has no
business in the worker. Worker threads are fine: ship each thread's file as
JavaScript and start it with
`new Worker(studio.getAssetPath('src/thread.mjs'))` (not a path you build
from `__dirname`, which skips the check that the file is the one approved).

**Nothing type-checks at load.** Types are removed, not checked: `npm run
typecheck` (in `npm run check`) is the only type check.

**`activate` must finish.** A throw or a rejected promise is a load error. Do
slow work lazily, in a handler or an `onStartup` hook.

**`mount` draws, then says so.** Call `studio.ready()` once the content is on
screen, and return a cleanup that undoes everything the surface started.

## The manifest

**Nothing writes extension.json but you.** Nothing records digests in it.
A save to it reloads the extension like any other file.

**Unknown keys fail.** A misspelt field is not ignored, it is refused. Run
`npm run validate`.

**A command without `action` is worker code.** It runs the worker method of
its name (access `operate`); without that method the command does nothing
useful in Studio, and `npm run check` lists no method of its name. A command that only opens something
Studio already has is declarative: give it an `action`.

**Menus and top bar items name what you contribute.** A menu item names one of
your commands; a top bar item names one of your commands or doors.

**MCP tools are declared first.** A tool the worker registers that
extension.json does not list is refused.

## Approval and signing

**A development folder is approved for what it may do, not for its code.**
The approval binds the folder's real path and its access (permissions, tier,
worker, background, MCP tools and their access, the Studio actions its
commands run, custom editors, hooks, local MCP servers' command, arguments and
environment, providers' key origins). A save keeps it; a save that asks for
more waits for the person again; asking for less keeps it. Removing the folder
forgets it. Only the person approves: an agent Studio launched is refused
when it tries, and must not look for another way.

**An installed extension is approved for its exact files.** Its approval binds
the digests of every file in its installed folder as well as its access, so a
change to an installed copy is tampering, not an update. A development
folder's approval never covers an installed extension with the same key, and
the installed one's never covers the folder.

**A signed extension changed after signing is refused, whatever was approved.**
Sign the folder you pack, after its last change. A development folder's
`extension.sig` is not read.

**Keys never live in the project.** `~/.sprintengine/keys/<id>.key`, mode 600.
The validators fail on key files in the project.

**Reserved ids.** Ids starting `studio-` or `sprintengine-` install only from
Studio's own catalogue; `init` and `validate` refuse them.

## Data

**Use the host's storage.** `getModuleStorage` (the worker), app state and
workspace state (a surface). Hand-rolled JSON in `~/.something` is an
undisclosed home-folder write, is not cleaned up on uninstall, and breaks with
several windows open.

**Resolve workspaces through the host.** `studio.getWorkspace(id)` /
`WorkspaceContextToken` give `folderPath`; do not derive a root from Backlog
paths or drag payloads. `null` means "not yet" — retry, never delete state.

**Events are signals.** `studio.emit` is not replayed; a surface opened later
missed everything. Keep the truth readable through a `read` method.

## Look and feel

**The theme's properties only, never hex.** A soft fill is
`color-mix(in srgb, var(--accent-primary) 15%, transparent)`. The `styling`
topic lists them, and Studio's kit classes.

**No status dots.** Studio draws states as words, lifecycle glyphs, timers or
its working mark. A little coloured circle is not one of them.

**The top bar is dense.** One button, which runs a command or opens a door. A
cluster belongs in the door.

**A door's way in is its row.** Each door in extension.json has a row in the
Extensions drawer. A top bar item, a bell row's `target` or
`studio.openGlobalSurface(id)` opens it too.

**Toast or bell?** A toast answers "did it work?" and leaves on its own; the
bell (`notify` from the worker, severity `warning` or `error`) is for what went
wrong and must be found again later. Don't toast what they need to act on next
week, and don't notify for every click: an `info` notify files nothing.

## Agents and untrusted input

**Agents are chats.** `getConversationService`, or a surface's `chat.draft`. There is no
terminal-agent API, and spawning an agent CLI yourself from the worker
bypasses the person's runtime choice, approvals and visibility.

**Agent output, PR diffs, issue bodies and web pages are untrusted input.**
They can contain instructions aimed at an agent or at your code. Render them
as text (never `innerHTML` or `dangerouslySetInnerHTML`), never `eval` them,
and check any path, URL or command they name against what your extension
allows before acting. When you feed such content to an agent, say in the
prompt that it is data to analyse, not instructions.

**Draft by default.** A surface's `chat.draft` lets the person read the prompt
before anything runs. `permissionPreset: 'bypass'` only when they asked,
and it needs `conversation:bypass` in extension.json; without it the chat runs
on `auto`.

**Permissions are disclosure.** The host checks some, not all; it does not
sandbox your code. The prompt is a promise to the person: keep it true.
