# The surface's `studio`

Each panel, door, settings section and custom editor in extension.json names an `entry`: a
module exporting `mount` (`.ts`, `.tsx`, `.js`, … loaded as written, with the
files it imports by relative paths; the `rules` topic). Studio draws the surface in a sandboxed frame of
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
| `surface` | `{ point, id, workspaceId? }`: which contribution this is (`panels`, `doors`, `settingsSections` or `customEditors`, and its id in extension.json), and for a panel or a custom editor, the workspace it was opened in. |
| `document` | A custom editor's file (below); absent in every other surface. |
| `host.call(method, params, { signal }?)` | Ask Studio to do one thing (the table below). Resolves with the method's result; rejects with an `Error` whose `code` says why (`not_permitted`, `approval_required`, `unknown_method`, `invalid_params`, `rate_limited`, `too_large`, `unavailable`, `timeout`, `cancelled`, `action_failed`, `conflict`, `missing`) and `retryable`. |
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
| `settings.get` | `{}` → the extension's Settings values, each declared one its stored value while it fits, else its default | `settings:own` | `extension:read` |
| `settings.set` | `{ key, value }` (`null` removes it); a declared setting is held to its declaration | `settings:own` | `settings:write` |
| `files.read` | `{ workspaceId, path, encoding? }` → `{ content, size, sha256 }` | `workspace-files:read` | `filesystem:read` |
| `files.stat`, `.search` | `{ workspaceId, path }`, `{ workspaceId, query, limit? }` | `workspace-files:read` | `filesystem:read` |
| `files.write` | `{ workspaceId, path, content, create?, encoding?, expectedSha256? }` → `{ size, created, sha256 }` | `workspace-files:write` | `filesystem:write` |
| `notify` | a bell row, as `MainHost.notify` | `notifications:show` | `extension:operate` |
| `worker.read`, `worker.operate` | what `methods()` sends | — | `extension:read`, `extension:operate` |
| `toast` | `{ tone, message, detail? }`, in the window that opened it | — | `extension:read` |
| `chat.draft` | `{ workspaceId, prompt, name? }`: a chat with the prompt drafted for the person to send | `chat:draft` | `conversation:create` |
| `tabs.focus` | `{ workspaceId, kind: 'chat' \| 'file', id }` | — | `workspace:read` |
| `doors.open` | `{ id }`: one of the extension's own doors | — | `extension:read` |

`files.*` reach only files inside a workspace's folder: a path is relative to
the folder, and a file is found by its real path, so a link out of the folder
is refused rather than followed, as is a file with a second name (a hard
link). Some tools hard-link the files they install (pnpm's store, some build
caches), so `files.read` refuses those too. Nothing is written under a `.git` folder. Up to 4 MiB: UTF-8
text, or with `encoding: 'base64'` the raw bytes in base64. `sha256` is of the
file's bytes; a `files.write` given `expectedSha256` writes only over a file
whose bytes still hash to it, and is refused `conflict` otherwise (one that is
gone too), so nothing changed meanwhile is written over unseen. A `files.write` with `create: true` over a
file that exists is refused `conflict` too.
A project's files can run code (its scripts, its tools' settings), so the
approval of an extension holding `workspace-files:write` says it has full
access to the person's account.

Opening a link in the person's browser is not offered to a frame yet: Studio
cannot tell a click in a frame from one in its own window.

## Custom editors: `studio.document`

A custom editor (`contributes.customEditors`) is drawn in the tab of the file
it opens, and its `studio` has a `document`: the file as Studio holds it, never
its path. Studio keeps the rest: the unsaved state, saving (its Save, or
Cmd/Ctrl+S inside the editor), the file on disk, and the text editor, which
shares a text file's unsaved edits with the custom editor in the same window.

```ts
import type { ExtensionMount } from '@sprintengine/extension-sdk'

export const mount: ExtensionMount = async (root, studio) => {
  const doc = await studio.document!.session<Todo[]>({
    decode: (content) => parse(content.kind === 'text' ? content.text : ''),
    encode: (todos) => ({ kind: 'text', text: format(todos) }),
  })
  draw(root, doc.value, (next) => doc.change(next))
  const replaced = doc.onReplace((todos) => draw(root, todos, (next) => doc.change(next)))
  studio.ready()
  return () => {
    replaced.dispose()
    doc.dispose()
  }
}
```

| Member | Notes |
| --- | --- |
| `get()` | The document once Studio handed it over: `{ version, readOnly, content }`, `content` being `{ kind: 'text', text }` or, with `contentKind: "bytes"`, `{ kind: 'bytes', bytes }` (an `ArrayBuffer`). |
| `onDidChange(fn)` | Each document Studio hands over, the current one first. A new one comes when the file changed outside the editor: on disk while there are no unsaved edits, in the text editor, or reloaded. |
| `applyEdit({ baseVersion, content })` | Replace the whole content. `baseVersion` is the version the edit was made against; an accepted edit keeps it. Rejects with `conflict` (and `document`, the current one) when the document changed since, `not_permitted` when it is read only, `too_large` past 1 MiB of text or 768 KiB of bytes. |
| `onWillSave(fn)` | Studio is about to save: hand over anything held back. Studio waits up to a second for the returned promise. |
| `session(options?)` | The sync in one call. `value` is the editor's value; `change(value)` sends it as an edit after `debounceMs` (250 by default), one at a time, and before a save; `flush()` sends it now; `onReplace(fn)` hears the value replaced from outside; `decode` and `encode` turn content into the editor's value and back (text by default); `merge(base, outside, mine)`, when given, resolves an edit refused because the document changed first, and is sent instead. Without `merge` the outside version wins and the refused edit is dropped, so nothing is written over unseen. |

A document is `readOnly` when the extension holds no `workspace-files:write`,
or the person, device or browser that opened it may not write files, and
Studio saves nothing then. A file larger than 1 MiB of text, or 768 KiB of
bytes, does not open in a custom editor: a save travels to the Studio as one
request, and bytes travel in base64. When the file changes on disk while the
editor has unsaved edits, Studio does not hand the change over: the tab says
the file changed and offers to load it from disk or save the edits over it. A
save that finds the file changed since it was read is refused the same way. A
file deleted under unsaved edits is written back by Save. Before a save, and
before the person leaves the editor (Open with…, closing the tab), Studio asks
the editor for the edits it holds back (`onWillSave`, `session()` does this),
and saves nothing, or stays, when it does not answer within a second. A
binary document's unsaved edits stay with the tab when another editor of the
file is opened; leaving them for the text editor, or closing the tab, asks
whether to save them.
`createFakeFrameStudio({ document: { text } })` (`/testing`) gives a test the
same `studio.document` against a fake Studio: `frame.document.replace(text)`
for a change made outside, `.save()`, `.edits` and `.refused`.
