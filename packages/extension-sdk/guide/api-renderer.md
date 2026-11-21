# The surface's `studio`

Each panel, door and settings section in extension.json names an `entry`: an
ESM bundle exporting `mount`. Studio draws the surface in a sandboxed frame of
its own, on every client (the desktop app, a desktop window paired with
another machine, a browser), loads the entry there and calls `mount` with the
frame's root element and a `studio` object:

```ts
import type { ExtensionMount } from '@sprintengine/extension-sdk'

export const mount: ExtensionMount = async (root, studio) => {
  const workspaces = await studio.host.call('workspace.list', {})
  // draw into root …
  studio.ready()
  return () => {
    // … and undo it when the surface closes
  }
}
```

`mount` may be async. What it returns, if anything, is a cleanup function
Studio calls when the surface closes. Types: `ExtensionMount`,
`ExtensionMountStudio`, `ExtensionFrameMethods` in
`@sprintengine/extension-sdk`.

## What the frame is

The frame is its own document with an opaque origin: the extension's code
cannot reach Studio's window, has no Node, and has no network (its policy
refuses every connection, and it cannot open windows or submit forms). A
frame that tries to load another page in its place (`location.href`, a
refresh) is stopped by the desktop app, and closed by any client that sees it
load a second document. Images and fonts must be `data:` or `blob:` URLs. Everything the
surface needs from Studio it asks for with `studio.host.call`, and Studio
checks every call twice: against the permissions the person approved for the
extension, and against what the person, device or browser that opened the
surface may do themselves. A frame sends at most 120 messages in any 10
seconds, each at most 64 KiB.

## `studio`

| Member | Notes |
| --- | --- |
| `surface` | `{ point, id, workspaceId? }`: which contribution this is (`panels`, `doors` or `settingsSections`, and its id in extension.json), and for a panel, the workspace it was opened in. |
| `host.call(method, params, { signal }?)` | Ask Studio to do one thing (the table below). Resolves with the method's result; rejects with an `Error` whose `code` says why (`not_permitted`, `approval_required`, `unknown_method`, `invalid_params`, `rate_limited`, `too_large`, `unavailable`, `timeout`, `cancelled`, `action_failed`) and `retryable`. |
| `host.has(method)` | Whether this Studio offers a method. |
| `methods<Contract>()` | The worker's declared methods (`registerMethods`): `.read(name, params)`, `.operate(name, params)`. Never throws: a refusal, the worker's or Studio's, is an answer. |
| `on('push', fn)` | The worker's events (`MainHost.emit`): `{ topic, payload? }`. Nothing is replayed: read the state again when an event says so. |
| `on('theme', fn)`, `theme` | The person's theme changed: `{ colorScheme }`. The CSS variables are already updated. |
| `ready()` | Say the surface has drawn its content. Studio measures the time from opening to this call. Call it once, after the first meaningful paint. |

## Host methods

| Method | Params → result | Extension needs | The one who opened it needs |
| --- | --- | --- | --- |
| `workspace.list` | `{}` → workspaces | `workspace:read` | `workspace:read` |
| `workspace.get` | `{ workspaceId }` → workspace or null | `workspace:read` | `workspace:read` |
| `backlog.list`, `backlog.location` | `{ workspaceId }` → `{ ok, items }`, `{ ok, location }` | `backlog:read` | `backlog:read` |
| `backlog.create`, `.updateStatus`, `.updateTriage`, `.addLink`, `.updateModuleMetadata` | as the worker's `getBacklogService` | `backlog:operate` | `backlog:operate` |
| `usage.query` | `{ query }` → as `getUsageService().query` | `usage:read` | `workspace:read` |
| `storage.get`, `.list` | `{ key \| prefix, workspaceId? }` | `storage:own` | `extension:read` |
| `storage.set`, `.delete` | `{ key, value?, workspaceId? }` | `storage:own` | `extension:operate` |
| `settings.get` | `{}` → the extension's Settings values | `settings:own` | `extension:read` |
| `settings.set` | `{ key, value }` (`null` removes it) | `settings:own` | `extension:operate` |
| `files.read`, `.stat`, `.search` | `{ workspaceId, path }`, `{ workspaceId, query, limit? }` | `workspace-files:read` | `filesystem:read` |
| `files.write` | `{ workspaceId, path, content, create? }` | `workspace-files:write` | `filesystem:write` |
| `notify` | a bell row, as `MainHost.notify` | `notifications:show` | `extension:operate` |
| `worker.read`, `worker.operate` | what `methods()` sends | — | `extension:read`, `extension:operate` |
| `toast` | `{ tone, message, detail? }`, in the window that opened it | — | `extension:read` |
| `chat.draft` | `{ workspaceId, prompt, name? }`: a chat with the prompt drafted for the person to send | `chat:draft` | `conversation:create` |
| `tabs.focus` | `{ workspaceId, kind: 'chat' \| 'file', id }` | — | `workspace:read` |
| `doors.open` | `{ id }`: one of the extension's own doors | — | `extension:read` |

`files.*` reach only files inside a workspace's folder: a path is relative to
the folder, and a file is found by its real path, so a link out of the folder
is refused rather than followed, as is a file with a second name (a hard
link). Nothing is written under a `.git` folder. Text files only, up to 4 MiB.
A project's files can run code (its scripts, its tools' settings), so the
approval of an extension holding `workspace-files:write` says it has full
access to the person's account.

Opening a link in the person's browser is not offered to a frame yet: Studio
cannot tell a click in a frame from one in its own window.
