# Events and terminals

## Events

An event tells the extension that something happened in Studio: a workspace
was made, removed or changed, or an agent changed status. Nothing waits for
it, and nothing it answers changes what happened (a hook does that: the
`hooks` topic).

A worker hears the events extension.json lists, at most five, worker tier
only, through `studio.events.on`:

```json
{
  "tier": "worker",
  "main": "src/main.ts",
  "permissions": ["workspace:read"],
  "contributes": { "events": [{ "on": "workspace.created" }, { "on": "workspace.removed" }] }
}
```

```ts
import type { MainHost } from '@sprintengine/extension-sdk'

export function activate(studio: MainHost): void {
  studio.events.on('workspace.created', (workspace) => console.log(`made ${workspace.name}`))
  const removed = studio.events.on('workspace.removed', (workspace) => console.log(`removed ${workspace.name}`))
  // removed.dispose() stops hearing it.
}
```

- A worker that is not running is started to hear an event, so register its
  handlers in `activate`. Each extension hears its events in the order they
  happened, one at a time.
- A handler runs as your extension's own work: as the person who approved it,
  held to whoever else your worker serves at that moment.
- A handler that throws is a line in your log; the other handlers still hear
  the event.
- An event's handlers have 60 seconds. Past that your worker is stopped, so
  the still-running handler never overlaps the next event, and the next event
  starts it again; your log says the event timed out. Start long work and
  return, rather than await it in the handler.
- An extension switched off, stopped, removed by the kill list, or not
  approved as it is now hears nothing. Nor does one whose approval does not
  hold the event's permission: extension.json refuses an event without it, so
  adding an event that needs a permission you did not have asks the person
  again, as any new permission does.

A surface hears one with `studio.on`, with no listing:

```ts
export function mount(root: HTMLElement, studio: ExtensionMountStudio) {
  const stop = studio.on('agent.status.changed', (agent) => {
    root.textContent = `${agent.title ?? agent.agentId}: ${agent.state}`
  })
  return () => stop.dispose()
}
```

The first listener for an event subscribes (`events.subscribe`). Studio holds
it to your approval and to whoever opened the surface (a paired desktop
window or a browser by what its connection was granted), and checks both
again at every event. A refusal is written to the frame's console, and so to
your log.

`editor.typography.changed` is the window's own: each window, paired or in a
browser, keeps its own appearance, so only a surface hears it, from the
window that drew it, the current one first.

Studio has no one focused workspace (each window has its own), so
`workspace.changed` says which workspace changed, and carries its live
terminals, whose ids the terminal service takes. A worker that lists it hears
every workspace as it is when its process starts, and a surface when it
subscribes (and again after its window reconnects), before any change, so
neither starts out stale. A shell the person opened has `title: null`:
Studio does not know the name its tab shows, and renaming a tab is no change.

<!-- generated:extension-event-reference:start -->

| Event | Needs | Heard by | Payload | When |
|---|---|---|---|---|
| `workspace.created` | `workspace:read` | a worker, a surface | `{ workspaceId: string; name: string; kind: 'worktree' \| 'folder'; folderPath: string \| null; branch: string \| null }` | A workspace was made: for a new chat, a worktree, or by an agent or extension. |
| `workspace.removed` | `workspace:read` | a worker, a surface | `{ workspaceId: string; name: string; kind: 'worktree' \| 'folder'; folderPath: string \| null; branch: string \| null }` | A workspace was removed; the payload is what it was. |
| `agent.status.changed` | `conversation:read` | a worker, a surface | `{ workspaceId: string \| null; agentId: string; where: 'chat' \| 'terminal'; terminalId: string \| null; title: string \| null; state: 'working' \| 'blocked' \| 'done'; failed: boolean; receivedAt: number }` | A chat or a terminal agent changed status: `working`, `blocked` (it waits on the person) or `done` (its turn ended, its chat closed or its process exited; `failed` when the turn failed). Said once per change of state, not for every step it takes, and `done` once. |
| `workspace.changed` | `workspace:read` | a worker, a surface | `{ workspace: { workspaceId: string; name: string; kind: 'worktree' \| 'folder'; folderPath: string \| null; branch: string \| null; terminals: { id: string; title: string \| null }[] } }` | A workspace changed: renamed, its branch or folder changed, or a terminal in it opened or closed. Studio has no one focused workspace (each window has its own), so it says which. A worker hears every workspace as it is when it starts, and a surface when it subscribes, before any change. |
| `editor.typography.changed` | — | a surface | `{ fontFamily: string \| null; cssFontFamily: string; fontSize: number; fontWeight: string; lineHeight: number; fontLigatures: boolean; wordWrap: 'on' \| 'off'; minimap: boolean }` | The code font the window’s editor draws with changed. A surface hears it from the window that drew it, the current one first; a worker cannot, since each window has its own. |

<!-- generated:extension-event-reference:end -->

## Terminals

A worker reaches the person's terminals through `getTerminalService(studio)`:

| Method                                      | Needs            | What it does                                                                                                                             |
| ------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `send({ terminalId, text, enter? })`        | `terminals:send` | Types `text` into a terminal your extension opened, or one in a workspace a window shows now, pressing Enter when `enter` is true. `accepted` is false when its process has exited. |
| `create({ workspaceId, title?, command? })` | `terminals:send` | Opens a shell in a workspace's folder, in the background (no window switches to it), and runs `command` in it. Answers its `terminalId`. |
| `read({ terminalId, maxLines? })`           | `terminals:read` | Its newest output as plain text, one line a string: 200 lines unless you ask, at most 2000.                                              |
| `close({ terminalId })`                     | `terminals:send` | Closes a terminal your extension opened. Any other is refused with `not_yours`.                                                          |
| `list({ workspaceId? })`                    | `terminals:read` | The live terminals, in one workspace when asked: at most 50, each with its id, workspace, title and whether your extension opened it.    |

```ts
import { getTerminalService, type MainHost } from '@sprintengine/extension-sdk'

export function activate(studio: MainHost): void {
  const terminals = getTerminalService(studio)
  studio.registerMethods({
    'tests.run': {
      access: 'operate',
      params: (value) => ({ ok: true, params: value as { workspaceId: string } }),
      handler: async ({ workspaceId }) => {
        const { terminalId } = await terminals.create({ workspaceId, title: 'Tests', command: 'npm test' })
        return { ok: true, result: { terminalId } }
      },
    },
  })
}
```

- Worker tier only: no surface has a way to a terminal, so extension.json
  refuses `terminals:send` and `terminals:read` below the worker tier. The
  approval reads "Type into your terminals and run commands".
- Terminals are the person's. Whoever set a call off must be the person at
  this machine, an agent of theirs, or your extension's own work: a paired
  device, the phone, another app and a browser tab (the person's own
  included) are refused (`not_permitted`), as they are for Studio's own
  terminals. An agent that asks before it runs commands
  cannot have you type or run a command for it either.
- `send` types into a terminal your extension opened, or one in a workspace
  a window on this machine shows now, checked at each call and again right
  before the text goes out; any other is refused with `not_yours`. So nothing
  types into a terminal in a workspace nobody is looking at.
- What you type passes the extensions' `terminal.write.before` hooks first,
  as an extension's write.
- A terminal is named by its id: what `create` or `list` answers, or one an
  event carries (`workspace.changed`'s `terminals`, `agent.status.changed`'s
  `terminalId`).
- Your extension keeps the terminals it opened until it is switched off or
  loses its approval; then they stay open, the person's. Uninstalling it, or
  the kill list removing its version, closes them.
- A workspace on another machine (over SSH, or in WSL) keeps its own
  terminals: `create` there answers `unavailable`.

A refused call rejects with an error whose `code` says why:
`not_permitted`, `approval_required`, `unknown_terminal`, `unknown_workspace`,
`not_yours`, `unavailable`, `invalid_params`, `refused_by_extension` (a
`terminal.write.before` hook refused the write), `limit_reached` (your
extension already has 128 terminals open; close one first) or
`action_failed`.
