# Phone canvases

Canvases lists every Canvas board on every paired desktop that can say,
labelled by project, as the desktop's Canvas pane lists All boards. A board
whose project the desktop has removed reads "Deleted project", the desktop's
words. Settings ▸ Canvases opens it; so does a chat's page (its title opens
it), from its Canvas row.

## Where the boards come from

The phone calls the gateway's `canvas.list` and `canvas.screenshot`
(`src/api/canvasBoards.ts`) over the same stateless JSON-RPC POST that
`workspace.list` rides. Both only look, so both need `workspace:read`, the
grant New already needs to list projects; a pairing without it lists nothing
and says so. A paired device is bound to no workspace, so it may read every
board on the machine and picture one by its id without naming a project.

How each desktop is asked depends on what it advertises
(`canvasListMode` in `src/features/canvas/canvasLogic.ts`):

- `canvas-machine-boards` (2026-11-07): one call with `scope: machine` lists
  every board there, each with its project, its `id` and the workspace in its
  folder. From a chat, the call names the chat's workspace, as a paired
  desktop does.
- An older desktop, from a chat: that chat's project alone, with no `scope`,
  which every desktop with canvas tools has answered. The list says, in the
  desktop's own sentence, that it is that project's alone and that updating
  Studio there shows all of them.
- An older desktop, from Settings: each project it has open, one call apiece
  (its checkout where it is open, else one of its worktrees, never "No
  project"), merged newest first. The list says the boards come a project at
  a time and that boards of removed projects are missing. A project that
  refuses is named under the list.

A desktop that offers no canvas tools (a server with no desktop open) answers
"Unknown tool", and the list says to open SprintEngine Studio there. Any
other refusal is said in the desktop's own words.

## A board

A board opens as a picture drawn on its desktop by `canvas.screenshot`, at
most 1600 pixels on its longest edge and in the phone's theme. Refresh (or
pulling the page) draws it again, keeping the old picture until the new one
comes. A tap shows it whole in the chat's picture viewer. A board with an id
is asked for by its id, which needs no project; a row from an older desktop
has none, and is asked for by its path in the project it was listed under.

A chat's Canvas row opens the board its agent named, by id or by name, as a
picture at once; a name is read in the chat's project, as the agent's own
tools read it. An agent that never named a board used its project's newest,
which the phone cannot name: the row then opens the page's Canvas view, which
says so and offers the desktop's boards.

The phone does not edit a board by hand. Continue in a new chat starts a chat
on the board's desktop (`conversation.create`) whose first message is the
desktop's own, naming the board by its id, else its path. It starts beside
the board, in the workspace in its folder; failing that in the project of the
chat it was opened from; failing that, for a board whose project is gone,
under no project, where the desktop advertises `new-chat-no-project`. A
desktop that cannot start a chat without a project gets no call, and the
phone says why. The new chat opens on top of the board, and Back returns to
it. Continue is offered only where New could start a chat on that desktop.

## Verification

A harness build (`EXPO_PUBLIC_VERIFY_HARNESS=1`) answers with a fixture
(`src/__verify__/fakeCanvases.ts`): the harness desktop lists two projects'
boards and a removed project's in one answer, and the older Mac mini is asked
a project at a time, one of which refuses. Reached by deep link:

- `sprintengine://verify/canvases`
- `sprintengine://verify/canvas/dev_verify/export-flow?path=export-flow.excalidraw&workspaceId=ws-mobile`
- `sprintengine://verify/canvas/dev_verify/missing?path=missing.excalidraw&workspaceId=ws-mobile`
  (a board that is not there)

The rules are pinned by `src/api/canvasBoards.regression.test.js` and
`src/features/canvas/canvasLogic.regression.test.js`.
