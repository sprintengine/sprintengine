# The surface's `studio`

Each panel, door and settings section in extension.json names an `entry`: an
ESM bundle exporting `mount`. Studio imports it when the surface first opens
and calls it with an element to draw in and a `studio` object:

```ts
import type { ExtensionMount } from '@sprintengine/extension-sdk'

export const mount: ExtensionMount = (root, studio) => {
  // draw into root …
  studio.ready()
  return () => {
    // … and undo it when the surface closes
  }
}
```

`mount` may be async. What it returns, if anything, is a cleanup function
Studio calls when the surface closes. `root` is Studio's; draw inside it and
nowhere else (the `styling` topic). Types: `ExtensionMount`,
`ExtensionMountStudio`, `RendererHost` in `@sprintengine/extension-sdk`.

`studio` is the window's API (`RendererHost`) plus two members for this one
surface:

| Member | Notes |
| --- | --- |
| `surface` | `{ point, id, workspaceId? }`: which contribution this is (`panels`, `doors` or `settingsSections`, and its id in extension.json), and for a panel, the workspace it was opened in. |
| `ready()` | Say the surface has drawn its content. Studio measures the time from opening to this call. Call it once, after the first meaningful paint. |

The surface adds nothing to Studio at runtime: what it contributes is declared
in extension.json. It draws, and it reaches Studio through `studio`.

## Identity and capabilities

| Member | Notes |
| --- | --- |
| `moduleId` | Your install key, `<publisher>.<id>` (`local.<id>` for a folder install): the extension your `methods()` calls reach and your bell rows are filed under. |
| `supports(capability)` | `'conversations'`, `'chat.open'`, `'storage'`, `'secrets'`, `'github'`, `'module-assets'`, `'toast'`, `'notifications'`, `'open-external'`, … Unknown names answer `false`. Check before relying on one. |
| `getAssetUrl(relativePath)` | A stable URL for a file inside the installed extension (no leading slash, no `..`). The way to reach HTML, images, WASM: the bundle runs from a blob URL, so relative URLs do not resolve. |
| `openGlobalSurface(id)` | Open one of your doors (`contributes.doors`) as if it had been picked in the Extensions drawer. `false` for an id that is not yours, or while the extension is off. |

## Feedback, links and the window

| Method | Notes |
| --- | --- |
| `toast({ tone, message, detail?, action? })` | Transient feedback in the app's toast region, under your extension's name. `tone`: `neutral`, `accent`, `good`, `warn`, `error`. One optional `action: { label, run }`; pressing it dismisses the toast. Returns a dismisser. Leaves on its own — anything the person must find again goes to the bell (`notify` in the worker). Throws on an empty message; shows nothing while the extension is off or the window has no toast region (`supports('toast')`). |
| `openExternal(url)` | Opens an absolute http(s) URL in the system browser through the app's own link path. Resolves `{ ok: true }` or `{ ok: false, code: 'invalid_url' \| 'unavailable' \| 'failed', message }`; never throws. Do not `window.open`. |
| `getActiveWorkspaceId()` / `watchActiveWorkspace(cb)` | The workspace this window is showing, or `null`. `watch` fires at once, then on change; returns the unsubscriber. |
| `watchColorScheme(cb)` | `'light' \| 'dark'` for a runtime you host (an editor, a chart library); ordinary styling uses the `--sem-*` properties. |

From the worker, `studio.notify({ severity, title, body?, target? })` is the
bell: see the `api-main` topic.

## Chats

| Method | Notes |
| --- | --- |
| `openChat({ workspaceId, prompt?, skills?, cli?, model?, send?, name?, dedupeKey? })` | Opens and focuses a new chat in the workspace. Default `send: false`: the prompt is a draft the person sends. `name` titles the chat; `dedupeKey` focuses the chat this extension already opened under that key (`existing: true`) instead of opening another. Resolves `{ ok: true, agentId, existing? }` or `{ ok: false, code, message }` (`permission_missing`, `unknown_workspace`, `workspace_folder_missing`, `cli_not_conversational`, `unavailable`, `invalid_input`) — never throws for those. A draft needs `chat:draft` (or `conversation:operate`); `send: true` needs `conversation:operate`. `name`/`dedupeKey`: `supports('chat.open-options')`. |
| `listChatRuntimes()` | `[{ id, label, available, models, lastSelected }]` for a picker; pass `id` as `cli`. |
| `focusTab({ workspaceId, kind: 'chat' \| 'file', id })` | Focus a chat by agent id (from `openChat` or the conversation service) or a file by workspace-relative path. |

For chats the extension drives itself (send, watch, stop), use the worker's
conversation service: the `conversations` topic.

## Workspaces and files

| Method | Permission | Notes |
| --- | --- | --- |
| `getWorkspace(id)` | `ipc:workspace-read` | `{ id, name, folderPath, mode }` or `null` ("not resolvable yet" — retry, never treat as deleted). |
| `listWorkspaces()` / `watchWorkspaces(cb)` | `ipc:workspace-read` | `watch` fires at once with the current list, then on change. |
| `getWorkspaceGitInfo(workspaceId)` | `ipc:workspace-read` (checked) | `{ ok, branch, remotes: [{ name, url, github? }] }` from git in the workspace's working root; SSH aliases for github.com resolved. Never throws. |
| `getWorkingRoot(id)` | `ipc:workspace-read` | Where live work happens (a worktree, for worktree-backed workspaces). |
| `watchWorkspaceFile(id, relativePath, cb)` | `filesystem:read-workspace` | Content now, then debounced on change; resolves to the unsubscriber. |
| `listBacklogItems(id)` / `watchBacklogItems(id, cb, { onError })` | `backlog.read` | Item views (with `numericId`, `displayId`, `epic`, `modifiedAt`). `onError` hears a folderless workspace or an unreadable Backlog; the watch stays open. |
| `getBacklogLocation(id)` | `backlog.read` | `{ root, isDefault, exists }` of the workspace's Backlog. |
| `createBacklogItem(id, input)`, `updateBacklogStatus`, `updateBacklogTriage`, `addBacklogLink`, `updateBacklogModuleMetadata` | `backlog.write` | Writes through the app's Backlog service; result-shaped. Never write item files. |
| `queryUsage(query)` | `usage:read` | Token usage of every agent session on the machine (twin of `getUsageService`). |

A panel's workspace is `studio.surface.workspaceId`.

## State

| Method | Permission | Use for |
| --- | --- | --- |
| `getModuleAppState(key)` / `setModuleAppState(key, value)` / `watchModuleAppState(cb)` | `storage` | The extension's own small settings-like values, shared by every surface and window; synchronous, safe to read in render; pair with `useSyncExternalStore`. `set` returns `false` when not stored. The worker reads the same values with its `getModuleAppState` (read-only). A settings section is a surface that writes here. |
| `getWorkspaceModuleState(id)` / `setWorkspaceModuleState(id, value)` | `storage` | The extension's entry on one workspace, saved and synced with it. `undefined` = unknown yet. |

Larger data, or data the worker writes: `getModuleStorage(studio)` in the
worker, reached from a surface through your own declared method.

## Talking to the worker

```ts
// src/methods.ts, imported by both sides
export type NotesMethods = {
  'notes.list': { access: 'read'; params: Record<string, never>; result: string[] }
  'notes.save': { access: 'operate'; params: { text: string }; result: { count: number } }
}
// the worker's activate(studio)
studio.registerMethods<NotesMethods>({
  'notes.list': {
    access: 'read',
    params: () => ({ ok: true, params: {} }),
    handler: () => ({ ok: true, result: notes }),
  },
  'notes.save': {
    access: 'operate',
    params: readText,
    handler: ({ text }) => ({ ok: true, result: { count: save(text) } }),
  },
})
studio.emit('changed')                     // push a signal to every surface
// a surface's mount(root, studio)
const methods = studio.methods<NotesMethods>()
const saved = await methods.operate('notes.save', { text })
if (!saved.ok) studio.toast({ tone: 'error', message: saved.message })
const stop = studio.subscribe('changed', () => void reload())
```

- A `read` method changes nothing; an `operate` one does, and runs once per
  command id (a retry gets the first answer; the handler sees it as
  `context.commandId`). `read` offers only read methods, `operate` only
  operate ones. Declaring methods needs `module:bridge`.
- A call never throws. Besides your own `{ ok: false, code }`, the host
  answers `extension_unavailable` (the worker is not running there),
  `extension_method_unknown`, `invalid_params` (your validator refused),
  `scope_required` or `unavailable` (a handler threw, or no connection).
- Events are signals, not state: nothing is replayed, so read the current
  state through a `read` method and let the event say "read again".
- Params, results and event payloads ride the Studio protocol
  (`extension.read`, `extension.operate`, `extension.events`): JSON values only.

## Drag and drop

`readFileDropPayload(event.dataTransfer)` reads Backlog/Files drags (`null` for
anything else); `hasFileDropData` is the `dragover` check;
`setFileDropData` starts a drag Studio's own targets accept.
