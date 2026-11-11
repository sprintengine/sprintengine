@AGENTS.md

# SprintEngine Studio

An Electron app that runs coding-agent CLIs side by side. A chat runs on this
desktop, on a paired machine over the tailnet, or on a WSL or SSH machine
(`src/server`), and the phone app in `mobile/` drives any of them. Every review
follows `REVIEW.md`.

## What we do not compromise on

1. **Open.** The code is public; write as if everything will be read.
2. **Fast.** Chats stream for hours. Send only what the screen needs over a
   wire, do not render long lists in full, and no animation that never stops
   repainting.
3. **Remote ready.** Paired machines and the phone are the product. A feature
   is not done until it works over the tailnet.
4. **Every surface.** Desktop (macOS, Windows, Linux), paired machine, phone,
   WSL and SSH machines.

## Hit every surface

The most common bug here is a change made to a local chat that never reached
the others. Say in the pull request what you did for each:

- **Paired machine.** A local chat reaches main over IPC; a paired chat goes
  over the tailnet, and every capability of a remote chat starts off
  (`createRemoteConversationTransport`), so a feature missing there fails
  silently. Add it to `packages/conversation-protocol`, serve it in
  `tailnet-conversation-host.ts` behind a capability in `tailnet-routes.ts`,
  ask for it from `tailnet-mesh-service.ts` and `RemoteConversationPanel.tsx`,
  and test it in a `tailnet-conversation-*.test.ts`.
- **Phone.** It has its own client of that wire
  (`mobile/src/api/conversationWire.ts`) and its own copy of the mobile-control
  types (`mobile/src/shared/mobile-control/protocol.ts`). Change both sides and
  build the screen, or say why a phone cannot. An older phone keeps working
  (`docs/compatibility.md`).
- **WSL and SSH.** By default a WSL chat is a local chat whose CLI Windows
  starts through `wsl.exe`, so check Windows and Linux paths and quoting. With
  the WSL server on, and on SSH machines, a chat goes through `src/server`'s
  backend wire: add a new backend member to `REMOTE_BACKEND_MEMBERS` and bump
  `BACKEND_WIRE_VERSION` (`src/server/wsl/backend-wire.ts`).
- **Other ways in.** The command palette, shortcuts, menus, the sidebar's row
  menu, Settings and the agents' MCP tools (`src/main/automation/`). Keep the
  behaviour in a service so all of them reach it.
- **Ways back.** A way in needs a way out: snooze needs unsnooze.

## Done means you watched it work

`npm run verify:app` is the floor, not the proof.

- Show the command and its output, or the screenshot.
- UI: run this worktree's build and look in light and dark, at the narrowest
  window, and with what sits beside it.
- Conversations: check a paired chat, and phone width when it reaches the phone
  (`mobile/README.md`).
- Bugs: a failing test first, then fix every instance, on every surface.
- Say what you did not check. A flaky test is a bug, not a re-run.
