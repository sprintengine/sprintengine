# Phone canvases

Canvases lists every Canvas board on every paired desktop that can say,
labelled by project, as the desktop's Canvas pane lists All boards. A board
whose project the desktop has removed reads "Deleted project", the desktop's
words. Settings ▸ Canvases opens it; so does a chat's page (its title opens
it), from its Canvas row.

## Where the boards come from

The phone calls the desktop's `canvas.list` and `canvas.picture` on its Studio
protocol (`src/api/canvasBoards.ts`, over `src/api/desktopStudio.ts`). Both
only look, so both need `workspace:read`, the grant New already needs to list
projects; a pairing without it lists nothing and says so. A paired device is
bound to no workspace, so it may read every board on the machine and picture
one by its id without naming a project.

One call lists every board there, each with its project, its `id` and the
workspace in its folder. From a chat, the call names the chat's workspace, so
that project's boards read as `here`, as a paired desktop asks. A desktop
whose Studio serves no boards (a server with no desktop open) answers that it
does not, and the list says to open SprintEngine Studio there; a desktop from
before the Studio protocol is one to update. Any other refusal is said in the
desktop's own words.

## A board

A board opens as a picture drawn on its desktop by `canvas.picture`, at
most 1600 pixels on its longest edge and in the phone's theme. Refresh (or
pulling the page) draws it again, keeping the old picture until the new one
comes. A tap shows it whole in the chat's picture viewer. A board is asked
for by its id, which needs no project; a board an agent named by its path is
asked for by that path in the chat's project.

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
boards and a removed project's in one answer, and the Mac mini refuses, to
show the words for one. Reached by deep link:

- `sprintengine://verify/canvases`
- `sprintengine://verify/canvas/dev_verify/export-flow?path=export-flow.excalidraw&workspaceId=ws-mobile`
- `sprintengine://verify/canvas/dev_verify/missing?path=missing.excalidraw&workspaceId=ws-mobile`
  (a board that is not there)

The rules are pinned by `src/api/canvasBoards.regression.test.js` and
`src/features/canvas/canvasLogic.regression.test.js`.
