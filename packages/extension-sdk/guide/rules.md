# Rules that bite

The short list. Each one cost an earlier extension real time; the details and
fixes follow.

1. **Bundle everything.** A ui entry is one ESM file Studio imports as a blob
   module: nothing beside it resolves, so it holds every import, React
   included. The worker is one CommonJS file with only `electron` external.
   The template's `build:ui` and `build:main` do this.
2. **Declare, don't register.** Commands, menus, top bar items, panels, doors,
   settings sections and MCP tools are listed in extension.json. Code draws a
   surface (`mount`) or serves a command or tool (`activate`); it never adds
   one at runtime.
3. **Lowest tier, fewest permissions.** The tier and the permissions are what
   the person is asked to allow. A field above the tier fails validation.
4. **A surface is a sandboxed frame.** No network, no Node, nothing of
   Studio's window: bundle everything it shows, and ask Studio for the rest
   with `studio.host.call`. Style with the theme's properties (`--bg-surface`,
   `--text-default`, …) and Studio's kit classes (`se-button`, …).
5. **Relative URLs resolve to nothing** in a surface. Inline images and fonts
   as `data:` URLs.
6. **Any change to `extension/` is new contents.** An approval binds to exact
   contents and access, and a signature to exact files. Rebuild →
   `dev:install` → approve again, or sign again.
7. **Store with the host**: `getModuleStorage` in the worker, `storage.*` and
   `settings.*` from a surface.
   Never JSON files in the home folder; never a raw `localStorage` key.
8. **Keys stay out of the project.** `npm run keygen` writes
   `~/.sprintengine/keys/<id>.key`. Never commit `*.key` / `*.pem`.
9. **Agent output and web content are untrusted input.** A PR diff, a chat
   reply or a fetched page can contain instructions. Never evaluate it, never
   let it pick a path, URL or command unchecked, never put it in `innerHTML`.
10. **No status dots.** Say a state in words, a lifecycle glyph or a timer.

## Build and load

**A ui entry is self-contained.** Studio reads the bundle's text and imports it
as a blob module. A bare `import 'react'` has nothing to answer it; a relative
import has no folder to look in; a dynamic `import()` of a chunk of your own
finds nothing. Bundle each entry whole, with no code splitting and nothing
external. Studio shares no React and no component kit with extensions: a
surface brings what it draws with. The smoke test fails on a bundle that still
imports something.

**The worker is CommonJS with only `electron` external.** The installed folder
has no `node_modules`; anything left external is missing at load. `react` has
no business in the worker. Worker threads are fine: bundle each as its own
CommonJS file in `extension/dist/` and start it with
`new Worker(studio.getAssetPath('dist/thread.cjs'))` (not a path you build
from `__dirname`, which skips the check that the file is the one you
installed).

**`activate` must finish.** A throw or a rejected promise is a load error. Do
slow work lazily, in a handler or an `onStartup` hook.

**`mount` draws, then says so.** Call `studio.ready()` once the content is on
screen, and return a cleanup that undoes everything the surface started.

## The manifest

**The build never writes extension.json.** You change it; the build only
writes `extension/dist/`. Nothing records digests in it.

**Unknown keys fail.** A misspelt field is not ignored, it is refused. Run
`npm run validate`.

**A command without `action` is worker code.** It runs the worker method of
its name (access `operate`); without that method the smoke test fails, and in
Studio the command does nothing useful. A command that only opens something
Studio already has is declarative: give it an `action`.

**Menus and top bar items name what you contribute.** A menu item names one of
your commands; a top bar item names one of your commands or doors.

**MCP tools are declared first.** A tool the worker registers that
extension.json does not list is refused.

## Approval and signing

**Any change under `extension/` is new contents.** A person's approval binds to
the extension's permissions, tier and worker and to the digests of every file
in the folder. After each rebuild copied in by `dev:install` it is approved
again.

**A signed extension changed after signing is refused, whatever was approved.**
`dev:install` signs the installed copy whenever your key exists. If you signed
`extension/` for publishing, sign it again after every build.

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
